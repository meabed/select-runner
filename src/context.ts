// What the workflow run itself tells us (event payload + GITHUB_* env): whether the code
// under test is untrusted, whether the repository is public, and which workflow runs.
import { existsSync, readFileSync } from 'node:fs';

export type RunContext = {
  eventName: string;
  actor: string;
  // Why the run must not reach self-hosted runners, or '' when it may.
  untrustedReason: string;
  repoPublic: boolean;
  ownerType: 'Organization' | 'User' | '';
  workflowRef: string;
  sha: string;
};

type EventPayload = {
  repository?: { full_name?: string; private?: boolean; visibility?: string; owner?: { type?: string } };
  pull_request?: { head?: { repo?: { full_name?: string } | null } };
};

function readPayload(path: string | undefined): EventPayload {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EventPayload;
  } catch {
    return {};
  }
}

const PULL_REQUEST_EVENTS = new Set(['pull_request', 'pull_request_review', 'pull_request_review_comment']);
const UNTRUSTED_ACTORS = new Set(['dependabot[bot]']);

export function untrustedReason(eventName: string, actor: string, payload: EventPayload) {
  if (eventName === 'pull_request_target') return 'pull_request_target event';
  if (UNTRUSTED_ACTORS.has(actor)) return `actor ${actor}`;
  if (!PULL_REQUEST_EVENTS.has(eventName)) return '';
  const head = payload.pull_request?.head?.repo?.full_name;
  const base = payload.repository?.full_name;
  if (!head) return 'pull request from a deleted fork';
  return head.toLowerCase() === base?.toLowerCase() ? '' : `pull request from fork ${head}`;
}

export function readContext(env: NodeJS.ProcessEnv = process.env): RunContext {
  const payload = readPayload(env.GITHUB_EVENT_PATH);
  const eventName = env.GITHUB_EVENT_NAME ?? '';
  const actor = env.GITHUB_ACTOR ?? '';
  const repository = payload.repository;
  const ownerType = repository?.owner?.type;
  return {
    eventName,
    actor,
    untrustedReason: untrustedReason(eventName, actor, payload),
    repoPublic: repository ? repository.private === false || repository.visibility === 'public' : false,
    ownerType: ownerType === 'Organization' || ownerType === 'User' ? ownerType : '',
    workflowRef: env.GITHUB_WORKFLOW_REF ?? '',
    sha: env.GITHUB_SHA ?? '',
  };
}
