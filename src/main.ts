// select-runner entry: resolve settings, list runners once, pick a tier per pool, then
// write outputs, annotations and the job summary. API or credential failures select each
// pool's first runs-on tier with a warning unless fail-on-error is set.
import { appendFileSync } from 'node:fs';

import type { Pool, RunsOn, Scope, Settings } from './config';
import type { RunContext } from './context';
import type { ApiOptions } from './github';
import type { Decision, SelectOptions } from './select';

import { readSettings } from './config';
import { readContext } from './context';
import { listRunners, mintInstallationToken, revokeInstallationToken, withoutDeprecatedRunners } from './github';
import { needsRunnerList, selectPool } from './select';

type Outcome = {
  decisions: Decision[];
  notes: string[];
  auth: 'GitHub App' | 'token' | 'none';
  scopes: Scope[];
  requests: number;
  polls: number;
};

function setOutput(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return console.log(`${name}=${value}`);
  const delimiter = `select_runner_${crypto.randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function describe(runsOn: RunsOn) {
  return typeof runsOn === 'string' ? runsOn : JSON.stringify(runsOn);
}

function labelsOf(runsOn: RunsOn) {
  return typeof runsOn === 'string' ? runsOn : Array.isArray(runsOn) ? runsOn.join(',') : (runsOn.labels ?? []).join(',');
}

function resolveScopes(settings: Settings, context: RunContext): Scope[] {
  if (settings.scopes !== 'auto') return settings.scopes;
  // Personal accounts have no organization runners.
  return [context.ownerType === 'User' ? 'repo' : 'org'];
}

async function selectWithRunners(settings: Settings, context: RunContext, options: SelectOptions): Promise<Outcome> {
  const stats = { requests: 0 };
  const api: ApiOptions = { apiUrl: settings.apiUrl, timeoutSeconds: settings.timeoutSeconds, retries: settings.retries, log: (message) => console.log(message), stats };
  const scopes = resolveScopes(settings, context);
  const useApp = Boolean(settings.appClientId && settings.appPrivateKey);
  const token = useApp ? await mintInstallationToken(api, settings, scopes) : settings.token;
  if (!token) throw new Error('no credentials: set app-client-id + app-private-key, or token');
  console.log(`::add-mask::${token}`);
  try {
    const deadline = Date.now() + settings.waitSeconds * 1000;
    for (let polls = 1; ; polls++) {
      const listed = await listRunners(api, settings, context, scopes, token);
      const checked = settings.skipDeprecated ? await withoutDeprecatedRunners(api, settings, listed.runners, token) : { runners: listed.runners, deprecated: [] };
      const notes = [...listed.excludedGroups.map((group) => `runner group not usable here: ${group}`), ...checked.deprecated.map((runner) => `runner skipped, version deprecated: ${runner}`)];
      const decisions = settings.pools.map((pool) => selectPool(pool, checked.runners, options));
      const waiting = decisions.filter((decision) => decision.overflowed && !decision.selfHosted);
      if (!waiting.length || Date.now() + settings.pollSeconds * 1000 > deadline) return { decisions, notes, auth: useApp ? 'GitHub App' : 'token', scopes, requests: stats.requests, polls };
      console.log(`waiting ${settings.pollSeconds}s for self-hosted capacity (${waiting.map((decision) => decision.pool).join(', ')}), until ${new Date(deadline).toISOString()}`);
      await new Promise((resolve) => setTimeout(resolve, settings.pollSeconds * 1000));
    }
  } finally {
    if (useApp) await revokeInstallationToken(api, token).catch(() => undefined);
  }
}

function fallbackOnError(pools: Pool[], options: SelectOptions, error: Error): Outcome {
  const decisions = pools.map((pool) => {
    const decision = selectPool(pool, [], { ...options, force: 'fallback', untrustedReason: '' });
    return { ...decision, reason: `${decision.name} (runner check failed: ${error.message})` };
  });
  return { decisions, notes: [`runner check failed: ${error.message}`], auth: 'none', scopes: [], requests: 0, polls: 0 };
}

// Outputs every pool gets (flat as <pool>-<key> in pools mode); the first pool also fills the plain keys.
function poolOutputs(decision: Decision) {
  return {
    'runs-on': JSON.stringify(decision.runsOn),
    'self-hosted': String(decision.selfHosted),
    index: String(decision.index),
    name: decision.name,
    reason: decision.reason,
  };
}

function writeOutputs(decisions: Decision[]) {
  const [first] = decisions;
  if (!first) return;
  const outputs: Record<string, string> = {
    ...poolOutputs(first),
    labels: labelsOf(first.runsOn),
    idle: String(first.counts.idle),
    online: String(first.counts.online),
    busy: String(first.counts.busy),
    registered: String(first.counts.registered),
    runners: JSON.stringify(first.counts.idleRunners),
    selections: JSON.stringify(Object.fromEntries(decisions.map((decision) => [decision.pool, { 'runs-on': decision.runsOn, 'self-hosted': decision.selfHosted, index: decision.index, name: decision.name, reason: decision.reason }]))),
  };
  for (const decision of decisions.filter((candidate) => candidate.pool !== 'default')) {
    for (const [key, value] of Object.entries(poolOutputs(decision))) outputs[`${decision.pool}-${key}`] = value;
  }
  for (const [name, value] of Object.entries(outputs)) setOutput(name, value);
}

const STATUS_LABEL = { chosen: '✅ chosen', 'no-capacity': '⛔ no capacity', disabled: '⏭️ disabled', unset: '⏭️ unset', 'not-reached': '· not reached' } as const;

function capacity(counts: Decision['counts'] | undefined) {
  return counts ? `${counts.idle} / ${counts.online} / ${counts.busy} / ${counts.registered}` : '';
}

function writeSummary(settings: Settings, context: RunContext, outcome: Outcome, elapsedMs: number) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!settings.summary || !file) return;
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const code = (value: string) => `\`${cell(value)}\``;
  const lines = ['### 🏃 Runner selection', '', '| Pool | Runs on | Tier | Self-hosted | Reason |', '| --- | --- | --- | --- | --- |'];
  for (const decision of outcome.decisions) {
    lines.push(`| **${decision.pool}** | ${code(describe(decision.runsOn))} | ${cell(decision.name)} (#${decision.index}) | ${decision.selfHosted ? '✅' : '—'} | ${cell(decision.reason)} |`);
  }
  for (const decision of outcome.decisions) {
    lines.push('', `<details><summary><b>${decision.pool}</b> — fallback chain</summary>`, '');
    lines.push('| # | Tier | Type | Status | Idle / online / busy / registered | Idle runners |', '| --- | --- | --- | --- | --- | --- |');
    for (const tier of decision.trail) {
      const runners = tier.counts?.idleRunners.length ? tier.counts.idleRunners.slice(0, 10).map(code).join(' ') + (tier.counts.idleRunners.length > 10 ? ' …' : '') : '';
      lines.push(`| ${tier.index} | ${cell(tier.name)} | ${tier.kind} | ${STATUS_LABEL[tier.status]} | ${capacity(tier.counts)} | ${runners} |`);
    }
    lines.push('', '</details>');
  }
  const facts = [
    ['Credentials', outcome.auth === 'none' ? 'none (no runner check needed)' : outcome.auth === 'GitHub App' ? 'GitHub App (read-only installation token, revoked)' : 'token'],
    ['Scopes', outcome.scopes.join(', ') || '—'],
    ['Event', `${context.eventName || 'unknown'} by ${context.actor || 'unknown'}`],
    ['Untrusted guard', context.untrustedReason ? `${settings.untrusted === 'fallback' ? 'applied' : 'allowed by untrusted: allow'} — ${context.untrustedReason}` : 'trusted run'],
    ['Force', settings.force],
    ['Checks', `${outcome.polls} listing(s), ${outcome.requests} API request(s), ${(elapsedMs / 1000).toFixed(1)}s`],
  ];
  lines.push('', '<details><summary>Run details</summary>', '', '| | |', '| --- | --- |', ...facts.map(([key, value]) => `| ${key} | ${cell(value ?? '')} |`));
  if (outcome.notes.length) lines.push('', ...outcome.notes.map((note) => `- ${cell(note)}`));
  lines.push('', '</details>', '');
  appendFileSync(file, `${lines.join('\n')}\n`);
}

// Workflow command data must not carry raw %, CR or LF (a newline would start a new command).
function commandData(value: string) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

async function run() {
  const startedAt = Date.now();
  const context = readContext();
  const settings = readSettings(process.env, { trustWorkspace: !context.untrustedReason });
  const options: SelectOptions = {
    minIdle: settings.minIdle,
    match: settings.match,
    force: settings.force,
    untrustedReason: settings.untrusted === 'fallback' ? context.untrustedReason : '',
  };

  const outcome = needsRunnerList(settings.pools, options)
    ? await selectWithRunners(settings, context, options).catch((error: Error) => {
        if (settings.failOnError) throw error;
        console.log(`::warning title=select-runner::${commandData(`${error.message} — using each pool's fallback`)}`);
        return fallbackOnError(settings.pools, options, error);
      })
    : { decisions: settings.pools.map((pool) => selectPool(pool, [], options)), notes: [], auth: 'none' as const, scopes: [], requests: 0, polls: 0 };

  for (const decision of outcome.decisions) {
    console.log(`[${decision.pool}] ${decision.reason} → runs-on: ${describe(decision.runsOn)}`);
    if (decision.overflowed && !decision.selfHosted && settings.annotate !== 'none') console.log(`::${settings.annotate} title=select-runner (${decision.pool})::${commandData(decision.reason)}`);
  }
  for (const note of outcome.notes) console.log(note);
  writeOutputs(outcome.decisions);
  writeSummary(settings, context, outcome, Date.now() - startedAt);
}

await run().catch((error: Error) => {
  console.log(`::error title=select-runner::${commandData(error.message)}`);
  process.exitCode = 1;
});
