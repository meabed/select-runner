import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS, parseList, parseRunsOn, readSettings } from '../src/config';

const env = (inputs: Record<string, string>, extra: Record<string, string> = {}) => ({
  GITHUB_REPOSITORY: 'acme/app',
  GITHUB_REPOSITORY_OWNER: 'acme',
  ...extra,
  ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
});

describe('parseList / parseRunsOn', () => {
  test('lists split on commas and newlines', () => {
    expect(parseList(' self-hosted , linux-arm64\ngpu,, ')).toEqual(['self-hosted', 'linux-arm64', 'gpu']);
  });

  test('runs-on values: label, list, JSON string/array/group, empty', () => {
    expect(parseRunsOn('ubuntu-latest')).toBe('ubuntu-latest');
    expect(parseRunsOn('self-hosted, linux')).toEqual(['self-hosted', 'linux']);
    expect(parseRunsOn('"ubuntu-latest"')).toBe('ubuntu-latest');
    expect(parseRunsOn('["a","b"]')).toEqual(['a', 'b']);
    expect(parseRunsOn('{"group":"larger","labels":["x"]}')).toEqual({ group: 'larger', labels: ['x'] });
    expect(parseRunsOn('  ')).toBeNull();
    expect(() => parseRunsOn('[]')).toThrow();
    expect(() => parseRunsOn('{"labels":["x"]}')).toThrow();
  });
});

describe('readSettings defaults', () => {
  test('no inputs: one default pool that is only the fallback', () => {
    const settings = readSettings(env({}));
    expect(settings.pools).toEqual([{ name: 'default', tiers: [{ kind: 'runs-on', name: 'fallback', runsOn: 'ubuntu-latest', enabled: true }] }]);
    expect(settings).toMatchObject({
      minIdle: DEFAULTS.minIdle,
      match: 'idle',
      force: 'auto',
      scopes: 'auto',
      owner: 'acme',
      repository: 'acme/app',
      untrusted: 'fallback',
      waitSeconds: 0,
      pollSeconds: 10,
      timeoutSeconds: 15,
      retries: 3,
      skipDeprecated: true,
      annotate: 'notice',
      summary: true,
      failOnError: false,
      apiUrl: 'https://api.github.com',
    });
  });

  test('labels shorthand becomes a self-hosted tier before the fallback', () => {
    const [pool] = readSettings(env({ labels: 'self-hosted, linux', fallback: 'ubuntu-24.04' })).pools;
    expect(pool?.tiers).toEqual([
      { kind: 'self-hosted', name: 'self-hosted, linux', labels: ['self-hosted', 'linux'], group: '', enabled: true },
      { kind: 'runs-on', name: 'fallback', runsOn: 'ubuntu-24.04', enabled: true },
    ]);
  });

  test('every knob is configurable from inputs', () => {
    const settings = readSettings(
      env({
        'min-idle': '2',
        match: 'online',
        force: 'self-hosted',
        scope: 'org, repo',
        untrusted: 'allow',
        'wait-seconds': '60',
        'poll-seconds': '5',
        'timeout-seconds': '30',
        retries: '0',
        'skip-deprecated': 'false',
        annotate: 'warning',
        summary: 'false',
        'fail-on-error': 'true',
        enterprise: 'acme-corp',
        'app-client-id': 'Iv1.example',
        'app-private-key': String.raw`-----BEGIN KEY-----\nabc\n-----END KEY-----`,
        'github-api-url': 'https://ghes.example.com/api/v3/',
      }),
    );
    expect(settings).toMatchObject({
      minIdle: 2,
      match: 'online',
      force: 'self-hosted',
      scopes: ['org', 'repo'],
      untrusted: 'allow',
      waitSeconds: 60,
      pollSeconds: 5,
      timeoutSeconds: 30,
      retries: 0,
      skipDeprecated: false,
      annotate: 'warning',
      summary: false,
      failOnError: true,
      enterprise: 'acme-corp',
      appClientId: 'Iv1.example',
      appPrivateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      apiUrl: 'https://ghes.example.com/api/v3',
    });
  });

  test('invalid values fail with the field name', () => {
    expect(() => readSettings(env({ force: 'maybe' }))).toThrow('force');
    expect(() => readSettings(env({ match: 'busy' }))).toThrow('match');
    expect(() => readSettings(env({ 'min-idle': '0' }))).toThrow('min-idle');
    expect(() => readSettings(env({ scope: 'org, team' }))).toThrow('scope');
    expect(() => readSettings(env({ retries: 'many' }))).toThrow('retries');
    expect(() => readSettings(env({ candidates: '- labels: a\n  capacity: 0' }))).toThrow('capacity');
  });
});

describe('candidates and pools', () => {
  const candidates = `
- labels: [self-hosted, gpu]
  min-idle: 2
- labels: self-hosted, linux
  match: online
  capacity: 8
- runs-on: blacksmith-4vcpu-ubuntu-2404
  enabled: false
- ubuntu-24.04
`;

  test('candidates: ordered tiers of both kinds, then the fallback', () => {
    const [pool] = readSettings(env({ candidates })).pools;
    expect(pool?.tiers).toEqual([
      { kind: 'self-hosted', name: 'self-hosted, gpu', labels: ['self-hosted', 'gpu'], group: '', minIdle: 2, match: undefined, enabled: true },
      { kind: 'self-hosted', name: 'self-hosted, linux', labels: ['self-hosted', 'linux'], group: '', minIdle: undefined, match: 'online', capacity: 8, enabled: true },
      { kind: 'runs-on', name: 'blacksmith-4vcpu-ubuntu-2404', runsOn: 'blacksmith-4vcpu-ubuntu-2404', enabled: false },
      { kind: 'runs-on', name: 'ubuntu-24.04', runsOn: 'ubuntu-24.04', enabled: true },
      { kind: 'runs-on', name: 'fallback', runsOn: 'ubuntu-latest', enabled: true },
    ]);
  });

  test('pools: one chain per name', () => {
    const pools = readSettings(
      env({
        pools: `
test:
  - labels: self-hosted
  - ubuntu-24.04-arm
build:
  - group: build-farm
    labels: x64
    name: farm
  - runs-on: { group: larger-runners, labels: [ubuntu-24.04-16core] }
`,
      }),
    ).pools;
    expect(pools.map((pool) => pool.name)).toEqual(['test', 'build']);
    expect(pools[1]?.tiers[0]).toMatchObject({ kind: 'self-hosted', name: 'farm', group: 'build-farm', labels: ['x64'] });
    expect(pools[1]?.tiers[1]).toMatchObject({ kind: 'runs-on', runsOn: { group: 'larger-runners', labels: ['ubuntu-24.04-16core'] } });
  });

  test('enabled: only an explicit false disables; empty (unset variable) keeps the tier', () => {
    const [pool] = readSettings(env({ candidates: '- runs-on: a\n  enabled: "false"\n- runs-on: b\n  enabled: ""\n- runs-on: c\n  enabled:' })).pools;
    expect(pool?.tiers.map((tier) => tier.enabled)).toEqual([false, true, true, true]);
  });

  test('empty labels from an unset variable leave an empty tier', () => {
    const [pool] = readSettings(env({ candidates: '- labels: ""\n- ubuntu-latest' })).pools;
    expect(pool?.tiers[0]).toMatchObject({ kind: 'self-hosted', labels: [], name: 'self-hosted (unset)' });
  });

  test('pools, candidates and labels are mutually exclusive', () => {
    expect(() => readSettings(env({ candidates: '- ubuntu-latest', labels: 'self-hosted' }))).toThrow('use one of pools, candidates or labels/group');
  });

  test('unknown tier keys and bad pool names are rejected', () => {
    expect(() => readSettings(env({ candidates: '- labels: x\n  min_idle: 2' }))).toThrow();
    expect(() => readSettings(env({ pools: 'bad name:\n  - ubuntu-latest' }))).toThrow('pool name "bad name"');
  });
});

describe('config sources', () => {
  test('precedence: input > config > config-file > default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'select-runner-config-'));
    writeFileSync(join(dir, 'runners.yml'), 'fallback: from-file\nmin-idle: 3\nretries: 5\n');
    const settings = readSettings(env({ 'config-file': 'runners.yml', config: 'min-idle: 2\nretries: 4\n', retries: '1' }, { GITHUB_WORKSPACE: dir }));
    expect(settings.pools[0]?.tiers.at(-1)).toMatchObject({ runsOn: 'from-file' });
    expect(settings.minIdle).toBe(2);
    expect(settings.retries).toBe(1);
  });

  test('config can hold pools (e.g. one org variable for every repository)', () => {
    const settings = readSettings(env({ config: 'pools:\n  test:\n    - labels: self-hosted\n    - ubuntu-latest\nmin-idle: 2' }));
    expect(settings.pools[0]?.name).toBe('test');
    expect(settings.minIdle).toBe(2);
  });

  test('config-file may not relax the untrusted guard or redirect the API', () => {
    const dir = mkdtempSync(join(tmpdir(), 'select-runner-config-'));
    writeFileSync(join(dir, 'evil.yml'), 'untrusted: allow\ngithub-api-url: https://attacker.example\n');
    expect(() => readSettings(env({ 'config-file': 'evil.yml' }, { GITHUB_WORKSPACE: dir }))).toThrow('may not set untrusted, github-api-url');
  });

  test('untrusted runs ignore config-file entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'select-runner-config-'));
    writeFileSync(join(dir, 'runners.yml'), 'candidates:\n  - runs-on: [self-hosted, linux]\n');
    const settings = readSettings(env({ 'config-file': 'runners.yml' }, { GITHUB_WORKSPACE: dir }), { trustWorkspace: false });
    expect(settings.pools[0]?.tiers).toEqual([{ kind: 'runs-on', name: 'fallback', runsOn: 'ubuntu-latest', enabled: true }]);
  });

  test('a missing config-file is an error; unknown config keys are rejected', () => {
    expect(() => readSettings(env({ 'config-file': 'nope.yml' }, { GITHUB_WORKSPACE: tmpdir() }))).toThrow('config-file nope.yml not found');
    expect(() => readSettings(env({ config: 'labelz: x' }))).toThrow();
    expect(() => readSettings(env({ config: '- a' }))).toThrow('mapping');
  });
});
