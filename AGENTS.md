# AGENTS.md

Canonical rules for working on this repository (CLAUDE.md points here). Usage docs for people are in README.md; a compact usage reference for agents writing workflows is in llms.txt.

## Product rules

- Public, generic action. Never reference real organizations, repositories, runner names or machines in code, tests, docs or examples — use `acme`, `self-hosted`, provider labels from public docs.
- Nothing hardcoded: every behaviour knob is an input with a default in `DEFAULTS` (`src/config.ts`). `action.yml` declares **no** input defaults (tested), so an empty input means "not set" and `config` / `config-file` can supply it.
- Safe by default: failures select each pool's first runs-on tier with a `::warning` unless `fail-on-error`; untrusted runs never reach self-hosted tiers; invalid configuration fails the step with the field path.
- No backward-compatibility shims. Breaking changes ship as a new major (conventional `feat!:` / `BREAKING CHANGE:`).

## Code map

| File             | Responsibility                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`  | Inputs, `config`, `config-file` → validated `Settings` (zod schemas, YAML via `yaml`). Builds pools of tiers; the fallback closes every chain.           |
| `src/context.ts` | Event payload + `GITHUB_*` env: untrusted run detection, repo visibility, owner type, workflow ref.                                                      |
| `src/github.ts`  | REST: requests with timeout/retry/backoff, App JWT + downscoped installation token, usable runner groups, runner listing per scope, deprecated versions. |
| `src/select.ts`  | Pure decision: walk a pool's tiers, count runners, apply force/untrusted. No I/O — unit-test it.                                                         |
| `src/main.ts`    | Orchestration: one token, one listing for all pools, wait loop, outputs, annotations, job summary.                                                       |
| `dist/index.mjs` | Bun bundle (minified, node24) — committed; rebuilt by the pre-commit hook.                                                                               |

## Conventions

- TypeScript run by Bun; target `node24` via `bun build`. Dependencies are bundled (zod, yaml); use `fetch` and `node:` built-ins for everything else.
- Style: `.oxfmtrc.json` (single quotes, trailing commas, 240 cols), type-aware oxlint, named exports, kebab-case files, no `any`/casts where a type guard or schema works.
- An input/output change updates together: `action.yml`, `src/config.ts` (`CONFIG_KEYS`, schema, `DEFAULTS`), README tables, llms.txt, tests. `test/action.test.ts` enforces the coupling.
- Tests: `test/select.test.ts` (logic), `test/config.test.ts` (parsing/precedence), `test/github.test.ts` (REST with mocked fetch), `test/context.test.ts`, `test/main.test.ts` (entry point end to end against a local fake GitHub API), `test/action.test.ts` (metadata guards).

## Commands

```bash
bun install          # installs the pre-commit hook: gitleaks, lint-staged, typecheck, tests, rebuild + stage dist/
bun test
bun run verify       # lint + format check + typecheck + tests + build + dist/ unchanged — what CI runs
```

## Releases

semantic-release on `master` (`.releaserc.json`): `feat` → minor, `fix`/`perf` → patch, `BREAKING CHANGE` → major; the release workflow then moves the major tag (`v2`). Never edit tags by hand.
