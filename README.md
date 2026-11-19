# select-runner

GitHub Action that **prefers your self-hosted runners when one is free and falls back to hosted runners otherwise**, and outputs a ready-to-use `runs-on` value.

GitHub has no native fallback: a job whose `runs-on` labels match no idle runner waits in the queue (up to 24 hours). `select-runner` runs in a tiny first job, checks your runners through the REST API, and tells the real jobs where to run.

- **Idle-aware** — counts runners that are online _and not busy_ by default, so a burst of jobs overflows to the fallback instead of queueing behind busy runners (`match: online` keeps the old behaviour).
- **Headroom** — `min-idle: 2` only picks self-hosted while at least two matching runners are free.
- **Labels and groups** — every label must match (case-insensitive, like GitHub); optionally restrict to a runner group and get `runs-on: { group, labels }`.
- **Any fallback** — a label, a list, or a `{ group, labels }` object (larger runners, other providers).
- **Overrides** — `force: fallback` / `force: self-hosted`, e.g. wired to a `workflow_dispatch` input.
- **GitHub App or token** — with App credentials it mints an installation token downscoped to _reading runners_ and revokes it when done.
- **Safe by default** — any API or credential problem selects the fallback with a warning (`fail-on-error: true` to fail instead).
- **Org or repo runners**, all pages of the runner list, GitHub Enterprise Server via `github-api-url`, a job summary of every decision.

## Quick start

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    outputs:
      runs-on: ${{ steps.select.outputs.runs-on }}
      self-hosted: ${{ steps.select.outputs.self-hosted }}
    steps:
      - id: select
        uses: meabed/select-runner@v1
        with:
          labels: self-hosted, linux, arm64
          fallback: ubuntu-24.04-arm
          app-client-id: ${{ vars.RUNNERS_APP_CLIENT_ID }}
          app-private-key: ${{ secrets.RUNNERS_APP_PRIVATE_KEY }}

  test:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runs-on) }}
    steps:
      - uses: actions/checkout@v7
      - run: echo "self-hosted=${{ needs.select-runner.outputs.self-hosted }}"
```

## Credentials

| Runners                              | GitHub App permission                        | Token (`token:`)                                                   |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| Organization (`scope: org`, default) | Organization → **Self-hosted runners: Read** | fine-grained PAT with the same permission (or classic `admin:org`) |
| Repository (`scope: repo`)           | Repository → **Administration: Read**        | fine-grained PAT with the same permission (or classic `repo`)      |

A GitHub App is recommended: the action mints a short-lived token limited to that permission and revokes it before the step ends. `GITHUB_TOKEN` cannot read runners.

## Recipes

**Keep headroom and let a manual run skip self-hosted**

```yaml
on:
  workflow_dispatch:
    inputs:
      hosted:
        description: Run on hosted runners
        type: boolean
        default: false
# ...
      - id: select
        uses: meabed/select-runner@v1
        with:
          labels: self-hosted, linux
          fallback: ubuntu-latest
          min-idle: 2
          force: ${{ inputs.hosted && 'fallback' || 'auto' }}
          token: ${{ secrets.RUNNERS_READ_TOKEN }}
```

**Different pools per job** — select once per pool:

```yaml
outputs:
  test: ${{ steps.test.outputs.runs-on }}
  build: ${{ steps.build.outputs.runs-on }}
steps:
  - id: test
    uses: meabed/select-runner@v1
    with: { labels: 'self-hosted, arm64', fallback: ubuntu-24.04-arm, token: '${{ secrets.RUNNERS_READ_TOKEN }}' }
  - id: build
    uses: meabed/select-runner@v1
    with: { labels: 'self-hosted, x64', fallback: ubuntu-24.04, token: '${{ secrets.RUNNERS_READ_TOKEN }}' }
```

**Runner group, larger-runner fallback**

```yaml
with:
  group: build-farm
  labels: linux
  fallback: '{"group": "larger-runners", "labels": ["ubuntu-24.04-16core"]}'
```

**Switch self-hosted on and off with a variable** — leave `SELF_HOSTED_LABELS` unset and every run uses the fallback, without credentials or API calls:

```yaml
with:
  labels: ${{ vars.SELF_HOSTED_LABELS }}
  fallback: ${{ vars.HOSTED_RUNNER || 'ubuntu-latest' }}
  app-client-id: ${{ vars.RUNNERS_APP_CLIENT_ID }}
  app-private-key: ${{ secrets.RUNNERS_APP_PRIVATE_KEY }}
```

**Branch on where the job runs** — e.g. skip a cache restore your self-hosted runners don't need:

```yaml
- uses: actions/cache@v5
  if: needs.select-runner.outputs.self-hosted != 'true'
```

## Fallback targets

`fallback` is any value `runs-on` accepts, so the overflow can go to GitHub-hosted runners or to any runner provider installed on your organization. Label names below are the providers' published examples; check their docs for the sizes you use.

| Fallback to                                                                     | `fallback:`                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GitHub-hosted Linux x64 / arm64                                                 | `ubuntu-latest` · `ubuntu-24.04` · `ubuntu-24.04-arm`               |
| GitHub-hosted macOS / Windows                                                   | `macos-15` · `macos-latest` · `windows-latest`                      |
| GitHub larger runners (by group)                                                | `{"group": "larger-runners", "labels": ["ubuntu-24.04-16core"]}`    |
| [Blacksmith](https://docs.blacksmith.sh)                                        | `blacksmith-4vcpu-ubuntu-2404` · `blacksmith-4vcpu-ubuntu-2404-arm` |
| [Depot](https://depot.dev/docs/github-actions/overview)                         | `depot-ubuntu-24.04` · `depot-ubuntu-24.04-arm`                     |
| [Namespace](https://namespace.so/docs/solutions/github-actions)                 | `namespace-profile-default`                                         |
| [WarpBuild](https://docs.warpbuild.com)                                         | `warp-ubuntu-latest-x64-4x`                                         |
| [Ubicloud](https://www.ubicloud.com/docs/github-actions-integration/quickstart) | `ubicloud-standard-4`                                               |
| [RunsOn](https://runs-on.com) (labels carry the run id)                         | `runs-on=${{ github.run_id }}/runner=4cpu-linux-x64`                |

**Homelab first, Blacksmith when it is busy or offline**

```yaml
- id: select
  uses: meabed/select-runner@v1
  with:
    labels: self-hosted, linux, x64
    fallback: blacksmith-4vcpu-ubuntu-2404
    app-client-id: ${{ vars.RUNNERS_APP_CLIENT_ID }}
    app-private-key: ${{ secrets.RUNNERS_APP_PRIVATE_KEY }}
```

**iOS builds on your own Mac, GitHub macOS otherwise** — and only pay for the setup the hosted image needs:

```yaml
jobs:
  select-runner:
    runs-on: ubuntu-latest
    outputs:
      runs-on: ${{ steps.select.outputs.runs-on }}
      self-hosted: ${{ steps.select.outputs.self-hosted }}
    steps:
      - id: select
        uses: meabed/select-runner@v1
        with:
          labels: self-hosted, macOS, ARM64
          fallback: macos-15
          scope: repo
          token: ${{ secrets.RUNNERS_READ_TOKEN }}

  ios:
    needs: select-runner
    runs-on: ${{ fromJSON(needs.select-runner.outputs.runs-on) }}
    steps:
      - uses: actions/checkout@v7
      - name: Select Xcode (hosted image only)
        if: needs.select-runner.outputs.self-hosted != 'true'
        run: sudo xcode-select -s /Applications/Xcode_16.4.app
```

**Hosted arm64 for tests, a provider's x64 for image builds, both preferring self-hosted**

```yaml
steps:
  - id: test
    uses: meabed/select-runner@v1
    with:
      labels: self-hosted, arm64
      fallback: ubuntu-24.04-arm
      token: ${{ secrets.RUNNERS_READ_TOKEN }}
  - id: build
    uses: meabed/select-runner@v1
    with:
      labels: self-hosted, x64
      fallback: depot-ubuntu-24.04
      token: ${{ secrets.RUNNERS_READ_TOKEN }}
```

## Inputs

| Input                              | Default                   | Description                                                                                                                                                         |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labels`                           |                           | Labels a runner must all carry; also the `runs-on` value when selected. Comma or newline separated. Empty (and no `group`) = self-hosted off, the fallback is used. |
| `group`                            |                           | Runner group name; only its runners count and `runs-on` becomes `{ group, labels }`. Org scope.                                                                     |
| `fallback`                         | `ubuntu-latest`           | `runs-on` when no self-hosted runner is available: label, comma list, or JSON string/array/`{ group, labels }`.                                                     |
| `min-idle`                         | `1`                       | Runners that must be available before self-hosted is chosen.                                                                                                        |
| `match`                            | `idle`                    | `idle` counts online, non-busy runners; `online` counts busy ones too.                                                                                              |
| `force`                            | `auto`                    | `auto`, `self-hosted` (always the labels), or `fallback` (always the fallback).                                                                                     |
| `scope`                            | `org`                     | `org` or `repo` runners.                                                                                                                                            |
| `owner`                            | `github.repository_owner` | Organization/user that owns the runners.                                                                                                                            |
| `repository`                       | `github.repository`       | `owner/repo` for `scope: repo`.                                                                                                                                     |
| `app-client-id`, `app-private-key` |                           | GitHub App credentials (preferred).                                                                                                                                 |
| `token`                            |                           | Token that can read runners, used without App credentials.                                                                                                          |
| `fail-on-error`                    | `false`                   | Fail the step on API/credential errors instead of falling back.                                                                                                     |
| `summary`                          | `true`                    | Write the decision to the job summary.                                                                                                                              |
| `github-api-url`                   | `github.api_url`          | REST API base URL (GHES).                                                                                                                                           |

## Outputs

| Output            | Example                        | Description                                   |
| ----------------- | ------------------------------ | --------------------------------------------- |
| `runs-on`         | `["self-hosted","arm64"]`      | JSON for `runs-on: ${{ fromJSON(...) }}`.     |
| `self-hosted`     | `true`                         | Whether the self-hosted labels were selected. |
| `idle` / `online` | `2` / `3`                      | Matching runners that are idle / online.      |
| `reason`          | `self-hosted: 2 idle (need 1)` | Why.                                          |

## How it decides

1. `force` set, or no `labels`/`group` → that choice (or the fallback), no API call.
2. Otherwise list every runner of the org (or repo), keep those carrying **all** `labels` (and in `group`, if set), count the online and the idle ones.
3. `idle` (or `online` with `match: online`) ≥ `min-idle` → the labels; else the fallback.

Two workflows that start at the same moment can both see the last idle runner; one of them then waits for it. Raise `min-idle` if that matters to you.

## Development

```bash
bun install        # also installs the pre-commit hook (secret scan, lint, format, typecheck, test, rebuild dist/)
bun test
bun run verify     # lint + format + typecheck + tests + build, and dist/ must be committed
```

`dist/index.mjs` is the bundled action (`bun run build`) and is committed. Releases are cut by semantic-release from conventional commits on `master`; the moving major tag (`v1`) follows the latest release.

## License

MIT
