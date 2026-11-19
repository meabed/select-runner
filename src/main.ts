// Select Runner action entry: list runners, decide, write outputs + job summary.
// Any failure (credentials, network, API) selects the fallback with a warning unless
// fail-on-error is set, so CI never queues against a runner that may not exist.
import { appendFileSync } from 'node:fs';

import type { Config, RunsOn } from './config';
import type { Decision } from './select';

import { readConfig } from './config';
import { findRunnerGroupId, listRunners, mintInstallationToken, revokeInstallationToken } from './github';
import { fallbackDecision, selectRunner, selfHostedRunsOn } from './select';

function setOutput(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return console.log(`${name}=${value}`);
  const delimiter = `select_runner_${crypto.randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function describe(runsOn: RunsOn) {
  return typeof runsOn === 'string' ? runsOn : JSON.stringify(runsOn);
}

function writeSummary(config: Config, decision: Decision) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!config.summary || !file) return;
  const rows = [
    ['Selected', decision.selfHosted ? 'self-hosted' : 'fallback'],
    ['runs-on', `\`${describe(decision.runsOn)}\``],
    ['Self-hosted target', `\`${describe(selfHostedRunsOn(config))}\` (${config.scope} ${config.scope === 'org' ? config.owner : config.repository})`],
    ['Matching runners', `${decision.idle} idle / ${decision.online} online`],
    ['Reason', decision.reason],
  ];
  appendFileSync(file, `### Runner selection\n\n| | |\n| --- | --- |\n${rows.map(([key, value]) => `| ${key} | ${value} |`).join('\n')}\n\n`);
}

async function decide(config: Config): Promise<Decision> {
  if (config.force !== 'auto') return selectRunner({ ...config, runners: [] });

  const useApp = Boolean(config.appClientId && config.appPrivateKey);
  const token = useApp ? await mintInstallationToken(config) : config.token;
  if (!token) throw new Error('no credentials: set app-client-id + app-private-key, or token');
  console.log(`::add-mask::${token}`);
  try {
    const groupId = config.group && config.scope === 'org' ? await findRunnerGroupId(config, token, config.group) : undefined;
    return selectRunner({ ...config, runners: await listRunners(config, token), groupId });
  } finally {
    if (useApp) await revokeInstallationToken(config, token).catch(() => undefined);
  }
}

async function run() {
  const config = readConfig();
  const decision = await decide(config).catch((error: Error) => {
    if (config.failOnError) throw error;
    console.log(`::warning title=select-runner::${error.message} — using the fallback runner`);
    return fallbackDecision(config, `fallback: ${error.message}`);
  });

  console.log(`${decision.reason} → runs-on: ${describe(decision.runsOn)}`);
  setOutput('runs-on', JSON.stringify(decision.runsOn));
  setOutput('self-hosted', String(decision.selfHosted));
  setOutput('idle', String(decision.idle));
  setOutput('online', String(decision.online));
  setOutput('reason', decision.reason);
  writeSummary(config, decision);
}

await run().catch((error: Error) => {
  console.log(`::error title=select-runner::${error.message}`);
  process.exitCode = 1;
});
