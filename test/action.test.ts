// Guards for action.yml: GitHub evaluates ${{ }} anywhere in action metadata (even in
// descriptions), inputs carry no defaults (defaults live in src/config.ts so an empty
// input means "not set"), and every input/output stays documented and implemented.
import { describe, expect, test } from 'bun:test';

type ActionMetadata = {
  inputs: Record<string, { description: string; default?: string; required?: boolean }>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string };
};

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const action = Bun.YAML.parse(await read('../action.yml')) as ActionMetadata;
const [readme, main, config] = await Promise.all([read('../README.md'), read('../src/main.ts'), read('../src/config.ts')]);

describe('action.yml', () => {
  test('descriptions contain no expressions (they would be evaluated and break loading)', () => {
    for (const entry of [...Object.values(action.inputs), ...Object.values(action.outputs)]) expect(entry.description).not.toContain('${{');
  });

  test('inputs have no defaults and are optional', () => {
    for (const [name, input] of Object.entries(action.inputs)) {
      expect({ name, default: input.default }).toEqual({ name, default: undefined });
      expect(input.required ?? false).toBe(false);
    }
  });

  test('runs the committed node24 bundle', async () => {
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.mjs' });
    expect(await Bun.file(new URL('../dist/index.mjs', import.meta.url)).exists()).toBe(true);
  });

  test('every input is read by the config and documented', () => {
    for (const name of Object.keys(action.inputs)) {
      expect(config).toContain(`'${name}'`);
      expect(readme).toContain(`\`${name}\``);
    }
  });

  test('every output is written by the entry point and documented', () => {
    for (const name of Object.keys(action.outputs)) {
      expect(main).toMatch(new RegExp(`^\\s+'?${name}'?: `, 'm'));
      expect(readme).toContain(`\`${name}\``);
    }
  });
});
