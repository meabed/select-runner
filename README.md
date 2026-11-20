# select-runner

[![ci](https://github.com/meabed/select-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/meabed/select-runner/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/meabed/select-runner)](https://github.com/meabed/select-runner/releases)

GitHub Action that **routes jobs to your self-hosted runners when they are free, and down an ordered fallback chain when they are not** — another self-hosted pool, a runner provider (Blacksmith, Depot, Namespace, …), GitHub-hosted runners. It outputs ready-to-use `runs-on` values.

GitHub has no native fallback ([community discussion](https://github.com/orgs/community/discussions/20019)): a job whose `runs-on` matches no idle runner waits in the queue for up to 24 hours. `select-runner` runs in a tiny first job, checks your runners through the REST API, and tells the real jobs where to run.

## Features

- **Fallback chains** — ordered tiers: `self-hosted pool A → pool B → Blacksmith → GitHub-hosted`. Each tier can be switched off (`enabled: false`, e.g. from a variable during a provider outage).
- **Idle-aware** — counts runners that are online _and not busy_, so a burst overflows instead of queueing behind busy runners; `min-idle` keeps headroom.
- **Autoscaler-aware** — with `capacity`, a self-hosted tier backed by an autoscaler (ephemeral runners started on demand, e.g. ARC or a runner-node supervisor) also takes jobs while fewer than `capacity` of its runners are busy and one is online, instead of overflowing whenever the warm runners happen to be busy.
- **Several routes, one API pass** — `pools` (e.g. `test` and `build`) share one token and one runner listing.
- **Correct counting** — only runners in runner groups this repository _and workflow_ may use, skipping runners whose version GitHub no longer serves.
- **Safe by default** — fork pull requests, `pull_request_target` and Dependabot never reach self-hosted runners; any API or credential error selects the fallback with a warning.
- **Wait for capacity** — optionally re-check for a few seconds before overflowing.
- **One config for every repository** — put the pools in an organization variable or a file; every input can come from `config`.
- **GitHub App or token**; org, repo and enterprise runners; GitHub Enterprise Server; retries with backoff; job summary and annotations.

## Quick start

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    outputs:
      runs-on: ${{ steps.select.outputs.runs-on }}
    steps:
      - id: select
        uses: meabed/select-runner@v2
        with:
          labels: self-hosted, linux, x64
          fallback: ubuntu-latest
          app-client-id: ${{ vars.RUNNERS_APP_CLIENT_ID }}
          app-private-key: ${{ secrets.RUNNERS_APP_PRIVATE_KEY }}

  test:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runs-on) }}
    steps:
      - uses: actions/checkout@v7
```

## Fallback chains

`candidates` is one route as an ordered list. The first tier that can take the job wins; `fallback` (default `ubuntu-latest`) always closes the chain.

```yaml
- id: select
  uses: meabed/select-runner@v2
  with:
    app-client-id: ${{ vars.RUNNERS_APP_CLIENT_ID }}
    app-private-key: ${{ secrets.RUNNERS_APP_PRIVATE_KEY }}
    candidates: |
      - labels: self-hosted, linux, x64        # homelab, if a runner is idle
      - labels: self-hosted, linux, x64, cloud # second self-hosted pool
        min-idle: 2                            # keep headroom there
      - labels: self-hosted, arc               # autoscaled (ARC): new runners start on demand
        capacity: 20                           #   take jobs until 20 of its runners are busy
      - runs-on: blacksmith-4vcpu-ubuntu-2404  # provider
        enabled: ${{ vars.BLACKSMITH_ENABLED != 'false' }}  # outage switch
      - ubuntu-24.04                           # GitHub-hosted (a bare string is a runs-on tier)
```

Tier fields:

| Field      | Tier        | Meaning                                                                                                 |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `labels`   | self-hosted | Labels a runner must all carry (string `a, b` or list).                                                 |
| `group`    | self-hosted | Only runners in this runner group; `runs-on` becomes `{ group, labels }`.                               |
| `min-idle` | self-hosted | Overrides the `min-idle` input for this tier.                                                           |
| `match`    | self-hosted | Overrides the `match` input (`idle` / `online`).                                                        |
| `capacity` | self-hosted | Autoscaled tier: also chosen with no idle runner while one is online and fewer than this many are busy. |
| `runs-on`  | runs-on     | Any `runs-on` value: label, list, or `{ group, labels }`. Always available.                             |
| `enabled`  | both        | Only an explicit `false` disables the tier; empty (unset variable) keeps it.                            |
| `name`     | both        | Name shown in outputs, logs and the summary.                                                            |

A self-hosted tier with empty `labels` and no `group` (e.g. `labels: ${{ vars.SELF_HOSTED_LABELS }}` while the variable is unset) is skipped — self-hosted switched off without editing the workflow.

## Pools: test and build in one step

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    outputs:
      test: ${{ steps.select.outputs.test-runs-on }}
      build: ${{ steps.select.outputs.build-runs-on }}
      test-self-hosted: ${{ steps.select.outputs.test-self-hosted }}
    steps:
      - id: select
        uses: meabed/select-runner@v2
        with:
          app-client-id: ${{ vars.RUNNERS_APP_CLIENT_ID }}
          app-private-key: ${{ secrets.RUNNERS_APP_PRIVATE_KEY }}
          pools: |
            test:
              - labels: self-hosted, arm64
              - blacksmith-2vcpu-ubuntu-2404-arm
              - ubuntu-24.04-arm
            build:
              - labels: self-hosted, x64
              - depot-ubuntu-24.04
              - ubuntu-latest

  test:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.test) }}
    steps:
      - uses: actions/cache@v5 # self-hosted runners keep their caches on disk
        if: needs.select-runner.outputs.test-self-hosted != 'true'
        with: { path: ~/.bun/install/cache, key: bun-${{ hashFiles('bun.lock') }} }

  build:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.build) }}
```

Each pool gets `<pool>-runs-on`, `<pool>-self-hosted`, `<pool>-index`, `<pool>-name` and `<pool>-reason`; `selections` has all of them as JSON. Linters such as actionlint only know outputs declared in `action.yml` and flag the per-pool ones; read `fromJSON(steps.select.outputs.selections).build['runs-on']` instead if that matters to you.

## One config for every repository

Every input except credentials can come from `config` (a YAML string) or `config-file` (a YAML file in the workspace). Store the pools once as an **organization variable** and each workflow step stays three lines:

```yaml
# Organization variable SELECT_RUNNER_CONFIG:
#   app-client-id: Iv23liExample
#   min-idle: 1
#   pools:
#     test: [{ labels: 'self-hosted, arm64' }, ubuntu-24.04-arm]
#     build: [{ labels: 'self-hosted, x64' }, blacksmith-4vcpu-ubuntu-2404, ubuntu-latest]

- id: select
  uses: meabed/select-runner@v2
  with:
    config: ${{ vars.SELECT_RUNNER_CONFIG }}
    app-private-key: ${{ secrets.RUNNERS_APP_PRIVATE_KEY }}
```

Precedence: individual inputs > `config` > `config-file` > defaults. `pools`, `candidates` and `labels`/`group` are mutually exclusive across all sources.

`config-file` is workspace content, which untrusted code can control (e.g. `pull_request_target` checking out the PR head). It therefore may not set `untrusted` or `github-api-url`, and it is ignored entirely for untrusted runs — prefer `config` from a variable.

## Credentials

| Runners (`scope`)                      | GitHub App permission                        | Token (`token:`)                                                  |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| `org` (default for organizations)      | Organization → **Self-hosted runners: Read** | fine-grained PAT with the same permission, or classic `admin:org` |
| `repo` (default for personal accounts) | Repository → **Administration: Read**        | fine-grained PAT with the same permission, or classic `repo`      |
| `enterprise`                           | — (token only)                               | classic PAT with `manage_runners:enterprise`                      |

A GitHub App is recommended: the action mints one installation token limited to those permissions for the scopes in use and revokes it before the step ends. With a personal access token:

```yaml
with:
  labels: self-hosted, linux
  token: ${{ secrets.RUNNERS_READ_TOKEN }}
```

`GITHUB_TOKEN` cannot read runners. No credentials are needed (and no API call is made) when nothing has to be checked: `force`, untrusted runs, or chains without an enabled self-hosted tier.

## Fallback targets

Any value `runs-on` accepts works as a `runs-on` tier or `fallback`. Label names below are the providers' published examples; check their docs for the sizes you use.

| Target                                                                          | Tier                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GitHub-hosted Linux x64 / arm64                                                 | `ubuntu-latest` · `ubuntu-24.04` · `ubuntu-24.04-arm`                                     |
| GitHub-hosted macOS / Windows                                                   | `macos-15` · `macos-latest` · `windows-latest`                                            |
| GitHub larger runners                                                           | `runs-on: { group: larger-runners, labels: [ubuntu-24.04-16core] }`                       |
| [Avrea](https://docs.avrea.com/runners/)                                        | `avrea-ubuntu-latest-4-vcpu` · `avrea-ubuntu-latest-arm-2-vcpu` · `avrea-macos-26-8-vcpu` |
| [Blacksmith](https://docs.blacksmith.sh)                                        | `blacksmith-4vcpu-ubuntu-2404` · `blacksmith-4vcpu-ubuntu-2404-arm`                       |
| [Depot](https://depot.dev/docs/github-actions/overview)                         | `depot-ubuntu-24.04` · `depot-ubuntu-24.04-arm`                                           |
| [Namespace](https://namespace.so/docs/solutions/github-actions)                 | `namespace-profile-default`                                                               |
| [WarpBuild](https://docs.warpbuild.com)                                         | `warp-ubuntu-latest-x64-4x`                                                               |
| [Ubicloud](https://www.ubicloud.com/docs/github-actions-integration/quickstart) | `ubicloud-standard-4`                                                                     |
| [RunsOn](https://runs-on.com) (labels carry the run id)                         | `runs-on=${{ github.run_id }}/runner=4cpu-linux-x64`                                      |

## Recipes

**Manual override** — a `workflow_dispatch` input that forces either side:

```yaml
on:
  workflow_dispatch:
    inputs:
      runner:
        type: choice
        options: [auto, self-hosted, fallback]
        default: auto
        # ...
        with:
          force: ${{ inputs.runner || 'auto' }}
```

**Wait a little before overflowing** — useful when jobs are short or an autoscaler is warming up:

```yaml
with:
  labels: self-hosted, linux
  wait-seconds: 60
  poll-seconds: 10
```

**iOS on your own Mac, GitHub macOS otherwise** — repository runners on a personal account:

```yaml
with:
  labels: self-hosted, macOS, ARM64
  fallback: macos-15
  token: ${{ secrets.RUNNERS_READ_TOKEN }} # personal accounts default to scope: repo
```

**Org and repository runners together**, with a group-restricted tier:

```yaml
with:
  scope: org, repo
  candidates: |
    - group: build-farm
      labels: linux
    - runs-on: { group: larger-runners, labels: [ubuntu-24.04-16core] }
```

**Never fail the downstream job on a missing output** (e.g. the select job was skipped):

```yaml
runs-on: ${{ fromJSON(needs.select-runner.outputs.runs-on || '"ubuntu-latest"') }}
```

## Inputs

All inputs are optional; defaults apply when an input is empty or unset.

| Input             | Default            | Description                                                                                                          |
| ----------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `pools`           |                    | Pool name → tiers (YAML/JSON). Per-pool outputs `<pool>-*`.                                                          |
| `candidates`      |                    | One route as ordered tiers (YAML/JSON).                                                                              |
| `labels`          |                    | Shorthand for one self-hosted tier. Empty and no `group` = self-hosted off.                                          |
| `group`           |                    | Shorthand tier restricted to a runner group.                                                                         |
| `fallback`        | `ubuntu-latest`    | Last tier of every chain: label, comma list, or JSON string/array/`{ group, labels }`.                               |
| `min-idle`        | `1`                | Available runners a self-hosted tier needs.                                                                          |
| `match`           | `idle`             | `idle` (online and not busy) or `online` (busy count too).                                                           |
| `force`           | `auto`             | `auto`, `self-hosted` (first enabled self-hosted tier), `fallback` (first enabled runs-on tier).                     |
| `untrusted`       | `fallback`         | `fallback` keeps fork PRs, `pull_request_target` and Dependabot off self-hosted runners; `allow` disables the guard. |
| `scope`           | `auto`             | `auto` (org for organizations, repo for users) or a list of `org`, `repo`, `enterprise`.                             |
| `owner`           | repository owner   | Organization/user that owns the runners.                                                                             |
| `repository`      | current repository | `owner/repo` for repo scope and runner-group visibility.                                                             |
| `enterprise`      |                    | Enterprise slug for `scope: enterprise`.                                                                             |
| `wait-seconds`    | `0`                | Re-check for this long when a self-hosted tier was passed over for capacity.                                         |
| `poll-seconds`    | `10`               | Interval between those checks.                                                                                       |
| `timeout-seconds` | `15`               | Per-request API timeout.                                                                                             |
| `retries`         | `3`                | Retries for network errors, 5xx and rate limits (backoff, honours `Retry-After`).                                    |
| `skip-deprecated` | `true`             | Ignore runners whose version GitHub no longer assigns jobs to.                                                       |
| `annotate`        | `notice`           | Annotation when a self-hosted tier was passed over: `notice`, `warning`, `none`.                                     |
| `summary`         | `true`             | Write the decisions to the job summary.                                                                              |
| `fail-on-error`   | `false`            | Fail instead of falling back when runners cannot be listed.                                                          |
| `config`          |                    | YAML/JSON mapping of any inputs above.                                                                               |
| `config-file`     |                    | Workspace path of a YAML/JSON file with the same keys.                                                               |
| `app-client-id`   |                    | GitHub App client ID (also allowed in `config`).                                                                     |
| `app-private-key` |                    | GitHub App private key (PEM).                                                                                        |
| `token`           |                    | Token that can read runners (see Credentials).                                                                       |
| `github-api-url`  | workflow API URL   | REST API base URL (GitHub Enterprise Server).                                                                        |

## Outputs

| Output                                                                                 | Example                               | Description                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `runs-on`                                                                              | `["self-hosted","arm64"]`             | JSON for `runs-on: ${{ fromJSON(...) }}` (first or only pool).   |
| `self-hosted`                                                                          | `true`                                | Whether a self-hosted tier was chosen.                           |
| `index`                                                                                | `0`                                   | Chosen tier's position in the chain (the fallback is last).      |
| `name`                                                                                 | `self-hosted, arm64`                  | Chosen tier's name.                                              |
| `labels`                                                                               | `self-hosted,arm64`                   | Chosen labels as a comma string.                                 |
| `reason`                                                                               | `self-hosted, arm64: 2 idle (need 1)` | Why, including tiers passed over.                                |
| `idle` / `online` / `busy` / `registered`                                              | `2` / `3` / `1` / `4`                 | Runner counts of the chosen (or first checked) self-hosted tier. |
| `runners`                                                                              | `["runner-1","runner-2"]`             | Idle matching runner names.                                      |
| `selections`                                                                           | `{"test":{"runs-on":…}}`              | Every pool as JSON.                                              |
| `<pool>-runs-on`, `<pool>-self-hosted`, `<pool>-index`, `<pool>-name`, `<pool>-reason` |                                       | Per pool (pools mode).                                           |

## Job summary

Every run writes a summary (disable with `summary: false`): one row per pool with the chosen `runs-on`, tier and reason; a collapsible fallback chain per pool showing each tier as ✅ chosen, ⛔ no capacity, ⏭️ disabled/unset or · not reached, with idle / online / busy / registered counts and the idle runner names; and run details — credentials, scopes, event, untrusted guard, force, listings, API requests and time.

## How it decides

1. **Settings** — defaults < `config-file` < `config` < inputs; tiers are validated (unknown keys are errors).
2. **Shortcuts** — `force`, an untrusted run (with `untrusted: fallback`) or a chain without an enabled self-hosted tier picks without any API call.
3. **Runners** — one token, one listing: for `org`, only runner groups visible to this repository, open to public repositories when it is public, and not restricted to other workflows, then their runners; plus `repo` / `enterprise` runners. Runners on deprecated versions are dropped.
4. **Chains** — per pool, the first enabled tier wins: a self-hosted tier when at least `min-idle` matching runners are idle (or online with `match: online`), or — with `capacity` — when one is online and fewer than `capacity` are busy; a runs-on tier always. The `fallback` closes every chain.
5. **Waiting** — with `wait-seconds`, if a self-hosted tier was passed over for capacity, re-list every `poll-seconds` until it has room or time is up.
6. **Errors** — API/credential failures pick each pool's first enabled runs-on tier with a warning (`fail-on-error: true` to fail).

## Pitfalls and tips

- **Use specific labels.** `self-hosted` alone also matches a Mac or Windows runner; include OS/arch labels. Never give self-hosted runners GitHub-hosted labels such as `ubuntu-latest`.
- **Races.** Two runs starting together can both see the last idle runner; one then waits for it. Raise `min-idle` for headroom. Avoid `concurrency` groups as a lock: GitHub cancels older pending runs in a group.
- **Scale-from-zero / ephemeral runners.** Autoscalers with no idle runner always overflow; keep a minimum of `min-idle` warm runners. Just-in-time runners show offline until they start.
- **"Re-run failed jobs"** reuses the select job's outputs from the original attempt; use "Re-run all jobs" to route again.
- **The select job needs a runner too.** Run it on a GitHub-hosted (or provider) runner with a short `timeout-minutes`, never on the pool it checks.
- **Rate limits.** One run costs a few requests (token, groups, one page per 100 runners per group, deprecation lookups per runner version). Prefer one select job with `pools` per workflow over one per job.

## Security

- Fork pull requests get no secrets and must not run on self-hosted runners; with `untrusted: fallback` (default) they — and `pull_request_target` and Dependabot runs — always get a runs-on tier, without credentials or API calls.
- App tokens are limited to reading runners (`organization_self_hosted_runners: read` / `administration: read` for this repository) and revoked when the step ends; tokens are masked in logs.
- `config-file` cannot relax the untrusted guard or change the API URL, and is ignored for untrusted runs; workflow-command output is escaped.
- The action has no runtime network access beyond the GitHub API URL and ships as a single bundled file (`dist/index.mjs`).

## For AI agents

[`llms.txt`](llms.txt) is a compact, machine-oriented reference (inputs, tier schema, outputs, decision rules, examples). Contributors and coding agents: see [AGENTS.md](AGENTS.md).

## Development

```bash
bun install        # also installs the pre-commit hook (secret scan, lint, format, typecheck, tests, rebuild dist/)
bun test           # unit + end-to-end tests (a local server stands in for the GitHub API)
bun run verify     # lint + format + typecheck + tests + build, and dist/ must be committed
```

Releases are cut by semantic-release from conventional commits on `master`; the moving major tag (`v1`) follows the latest release.

## License

MIT
