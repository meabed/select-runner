// Pure selection: walk a pool's tiers in order and pick the first that can take the job.
import type { Force, Match, Pool, RunsOn, Tier } from './config';
import type { Runner } from './github';

export type Counts = { idle: number; online: number; busy: number; registered: number; idleRunners: string[] };

export type Decision = {
  pool: string;
  selfHosted: boolean;
  runsOn: RunsOn;
  index: number;
  name: string;
  reason: string;
  // Counts of the chosen self-hosted tier, else of the first self-hosted tier that was checked.
  counts: Counts;
  // True when an enabled self-hosted tier was passed over for lack of capacity (worth waiting for).
  overflowed: boolean;
};

export type SelectOptions = { minIdle: number; match: Match; force: Force; untrustedReason?: string };

type SelfHostedTier = Extract<Tier, { kind: 'self-hosted' }>;

const EMPTY_COUNTS: Counts = { idle: 0, online: 0, busy: 0, registered: 0, idleRunners: [] };

// GitHub matches runs-on labels case-insensitively; a runner must carry every label.
export function matchesLabels(runner: Runner, labels: string[]) {
  const have = new Set(runner.labels.map((label) => label.name.toLowerCase()));
  return labels.every((label) => have.has(label.toLowerCase()));
}

export function countRunners(runners: Runner[], tier: SelfHostedTier): Counts {
  const matching = runners.filter((runner) => matchesLabels(runner, tier.labels) && (!tier.group || runner.group?.toLowerCase() === tier.group.toLowerCase()));
  const online = matching.filter((runner) => runner.status === 'online');
  const idle = online.filter((runner) => !runner.busy);
  return { idle: idle.length, online: online.length, busy: online.length - idle.length, registered: matching.length, idleRunners: idle.map((runner) => runner.name) };
}

export function selfHostedRunsOn(tier: SelfHostedTier): RunsOn {
  if (tier.group) return tier.labels.length ? { group: tier.group, labels: tier.labels } : { group: tier.group };
  return tier.labels;
}

function usable(tier: Tier) {
  return tier.enabled && (tier.kind === 'runs-on' ? tier.runsOn !== null : Boolean(tier.labels.length || tier.group));
}

export function selectPool(pool: Pool, runners: Runner[], options: SelectOptions): Decision {
  const skipped: string[] = [];
  let firstCounts: Counts | undefined;
  let overflowed = false;
  const decide = (index: number, reason: string, tierCounts?: Counts): Decision => {
    const tier = pool.tiers[index]!;
    const runsOn = tier.kind === 'self-hosted' ? selfHostedRunsOn(tier) : tier.runsOn!;
    const passed = skipped.length ? ` — passed over ${skipped.join('; ')}` : '';
    return { pool: pool.name, selfHosted: tier.kind === 'self-hosted', runsOn, index, name: tier.name, reason: `${reason}${passed}`, counts: tierCounts ?? firstCounts ?? EMPTY_COUNTS, overflowed };
  };

  // Forced or untrusted runs never look at runner availability.
  const forced = options.untrustedReason ? 'fallback' : options.force;
  if (forced !== 'auto') {
    const wanted = forced === 'self-hosted' ? 'self-hosted' : 'runs-on';
    const index = pool.tiers.findIndex((tier) => tier.kind === wanted && usable(tier));
    const why = options.untrustedReason ? `untrusted run (${options.untrustedReason})` : `forced to ${forced}`;
    if (index < 0) throw new Error(`pool ${pool.name}: ${why}, but it has no enabled ${wanted} tier`);
    return decide(index, why);
  }

  for (const [index, tier] of pool.tiers.entries()) {
    if (!usable(tier)) {
      skipped.push(tier.enabled ? tier.name : `${tier.name} (disabled)`);
      continue;
    }
    if (tier.kind === 'runs-on') return decide(index, tier.name);
    const counts = countRunners(runners, tier);
    firstCounts ??= counts;
    const match = tier.match ?? options.match;
    const minIdle = tier.minIdle ?? options.minIdle;
    const available = match === 'idle' ? counts.idle : counts.online;
    if (available >= minIdle) return decide(index, `${tier.name}: ${available} ${match} (need ${minIdle})`, counts);
    overflowed = true;
    skipped.push(`${tier.name} (${available} ${match}, need ${minIdle})`);
  }
  throw new Error(`pool ${pool.name}: no tier can take the job — ${skipped.join('; ')}`);
}

// Whether any self-hosted tier needs the runner list (else no credentials or API calls).
export function needsRunnerList(pools: Pool[], options: Pick<SelectOptions, 'force' | 'untrustedReason'>) {
  if (options.untrustedReason || options.force !== 'auto') return false;
  return pools.some((pool) => pool.tiers.some((tier) => tier.kind === 'self-hosted' && usable(tier)));
}
