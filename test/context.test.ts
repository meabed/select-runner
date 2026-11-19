import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readContext, untrustedReason } from '../src/context';

const repository = { full_name: 'acme/app', private: false, owner: { type: 'Organization' } };

describe('untrustedReason', () => {
  test('fork pull requests, deleted forks, pull_request_target and Dependabot are untrusted', () => {
    expect(untrustedReason('pull_request', 'octocat', { repository, pull_request: { head: { repo: { full_name: 'octocat/app' } } } })).toBe('pull request from fork octocat/app');
    expect(untrustedReason('pull_request', 'octocat', { repository, pull_request: { head: { repo: null } } })).toBe('pull request from a deleted fork');
    expect(untrustedReason('pull_request_target', 'octocat', { repository })).toBe('pull_request_target event');
    expect(untrustedReason('push', 'dependabot[bot]', { repository })).toBe('actor dependabot[bot]');
  });

  test('same-repository pull requests and pushes are trusted', () => {
    expect(untrustedReason('pull_request', 'octocat', { repository, pull_request: { head: { repo: { full_name: 'ACME/app' } } } })).toBe('');
    expect(untrustedReason('push', 'octocat', { repository })).toBe('');
    expect(untrustedReason('workflow_dispatch', 'octocat', {})).toBe('');
  });
});

describe('readContext', () => {
  test('reads the event payload and workflow env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'select-runner-event-'));
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ repository }));
    const context = readContext({ GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'push', GITHUB_ACTOR: 'octocat', GITHUB_WORKFLOW_REF: 'acme/app/.github/workflows/ci.yml@refs/heads/main', GITHUB_SHA: 'abc' });
    expect(context).toEqual({ eventName: 'push', actor: 'octocat', untrustedReason: '', repoPublic: true, ownerType: 'Organization', workflowRef: 'acme/app/.github/workflows/ci.yml@refs/heads/main', sha: 'abc' });
  });

  test('without a payload the repository counts as private', () => {
    expect(readContext({})).toMatchObject({ repoPublic: false, ownerType: '', untrustedReason: '' });
  });
});
