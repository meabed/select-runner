// Guards for action.yml: GitHub evaluates ${{ }} anywhere in action metadata (even in
// descriptions), and every input/output must stay documented in the README.
import { describe, expect, test } from 'bun:test';

type ActionMetadata = {
  inputs: Record<string, { description: string; default?: string }>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string };
};

const action = Bun.YAML.parse(await Bun.file(new URL('../action.yml', import.meta.url)).text()) as ActionMetadata;
const readme = await Bun.file(new URL('../README.md', import.meta.url)).text();

describe('action.yml', () => {
  test('descriptions contain no expressions (they would be evaluated and break loading)', () => {
    const descriptions = [...Object.values(action.inputs), ...Object.values(action.outputs)].map((entry) => entry.description);
    for (const description of descriptions) expect(description).not.toContain('${{');
  });

  test('runs the committed node24 bundle', async () => {
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.mjs' });
    expect(await Bun.file(new URL('../dist/index.mjs', import.meta.url)).exists()).toBe(true);
  });

  test('every input and output is documented in the README', () => {
    for (const name of [...Object.keys(action.inputs), ...Object.keys(action.outputs)]) expect(readme).toContain(`\`${name}\``);
  });

  test('every output is written by the entry point', async () => {
    const main = await Bun.file(new URL('../src/main.ts', import.meta.url)).text();
    for (const name of Object.keys(action.outputs)) expect(main).toContain(`setOutput('${name}'`);
  });
});
