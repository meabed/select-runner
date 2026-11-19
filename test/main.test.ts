// Runs the action entry point the way GitHub does: INPUT_* env vars in, GITHUB_OUTPUT
// and GITHUB_STEP_SUMMARY files out. Only paths that need no network are covered here.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runAction(inputs: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'select-runner-'));
  const outputFile = join(dir, 'output');
  const summaryFile = join(dir, 'summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  const proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_REPOSITORY_OWNER: 'acme',
      ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const outputs = Object.fromEntries([...readFileSync(outputFile, 'utf8').matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)].map((match) => [match[1], match[3]]));
  return { exitCode, stdout, outputs, summary: readFileSync(summaryFile, 'utf8') };
}

describe('action entry point', () => {
  test('force fallback needs no credentials', async () => {
    const result = await runAction({ labels: 'self-hosted', fallback: 'ubuntu-24.04', force: 'fallback' });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ 'runs-on': '"ubuntu-24.04"', 'self-hosted': 'false', reason: 'forced to fallback' });
    expect(result.summary).toContain('### Runner selection');
  });

  test('force self-hosted outputs the labels as a runs-on array', async () => {
    const result = await runAction({ labels: 'self-hosted, linux-arm64', force: 'self-hosted' });
    expect(result.outputs).toMatchObject({ 'runs-on': '["self-hosted","linux-arm64"]', 'self-hosted': 'true' });
  });

  test('missing credentials fall back with a warning', async () => {
    const result = await runAction({ labels: 'self-hosted' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('::warning title=select-runner::no credentials');
    expect(result.outputs).toMatchObject({ 'runs-on': '"ubuntu-latest"', 'self-hosted': 'false' });
  });

  test('missing credentials fail with fail-on-error', async () => {
    const result = await runAction({ labels: 'self-hosted', 'fail-on-error': 'true' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('::error title=select-runner::no credentials');
  });

  test('empty labels select the fallback without credentials or warnings', async () => {
    const result = await runAction({ labels: '', fallback: 'ubuntu-24.04' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('::warning');
    expect(result.outputs).toMatchObject({ 'runs-on': '"ubuntu-24.04"', 'self-hosted': 'false' });
  });

  test('invalid inputs fail the step', async () => {
    const result = await runAction({ labels: 'self-hosted', force: 'maybe' });
    expect(result.exitCode).toBe(1);
  });
});
