// Pure selection logic: which runners match, how many are available, and the runs-on value.
import type { Config, RunsOn } from './config';

export type Runner = {
  id: number;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: { name: string }[];
  runner_group_id?: number;
};

export type Decision = {
  selfHosted: boolean;
  runsOn: RunsOn;
  idle: number;
  online: number;
  reason: string;
};

type SelectInput = Pick<Config, 'labels' | 'group' | 'fallback' | 'minIdle' | 'match' | 'force'> & {
  runners: Runner[];
  // Resolved id of `group` (org scope); undefined means "don't filter by group".
  groupId?: number;
};

export function selfHostedRunsOn({ labels, group }: Pick<Config, 'labels' | 'group'>): RunsOn {
  if (group) return labels.length ? { group, labels } : { group };
  return labels;
}

// GitHub matches runs-on labels case-insensitively; a runner must carry every label.
export function matchesLabels(runner: Runner, labels: string[]) {
  const have = new Set(runner.labels.map((label) => label.name.toLowerCase()));
  return labels.every((label) => have.has(label.toLowerCase()));
}

export function countRunners(runners: Runner[], labels: string[], groupId?: number) {
  const matching = runners.filter((runner) => matchesLabels(runner, labels) && (groupId === undefined || runner.runner_group_id === groupId));
  const online = matching.filter((runner) => runner.status === 'online');
  return { online: online.length, idle: online.filter((runner) => !runner.busy).length };
}

export function selectRunner(input: SelectInput): Decision {
  const { idle, online } = countRunners(input.runners, input.labels, input.groupId);
  const target = selfHostedRunsOn(input);
  if (input.force === 'self-hosted') return { selfHosted: true, runsOn: target, idle, online, reason: 'forced to self-hosted' };
  if (input.force === 'fallback') return { selfHosted: false, runsOn: input.fallback, idle, online, reason: 'forced to fallback' };

  const available = input.match === 'idle' ? idle : online;
  const counted = `${available} ${input.match} (need ${input.minIdle})`;
  return available >= input.minIdle ? { selfHosted: true, runsOn: target, idle, online, reason: `self-hosted: ${counted}` } : { selfHosted: false, runsOn: input.fallback, idle, online, reason: `fallback: ${counted}` };
}

export function fallbackDecision(input: Pick<Config, 'fallback'>, reason: string): Decision {
  return { selfHosted: false, runsOn: input.fallback, idle: 0, online: 0, reason };
}
