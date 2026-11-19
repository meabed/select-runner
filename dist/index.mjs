// src/main.ts
import { appendFileSync } from "node:fs";

// src/config.ts
function readInput(name, env = process.env) {
  return (env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "").trim();
}
function parseList(value) {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}
function isRunsOnObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const { group, labels } = value;
  return typeof group === "string" && (labels === undefined || Array.isArray(labels) && labels.every((label) => typeof label === "string"));
}
function parseRunsOn(value) {
  if (!/^[[{"]/.test(value)) {
    const labels = parseList(value);
    if (!labels.length)
      throw new Error("fallback is empty");
    return labels.length === 1 ? labels[0] : labels;
  }
  const parsed = JSON.parse(value);
  if (typeof parsed === "string" && parsed)
    return parsed;
  if (Array.isArray(parsed) && parsed.length && parsed.every((label) => typeof label === "string"))
    return parsed;
  if (isRunsOnObject(parsed))
    return parsed;
  throw new Error(`fallback is not a valid runs-on value: ${value}`);
}
function oneOf(name, value, allowed, fallback) {
  if (!value)
    return fallback;
  if (allowed.includes(value))
    return value;
  throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
}
function readConfig(env = process.env) {
  const input = (name) => readInput(name, env);
  const labels = parseList(input("labels"));
  const group = input("group");
  const minIdle = Number(input("min-idle") || "1");
  if (!Number.isInteger(minIdle) || minIdle < 1)
    throw new Error(`min-idle must be a positive integer (got "${input("min-idle")}")`);
  const repository = input("repository") || env.GITHUB_REPOSITORY || "";
  return {
    labels,
    group,
    fallback: parseRunsOn(input("fallback") || "ubuntu-latest"),
    minIdle,
    match: oneOf("match", input("match"), ["idle", "online"], "idle"),
    force: oneOf("force", input("force"), ["auto", "self-hosted", "fallback"], "auto"),
    scope: oneOf("scope", input("scope"), ["org", "repo"], "org"),
    owner: input("owner") || env.GITHUB_REPOSITORY_OWNER || repository.split("/")[0] || "",
    repository,
    appClientId: input("app-client-id"),
    appPrivateKey: input("app-private-key").replaceAll(String.raw`\n`, `
`),
    token: input("token"),
    failOnError: input("fail-on-error") === "true",
    summary: input("summary") !== "false",
    apiUrl: (input("github-api-url") || env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "")
  };
}

// src/github.ts
import { createPrivateKey, sign } from "node:crypto";
async function request(api, path, token, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(`${api.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "select-runner"
    },
    body: init.body && JSON.stringify(init.body)
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.status === 204 ? undefined : await response.json();
}
function appJwt(clientId, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), createPrivateKey(privateKeyPem)).toString("base64url")}`;
}
async function mintInstallationToken(config) {
  const jwt = appJwt(config.appClientId, config.appPrivateKey);
  const repoName = config.repository.split("/")[1] ?? "";
  const installation = await request(config, config.scope === "org" ? `/orgs/${config.owner}/installation` : `/repos/${config.repository}/installation`, jwt);
  const body = config.scope === "org" ? { permissions: { organization_self_hosted_runners: "read" } } : { permissions: { administration: "read" }, repositories: [repoName] };
  const { token } = await request(config, `/app/installations/${installation.id}/access_tokens`, jwt, { method: "POST", body });
  return token;
}
async function revokeInstallationToken(api, token) {
  await request(api, "/installation/token", token, { method: "DELETE" });
}
async function listRunners(config, token) {
  const base = config.scope === "org" ? `/orgs/${config.owner}/actions/runners` : `/repos/${config.repository}/actions/runners`;
  const runners = [];
  for (let page = 1;; page++) {
    const batch = await request(config, `${base}?per_page=100&page=${page}`, token);
    runners.push(...batch.runners);
    if (batch.runners.length < 100 || runners.length >= batch.total_count)
      return runners;
  }
}
async function findRunnerGroupId(config, token, name) {
  const groups = [];
  for (let page = 1;; page++) {
    const batch = await request(config, `/orgs/${config.owner}/actions/runner-groups?per_page=100&page=${page}`, token);
    groups.push(...batch.runner_groups);
    if (batch.runner_groups.length < 100 || groups.length >= batch.total_count)
      break;
  }
  const group = groups.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!group)
    throw new Error(`runner group "${name}" not found in ${config.owner}`);
  return group.id;
}

// src/select.ts
function selfHostedRunsOn({ labels, group }) {
  if (group)
    return labels.length ? { group, labels } : { group };
  return labels;
}
function matchesLabels(runner, labels) {
  const have = new Set(runner.labels.map((label) => label.name.toLowerCase()));
  return labels.every((label) => have.has(label.toLowerCase()));
}
function countRunners(runners, labels, groupId) {
  const matching = runners.filter((runner) => matchesLabels(runner, labels) && (groupId === undefined || runner.runner_group_id === groupId));
  const online = matching.filter((runner) => runner.status === "online");
  return { online: online.length, idle: online.filter((runner) => !runner.busy).length };
}
function selectRunner(input) {
  if (!input.labels.length && !input.group)
    return { selfHosted: false, runsOn: input.fallback, idle: 0, online: 0, reason: "fallback: no self-hosted labels or group configured" };
  const { idle, online } = countRunners(input.runners, input.labels, input.groupId);
  const target = selfHostedRunsOn(input);
  if (input.force === "self-hosted")
    return { selfHosted: true, runsOn: target, idle, online, reason: "forced to self-hosted" };
  if (input.force === "fallback")
    return { selfHosted: false, runsOn: input.fallback, idle, online, reason: "forced to fallback" };
  const available = input.match === "idle" ? idle : online;
  const counted = `${available} ${input.match} (need ${input.minIdle})`;
  return available >= input.minIdle ? { selfHosted: true, runsOn: target, idle, online, reason: `self-hosted: ${counted}` } : { selfHosted: false, runsOn: input.fallback, idle, online, reason: `fallback: ${counted}` };
}
function fallbackDecision(input, reason) {
  return { selfHosted: false, runsOn: input.fallback, idle: 0, online: 0, reason };
}

// src/main.ts
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file)
    return console.log(`${name}=${value}`);
  const delimiter = `select_runner_${crypto.randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}
function describe(runsOn) {
  return typeof runsOn === "string" ? runsOn : JSON.stringify(runsOn);
}
function writeSummary(config, decision) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!config.summary || !file)
    return;
  const rows = [
    ["Selected", decision.selfHosted ? "self-hosted" : "fallback"],
    ["runs-on", `\`${describe(decision.runsOn)}\``],
    ["Self-hosted target", `\`${describe(selfHostedRunsOn(config))}\` (${config.scope} ${config.scope === "org" ? config.owner : config.repository})`],
    ["Matching runners", `${decision.idle} idle / ${decision.online} online`],
    ["Reason", decision.reason]
  ];
  appendFileSync(file, `### Runner selection

| | |
| --- | --- |
${rows.map(([key, value]) => `| ${key} | ${value} |`).join(`
`)}

`);
}
async function decide(config) {
  if (config.force !== "auto" || !config.labels.length && !config.group)
    return selectRunner({ ...config, runners: [] });
  const useApp = Boolean(config.appClientId && config.appPrivateKey);
  const token = useApp ? await mintInstallationToken(config) : config.token;
  if (!token)
    throw new Error("no credentials: set app-client-id + app-private-key, or token");
  console.log(`::add-mask::${token}`);
  try {
    const groupId = config.group && config.scope === "org" ? await findRunnerGroupId(config, token, config.group) : undefined;
    return selectRunner({ ...config, runners: await listRunners(config, token), groupId });
  } finally {
    if (useApp)
      await revokeInstallationToken(config, token).catch(() => {
        return;
      });
  }
}
async function run() {
  const config = readConfig();
  const decision = await decide(config).catch((error) => {
    if (config.failOnError)
      throw error;
    console.log(`::warning title=select-runner::${error.message} — using the fallback runner`);
    return fallbackDecision(config, `fallback: ${error.message}`);
  });
  console.log(`${decision.reason} → runs-on: ${describe(decision.runsOn)}`);
  setOutput("runs-on", JSON.stringify(decision.runsOn));
  setOutput("self-hosted", String(decision.selfHosted));
  setOutput("idle", String(decision.idle));
  setOutput("online", String(decision.online));
  setOutput("reason", decision.reason);
  writeSummary(config, decision);
}
await run().catch((error) => {
  console.log(`::error title=select-runner::${error.message}`);
  process.exitCode = 1;
});
