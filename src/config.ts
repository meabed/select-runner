// Action inputs → typed config. GitHub passes `with:` values as INPUT_<NAME> env vars
// (name upper-cased, spaces → underscores, dashes kept).

export type RunsOn = string | string[] | { group: string; labels?: string[] };
export type Match = 'idle' | 'online';
export type Force = 'auto' | 'self-hosted' | 'fallback';

export type Config = {
  labels: string[];
  group: string;
  fallback: RunsOn;
  minIdle: number;
  match: Match;
  force: Force;
  scope: 'org' | 'repo';
  owner: string;
  repository: string;
  appClientId: string;
  appPrivateKey: string;
  token: string;
  failOnError: boolean;
  summary: boolean;
  apiUrl: string;
};

export function readInput(name: string, env: NodeJS.ProcessEnv = process.env) {
  return (env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim();
}

export function parseList(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRunsOnObject(value: unknown): value is { group: string; labels?: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { group, labels } = value as { group?: unknown; labels?: unknown };
  return typeof group === 'string' && (labels === undefined || (Array.isArray(labels) && labels.every((label) => typeof label === 'string')));
}

// A label, a comma/newline list, or JSON (string, string[], { group, labels }).
export function parseRunsOn(value: string): RunsOn {
  if (!/^[[{"]/.test(value)) {
    const labels = parseList(value);
    if (!labels.length) throw new Error('fallback is empty');
    return labels.length === 1 ? labels[0]! : labels;
  }
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed === 'string' && parsed) return parsed;
  if (Array.isArray(parsed) && parsed.length && parsed.every((label) => typeof label === 'string')) return parsed;
  if (isRunsOnObject(parsed)) return parsed;
  throw new Error(`fallback is not a valid runs-on value: ${value}`);
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(', ')} (got "${value}")`);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const input = (name: string) => readInput(name, env);
  const labels = parseList(input('labels'));
  const group = input('group');
  const minIdle = Number(input('min-idle') || '1');
  if (!Number.isInteger(minIdle) || minIdle < 1) throw new Error(`min-idle must be a positive integer (got "${input('min-idle')}")`);
  const repository = input('repository') || env.GITHUB_REPOSITORY || '';

  return {
    labels,
    group,
    fallback: parseRunsOn(input('fallback') || 'ubuntu-latest'),
    minIdle,
    match: oneOf('match', input('match'), ['idle', 'online'], 'idle'),
    force: oneOf('force', input('force'), ['auto', 'self-hosted', 'fallback'], 'auto'),
    scope: oneOf('scope', input('scope'), ['org', 'repo'], 'org'),
    owner: input('owner') || env.GITHUB_REPOSITORY_OWNER || repository.split('/')[0] || '',
    repository,
    appClientId: input('app-client-id'),
    // Keys pasted into single-line secrets often arrive with literal \n.
    appPrivateKey: input('app-private-key').replaceAll(String.raw`\n`, '\n'),
    token: input('token'),
    failOnError: input('fail-on-error') === 'true',
    summary: input('summary') !== 'false',
    apiUrl: (input('github-api-url') || env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}
