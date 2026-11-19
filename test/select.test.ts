import { describe, expect, test } from 'bun:test';

import type { Runner } from '../src/select';

import { countRunners, matchesLabels, selectRunner } from '../src/select';

function runner(name: string, labels: string[], status: Runner['status'] = 'online', busy = false, groupId = 1): Runner {
  return { id: name.length, name, status, busy, labels: labels.map((label) => ({ name: label })), runner_group_id: groupId };
}

const base: Omit<Parameters<typeof selectRunner>[0], 'runners'> = { labels: ['self-hosted'], group: '', fallback: 'ubuntu-latest', minIdle: 1, match: 'idle', force: 'auto' };

describe('matchesLabels', () => {
  test('requires every label, case-insensitively', () => {
    const gpuRunner = runner('runner-1', ['self-hosted', 'linux-arm64', 'GPU']);
    expect(matchesLabels(gpuRunner, ['SELF-HOSTED', 'gpu'])).toBe(true);
    expect(matchesLabels(gpuRunner, ['self-hosted', 'linux-x64'])).toBe(false);
  });
});

describe('countRunners', () => {
  test('counts online and idle matching runners, filtered by group', () => {
    const runners = [runner('a', ['self-hosted']), runner('b', ['self-hosted'], 'online', true), runner('c', ['self-hosted'], 'offline'), runner('d', ['windows']), runner('e', ['self-hosted'], 'online', false, 2)];
    expect(countRunners(runners, ['self-hosted'])).toEqual({ online: 3, idle: 2 });
    expect(countRunners(runners, ['self-hosted'], 1)).toEqual({ online: 2, idle: 1 });
  });
});

describe('selectRunner', () => {
  test('selects the labels when enough runners are idle', () => {
    const decision = selectRunner({ ...base, runners: [runner('a', ['self-hosted'])] });
    expect(decision).toMatchObject({ selfHosted: true, runsOn: ['self-hosted'], idle: 1, online: 1 });
  });

  test('falls back when every matching runner is busy (idle mode)', () => {
    const decision = selectRunner({ ...base, runners: [runner('a', ['self-hosted'], 'online', true)] });
    expect(decision).toMatchObject({ selfHosted: false, runsOn: 'ubuntu-latest', idle: 0, online: 1 });
  });

  test('online mode counts busy runners', () => {
    const decision = selectRunner({ ...base, match: 'online', runners: [runner('a', ['self-hosted'], 'online', true)] });
    expect(decision.selfHosted).toBe(true);
  });

  test('offline runners never count', () => {
    expect(selectRunner({ ...base, runners: [runner('a', ['self-hosted'], 'offline')] }).selfHosted).toBe(false);
  });

  test('min-idle keeps headroom', () => {
    const runners = [runner('a', ['self-hosted']), runner('b', ['self-hosted'])];
    expect(selectRunner({ ...base, minIdle: 3, runners }).selfHosted).toBe(false);
    expect(selectRunner({ ...base, minIdle: 2, runners }).selfHosted).toBe(true);
  });

  test('force overrides availability', () => {
    expect(selectRunner({ ...base, force: 'self-hosted', runners: [] })).toMatchObject({ selfHosted: true, reason: 'forced to self-hosted' });
    expect(selectRunner({ ...base, force: 'fallback', runners: [runner('a', ['self-hosted'])] })).toMatchObject({ selfHosted: false, runsOn: 'ubuntu-latest' });
  });

  test('group produces a { group, labels } runs-on and filters by group id', () => {
    const runners = [runner('a', ['self-hosted'], 'online', false, 2)];
    expect(selectRunner({ ...base, group: 'Default', groupId: 1, runners }).selfHosted).toBe(false);
    expect(selectRunner({ ...base, group: 'Default', groupId: 2, runners }).runsOn).toEqual({ group: 'Default', labels: ['self-hosted'] });
  });

  test('fallback can be an array or a group object', () => {
    const fallback = { group: 'larger', labels: ['ubuntu-24.04-arm64-4-cores'] };
    expect(selectRunner({ ...base, fallback, runners: [] }).runsOn).toEqual(fallback);
  });
});
