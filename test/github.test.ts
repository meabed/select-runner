import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import type { ApiOptions, Runner } from '../src/github';

import { appJwt, listRunners, mintInstallationToken, request, usableRunnerGroups, withoutDeprecatedRunners, workflowAllowed } from '../src/github';

const api: ApiOptions = { apiUrl: 'https://api.github.test', timeoutSeconds: 5, retries: 2, retryDelayMs: 1 };
const settings = { owner: 'acme', repository: 'acme/app', enterprise: 'acme-corp' };
const context = { repoPublic: false, workflowRef: 'acme/app/.github/workflows/ci.yml@refs/heads/main', sha: 'abc123' };
const group = (id: number, name: string, extra: object = {}) => ({ id, name, allows_public_repositories: false, restricted_to_workflows: false, selected_workflows: [], ...extra });
const runners = (count: number, offset = 0): Runner[] =>
  Array.from({ length: count }, (_, index) => ({ id: offset + index, name: `r${offset + index}`, status: 'online', busy: false, labels: [{ name: 'self-hosted' }], version: '2.330.0' }));

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
afterEach(() => fetchSpy?.mockRestore());

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
function mockFetch(handler: (url: string, init?: RequestInit, call?: number) => Reply | unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = handler(url, init, calls.length) as Reply;
    if (reply && typeof reply === 'object' && 'status' in reply) return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers });
    return Response.json(reply);
  }) as typeof fetch);
  return calls;
}

describe('request', () => {
  test('retries 5xx and rate limits, honouring Retry-After', async () => {
    const calls = mockFetch((_url, _init, call) => (call === 1 ? { status: 502 } : call === 2 ? { status: 403, headers: { 'retry-after': '0' } } : { ok: true }));
    expect(await request(api, '/x', 't')).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  test('does not retry other client errors, and stops after `retries`', async () => {
    mockFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    expect(request(api, '/x', 't')).rejects.toThrow('GET /x: HTTP 404');
    const calls = mockFetch(() => ({ status: 500 }));
    await expect(request(api, '/y', 't')).rejects.toThrow('HTTP 500');
    expect(calls).toHaveLength(3);
  });

  test('retries network errors', async () => {
    let first = true;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      if (first) {
        first = false;
        throw new TypeError('fetch failed');
      }
      return Response.json({ ok: 1 });
    }) as unknown as typeof fetch);
    expect(await request(api, '/x', 't')).toEqual({ ok: 1 });
  });
});

describe('appJwt', () => {
  test('is a valid RS256 JWT issued by the client id', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const [header = '', payload = '', signature = ''] = appJwt('Iv1.example', pem, 1_000).split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iat: 940, exp: 1_540, iss: 'Iv1.example' });
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('mintInstallationToken', () => {
  const app = () => ({ ...settings, appClientId: 'Iv1.example', appPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() });

  test('org + repo scopes: one token with both read permissions', async () => {
    const calls = mockFetch((url) => (url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_x' }));
    expect(await mintInstallationToken(api, app(), ['org', 'repo'])).toBe('ghs_x');
    expect(calls[0]?.url).toBe('https://api.github.test/orgs/acme/installation');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ permissions: { organization_self_hosted_runners: 'read', administration: 'read' }, repositories: ['app'] });
  });

  test('repo scope uses the repository installation', async () => {
    const calls = mockFetch((url) => (url.endsWith('/installation') ? { id: 7 } : { token: 'ghs_y' }));
    await mintInstallationToken(api, app(), ['repo']);
    expect(calls[0]?.url).toBe('https://api.github.test/repos/acme/app/installation');
  });

  test('enterprise scope needs a token', async () => {
    expect(mintInstallationToken(api, app(), ['enterprise'])).rejects.toThrow('scope enterprise needs a token');
  });
});

describe('workflowAllowed', () => {
  test('matches path plus branch, full ref, tag or sha', () => {
    const ref = 'acme/app/.github/workflows/ci.yml@refs/heads/main';
    expect(workflowAllowed(['acme/app/.github/workflows/ci.yml@main'], ref, 'abc')).toBe(true);
    expect(workflowAllowed(['acme/app/.github/workflows/ci.yml@refs/heads/main'], ref, 'abc')).toBe(true);
    expect(workflowAllowed(['acme/app/.github/workflows/ci.yml@abc'], ref, 'abc')).toBe(true);
    expect(workflowAllowed(['acme/app/.github/workflows/ci.yml@release'], ref, 'abc')).toBe(false);
    expect(workflowAllowed(['acme/app/.github/workflows/deploy.yml@main'], ref, 'abc')).toBe(false);
  });
});

describe('runner groups and listing', () => {
  test('only groups visible to the repository, open to it and its workflow', async () => {
    const calls = mockFetch(() => ({
      total_count: 3,
      runner_groups: [group(1, 'Default'), group(2, 'deploy-only', { restricted_to_workflows: true, selected_workflows: ['acme/app/.github/workflows/deploy.yml@main'] }), group(3, 'public-ok', { allows_public_repositories: true })],
    }));
    const privateRepo = await usableRunnerGroups(api, settings, context, 't');
    expect(calls[0]?.url).toBe('https://api.github.test/orgs/acme/actions/runner-groups?visible_to_repository=app&per_page=100&page=1');
    expect(privateRepo.usable.map((candidate) => candidate.name)).toEqual(['Default', 'public-ok']);
    expect(privateRepo.excluded).toEqual(['deploy-only (other workflows only)']);
    const publicRepo = await usableRunnerGroups(api, settings, { ...context, repoPublic: true }, 't');
    expect(publicRepo.usable.map((candidate) => candidate.name)).toEqual(['public-ok']);
  });

  test('org runners come per usable group (paginated); repo and enterprise runners are added', async () => {
    mockFetch((url) => {
      if (url.includes('/runner-groups?')) return { total_count: 1, runner_groups: [group(1, 'Default')] };
      if (url.includes('/runner-groups/1/runners')) return { total_count: 130, runners: url.endsWith('&page=1') ? runners(100) : runners(30, 100) };
      if (url.includes('/repos/acme/app/actions/runners')) return { total_count: 1, runners: runners(1, 500) };
      return { total_count: 1, runners: runners(1, 900) };
    });
    const { runners: listed } = await listRunners(api, settings, context, ['org', 'repo', 'enterprise'], 't');
    expect(listed).toHaveLength(132);
    expect(listed[0]).toMatchObject({ scope: 'org', group: 'Default' });
    expect(listed.at(-1)).toMatchObject({ scope: 'enterprise', name: 'r900' });
  });
});

describe('withoutDeprecatedRunners', () => {
  test('drops runners whose version is past its runtime deprecation; lookup errors keep them', async () => {
    const calls = mockFetch((url) => (url.endsWith('/2.300.0') ? { runtime_deprecates_at: '2026-01-01T00:00:00Z' } : url.endsWith('/2.330.0') ? { runtime_deprecates_at: null } : { status: 500 }));
    const list: Runner[] = [
      { ...runners(1)[0]!, name: 'old', version: '2.300.0', scope: 'org' },
      { ...runners(1, 1)[0]!, name: 'new', version: '2.330.0', scope: 'org' },
      { ...runners(1, 2)[0]!, name: 'unknown', version: '2.999.0', scope: 'repo' },
    ];
    const result = await withoutDeprecatedRunners({ ...api, retries: 0 }, settings, list, 't', Date.parse('2026-06-01'));
    expect(result.runners.map((candidate) => candidate.name)).toEqual(['new', 'unknown']);
    expect(result.deprecated).toEqual(['old (2.300.0)']);
    expect(calls.map((call) => call.url)).toContain('https://api.github.test/repos/acme/app/actions/runners/deprecations/2.999.0');
  });
});
