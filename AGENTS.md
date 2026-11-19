# AGENTS.md

Public, generic GitHub Action — never reference specific organizations, repositories, runner names or machines in code, tests, docs or examples (use `acme`, `self-hosted`, `ubuntu-latest`).

- Runtime: `node24` action; source is TypeScript in `src/`, bundled by Bun to `dist/index.mjs`, which is committed. No runtime dependencies — use `fetch` and `node:` built-ins.
- `src/config.ts` reads inputs, `src/select.ts` is the pure decision (unit-test it), `src/github.ts` is REST access, `src/main.ts` wires outputs and the job summary.
- Errors select the fallback with a `::warning` unless `fail-on-error`; invalid inputs fail the step.
- Tooling: `bun test`, `bun check` (typecheck), `oxlint --type-aware`, `bun fmt` (`.oxfmtrc.json`). `bun run verify` is the full gate and is what CI runs.
- Every input/output change updates `action.yml`, the README tables and tests together.
- Conventional commits; semantic-release tags `vX.Y.Z` and moves `vX`.
