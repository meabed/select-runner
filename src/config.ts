// Settings resolution. Sources, lowest to highest precedence:
//   built-in defaults < config-file (YAML in the workspace) < config (YAML string,
//   e.g. an org variable) < individual inputs.
// action.yml declares no input defaults, so an empty input always means "not set".
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export type RunsOn = string | string[] | { group: string; labels?: string[] };
export type Match = 'idle' | 'online';
export type Force = 'auto' | 'self-hosted' | 'fallback';
export type Scope = 'org' | 'repo' | 'enterprise';

// A self-hosted tier is checked against the runner list; a runs-on tier (GitHub-hosted,
// larger runners, any provider) is taken as always available.
export type Tier = { kind: 'self-hosted'; name: string; labels: string[]; group: string; minIdle?: number; match?: Match; enabled: boolean } | { kind: 'runs-on'; name: string; runsOn: RunsOn | null; enabled: boolean };

export type Pool = { name: string; tiers: Tier[] };

export type Settings = {
  pools: Pool[];
  minIdle: number;
  match: Match;
  force: Force;
  scopes: Scope[] | 'auto';
  owner: string;
  repository: string;
  enterprise: string;
  untrusted: 'fallback' | 'allow';
  waitSeconds: number;
  pollSeconds: number;
  timeoutSeconds: number;
  retries: number;
  skipDeprecated: boolean;
  annotate: 'notice' | 'warning' | 'none';
  summary: boolean;
  failOnError: boolean;
  appClientId: string;
  appPrivateKey: string;
  token: string;
  apiUrl: string;
};

export const DEFAULTS = {
  fallback: 'ubuntu-latest',
  minIdle: 1,
  match: 'idle',
  force: 'auto',
  scope: 'auto',
  untrusted: 'fallback',
  waitSeconds: 0,
  pollSeconds: 10,
  timeoutSeconds: 15,
  retries: 3,
  skipDeprecated: true,
  annotate: 'notice',
  summary: true,
  failOnError: false,
} as const;

// Inputs that may also come from `config` / `config-file`. Secrets stay inputs only.
const CONFIG_KEYS = [
  'pools',
  'candidates',
  'labels',
  'group',
  'fallback',
  'min-idle',
  'match',
  'force',
  'scope',
  'owner',
  'repository',
  'enterprise',
  'untrusted',
  'wait-seconds',
  'poll-seconds',
  'timeout-seconds',
  'retries',
  'skip-deprecated',
  'annotate',
  'summary',
  'fail-on-error',
  'app-client-id',
  'github-api-url',
] as const;

// YAML-valued inputs (structures); every other input is a plain string.
const STRUCTURED_INPUTS = new Set(['pools', 'candidates']);

export function readInput(name: string, env: NodeJS.ProcessEnv = process.env) {
  return (env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim();
}

export function parseList(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// A label, a comma/newline list, or JSON (string, string[], { group, labels }).
export function parseRunsOn(value: string): RunsOn | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^[[{"]/.test(text)) {
    const labels = parseList(text);
    return labels.length === 1 ? labels[0]! : labels;
  }
  return runsOnValue.parse(JSON.parse(text));
}

const runsOnValue = z.union([z.string().min(1), z.array(z.string().min(1)).min(1), z.strictObject({ group: z.string().min(1), labels: z.array(z.string().min(1)).optional() })]);

const runsOnField = z.union([z.string(), runsOnValue, z.null()]).transform((value) => (typeof value === 'string' ? parseRunsOn(value) : value));
const labelsField = z.union([z.string(), z.array(z.string()), z.null()]).transform((value) => (value === null ? [] : typeof value === 'string' ? parseList(value) : value.map((label) => label.trim()).filter(Boolean)));
const textField = z.union([z.string(), z.null()]).transform((value) => value?.trim() ?? '');
const intField = (min: number) =>
  z
    .union([z.number(), z.string().regex(/^\d+$/, 'must be a whole number')])
    .transform(Number)
    .pipe(z.number().int().min(min));
const boolField = z.union([z.boolean(), z.enum(['true', 'false'])]).transform((value) => value === true || value === 'true');
// Only an explicit false disables a tier; empty values (unset variables) keep it on.
const enabledField = z.union([z.boolean(), z.string(), z.null()]).transform((value) => value !== false && value !== 'false');
const scopeField = z.union([z.string(), z.array(z.string())]).transform((value, ctx) => {
  const scopes = typeof value === 'string' ? parseList(value) : value;
  if (scopes.length === 1 && scopes[0] === 'auto') return 'auto' as const;
  const invalid = scopes.filter((scope) => !['org', 'repo', 'enterprise'].includes(scope));
  if (!scopes.length || invalid.length) ctx.addIssue({ code: 'custom', message: `scope must be auto or a list of org, repo, enterprise (got "${scopes.join(', ')}")` });
  return [...new Set(scopes)] as Scope[];
});

const selfHostedTier = z.strictObject({
  labels: labelsField.optional(),
  group: textField.optional(),
  'min-idle': intField(1).optional(),
  match: z.enum(['idle', 'online']).optional(),
  enabled: enabledField.optional(),
  name: z.string().optional(),
});
const runsOnTier = z.strictObject({ 'runs-on': runsOnField, enabled: enabledField.optional(), name: z.string().optional() });

// A bare string is a runs-on tier: `- ubuntu-latest`.
const tierField = z.union([z.string(), z.null(), z.looseObject({})]).transform((value, ctx): Tier => {
  if (value === null || typeof value === 'string') return { kind: 'runs-on', name: '', runsOn: parseRunsOn(value ?? ''), enabled: true };
  const isRunsOn = 'runs-on' in value;
  const parsed = (isRunsOn ? runsOnTier : selfHostedTier).safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: issue.path });
    return z.NEVER;
  }
  if ('runs-on' in parsed.data) return { kind: 'runs-on', name: parsed.data.name ?? '', runsOn: parsed.data['runs-on'], enabled: parsed.data.enabled ?? true };
  const tier = parsed.data;
  return { kind: 'self-hosted', name: tier.name ?? '', labels: tier.labels ?? [], group: tier.group ?? '', minIdle: tier['min-idle'], match: tier.match, enabled: tier.enabled ?? true };
});

const POOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const poolsField = z.record(z.string(), z.array(tierField).min(1)).superRefine((pools, ctx) => {
  for (const name of Object.keys(pools)) {
    if (!POOL_NAME.test(name)) ctx.addIssue({ code: 'custom', path: [name], message: `pool name "${name}": use letters, digits, - and _ (it becomes the output prefix <name>-runs-on)` });
  }
});

export const configSchema = z.strictObject({
  pools: poolsField.optional(),
  candidates: z.array(tierField).min(1).optional(),
  labels: labelsField.optional(),
  group: textField.optional(),
  fallback: runsOnField.optional(),
  'min-idle': intField(1).optional(),
  match: z.enum(['idle', 'online']).optional(),
  force: z.enum(['auto', 'self-hosted', 'fallback']).optional(),
  scope: scopeField.optional(),
  owner: textField.optional(),
  repository: textField.optional(),
  enterprise: textField.optional(),
  untrusted: z.enum(['fallback', 'allow']).optional(),
  'wait-seconds': intField(0).optional(),
  'poll-seconds': intField(1).optional(),
  'timeout-seconds': intField(1).optional(),
  retries: intField(0).optional(),
  'skip-deprecated': boolField.optional(),
  annotate: z.enum(['notice', 'warning', 'none']).optional(),
  summary: boolField.optional(),
  'fail-on-error': boolField.optional(),
  'app-client-id': textField.optional(),
  'github-api-url': textField.optional(),
});

type RawConfig = Partial<Record<(typeof CONFIG_KEYS)[number], unknown>>;

function parseYamlObject(text: string, source: string): RawConfig {
  if (!text.trim()) return {};
  const parsed: unknown = parseYaml(text);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${source} must be a YAML/JSON mapping of inputs`);
  return parsed;
}

// The config file lives in the checked-out workspace, which untrusted code can control
// (e.g. pull_request_target checking out the PR head), so it may never relax the untrusted
// guard or redirect API calls (and the token) to another host.
const FILE_FORBIDDEN_KEYS = ['untrusted', 'github-api-url'] as const;

function readConfigFile(path: string, env: NodeJS.ProcessEnv): RawConfig {
  if (!path) return {};
  const fullPath = isAbsolute(path) ? path : join(env.GITHUB_WORKSPACE ?? process.cwd(), path);
  if (!existsSync(fullPath)) throw new Error(`config-file ${path} not found (check out the repository before this step, or pass config instead)`);
  const raw = parseYamlObject(readFileSync(fullPath, 'utf8'), `config-file ${path}`);
  const forbidden = FILE_FORBIDDEN_KEYS.filter((key) => key in raw);
  if (forbidden.length) throw new Error(`config-file ${path} may not set ${forbidden.join(', ')} — pass them as inputs or in config`);
  return raw;
}

function inputsAsConfig(env: NodeJS.ProcessEnv): RawConfig {
  const raw: RawConfig = {};
  for (const key of CONFIG_KEYS) {
    const value = readInput(key, env);
    if (!value) continue;
    raw[key] = STRUCTURED_INPUTS.has(key) ? parseYaml(value) : value;
  }
  return raw;
}

function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
}

function describeRunsOn(runsOn: RunsOn) {
  return typeof runsOn === 'string' ? runsOn : Array.isArray(runsOn) ? runsOn.join(', ') : `group ${runsOn.group}${runsOn.labels?.length ? ` (${runsOn.labels.join(', ')})` : ''}`;
}

export function tierName(tier: Tier) {
  if (tier.name) return tier.name;
  if (tier.kind === 'runs-on') return tier.runsOn ? describeRunsOn(tier.runsOn) : 'runs-on (unset)';
  return [tier.group && `group ${tier.group}`, tier.labels.join(', ')].filter(Boolean).join(': ') || 'self-hosted (unset)';
}

function buildPools(config: z.infer<typeof configSchema>, fallback: RunsOn | null): Pool[] {
  const fallbackTier: Tier = { kind: 'runs-on', name: 'fallback', runsOn: fallback, enabled: true };
  const hasShorthand = Boolean(config.labels?.length || config.group);
  const modes = [config.pools && 'pools', config.candidates && 'candidates', hasShorthand && 'labels/group'].filter(Boolean);
  if (modes.length > 1) throw new Error(`use one of pools, candidates or labels/group (got ${modes.join(' + ')})`);

  const named = (tiers: Tier[]) => [...tiers, fallbackTier].map((tier) => ({ ...tier, name: tierName(tier) }));
  if (config.pools) return Object.entries(config.pools).map(([name, tiers]) => ({ name, tiers: named(tiers) }));
  if (config.candidates) return [{ name: 'default', tiers: named(config.candidates) }];
  // Empty labels and group (e.g. an unset variable) leave only the fallback: self-hosted switched off.
  const shorthand: Tier[] = hasShorthand ? [{ kind: 'self-hosted', name: '', labels: config.labels ?? [], group: config.group ?? '', enabled: true }] : [];
  return [{ name: 'default', tiers: named(shorthand) }];
}

// trustWorkspace = false (untrusted runs) ignores config-file: its content may come from the untrusted code.
export function readSettings(env: NodeJS.ProcessEnv = process.env, { trustWorkspace = true } = {}): Settings {
  const merged: RawConfig = {
    ...(trustWorkspace ? readConfigFile(readInput('config-file', env), env) : {}),
    ...parseYamlObject(readInput('config', env), 'config'),
    ...inputsAsConfig(env),
  };
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`invalid configuration — ${formatIssues(parsed.error)}`);
  const config = parsed.data;
  const repository = config.repository || env.GITHUB_REPOSITORY || '';

  return {
    pools: buildPools(config, config.fallback === undefined ? DEFAULTS.fallback : config.fallback),
    minIdle: config['min-idle'] ?? DEFAULTS.minIdle,
    match: config.match ?? DEFAULTS.match,
    force: config.force ?? DEFAULTS.force,
    scopes: config.scope ?? DEFAULTS.scope,
    owner: config.owner || env.GITHUB_REPOSITORY_OWNER || repository.split('/')[0] || '',
    repository,
    enterprise: config.enterprise ?? '',
    untrusted: config.untrusted ?? DEFAULTS.untrusted,
    waitSeconds: config['wait-seconds'] ?? DEFAULTS.waitSeconds,
    pollSeconds: config['poll-seconds'] ?? DEFAULTS.pollSeconds,
    timeoutSeconds: config['timeout-seconds'] ?? DEFAULTS.timeoutSeconds,
    retries: config.retries ?? DEFAULTS.retries,
    skipDeprecated: config['skip-deprecated'] ?? DEFAULTS.skipDeprecated,
    annotate: config.annotate ?? DEFAULTS.annotate,
    summary: config.summary ?? DEFAULTS.summary,
    failOnError: config['fail-on-error'] ?? DEFAULTS.failOnError,
    appClientId: config['app-client-id'] ?? '',
    // Keys pasted into single-line secrets often arrive with literal \n.
    appPrivateKey: readInput('app-private-key', env).replaceAll(String.raw`\n`, '\n'),
    token: readInput('token', env),
    apiUrl: (config['github-api-url'] || env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}
