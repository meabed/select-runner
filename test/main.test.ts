// Runs the action entry point the way GitHub does: INPUT_* env in, GITHUB_OUTPUT and
// GITHUB_STEP_SUMMARY files out. A local Bun server stands in for the GitHub REST API.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type FakeRunner = { id: number; name: string; status: 'online' | 'offline'; busy: boolean; labels: { name: string }[]; version: string };

// Mutable fake org: one usable group (Default) and one restricted to another workflow.
const state = { runners: [] as FakeRunner[], restricted: [] as FakeRunner[], listCalls: 0, becomeIdleAfter: 0 };
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== 'Bearer test-token') return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (url.pathname === '/orgs/acme/actions/runner-groups') {
      return Response.json({
        total_count: 2,
        runner_groups: [
          { id: 1, name: 'Default', allows_public_repositories: false, restricted_to_workflows: false, selected_workflows: [] },
          { id: 2, name: 'deploy', allows_public_repositories: false, restricted_to_workflows: true, selected_workflows: ['acme/app/.github/workflows/deploy.yml@main'] },
        ],
      });
    }
    if (url.pathname === '/orgs/acme/actions/runner-groups/1/runners') {
      state.listCalls += 1;
      const runners = state.becomeIdleAfter && state.listCalls > state.becomeIdleAfter ? state.runners.map((runner) => ({ ...runner, busy: false })) : state.runners;
      return Response.json({ total_count: runners.length, runners });
    }
    if (url.pathname === '/orgs/acme/actions/runner-groups/2/runners') return Response.json({ total_count: state.restricted.length, runners: state.restricted });
    if (url.pathname.startsWith('/orgs/acme/actions/runners/deprecations/')) return Response.json({ runtime_deprecates_at: null });
    return Response.json({ message: 'Not Found' }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

const runner = (name: string, labels: string[], busy = false): FakeRunner => ({ id: name.length, name, status: 'online', busy, labels: labels.map((label) => ({ name: label })), version: '2.330.0' });

async function runAction(inputs: Record<string, string>, event: object = { repository: { full_name: 'acme/app', private: true, owner: { type: 'Organization' } } }, eventName = 'push') {
  const dir = mkdtempSync(join(tmpdir(), 'select-runner-'));
  const files = { output: join(dir, 'output'), summary: join(dir, 'summary'), event: join(dir, 'event.json') };
  writeFileSync(files.output, '');
  writeFileSync(files.summary, '');
  writeFileSync(files.event, JSON.stringify(event));
  const proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      GITHUB_EVENT_PATH: files.event,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_ACTOR: 'octocat',
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_REPOSITORY_OWNER: 'acme',
      GITHUB_WORKFLOW_REF: 'acme/app/.github/workflows/ci.yml@refs/heads/main',
      'INPUT_GITHUB-API-URL': server.url.origin,
      ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const outputs: Record<string, string> = Object.fromEntries([...readFileSync(files.output, 'utf8').matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)].map((match) => [match[1], match[3]]));
  return { exitCode, stdout, outputs, summary: readFileSync(files.summary, 'utf8') };
}

describe('without the API', () => {
  test('force fallback needs no credentials', async () => {
    const result = await runAction({ labels: 'self-hosted', fallback: 'ubuntu-24.04', force: 'fallback' });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ 'runs-on': '"ubuntu-24.04"', 'self-hosted': 'false', index: '1', name: 'fallback', reason: 'forced to fallback' });
    expect(result.summary).toContain('### 🏃 Runner selection');
  });

  test('force self-hosted outputs the labels', async () => {
    const result = await runAction({ labels: 'self-hosted, linux-arm64', force: 'self-hosted' });
    expect(result.outputs).toMatchObject({ 'runs-on': '["self-hosted","linux-arm64"]', 'self-hosted': 'true', labels: 'self-hosted,linux-arm64' });
  });

  test('no labels: the fallback, no credentials, no warning', async () => {
    const result = await runAction({ fallback: 'ubuntu-24.04' });
    expect(result.stdout).not.toContain('::warning');
    expect(result.outputs).toMatchObject({ 'runs-on': '"ubuntu-24.04"', 'self-hosted': 'false' });
  });

  test('fork pull requests never reach self-hosted runners', async () => {
    const event = { repository: { full_name: 'acme/app', private: false }, pull_request: { head: { repo: { full_name: 'mallory/app' } } } };
    const result = await runAction({ labels: 'self-hosted', token: 'test-token' }, event, 'pull_request');
    expect(result.outputs).toMatchObject({ 'self-hosted': 'false', reason: 'untrusted run (pull request from fork mallory/app)' });
  });

  test('missing credentials: warn and fall back, or fail with fail-on-error', async () => {
    const warned = await runAction({ labels: 'self-hosted' });
    expect(warned.exitCode).toBe(0);
    expect(warned.stdout).toContain('::warning title=select-runner::no credentials');
    expect(warned.outputs['runs-on']).toBe('"ubuntu-latest"');
    const failed = await runAction({ labels: 'self-hosted', 'fail-on-error': 'true' });
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain('::error title=select-runner::no credentials');
  });

  test('error text cannot inject workflow commands', async () => {
    const result = await runAction({ candidates: '- labelz: "x\n::add-mask::y"' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toMatch(/^::add-mask::/m);
  });

  test('invalid configuration fails the step', async () => {
    expect((await runAction({ force: 'maybe' })).exitCode).toBe(1);
    expect((await runAction({ candidates: '- labelz: x' })).exitCode).toBe(1);
  });
});

describe('against a fake GitHub API', () => {
  test('idle self-hosted runner is selected', async () => {
    state.runners = [runner('mac-1', ['self-hosted', 'arm64'])];
    const result = await runAction({ labels: 'self-hosted, arm64', token: 'test-token' });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ 'runs-on': '["self-hosted","arm64"]', 'self-hosted': 'true', idle: '1', online: '1', busy: '0', registered: '1', runners: '["mac-1"]' });
  });

  test('busy runners overflow down the chain with an annotation', async () => {
    state.runners = [runner('mac-1', ['self-hosted', 'arm64'], true)];
    const result = await runAction({ candidates: '- labels: self-hosted, arm64\n- runs-on: blacksmith-4vcpu-ubuntu-2404\n  enabled: false\n- ubuntu-24.04-arm', token: 'test-token' });
    expect(result.outputs).toMatchObject({ 'runs-on': '"ubuntu-24.04-arm"', index: '2', 'self-hosted': 'false', idle: '0', busy: '1' });
    expect(result.stdout).toContain('::notice title=select-runner (default)::ubuntu-24.04-arm — passed over self-hosted, arm64 (0 idle, need 1); blacksmith-4vcpu-ubuntu-2404 (disabled)');
    for (const text of ['### 🏃 Runner selection', '⛔ no capacity', '⏭️ disabled', '✅ chosen', '· not reached', 'token', 'API request']) expect(result.summary).toContain(text);
  });

  test('runners in groups this workflow may not use are not counted', async () => {
    state.runners = [];
    state.restricted = [runner('deploy-1', ['self-hosted', 'arm64'])];
    const result = await runAction({ labels: 'self-hosted, arm64', token: 'test-token' });
    expect(result.outputs).toMatchObject({ 'self-hosted': 'false', registered: '0' });
    expect(result.summary).toContain('runner group not usable here: deploy (other workflows only)');
    state.restricted = [];
  });

  test('pools: several routes from one listing, flat and JSON outputs', async () => {
    state.runners = [runner('mac-1', ['self-hosted', 'arm64'])];
    const result = await runAction({
      token: 'test-token',
      pools: 'test:\n  - labels: self-hosted, arm64\n  - ubuntu-24.04-arm\nbuild:\n  - labels: self-hosted, x64\n  - blacksmith-4vcpu-ubuntu-2404',
    });
    expect(result.outputs).toMatchObject({
      'test-runs-on': '["self-hosted","arm64"]',
      'test-self-hosted': 'true',
      'build-runs-on': '"blacksmith-4vcpu-ubuntu-2404"',
      'build-self-hosted': 'false',
      'build-index': '1',
      'runs-on': '["self-hosted","arm64"]',
    });
    expect(JSON.parse(result.outputs.selections ?? '{}')).toMatchObject({ test: { 'self-hosted': true }, build: { 'runs-on': 'blacksmith-4vcpu-ubuntu-2404', index: 1 } });
  });

  test('wait-seconds re-polls until a runner frees up', async () => {
    state.runners = [runner('mac-1', ['self-hosted'], true)];
    state.listCalls = 0;
    state.becomeIdleAfter = 1;
    const result = await runAction({ labels: 'self-hosted', token: 'test-token', 'wait-seconds': '5', 'poll-seconds': '1' });
    expect(result.outputs).toMatchObject({ 'self-hosted': 'true' });
    expect(result.stdout).toContain('waiting 1s for self-hosted capacity');
    state.becomeIdleAfter = 0;
  });

  test('API errors fall back with a warning', async () => {
    const result = await runAction({ labels: 'self-hosted', token: 'wrong-token', retries: '0' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('HTTP 401');
    expect(result.outputs).toMatchObject({ 'self-hosted': 'false', 'runs-on': '"ubuntu-latest"' });
  });
});
