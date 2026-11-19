// GitHub REST access: resilient requests, App installation tokens downscoped to reading
// runners, and listing exactly the runners this workflow run is allowed to use.
import { createPrivateKey, sign } from 'node:crypto';

import type { Scope, Settings } from './config';
import type { RunContext } from './context';

export type Runner = {
  id: number;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: { name: string }[];
  version?: string;
  // Filled while listing: where the runner was found and its runner group (org scope).
  scope?: Scope;
  group?: string;
};

type RunnerGroup = { id: number; name: string; allows_public_repositories: boolean; restricted_to_workflows: boolean; selected_workflows: string[] };

export type ApiOptions = Pick<Settings, 'apiUrl' | 'timeoutSeconds' | 'retries'> & {
  // Base delay for exponential backoff (tests shrink it).
  retryDelayMs?: number;
  log?: (message: string) => void;
  // Counts every HTTP attempt (job summary).
  stats?: { requests: number };
};

const MAX_RETRY_WAIT_MS = 60_000;

function retryDelay(response: Response | undefined, attempt: number, baseMs: number) {
  const retryAfter = Number(response?.headers.get('retry-after'));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(response?.headers.get('x-ratelimit-reset'));
  if (response?.headers.get('x-ratelimit-remaining') === '0' && reset > 0) return Math.max(0, reset * 1000 - Date.now()) + 1000;
  return baseMs * 2 ** attempt;
}

function isRetryable(response: Response) {
  if (response.status >= 500 || response.status === 429) return true;
  // Secondary/primary rate limits answer 403 with these headers.
  return response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0');
}

export async function request<T>(api: ApiOptions, path: string, token: string, init: { method?: string; body?: object } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  for (let attempt = 0; ; attempt++) {
    if (api.stats) api.stats.requests += 1;
    const response = await fetch(`${api.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'select-runner',
      },
      body: init.body && JSON.stringify(init.body),
      signal: AbortSignal.timeout(api.timeoutSeconds * 1000),
    }).catch((error: Error) => error);

    const failure = response instanceof Error ? `${method} ${path}: ${response.name === 'TimeoutError' ? `timed out after ${api.timeoutSeconds}s` : response.message}` : undefined;
    if (!(response instanceof Error) && response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
    const retryable = response instanceof Error || isRetryable(response);
    const delay = retryDelay(response instanceof Error ? undefined : response, attempt, api.retryDelayMs ?? 1000);
    if (!retryable || attempt >= api.retries || delay > MAX_RETRY_WAIT_MS) {
      if (response instanceof Error) throw new Error(failure);
      throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    api.log?.(`${failure ?? `${method} ${path}: HTTP ${(response as Response).status}`} — retrying in ${Math.ceil(delay / 1000)}s (${attempt + 1}/${api.retries})`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function paginate<T>(api: ApiOptions, path: string, token: string, key: string): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const batch = await request<Record<string, unknown> & { total_count: number }>(api, `${path}${separator}per_page=100&page=${page}`, token);
    const pageItems = (batch[key] ?? []) as T[];
    items.push(...pageItems);
    if (pageItems.length < 100 || items.length >= batch.total_count) return items;
  }
}

export function appJwt(clientId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // iat 60s in the past absorbs clock drift; GitHub caps exp at 10 minutes.
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), createPrivateKey(privateKeyPem)).toString('base64url')}`;
}

// One installation token covering every listed scope, limited to reading runners.
export async function mintInstallationToken(api: ApiOptions, settings: Pick<Settings, 'appClientId' | 'appPrivateKey' | 'owner' | 'repository'>, scopes: Scope[]) {
  if (scopes.includes('enterprise')) throw new Error('scope enterprise needs a token (enterprise runners are not readable with an organization App installation)');
  const jwt = appJwt(settings.appClientId, settings.appPrivateKey);
  const installationPath = scopes.includes('org') ? `/orgs/${settings.owner}/installation` : `/repos/${settings.repository}/installation`;
  const installation = await request<{ id: number }>(api, installationPath, jwt);
  const permissions: Record<string, string> = {};
  if (scopes.includes('org')) permissions.organization_self_hosted_runners = 'read';
  if (scopes.includes('repo')) permissions.administration = 'read';
  const repoName = settings.repository.split('/')[1];
  const body = scopes.includes('repo') && repoName ? { permissions, repositories: [repoName] } : { permissions };
  const { token } = await request<{ token: string }>(api, `/app/installations/${installation.id}/access_tokens`, jwt, { method: 'POST', body });
  return token;
}

export async function revokeInstallationToken(api: ApiOptions, token: string) {
  await request(api, '/installation/token', token, { method: 'DELETE' });
}

// selected_workflows entries look like "owner/repo/.github/workflows/ci.yml@main" (a branch,
// tag, full ref or SHA); GITHUB_WORKFLOW_REF is "owner/repo/.github/workflows/ci.yml@refs/heads/main".
export function workflowAllowed(selected: string[], workflowRef: string, sha: string) {
  const [path = '', ref = ''] = workflowRef.split('@');
  return selected.some((entry) => {
    const [entryPath = '', entryRef = ''] = entry.split('@');
    if (entryPath.toLowerCase() !== path.toLowerCase()) return false;
    return [ref, sha].includes(entryRef) || [`refs/heads/${entryRef}`, `refs/tags/${entryRef}`].includes(ref);
  });
}

// Org runner groups this run may use: visible to the repository, open to public repos when
// it is public, and not restricted to other workflows. Returns the excluded ones too.
export async function usableRunnerGroups(api: ApiOptions, settings: Pick<Settings, 'owner' | 'repository'>, context: Pick<RunContext, 'repoPublic' | 'workflowRef' | 'sha'>, token: string) {
  const [repoOwner = '', repoName = ''] = settings.repository.split('/');
  const sameOrg = repoOwner.toLowerCase() === settings.owner.toLowerCase();
  const query = sameOrg && repoName ? `?visible_to_repository=${encodeURIComponent(repoName)}` : '';
  const groups = await paginate<RunnerGroup>(api, `/orgs/${settings.owner}/actions/runner-groups${query}`, token, 'runner_groups');
  const excluded: string[] = [];
  const usable = groups.filter((group) => {
    if (context.repoPublic && !group.allows_public_repositories) return excluded.push(`${group.name} (no public repositories)`) && false;
    if (group.restricted_to_workflows && !workflowAllowed(group.selected_workflows, context.workflowRef, context.sha)) return excluded.push(`${group.name} (other workflows only)`) && false;
    return true;
  });
  return { usable, excluded };
}

export async function listRunners(api: ApiOptions, settings: Pick<Settings, 'owner' | 'repository' | 'enterprise'>, context: Pick<RunContext, 'repoPublic' | 'workflowRef' | 'sha'>, scopes: Scope[], token: string) {
  const runners: Runner[] = [];
  const excludedGroups: string[] = [];
  if (scopes.includes('org')) {
    const { usable, excluded } = await usableRunnerGroups(api, settings, context, token);
    excludedGroups.push(...excluded);
    for (const group of usable) {
      const members = await paginate<Runner>(api, `/orgs/${settings.owner}/actions/runner-groups/${group.id}/runners`, token, 'runners');
      runners.push(...members.map((runner) => ({ ...runner, scope: 'org' as const, group: group.name })));
    }
  }
  if (scopes.includes('repo')) {
    const members = await paginate<Runner>(api, `/repos/${settings.repository}/actions/runners`, token, 'runners');
    runners.push(...members.map((runner) => ({ ...runner, scope: 'repo' as const, group: '' })));
  }
  if (scopes.includes('enterprise')) {
    if (!settings.enterprise) throw new Error('scope enterprise needs the enterprise input (enterprise slug)');
    const members = await paginate<Runner>(api, `/enterprises/${settings.enterprise}/actions/runners`, token, 'runners');
    runners.push(...members.map((runner) => ({ ...runner, scope: 'enterprise' as const, group: '' })));
  }
  const seen = new Set<string>();
  const unique = runners.filter((runner) => {
    const key = `${runner.scope}:${runner.id}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { runners: unique, excludedGroups };
}

// GitHub stops assigning jobs to runners whose version is past its runtime deprecation date,
// though they still report online and idle. Lookup failures keep the runners (best effort).
export async function withoutDeprecatedRunners(api: ApiOptions, settings: Pick<Settings, 'owner' | 'repository' | 'enterprise'>, runners: Runner[], token: string, now = Date.now()) {
  const base = (scope: Scope | undefined) => (scope === 'repo' ? `/repos/${settings.repository}` : scope === 'enterprise' ? `/enterprises/${settings.enterprise}` : `/orgs/${settings.owner}`);
  const deprecated = new Set<string>();
  const checked = new Set<string>();
  for (const runner of runners) {
    const key = `${runner.scope}:${runner.version}`;
    if (!runner.version || checked.has(key)) continue;
    checked.add(key);
    const info = await request<{ runtime_deprecates_at: string | null }>(api, `${base(runner.scope)}/actions/runners/deprecations/${runner.version}`, token).catch(() => undefined);
    if (info?.runtime_deprecates_at && Date.parse(info.runtime_deprecates_at) <= now) deprecated.add(key);
  }
  return {
    runners: runners.filter((runner) => !deprecated.has(`${runner.scope}:${runner.version}`)),
    deprecated: runners.filter((runner) => deprecated.has(`${runner.scope}:${runner.version}`)).map((runner) => `${runner.name} (${runner.version})`),
  };
}
