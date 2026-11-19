import { describe, expect, test } from 'bun:test';

import type { Pool, Tier } from '../src/config';
import type { Runner } from '../src/github';
import type { SelectOptions } from '../src/select';

import { countRunners, matchesLabels, needsRunnerList, selectPool } from '../src/select';

function runner(name: string, labels: string[], status: Runner['status'] = 'online', busy = false, group = 'Default'): Runner {
  return { id: name.length, name, status, busy, labels: labels.map((label) => ({ name: label })), group, scope: 'org' };
}

const selfHosted = (labels: string[], extra: Partial<Extract<Tier, { kind: 'self-hosted' }>> = {}): Tier => ({ kind: 'self-hosted', name: labels.join(', '), labels, group: '', enabled: true, ...extra });
const runsOn = (value: string, enabled = true): Tier => ({ kind: 'runs-on', name: value, runsOn: value, enabled });
const pool = (...tiers: Tier[]): Pool => ({ name: 'default', tiers: [...tiers, { kind: 'runs-on', name: 'fallback', runsOn: 'ubuntu-latest', enabled: true }] });
const auto: SelectOptions = { minIdle: 1, match: 'idle', force: 'auto' };

describe('matching and counting', () => {
  test('labels match case-insensitively and must all be present', () => {
    const gpu = runner('gpu-1', ['self-hosted', 'Linux', 'GPU']);
    expect(matchesLabels(gpu, ['SELF-HOSTED', 'gpu'])).toBe(true);
    expect(matchesLabels(gpu, ['self-hosted', 'arm64'])).toBe(false);
  });

  test('counts idle, online, busy and registered; filters by group', () => {
    const runners = [runner('a', ['x']), runner('b', ['x'], 'online', true), runner('c', ['x'], 'offline'), runner('d', ['y']), runner('e', ['x'], 'online', false, 'gpu-farm')];
    expect(countRunners(runners, selfHosted(['x']) as Extract<Tier, { kind: 'self-hosted' }>)).toEqual({ idle: 2, online: 3, busy: 1, registered: 4, idleRunners: ['a', 'e'] });
    expect(countRunners(runners, selfHosted(['x'], { group: 'GPU-farm' }) as Extract<Tier, { kind: 'self-hosted' }>)).toMatchObject({ idle: 1, registered: 1 });
  });
});

describe('selectPool chain', () => {
  test('first tier with capacity wins', () => {
    const decision = selectPool(pool(selfHosted(['a']), selfHosted(['b']), runsOn('blacksmith')), [runner('b1', ['b'])], auto);
    expect(decision).toMatchObject({ selfHosted: true, runsOn: ['b'], index: 1, name: 'b', overflowed: true });
    expect(decision.reason).toBe('b: 1 idle (need 1) — passed over a (0 idle, need 1)');
  });

  test('busy self-hosted overflows to the next runs-on tier', () => {
    const decision = selectPool(pool(selfHosted(['a']), runsOn('blacksmith'), runsOn('ubuntu-24.04')), [runner('a1', ['a'], 'online', true)], auto);
    expect(decision).toMatchObject({ selfHosted: false, runsOn: 'blacksmith', index: 1, overflowed: true, counts: { idle: 0, online: 1, busy: 1 } });
  });

  test('disabled and empty tiers are skipped (multi-level fallback)', () => {
    const decision = selectPool(pool(selfHosted([], { name: 'self-hosted (unset)' }), runsOn('blacksmith', false), runsOn('ubuntu-24.04')), [], auto);
    expect(decision).toMatchObject({ runsOn: 'ubuntu-24.04', index: 2, overflowed: false });
    expect(decision.reason).toBe('ubuntu-24.04 — passed over self-hosted (unset); blacksmith (disabled)');
  });

  test('the trail records every tier', () => {
    const decision = selectPool(pool(selfHosted(['a']), runsOn('blacksmith', false), runsOn('ubuntu-24.04'), runsOn('macos-15')), [runner('a1', ['a'], 'online', true)], auto);
    expect(decision.trail.map((tier) => tier.status)).toEqual(['no-capacity', 'disabled', 'chosen', 'not-reached', 'not-reached']);
    expect(decision.trail[0]?.counts).toMatchObject({ busy: 1 });
  });

  test('the fallback closes every chain', () => {
    expect(selectPool(pool(selfHosted(['a'])), [], auto)).toMatchObject({ runsOn: 'ubuntu-latest', name: 'fallback' });
  });

  test('per-tier min-idle and match override the defaults', () => {
    const runners = [runner('a1', ['a']), runner('a2', ['a'], 'online', true)];
    expect(selectPool(pool(selfHosted(['a'], { minIdle: 2 })), runners, auto).selfHosted).toBe(false);
    expect(selectPool(pool(selfHosted(['a'], { minIdle: 2, match: 'online' })), runners, auto).selfHosted).toBe(true);
    expect(selectPool(pool(selfHosted(['a'])), runners, { ...auto, minIdle: 2 }).selfHosted).toBe(false);
  });

  test('group tiers produce a { group, labels } runs-on', () => {
    const decision = selectPool(pool(selfHosted(['x64'], { group: 'farm' })), [runner('f1', ['x64'], 'online', false, 'farm')], auto);
    expect(decision.runsOn).toEqual({ group: 'farm', labels: ['x64'] });
  });

  test('force picks the first enabled tier of the wanted kind', () => {
    const chain = pool(selfHosted(['a']), runsOn('blacksmith', false), runsOn('ubuntu-24.04'));
    expect(selectPool(chain, [], { ...auto, force: 'self-hosted' })).toMatchObject({ runsOn: ['a'], reason: 'forced to self-hosted' });
    expect(selectPool(chain, [runner('a1', ['a'])], { ...auto, force: 'fallback' })).toMatchObject({ runsOn: 'ubuntu-24.04', reason: 'forced to fallback' });
  });

  test('untrusted runs go to the first runs-on tier', () => {
    const decision = selectPool(pool(selfHosted(['a'])), [runner('a1', ['a'])], { ...auto, untrustedReason: 'pull request from fork x/y' });
    expect(decision).toMatchObject({ selfHosted: false, runsOn: 'ubuntu-latest', reason: 'untrusted run (pull request from fork x/y)' });
  });

  test('a chain with nothing usable is an error', () => {
    const chain: Pool = { name: 'p', tiers: [selfHosted(['a']), { kind: 'runs-on', name: 'fallback', runsOn: null, enabled: true }] };
    expect(() => selectPool(chain, [], auto)).toThrow('pool p: no tier can take the job');
    expect(() => selectPool(chain, [], { ...auto, force: 'fallback' })).toThrow('no enabled runs-on tier');
  });
});

describe('needsRunnerList', () => {
  test('only when some enabled self-hosted tier exists and nothing is forced', () => {
    expect(needsRunnerList([pool(selfHosted(['a']))], auto)).toBe(true);
    expect(needsRunnerList([pool(selfHosted([]))], auto)).toBe(false);
    expect(needsRunnerList([pool(selfHosted(['a'], { enabled: false }))], auto)).toBe(false);
    expect(needsRunnerList([pool(selfHosted(['a']))], { force: 'fallback' })).toBe(false);
    expect(needsRunnerList([pool(selfHosted(['a']))], { force: 'auto', untrustedReason: 'fork' })).toBe(false);
  });
});
