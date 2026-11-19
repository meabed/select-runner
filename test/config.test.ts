import { describe, expect, test } from 'bun:test';

import { parseList, parseRunsOn, readConfig } from '../src/config';

const env = (inputs: Record<string, string>) => ({
  GITHUB_REPOSITORY: 'acme/app',
  GITHUB_REPOSITORY_OWNER: 'acme',
  ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
});

describe('parseList', () => {
  test('splits commas and newlines, trims, drops empties', () => {
    expect(parseList(' self-hosted , linux-arm64\ngpu,, ')).toEqual(['self-hosted', 'linux-arm64', 'gpu']);
  });
});

describe('parseRunsOn', () => {
  test('single label stays a string', () => {
    expect(parseRunsOn('ubuntu-latest')).toBe('ubuntu-latest');
  });

  test('comma list becomes an array', () => {
    expect(parseRunsOn('self-hosted, linux')).toEqual(['self-hosted', 'linux']);
  });

  test('JSON string, array and group object', () => {
    expect(parseRunsOn('"ubuntu-latest"')).toBe('ubuntu-latest');
    expect(parseRunsOn('["a","b"]')).toEqual(['a', 'b']);
    expect(parseRunsOn('{"group":"larger","labels":["x"]}')).toEqual({ group: 'larger', labels: ['x'] });
  });

  test('rejects invalid values', () => {
    expect(() => parseRunsOn('[]')).toThrow();
    expect(() => parseRunsOn('{"labels":["x"]}')).toThrow();
    expect(() => parseRunsOn(' , ')).toThrow();
  });
});

describe('readConfig', () => {
  test('defaults', () => {
    const config = readConfig(env({ labels: 'self-hosted' }));
    expect(config).toMatchObject({
      labels: ['self-hosted'],
      fallback: 'ubuntu-latest',
      minIdle: 1,
      match: 'idle',
      force: 'auto',
      scope: 'org',
      owner: 'acme',
      repository: 'acme/app',
      failOnError: false,
      summary: true,
      apiUrl: 'https://api.github.com',
    });
  });

  test('reads dashed inputs and restores escaped key newlines', () => {
    const config = readConfig(env({ labels: 'self-hosted', 'app-client-id': 'Iv1.example', 'app-private-key': String.raw`-----BEGIN KEY-----\nabc\n-----END KEY-----`, 'min-idle': '2' }));
    expect(config.appClientId).toBe('Iv1.example');
    expect(config.appPrivateKey).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----');
    expect(config.minIdle).toBe(2);
  });

  test('empty force/match fall back to defaults; invalid values throw', () => {
    expect(readConfig(env({ labels: 'self-hosted', force: '' })).force).toBe('auto');
    expect(() => readConfig(env({ labels: 'self-hosted', force: 'yes' }))).toThrow('force must be one of');
    expect(() => readConfig(env({ labels: 'self-hosted', match: 'busy' }))).toThrow('match must be one of');
    expect(() => readConfig(env({ labels: 'self-hosted', 'min-idle': '0' }))).toThrow('min-idle');
    expect(readConfig(env({ labels: '' })).labels).toEqual([]);
  });

  test('group alone is enough', () => {
    expect(readConfig(env({ labels: '', group: 'my-runners' })).group).toBe('my-runners');
  });
});
