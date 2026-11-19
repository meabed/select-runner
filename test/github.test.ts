import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import type { Runner } from '../src/select';

import { appJwt, findRunnerGroupId, listRunners, mintInstallationToken } from '../src/github';

const api = { apiUrl: 'https://api.github.test' };

function runners(count: number, offset = 0): Runner[] {
  return Array.from({ length: count }, (_, index) => ({ id: offset + index, name: `r${offset + index}`, status: 'online', busy: false, labels: [{ name: 'self-hosted' }] }));
}

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
afterEach(() => fetchSpy?.mockRestore());

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Response.json(handler(url, init));
  }) as typeof fetch);
  return calls;
}

describe('appJwt', () => {
  test('is a valid RS256 JWT issued by the client id', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const [header = '', payload = '', signature = ''] = appJwt('Iv1.example', pem, 1_000).split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iat: 940, exp: 1_540, iss: 'Iv1.example' });
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('listRunners', () => {
  test('follows pages until a short page', async () => {
    const calls = mockFetch((url) => ({ total_count: 130, runners: url.endsWith('&page=1') ? runners(100) : runners(30, 100) }));
    const listed = await listRunners({ ...api, scope: 'org', owner: 'acme', repository: 'acme/app' }, 'token');
    expect(listed).toHaveLength(130);
    expect(calls.map((call) => call.url)).toEqual(['https://api.github.test/orgs/acme/actions/runners?per_page=100&page=1', 'https://api.github.test/orgs/acme/actions/runners?per_page=100&page=2']);
  });

  test('repo scope lists repository runners', async () => {
    const calls = mockFetch(() => ({ total_count: 0, runners: [] }));
    await listRunners({ ...api, scope: 'repo', owner: 'acme', repository: 'acme/app' }, 'token');
    expect(calls[0]?.url).toBe('https://api.github.test/repos/acme/app/actions/runners?per_page=100&page=1');
  });
});

describe('findRunnerGroupId', () => {
  test('matches the group name case-insensitively', async () => {
    mockFetch(() => ({
      total_count: 2,
      runner_groups: [
        { id: 1, name: 'Default' },
        { id: 7, name: 'my-runners' },
      ],
    }));
    expect(await findRunnerGroupId({ ...api, owner: 'acme' }, 'token', 'My-Runners')).toBe(7);
  });

  test('throws when the group does not exist', async () => {
    mockFetch(() => ({ total_count: 0, runner_groups: [] }));
    expect(findRunnerGroupId({ ...api, owner: 'acme' }, 'token', 'missing')).rejects.toThrow('runner group "missing" not found');
  });
});

describe('mintInstallationToken', () => {
  test('requests an org token downscoped to reading self-hosted runners', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calls = mockFetch((url) => (url.endsWith('/installation') ? { id: 42 } : { token: 'ghs_x' }));
    const token = await mintInstallationToken({
      ...api,
      appClientId: 'Iv1.example',
      appPrivateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      scope: 'org',
      owner: 'acme',
      repository: 'acme/app',
    });
    expect(token).toBe('ghs_x');
    expect(calls[0]?.url).toBe('https://api.github.test/orgs/acme/installation');
    expect(calls[1]?.url).toBe('https://api.github.test/app/installations/42/access_tokens');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ permissions: { organization_self_hosted_runners: 'read' } });
  });
});
