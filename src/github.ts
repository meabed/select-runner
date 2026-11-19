// GitHub REST access: App installation tokens (downscoped to reading runners), runner
// listing with pagination, and runner group lookup.
import { createPrivateKey, sign } from 'node:crypto';

import type { Config } from './config';
import type { Runner } from './select';

type Api = Pick<Config, 'apiUrl'>;

export async function request<T>(api: Api, path: string, token: string, init: { method?: string; body?: object } = {}) {
  const method = init.method ?? 'GET';
  const response = await fetch(`${api.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'select-runner',
    },
    body: init.body && JSON.stringify(init.body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export function appJwt(clientId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // iat 60s in the past absorbs clock drift; GitHub caps exp at 10 minutes.
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), createPrivateKey(privateKeyPem)).toString('base64url')}`;
}

// Installation token limited to what listing runners needs, for this owner only.
export async function mintInstallationToken(config: Pick<Config, 'apiUrl' | 'appClientId' | 'appPrivateKey' | 'scope' | 'owner' | 'repository'>) {
  const jwt = appJwt(config.appClientId, config.appPrivateKey);
  const repoName = config.repository.split('/')[1] ?? '';
  const installation = await request<{ id: number }>(config, config.scope === 'org' ? `/orgs/${config.owner}/installation` : `/repos/${config.repository}/installation`, jwt);
  const body = config.scope === 'org' ? { permissions: { organization_self_hosted_runners: 'read' } } : { permissions: { administration: 'read' }, repositories: [repoName] };
  const { token } = await request<{ token: string }>(config, `/app/installations/${installation.id}/access_tokens`, jwt, { method: 'POST', body });
  return token;
}

export async function revokeInstallationToken(api: Api, token: string) {
  await request(api, '/installation/token', token, { method: 'DELETE' });
}

export async function listRunners(config: Pick<Config, 'apiUrl' | 'scope' | 'owner' | 'repository'>, token: string) {
  const base = config.scope === 'org' ? `/orgs/${config.owner}/actions/runners` : `/repos/${config.repository}/actions/runners`;
  const runners: Runner[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<{ total_count: number; runners: Runner[] }>(config, `${base}?per_page=100&page=${page}`, token);
    runners.push(...batch.runners);
    if (batch.runners.length < 100 || runners.length >= batch.total_count) return runners;
  }
}

export async function findRunnerGroupId(config: Pick<Config, 'apiUrl' | 'owner'>, token: string, name: string) {
  const groups: { id: number; name: string }[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<{ total_count: number; runner_groups: { id: number; name: string }[] }>(config, `/orgs/${config.owner}/actions/runner-groups?per_page=100&page=${page}`, token);
    groups.push(...batch.runner_groups);
    if (batch.runner_groups.length < 100 || groups.length >= batch.total_count) break;
  }
  const group = groups.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!group) throw new Error(`runner group "${name}" not found in ${config.owner}`);
  return group.id;
}
