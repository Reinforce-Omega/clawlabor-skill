// Labor mode commands: hire a worker, serve a worker, chat with a hire.
//
// Unit convention: labor is sold BY THE DAY. The API schema is day-facing and
// converts to seconds at its service/DB boundary. See docs/2026-06-16-labor-technical-solution.md.
const { spawnSync } = require("node:child_process");
const dns = require("node:dns").promises;
const https = require("node:https");
const {
  resolveClaudeCodeAccount,
  resolveClaudeCodeOauthToken,
} = require("../claude_auth");
const { apiBase, envWithApiKey, request, requestJson, resolveApiKey } = require("../http");
const { numberOption, positiveNumberOption, requiredOption } = require("../options");

const LABOR_STATUSES = new Set(["draft", "available", "occupied", "inactive", "all"]);
const DEFAULT_DAILY_RATE_UAT = 50;
const PLAN_MONTHLY_COST_UAT = {
  pro: 20 * 10, // $20/month = 200 UAT/month
  team: 50 * 10, // $50/month = 500 UAT/month
  enterprise: 200 * 10, // $200/month = 2000 UAT/month
};
const LABOR_CONTROL_TIMEOUT_MS = 10_000;
const CLOUDFLARE_RESOLVERS = ["1.1.1.1", "1.0.0.1"];
const DEFAULT_GATEKEEPER_PROMPT = "Accept only safe, legal, well-scoped requests that can be completed by this local agent. Refuse requests requiring private credentials, illegal activity, or work outside the published description.";
const NANO_FACTOR = 1e9;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function dockerName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function opencodeAuthPath(env) {
  const path = require("path");
  const os = require("os");
  const base = (env && env.XDG_DATA_HOME) || path.join((env && env.HOME) || os.homedir(), ".local", "share");
  return path.join(base, "opencode", "auth.json");
}

function runtimeStateMounts(runtime, hireId) {
  const source = `clawlabor-hire-${dockerName(hireId)}-state`;
  const targets = {
    claude: ["/home/sandbox/.claude"],
    codex: ["/home/sandbox/.codex"],
    opencode: ["/home/sandbox/.local/share/opencode"],
  }[runtime] || [];
  return targets.map((target) => ({ source, target, type: "volume" }));
}

function runtimeStateInitCommand(mounts, { excludePaths = [] } = {}) {
  const targets = [
    "/home/sandbox/.local",
    "/home/sandbox/.cache",
    "/home/sandbox/.config",
    ...mounts.map((m) => m.target),
  ];
  if (targets.length === 0) return "true";
  const quoted = targets.map(shellQuote).join(" ");
  const excludes = excludePaths.map((p) => `! -path ${shellQuote(p)}`).join(" ");
  const recursiveChowns = targets
    .map((target) => `find ${shellQuote(target)} -mindepth 1 ${excludes} -exec chown sandbox:sandbox {} +`)
    .join(" && ");
  // Docker creates named volumes as root-owned directories. The runtime agents
  // run as the sandbox user, so normalize ownership before agent startup. Some
  // credentials are mounted read-only under these dirs and must be skipped.
  return `mkdir -p ${quoted} && chown sandbox:sandbox ${quoted} && ${recursiveChowns}`;
}

function sandboxUserCommand(command) {
  return `setpriv --reuid=sandbox --regid=sandbox --init-groups env HOME=/home/sandbox ${command}`;
}

function dockerContainerRunning(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && String(result.stdout || "").trim() === "true";
}

function hireStateVolumeName(hireId) {
  return `clawlabor-hire-${dockerName(hireId)}-state`;
}

function dockerVolumeExists(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["volume", "inspect", name], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function dockerRemoveVolume(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["volume", "rm", name], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function dockerListHireStateVolumes(deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run(
    "docker",
    ["volume", "ls", "--filter", "name=clawlabor-hire-", "--format", "{{.Name}}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("clawlabor-hire-") && line.endsWith("-state"));
}

function hireIdFromVolumeName(volumeName) {
  const m = /^clawlabor-hire-(.+)-state$/.exec(volumeName);
  return m ? m[1] : null;
}

// What to inject into the per-hire `docker run` so the runtime can authenticate.
// Returns { env: {NAME: value}, mounts: [{host, container, ro}] }. Throws a clear
// error if the runtime's local credentials are missing. Never reads secret content.
async function resolveRuntimeSandboxCredentials(runtime, deps) {
  if (runtime === "claude") {
    const claudeOauth = await resolveClaudeCodeOauthToken(deps);
    if (!claudeOauth.token) {
      const authHint = claudeOauth.authStatusOk
        ? "Claude Code is logged in, but no fresh local claude.ai OAuth token was available. Open Claude Code once or wait for any Claude session limit to reset, then retry."
        : "Run `claude auth status` and make sure it shows authMethod claude.ai with an active subscription.";
      throw new Error(`labor-serve requires a working local Claude Code claude.ai subscription login. ${authHint}`);
    }
    return { env: { CLAUDE_CODE_OAUTH_TOKEN: claudeOauth.token }, mounts: [] };
  }
  if (runtime === "opencode") {
    const fs = deps.fs || require("fs");
    const authPath = opencodeAuthPath(deps.env);
    if (!fs.existsSync(authPath)) {
      throw new Error(`labor-serve --runtime opencode needs local OpenCode credentials at ${authPath}. Run \`opencode auth login\` first.`);
    }
    return {
      env: {},
      mounts: [{ host: authPath, container: "/home/sandbox/.local/share/opencode/auth.json", ro: true }],
    };
  }
  throw new Error(`labor-serve does not support --runtime ${runtime}`);
}

async function resolveViaCloudflare(hostname) {
  const previous = dns.getServers();
  try {
    dns.setServers(CLOUDFLARE_RESOLVERS);
    const [v4, v6] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);
    return [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
  } finally {
    try { dns.setServers(previous); } catch (_err) { /* noop */ }
  }
}

function httpsGetViaResolvedIp(url, token, ip) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const family = ip.includes(":") ? 6 : 4;
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: ip,
        family,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Host: parsed.hostname,
        },
        servername: parsed.hostname,
        timeout: LABOR_CONTROL_TIMEOUT_MS,
      },
      (resp) => {
        resp.resume();
        resp.once("end", () => resolve(resp.statusCode >= 200 && resp.statusCode < 300));
      },
    );
    req.once("timeout", () => req.destroy(new Error("health probe timeout")));
    req.once("error", () => resolve(false));
    req.end();
  });
}

async function probePublicHealthWithDnsFallback(url, token) {
  try {
    const ips = await resolveViaCloudflare(new URL(url).hostname);
    for (const ip of ips) {
      if (await httpsGetViaResolvedIp(url, token, ip)) return true;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

function commandProbe(deps, command, args = ["--version"]) {
  const run = deps.spawnSync || spawnSync;
  const pathResult = run("sh", ["-c", 'command -v "$1"', "sh", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = run(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onPath = pathResult.status === 0;
  return {
    status: result.status === 0 ? "pass" : "fail",
    command,
    on_path: onPath,
    path: onPath ? pathResult.stdout.trim() || null : null,
    version: result.status === 0
      ? (result.stdout || result.stderr || "").trim() || null
      : null,
    error: result.status === 0
      ? null
      : (result.stderr || result.stdout || (result.error && result.error.message) || "").trim() || null,
  };
}

function runtimeAgent({
  hostPlan = null,
  hostAccount = null,
  id,
  name,
  runtime,
  command,
  probe,
  readyToServe,
  serveStatus,
  requirements,
  publishName,
}) {
  const suggestedDailyRate = hostPlan && PLAN_MONTHLY_COST_UAT[hostPlan?.toLowerCase()]
    ? Math.ceil(PLAN_MONTHLY_COST_UAT[hostPlan.toLowerCase()] / 30)
    : DEFAULT_DAILY_RATE_UAT;
  const installed = probe.status === "pass";
  return {
    id,
    name,
    runtime,
    command,
    present_on_path: probe.on_path,
    installed,
    runnable: installed,
    path: probe.path,
    version: probe.version,
    ready_to_publish: installed,
    ready_to_serve: readyToServe,
    serve_status: serveStatus,
    host_account: hostAccount || null,
    suggested_daily_rate_uat: suggestedDailyRate,
    requirements,
    publish_command_template: [
      "clawlabor labor-publish",
      `--name ${shellQuote(publishName)}`,
      `--description ${shellQuote(`${publishName}${hostPlan ? ` (${hostPlan} plan)` : ""} backed by the local ${name} runtime.`)}`,
      `--daily-rate ${suggestedDailyRate}`,
    ].join(" "),
  };
}

function shortRuntimeStatus(agent) {
  if (agent.ready_to_serve) return "ready_to_serve";
  if (agent.ready_to_publish) return "publish_only";
  if (agent.present_on_path) return "needs_repair";
  return "not_installed";
}

function missingRequirementNames(agent) {
  return (agent.requirements || [])
    .filter((item) => item.status !== "pass")
    .map((item) => item.name);
}

function compactHostAccount(account) {
  if (!account || !account.logged_in) {
    return { provider: "claude", status: "not_logged_in" };
  }
  const compact = {
    provider: account.provider,
    label: account.label || account.email || account.org_name || null,
    plan: account.plan || null,
  };
  if (account.quota) {
    compact.quota = account.quota;
  }
  return compact;
}

function nanoToUatDisplay(nano) {
  if (nano === null || nano === undefined) return null;
  const whole = Math.trunc(Number(nano) / NANO_FACTOR);
  const frac = Math.trunc((Number(nano) % NANO_FACTOR) * 100 / NANO_FACTOR);
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

function summarizeLaborAgent(agent, existingLaborByRuntime) {
  const missing = missingRequirementNames(agent);
  const existing = existingLaborByRuntime[agent.runtime] || null;
  const publishCommand = agent.publish_command_template;
  const summary = {
    runtime: agent.runtime,
    name: agent.name,
    status: shortRuntimeStatus(agent),
    can_publish: agent.ready_to_publish,
    suggested_daily_rate_uat: agent.suggested_daily_rate_uat,
    can_serve: agent.ready_to_serve,
  };
  if (missing.length > 0) {
    summary.needs = missing;
  }
  if (agent.ready_to_publish) {
    summary.publish_command = publishCommand;
  }
  if (existing) {
    summary.labor_id = existing.id;
    summary.labor_status = existing.status;
  }
  if (agent.ready_to_serve) {
    summary.start_command = `clawlabor labor-start --runtime ${agent.runtime}`;
  }
  return summary;
}

async function currentMarketplaceAgent(deps) {
  try {
    const me = await requestJson(deps, "GET", "/agents/me");
    const agent = me.agent || me;
    return {
      status: "authenticated",
      id: agent.id || null,
      agent_id: agent.agent_id || null,
      name: agent.name || null,
      owner_email: agent.owner_email || null,
      balance: agent.balance ?? null,
      frozen: agent.frozen ?? null,
      is_online: Boolean(agent.is_online),
    };
  } catch (err) {
    return {
      status: "unavailable",
      id: null,
      agent_id: null,
      name: null,
      owner_email: null,
      balance: null,
      frozen: null,
      is_online: false,
      api_base: apiBase(deps.env),
      error: err.message,
      error_code: err.errorCode || "cli_error",
    };
  }
}

function compactMarketplaceAgent(agent) {
  if (!agent || agent.status !== "authenticated") {
    return {
      status: "unavailable",
      api_base: agent && agent.api_base ? agent.api_base : null,
      reason: agent && agent.error_code ? agent.error_code : "unknown",
      next: "Run clawlabor auth status.",
    };
  }
  const compact = {
    status: "authenticated",
    name: agent.name,
    // /agents/me already returns balance/frozen as UAT 2-decimal strings
    // (server-side nano_to_uat_display). Pass through; do NOT convert again.
    balance: agent.balance,
    online: agent.is_online,
  };
  if (agent.frozen !== null && agent.frozen !== undefined) {
    compact.frozen = agent.frozen;
  }
  return compact;
}

async function activeLaborResourcesForRuntime(deps, runtime) {
  const list = await requestJson(deps, "GET", "/labor/list?limit=100");
  const me = await requestJson(deps, "GET", "/agents/me");
  const owner = me.agent || me;
  const ownerId = owner && owner.id ? String(owner.id) : null;
  return (list.items || []).filter((item) =>
    String(item.seller_agent_id) === ownerId &&
    item.runtime === runtime &&
    ["draft", "available", "occupied"].includes(item.status),
  );
}

async function currentSellerLaborResources(deps, marketplaceAgent) {
  if (!marketplaceAgent || marketplaceAgent.status !== "authenticated" || !marketplaceAgent.id) {
    return [];
  }
  try {
    const list = await requestJson(deps, "GET", "/labor/list?limit=100");
    return (list.items || []).filter((item) =>
      String(item.seller_agent_id) === String(marketplaceAgent.id) &&
      ["draft", "available", "occupied"].includes(item.status),
    );
  } catch (_err) {
    return [];
  }
}

function existingLaborByRuntime(resources) {
  const byRuntime = {};
  for (const resource of resources) {
    if (resource.runtime && !byRuntime[resource.runtime]) {
      byRuntime[resource.runtime] = resource;
    }
  }
  return byRuntime;
}

async function claudeRuntimeAgent(deps) {
  const claudeOauth = await resolveClaudeCodeOauthToken(deps);
  const claudeAccount = await resolveClaudeCodeAccount(deps);
  const claude = commandProbe(deps, "claude");
  const docker = commandProbe(deps, "docker");
  const cloudflared = commandProbe(deps, "cloudflared");
  const sharedServeRequirements = [
    {
      name: "docker",
      status: docker.status,
      command: "docker --version",
      version: docker.version,
      detail: docker.status === "pass"
        ? "Docker CLI is available"
        : "Install/start Docker Desktop before running labor-serve",
    },
    {
      name: "cloudflared",
      status: cloudflared.status,
      command: "cloudflared --version",
      version: cloudflared.version,
      detail: cloudflared.status === "pass"
        ? "cloudflared is available"
        : "Install cloudflared before running labor-serve",
    },
  ];
  const claudeRequirements = [
    {
      name: "claude_cli",
      status: claude.status,
      command: "claude --version",
      version: claude.version,
      detail: claude.status === "pass"
        ? "Claude Code CLI is available"
        : "Install Claude Code before publishing this labor runtime",
    },
    {
      name: "claude_code_oauth",
      status: claudeOauth.token ? "pass" : "fail",
      detail: claudeOauth.token
        ? "Claude Code claude.ai OAuth token is available"
        : claudeOauth.authStatusOk
          ? "Claude Code auth status passed, but no fresh local claude.ai OAuth token was available"
          : "Run `claude auth status` and make sure it shows authMethod claude.ai with an active subscription.",
    },
    ...sharedServeRequirements,
  ];
  const claudeReadyToServe = claudeRequirements.every((item) => item.status === "pass");
  return runtimeAgent({
    id: "claude-code-sandbox",
    name: "Claude Code Sandbox",
    runtime: "claude",
    command: "claude",
    probe: claude,
    readyToServe: claudeReadyToServe,
    serveStatus: claudeReadyToServe
      ? "supported"
      : "missing_requirements",
    requirements: claudeRequirements,
    publishName: "Claude Code Labor",
    hostAccount: claudeAccount,
    hostPlan: claudeAccount.plan,
  });
}

// ---------------------------------------------------------------------------
// labor-agents — inspect local runtimes that can back a labor listing
// ---------------------------------------------------------------------------
async function commandLaborAgents(_options, deps, flags) {
  const marketplaceAgent = await currentMarketplaceAgent(deps);
  const existingLabor = existingLaborByRuntime(
    await currentSellerLaborResources(deps, marketplaceAgent),
  );
  const claudeAgent = await claudeRuntimeAgent(deps);
  const codex = commandProbe(deps, "codex");
  const opencode = commandProbe(deps, "opencode");
  const opencodeAuthPresent = opencode.status === "pass" && (deps.fs || require("fs")).existsSync(opencodeAuthPath(deps.env));
  const agents = [
    claudeAgent,
    runtimeAgent({
      id: "codex-sandbox",
      name: "Codex Sandbox",
      runtime: "codex",
      command: "codex",
      probe: codex,
      readyToServe: false,
      serveStatus: codex.status === "pass"
        ? "candidate_not_wired_to_labor_serve"
        : "not_installed",
      requirements: [
        {
          name: "codex_cli",
          status: codex.status,
          command: "codex --version",
          version: codex.version,
          detail: codex.status === "pass"
            ? "Codex CLI is installed locally; Clawlabor labor-serve is not wired to start Codex-backed sandbox sessions yet"
            : codex.on_path
              ? "Codex CLI is on PATH but failed to run; repair the local Codex install before publishing a Codex-backed labor runtime"
              : "Install Codex CLI before publishing a Codex-backed labor runtime",
          error: codex.error,
        },
      ],
      publishName: "Codex Labor",
    }),
    runtimeAgent({
      id: "opencode-sandbox",
      name: "OpenCode Sandbox",
      runtime: "opencode",
      command: "opencode",
      probe: opencode,
      readyToServe: opencodeAuthPresent,
      serveStatus: opencodeAuthPresent
        ? "ready_to_serve"
        : opencode.status === "pass"
          ? "needs_opencode_auth"
          : "not_installed",
      requirements: [
        {
          name: "opencode_cli",
          status: opencode.status,
          command: "opencode --version",
          version: opencode.version,
          detail: opencode.status === "pass"
            ? "OpenCode CLI is installed locally"
            : opencode.on_path
              ? "OpenCode CLI is on PATH but failed to run; repair the local OpenCode install before publishing an OpenCode-backed labor runtime"
              : "Install OpenCode CLI before publishing an OpenCode-backed labor runtime",
          error: opencode.error,
        },
        {
          name: "opencode_auth",
          status: opencodeAuthPresent ? "pass" : "fail",
          detail: opencodeAuthPresent
            ? "OpenCode auth.json found; labor-serve will mount it read-only into the sandbox"
            : "Run `opencode auth login` so labor-serve can pass your provider credentials into the sandbox",
        },
      ],
      publishName: "OpenCode Labor",
    }),
  ];
  const verbose = Boolean(_options.verbose) || Boolean(flags && flags.has && flags.has("verbose"));
  if (verbose) {
    return JSON.stringify(
      {
        action: "labor-agents",
        agents,
        marketplace_agent: marketplaceAgent,
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      action: "labor-agents",
      account: compactMarketplaceAgent(marketplaceAgent),
      host: {
        claude: compactHostAccount(claudeAgent.host_account),
      },
      agents: agents.map((agent) => summarizeLaborAgent(agent, existingLabor)),
      next_actions: [
        "Use labor-publish to list a ready runtime.",
        "Use labor-list to inspect existing labor.",
        "Use labor-agents --verbose for diagnostics.",
      ],
    },
    null,
    2,
  );
}

function compactLaborResource(resource) {
  const id = resource.id;
  return {
    id: resource.id,
    name: resource.name,
    status: resource.status,
    serve_status: resource.serve_status,
    daily_rate_uat: nanoToUatDisplay(resource.daily_rate_nano),
    tier: resource.tier,
    seller_agent_id: resource.seller_agent_id,
    host_account_provider: resource.host_account_provider || null,
    host_account_id: resource.host_account_id || null,
    host_account_label: resource.host_account_label || null,
    host_account_plan: resource.host_account_plan || null,
    host_account_quota: resource.host_account_quota || null,
    last_heartbeat_at: resource.last_heartbeat_at || null,
    sandbox_base_url: resource.sandbox_base_url || null,
    created_at: resource.created_at,
    updated_at: resource.updated_at,
    management_commands: {
      serve_command: `clawlabor labor-serve --labor ${id}`,
      unpublish_command: `clawlabor labor-unpublish --labor ${id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// labor-list — list current seller's labor resources (or all public resources)
// ---------------------------------------------------------------------------
async function commandLaborList(options, deps, flags) {
  const showAll = flags && flags.has && flags.has("all");
  const status = options.status || "available";
  if (!LABOR_STATUSES.has(status)) {
    throw new Error(
      `Invalid --status "${status}". Use draft, available, occupied, inactive, or all.`,
    );
  }
  const limit = positiveNumberOption(options, "limit") || 100;
  const params = new URLSearchParams();
  params.set("limit", String(Math.min(limit, 100)));
  if (options.cursor) params.set("cursor", options.cursor);
  if (status !== "all") params.set("status", status);

  const list = await requestJson(deps, "GET", `/labor/list?${params.toString()}`);
  let owner = null;
  if (!showAll) {
    const me = await requestJson(deps, "GET", "/agents/me");
    owner = me.agent || me;
  }
  const ownerId = owner && owner.id ? String(owner.id) : null;
  const items = (list.items || [])
    .filter((item) => showAll || String(item.seller_agent_id) === ownerId)
    .map(compactLaborResource);

  return JSON.stringify(
    {
      action: "labor-list",
      scope: showAll ? "all" : "mine",
      status,
      count: items.length,
      items,
      management_commands: {
        serve_command: "clawlabor labor-serve --labor <labor_resource_id>",
        unpublish_command: "clawlabor labor-unpublish --labor <labor_resource_id>",
        inspect_command: "clawlabor labor-list",
      },
      next_cursor: list.next_cursor || null,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// hire — buy exclusive use of a labor resource for one day
// ---------------------------------------------------------------------------
async function commandHire(options, deps) {
  const listing = requiredOption(options, "listing");
  // v1: rentals are exactly one day (multi-day not yet supported).
  const body = { labor_resource_id: listing, duration_days: 1 };
  if (options.message) {
    body.message = options.message;
  }
  const hire = await requestJson(deps, "POST", "/labor/hire", { body });
  return JSON.stringify(
    {
      action: "hire",
      hire_id: hire.id,
      status: hire.status,
      labor_resource_id: hire.labor_resource_id,
      duration_days: hire.duration_days,
      frozen_nano: hire.frozen_nano,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// labor-publish — create a labor resource and publish it (available)
// ---------------------------------------------------------------------------
async function commandLaborPublish(options, deps) {
  const name = requiredOption(options, "name");
  const description = requiredOption(options, "description");
  const dailyRate = positiveNumberOption(options, "daily-rate");
  if (dailyRate === undefined) {
    throw new Error("Missing required --daily-rate");
  }
  const runtime = options.runtime || "claude";
  if (!["claude", "opencode"].includes(runtime)) {
    throw new Error(`labor-publish supports --runtime claude or opencode; ${runtime} has no labor-serve support yet.`);
  }
  const existing = await activeLaborResourcesForRuntime(deps, runtime);
  if (existing.length > 0) {
    const ids = existing.map((item) => `${item.id}(${item.status})`).join(", ");
    throw new Error(
      `Already have an active ${runtime} labor: ${ids}. ` +
      "Use `clawlabor labor-list` to inspect it or `clawlabor labor-unpublish --labor <id>` before publishing again.",
    );
  }
  const hostAccount = runtime === "claude" ? await resolveClaudeCodeAccount(deps) : null;
  const body = {
    name,
    description,
    runtime,
    daily_rate_uat: dailyRate,
    min_duration_days: 1,
    max_duration_days: 1,
    tier: options.tier || "tier_1",
  };
  if (runtime === "claude" && hostAccount && hostAccount.provider === "claude" && hostAccount.logged_in && hostAccount.id) {
    body.host_account_provider = hostAccount.provider;
    body.host_account_id = hostAccount.id;
    body.host_account_label = hostAccount.label;
    body.host_account_plan = hostAccount.plan;
    body.host_account_quota = hostAccount.quota;
  }
  body.gatekeeper_prompt = options.gatekeeper || DEFAULT_GATEKEEPER_PROMPT;
  const created = await requestJson(deps, "POST", "/labor", { body });
  const published = await requestJson(deps, "PUT", `/labor/${created.id}`, {
    body: { status: "available" },
  });
  return JSON.stringify(
    {
      action: "labor-publish",
      labor_resource_id: created.id,
      status: published.status,
      name: published.name,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// labor-start — put a supported local runtime on duty: publish if needed, then serve
// ---------------------------------------------------------------------------
async function commandLaborStart(options, deps) {
  const runtime = options.runtime || "claude";

  const marketplaceAgent = await currentMarketplaceAgent(deps);
  if (marketplaceAgent.status !== "authenticated") {
    throw new Error("Authenticate before starting labor. Run `clawlabor auth status`.");
  }

  // Readiness: reuse the labor-agents inventory for the chosen runtime.
  const inventory = JSON.parse(await commandLaborAgents({}, deps));
  const agent = (inventory.agents || []).find((a) => a.runtime === runtime);
  if (!agent || !agent.can_serve) {
    const needs = (agent && agent.needs) ? agent.needs.join(", ") : "runtime not serveable";
    throw new Error(`Cannot start ${runtime} labor yet; ${needs}. Run \`clawlabor labor-agents --verbose\` for diagnostics.`);
  }

  const existing = existingLaborByRuntime(
    await currentSellerLaborResources(deps, marketplaceAgent),
  )[runtime];
  let laborId = existing && existing.id;
  if (!laborId) {
    const defaults = {
      claude: { name: "Claude Code Labor", description: "Claude Code Labor backed by the local Claude Code Sandbox runtime." },
      opencode: { name: "OpenCode Labor", description: "OpenCode Labor backed by the local OpenCode Sandbox runtime." },
    }[runtime] || { name: `${runtime} Labor`, description: `${runtime} Labor backed by the local sandbox runtime.` };
    const publishOut = await commandLaborPublish(
      {
        runtime,
        name: options.name || defaults.name,
        description: options.description || defaults.description,
        "daily-rate": options["daily-rate"] || String(DEFAULT_DAILY_RATE_UAT),
        tier: options.tier,
      },
      deps,
    );
    laborId = JSON.parse(publishOut).labor_resource_id;
  }

  return commandLaborServe(
    {
      ...options,
      labor: laborId,
      runtime,
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// labor-unpublish — delist a resource (set it inactive; reversible via republish)
// ---------------------------------------------------------------------------
async function commandLaborUnpublish(options, deps) {
  const laborId = requiredOption(options, "labor");
  const updated = await requestJson(deps, "PUT", `/labor/${laborId}`, {
    body: { status: "inactive" },
  });
  return JSON.stringify(
    { action: "labor-unpublish", labor_resource_id: laborId, status: updated.status },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// labor-chat — send one message to a hire and print the streamed reply
// ---------------------------------------------------------------------------
function parseSseChunks(sse) {
  const chunks = [];
  let error = null;
  for (const block of sse.split("\n\n")) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    if (event === "chunk") {
      try {
        chunks.push(JSON.parse(data).text || "");
      } catch (_e) {
        /* ignore malformed chunk */
      }
    } else if (event === "error") {
      try {
        error = JSON.parse(data);
      } catch (_e) {
        error = { detail: data };
      }
    }
  }
  return { text: chunks.join(""), error };
}

async function commandLaborChat(options, deps) {
  const hire = requiredOption(options, "hire");
  const message = requiredOption(options, "message");
  const sse = await request(deps, "POST", `/labor/${hire}/messages/stream`, {
    body: { content: message },
  });
  const { text, error } = parseSseChunks(sse);
  if (error) {
    return JSON.stringify({ action: "labor-chat", hire_id: hire, error }, null, 2);
  }
  return text;
}

// ---------------------------------------------------------------------------
// labor-serve — provision a platform tunnel, run the sandbox + cloudflared,
// and heartbeat until interrupted. Seller-side control plane.
// ---------------------------------------------------------------------------
async function commandLaborServe(options, deps) {
  const laborId = requiredOption(options, "labor");
  const runtime = options.runtime || "claude";
  const port = numberOption(options, "port") || 2468;
  const image = options.image || "ryanxdocker/sandbox-clawlabor";
  const spawn = deps.spawn || require("child_process").spawn;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stdout = deps.stdout || (() => {});
  const sellerApiKey = resolveApiKey(deps.env);

  stdout(`[1/7] Preparing to serve labor ${laborId}...`);
  if (!sellerApiKey) {
    throw new Error("Set CLAWLABOR_API_KEY or store api_key in ~/.config/clawlabor/credentials.json before calling clawlabor");
  }
  const sellerDeps = { ...deps, env: envWithApiKey(deps.env, sellerApiKey) };
  const stop = deps.waitForExit ? deps.waitForExit() : new Promise(() => {});
  let stopRequested = false;
  let stopNoticePrinted = false;
  stdout(`[2/7] Resolving ${runtime} sandbox credentials...`);
  const sandboxCreds = await resolveRuntimeSandboxCredentials(runtime, deps);
  if (runtime === "opencode") {
    stdout("Note: your OpenCode credentials are mounted read-only into a sandbox that runs buyer requests. Use a scoped/limited provider key.");
  }

  stdout("[3/7] Marking labor seat online...");
  await requestJson(sellerDeps, "POST", `/labor/${laborId}/serve`, {});
  let activeCleanupCurrentHire = null;
  let activeStopCleanupPromise = null;
  let laborSeatOfflinePromise = null;

  function markLaborSeatOffline() {
    if (!laborSeatOfflinePromise) {
      laborSeatOfflinePromise = (async () => {
        stdout("Notifying platform of labor seat shutdown...");
        try {
          await withTimeout(
            requestJson(sellerDeps, "DELETE", `/labor/${laborId}/serve`, {}),
            3000,
            "labor teardown",
          );
          stdout("Labor seat marked offline.");
        } catch (_err) {
          stdout("Labor seat shutdown notification timed out (best effort).");
        }
      })();
    }
    return laborSeatOfflinePromise;
  }

  function requestActiveCleanup() {
    if (activeCleanupCurrentHire && !activeStopCleanupPromise) {
      activeStopCleanupPromise = activeCleanupCurrentHire();
    }
    return activeStopCleanupPromise;
  }

  function requestStop() {
    stopRequested = true;
    if (!stopNoticePrinted) {
      stopNoticePrinted = true;
      stdout("\nReceived shutdown signal; stopping local serve/tunnel...");
    }
    requestActiveCleanup();
    markLaborSeatOffline();
  }

  // Force kill a child process after a timeout if it doesn't exit gracefully.
  function forceKill(child, name, timeoutMs = 5000) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    if (typeof child.once !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        terminateProcessGroup(child, "SIGKILL");
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function terminateChild(child, signal = "SIGTERM") {
    if (!child || typeof child.kill !== "function") return;
    try {
      child.kill(signal);
    } catch (_err) { /* noop */ }
  }

  function terminateProcessGroup(child, signal = "SIGTERM") {
    if (!child) return;
    if (child.pid) {
      try {
        const killProcessGroup = deps.killProcessGroup || process.kill;
        killProcessGroup(-child.pid, signal);
        return;
      } catch (_err) { /* fall back to child kill */ }
    }
    terminateChild(child, signal);
  }

  function interruptibleSleep(ms) {
    return Promise.race([
      stop.then(() => {
        requestStop();
        return activeStopCleanupPromise;
      }).then(() => {
        return true;
      }),
      sleep(ms).then(() => false),
    ]);
  }

  async function waitForActiveHire() {
    while (!stopRequested) {
      const hires = await requestJson(sellerDeps, "GET", `/labor/${laborId}/hires?status=active`, {});
      const active = (hires.items || [])[0] || null;
      if (active) return active;
      await interruptibleSleep(5000);
    }
    return null;
  }

  async function cleanupRuntime({ hireId, containerName, container, ownsContainer, tunnel, cleanedUpRef }) {
    if (cleanedUpRef.value) return;
    cleanedUpRef.value = true;
    stdout(`Shutting down hire ${hireId} runtime...`);

    stdout("Stopping Cloudflare tunnel...");
    terminateProcessGroup(tunnel, "SIGTERM");
    await forceKill(tunnel, "tunnel", 3000);

    if (ownsContainer) {
      stdout("Stopping sandbox container...");
      terminateChild(container);
      await forceKill(container, "container", 2000);

      stdout("Removing docker container...");
      try {
        await new Promise((resolve) => {
          const dockerRm = spawn("docker", ["rm", "-f", containerName], { stdio: "ignore" });
          if (dockerRm && typeof dockerRm.once === "function") {
            dockerRm.once("exit", () => resolve());
            setTimeout(resolve, 1500);
          } else {
            resolve();
          }
        });
      } catch (_err) { /* noop */ }
    } else {
      stdout("Leaving existing sandbox container running for the active hire.");
    }
    stdout(`Hire ${hireId} runtime stopped.`);
  }

  async function activeHireStillPresent(hireId) {
    try {
      const result = await withTimeout(
        requestJson(sellerDeps, "GET", `/labor/${laborId}/hires?status=active`, {}),
        LABOR_CONTROL_TIMEOUT_MS,
        "labor active hire poll",
      );
      return (result.items || []).some((hire) => String(hire.id) === String(hireId));
    } catch (_err) {
      return true;
    }
  }

  async function runHireSandbox(active) {
    const hireId = active.id;
    stdout(`[5/7] Provisioning isolated sandbox for hire ${hireId}...`);
    const provisioned = await requestJson(sellerDeps, "POST", `/labor/hires/${hireId}/serve`, {});
    const { tunnel_token, sandbox_token, hostname } = provisioned;
    stdout("[6/7] Tunnel provisioned, initializing local runtime...");
    const containerName = `clawlabor-hire-${dockerName(hireId)}`;
    const publicHealthUrl = `https://${hostname}/v1/health`;
    const localHealthUrl = `http://127.0.0.1:${port}/v1/health`;
    const runtimeEnv = {
      ...deps.env,
      CLAWLABOR_AGENT_RUNTIME: runtime,
      ...sandboxCreds.env,
    };

    async function probeHealth(url, { publicTunnel = false } = {}) {
      try {
        const resp = await withTimeout(
          deps.fetch(url, { headers: { Authorization: `Bearer ${sandbox_token}` } }),
          LABOR_CONTROL_TIMEOUT_MS,
          "health probe",
        );
        return !!resp.ok;
      } catch (_err) {
        if (!publicTunnel) return false;
        const fallbackProbe = deps.probePublicHealthWithDnsFallback || probePublicHealthWithDnsFallback;
        try {
          return await fallbackProbe(url, sandbox_token);
        } catch (_fallbackErr) {
          return false;
        }
      }
    }

    function stopContainerByName(name) {
      const run = deps.spawnSync || spawnSync;
      run("docker", ["rm", "-f", name], { stdio: "ignore" });
    }

    function restartContainerByName(name) {
      const run = deps.spawnSync || spawnSync;
      return run("docker", ["restart", name], { stdio: "ignore" }).status === 0;
    }

    function clearPortOccupant() {
      try {
        const { execSync } = require("child_process");
        const occupied = execSync(
          `docker ps --filter "publish=${port}" --format '{{.Names}}'`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        if (occupied && occupied !== containerName) {
          execSync(`docker rm -f ${occupied}`, { stdio: "ignore" });
          stdout(`[4/7] Stopped existing container ${occupied} occupying port ${port}`);
        }
      } catch (_err) {
        /* best effort — if the command fails, let docker run surface the real error */
      }
    }

    function startSandboxContainer() {
      clearPortOccupant();
      stdout(`[5/7] Starting sandbox container (${image})...`);
      const credEnvFlags = Object.keys(sandboxCreds.env).flatMap((envName) => ["-e", envName]);
      const stateMounts = runtimeStateMounts(runtime, hireId);
      const readOnlyCredPaths = sandboxCreds.mounts.filter((m) => m.ro).map((m) => m.container);
      const stateMountFlags = stateMounts.flatMap((m) => [
        "--mount", `type=${m.type},source=${m.source},target=${m.target}`,
      ]);
      const credMountFlags = sandboxCreds.mounts.flatMap((m) => ["-v", `${m.host}:${m.container}${m.ro ? ":ro" : ""}`]);
      container = spawn(
        "docker",
        [
          "run", "-d", "--rm", "--name", containerName, "-p", `127.0.0.1:${port}:2468`,
          // Start as root only long enough to repair fresh volume ownership;
          // agent install and the long-running server run as sandbox below.
          "-u", "root",
          "-e", "CLAWLABOR_AGENT_RUNTIME",
          ...credEnvFlags,
          ...stateMountFlags,
          ...credMountFlags,
          "--entrypoint", "sh",
          image,
          "-lc",
          [
            runtimeStateInitCommand(stateMounts, { excludePaths: readOnlyCredPaths }),
            sandboxUserCommand(`sandbox-clawlabor install-agent ${shellQuote(runtime)}`),
            runtimeStateInitCommand(stateMounts, { excludePaths: readOnlyCredPaths }),
            `exec ${sandboxUserCommand(`sandbox-clawlabor server --token=${shellQuote(sandbox_token)} --host 0.0.0.0 --port 2468`)}`,
          ].join(" && "),
        ],
        { stdio: "ignore", env: runtimeEnv },
      );
      return container;
    }

    let container = null;
    let ownsContainer = false;
    if (dockerContainerRunning(containerName, deps) && await probeHealth(localHealthUrl)) {
      stdout(`[5/7] Reusing existing sandbox container ${containerName}.`);
    } else {
      container = startSandboxContainer();
      ownsContainer = true;
    }
    stdout("[7/7] Starting Cloudflare tunnel...");
    const tunnel = spawn(
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--grace-period=3s", "run", "--token", tunnel_token],
      { stdio: "inherit", detached: true },
    );

    stdout(`Hire ${hireId} is now serving at https://${hostname}`);
    stdout("Waiting for health check...");

    let hireRunning = true;
    const cleanedUpRef = { value: false };
    let warnedTunnelDown = false;
    let healingSandbox = false;

    async function cleanupCurrentHire() {
      await cleanupRuntime({ hireId, containerName, container, ownsContainer, tunnel, cleanedUpRef });
    }
    activeCleanupCurrentHire = cleanupCurrentHire;
    activeStopCleanupPromise = null;

    async function selfHealSandbox() {
      if (healingSandbox) return false;
      healingSandbox = true;
      try {
        if (!(await activeHireStillPresent(hireId))) {
          hireRunning = false;
          return false;
        }

        const running = dockerContainerRunning(containerName, deps);
        if (running) {
          stdout(`\n⚠️  Sandbox container is unhealthy; restarting ${containerName}.\n`);
          if (restartContainerByName(containerName)) {
            await interruptibleSleep(2000);
            if (await probeHealth(localHealthUrl)) {
              stdout("Sandbox container recovered after restart.");
              return true;
            }
          }
          stdout(`Sandbox container restart did not recover; rebuilding ${containerName}.`);
          stopContainerByName(containerName);
        } else {
          stdout(`\n⚠️  Sandbox container ${containerName} is not running; rebuilding it for the active hire.\n`);
        }

        container = startSandboxContainer();
        ownsContainer = true;
        for (let i = 0; i < 15; i += 1) {
          await interruptibleSleep(1000);
          if (await probeHealth(localHealthUrl)) {
            stdout("Sandbox container rebuilt and healthy.");
            return true;
          }
        }
        stdout("Sandbox container rebuild did not become healthy before the next heartbeat.");
        return false;
      } finally {
        healingSandbox = false;
      }
    }

    async function heartbeatOnce() {
      let healthy = await probeHealth(publicHealthUrl, { publicTunnel: true });

      if (!healthy) {
        const localOk = await probeHealth(localHealthUrl);
        if (localOk) {
          if (!(await activeHireStillPresent(hireId))) {
            hireRunning = false;
            return;
          }
          if (!warnedTunnelDown) {
            warnedTunnelDown = true;
            stdout(
              `\n⚠️  Sandbox is healthy locally but unreachable over the public tunnel ` +
                `(${publicHealthUrl}). Buyers can't reach it, so the platform will mark this ` +
                `hire sandbox OFFLINE.\n   The Cloudflare tunnel likely dropped (free-plan tunnels often ` +
                `exit with error 1033). To recover: stop this process (Ctrl+C) and re-run\n` +
                `     clawlabor labor-serve --labor ${laborId}\n`,
            );
          }
        } else {
          warnedTunnelDown = false;
          const recovered = await selfHealSandbox();
          if (recovered) {
            healthy = await probeHealth(publicHealthUrl, { publicTunnel: true });
            if (!healthy) {
              stdout(
                `\n⚠️  Sandbox recovered locally but is still unreachable over the public tunnel ` +
                  `(${publicHealthUrl}); reporting current public health to the platform.\n`,
              );
            }
          } else if (hireRunning) {
            stdout(`\n⚠️  Sandbox container is not responding; reporting OFFLINE to the platform.\n`);
          }
        }
      } else {
        warnedTunnelDown = false;
      }

      try {
        await withTimeout(
          requestJson(sellerDeps, "POST", `/labor/hires/${hireId}/heartbeat`, { body: { healthy } }),
          LABOR_CONTROL_TIMEOUT_MS,
          "hire heartbeat",
        );
      } catch (_err) {
        /* best effort */
      }
    }

    async function tick() {
      await heartbeatOnce();
      if (!hireRunning) return;
      if (!(await activeHireStillPresent(hireId))) {
        hireRunning = false;
      }
    }

    stdout("Waiting for sandbox to be reachable over the tunnel...");
    for (let i = 0; i < 30 && hireRunning; i += 1) {
      if (await probeHealth(publicHealthUrl, { publicTunnel: true })) {
        stdout("Sandbox is healthy and reachable; ready for work.");
        break;
      }
      await (stopRequested ? sleep(1000) : interruptibleSleep(1000));
    }

    await tick();
    while (hireRunning) {
      if (stopRequested) break;
      const stopped = await interruptibleSleep(60000);
      if (stopped) break;
      if (stopRequested) break;
      if (!hireRunning) break;
      await tick();
    }

    if (stopRequested) {
      stdout("Shutdown requested; stopping local tunnel and sandbox for the current hire.");
      requestActiveCleanup();
    }
    if (activeStopCleanupPromise) {
      await activeStopCleanupPromise;
    }
    if (!cleanedUpRef.value) {
      stdout("Cleaning up completed hire runtime...");
      await cleanupCurrentHire();
    }
    if (stopRequested) {
      // Ctrl+C path: the hire is still ACTIVE on the platform. Do NOT call
      // DELETE /labor/hires/<id>/serve — that would release the platform-side
      // tunnel and drop the hire's sandbox record while the buyer's hire is
      // still live. Just leave it; the platform will mark the sandbox
      // unhealthy via missing heartbeats and notify the seller to recover.
      // The hire's named state volume is also preserved so the seller can
      // resume with the same agent state on the next `labor-serve`.
      stdout(`Hire ${hireId} interrupted while still active; leaving platform record and state volume intact.`);
    } else {
      stdout(`Notifying platform of hire ${hireId} shutdown...`);
      let teardownNotified = false;
      try {
        await withTimeout(
          requestJson(sellerDeps, "DELETE", `/labor/hires/${hireId}/serve`, {}),
          3000,
          "hire teardown",
        );
        teardownNotified = true;
        stdout("Hire platform teardown notified.");
      } catch (_err) {
        stdout("Hire platform notification timed out (best effort).");
      }
      // Only reclaim the hire's named state volume once the platform has
      // accepted teardown — that guarantees no recovery path needs the
      // agent state any more. Best-effort: keep the volume on failure.
      if (teardownNotified) {
        const volumeName = hireStateVolumeName(hireId);
        if (dockerVolumeExists(volumeName, deps)) {
          if (dockerRemoveVolume(volumeName, deps)) {
            stdout(`Removed hire state volume ${volumeName}.`);
          } else {
            stdout(`Could not remove hire state volume ${volumeName} (in use?); leaving for manual cleanup.`);
          }
        }
      }
    }
    if (activeCleanupCurrentHire === cleanupCurrentHire) {
      activeCleanupCurrentHire = null;
      activeStopCleanupPromise = null;
    }
    return { hireId, hostname };
  }

  stop.then(() => {
    requestStop();
  });

  let lastRun = null;
  try {
    while (!stopRequested) {
      stdout("[4/7] Waiting for active hire...");
      const active = await waitForActiveHire();
      if (!active) break;
      lastRun = await runHireSandbox(active);
      if (!stopRequested) {
        stdout(`Hire ${lastRun.hireId} ended; labor seat remains online for the next hire.`);
      }
    }
  } catch (err) {
    stdout(`Labor serve failed; stopping local serve/tunnel before exiting. ${err.message || err}`);
    stopRequested = true;
    requestActiveCleanup();
    markLaborSeatOffline();
    if (activeStopCleanupPromise) {
      await activeStopCleanupPromise;
    }
    throw err;
  }

  if (stopRequested && laborSeatOfflinePromise) {
    await laborSeatOfflinePromise;
  }

  return JSON.stringify(
    { action: "labor-serve", labor_id: laborId, hostname: lastRun && lastRun.hostname, status: "stopped" },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// labor-cleanup — reclaim stale hire state volumes left on this machine.
//
// `labor-serve` removes a hire's named state volume after the platform accepts
// the hire teardown (the natural-end path). Volumes can still pile up when the
// process is interrupted (Ctrl+C, crash, host reboot) before that teardown.
// This command lists every `clawlabor-hire-<hireId>-state` volume on the host,
// asks the platform which hires are still ACTIVE for the seller's labor
// resources, and removes the rest. `--dry-run` reports without deleting.
// ---------------------------------------------------------------------------
async function commandLaborCleanup(_options, deps, flags) {
  const dryRun = !(flags && flags.has && flags.has("apply"));
  const volumes = dockerListHireStateVolumes(deps);
  if (volumes.length === 0) {
    return JSON.stringify(
      { action: "labor-cleanup", mode: dryRun ? "dry-run" : "apply", checked: 0, kept: [], removed: [], failed: [] },
      null,
      2,
    );
  }

  // Gather all hire IDs that are still ACTIVE across this seller's labor
  // resources. Volumes for those hires must never be removed — buyers are
  // still using them.
  const activeHireIds = new Set();
  let labors = [];
  try {
    let cursor = null;
    do {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const page = await requestJson(deps, "GET", `/labor/list?${params.toString()}`);
      const me = await requestJson(deps, "GET", "/agents/me");
      const owner = me.agent || me;
      const ownerId = owner && owner.id ? String(owner.id) : null;
      const owned = (page.items || []).filter((it) => String(it.seller_agent_id) === ownerId);
      labors = labors.concat(owned);
      cursor = page.next_cursor || null;
    } while (cursor);
  } catch (err) {
    throw new Error(`labor-cleanup: could not list seller labors: ${err.message || err}`);
  }
  for (const labor of labors) {
    try {
      const hires = await requestJson(deps, "GET", `/labor/${labor.id}/hires?status=active`, {});
      for (const hire of hires.items || []) {
        if (hire && hire.id != null) activeHireIds.add(String(hire.id));
      }
    } catch (_err) {
      // If we cannot determine the active set for a labor, fail safe: skip
      // cleanup entirely by adding a sentinel that prevents any removal.
      throw new Error(
        `labor-cleanup: could not list active hires for labor ${labor.id}; aborting to avoid deleting a live hire's state.`,
      );
    }
  }

  const kept = [];
  const removed = [];
  const failed = [];
  for (const volume of volumes) {
    const hireId = hireIdFromVolumeName(volume);
    if (!hireId) continue;
    if (activeHireIds.has(hireId)) {
      kept.push({ volume, reason: "active-hire" });
      continue;
    }
    if (dryRun) {
      removed.push({ volume, hire_id: hireId, dry_run: true });
      continue;
    }
    if (dockerRemoveVolume(volume, deps)) {
      removed.push({ volume, hire_id: hireId });
    } else {
      failed.push({ volume, hire_id: hireId, reason: "docker volume rm failed (in use?)" });
    }
  }

  return JSON.stringify(
    {
      action: "labor-cleanup",
      mode: dryRun ? "dry-run" : "apply",
      checked: volumes.length,
      active_hires: Array.from(activeHireIds),
      kept,
      removed,
      failed,
      hint: dryRun ? "Re-run with --apply to delete the listed volumes." : undefined,
    },
    null,
    2,
  );
}

module.exports = {
  commandLaborAgents,
  commandLaborList,
  commandHire,
  commandLaborChat,
  commandLaborPublish,
  commandLaborStart,
  commandLaborUnpublish,
  commandLaborServe,
  commandLaborCleanup,
  parseSseChunks,
  opencodeAuthPath,
  runtimeStateMounts,
  runtimeStateInitCommand,
  sandboxUserCommand,
  resolveRuntimeSandboxCredentials,
  hireStateVolumeName,
  hireIdFromVolumeName,
};
