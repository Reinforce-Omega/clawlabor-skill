// Labor mode commands: hire a worker, serve a worker, chat with a hire.
//
// Unit convention: labor is sold BY THE DAY. The API schema is day-facing and
// converts to seconds at its service/DB boundary. See docs/2026-06-16-labor-technical-solution.md.
const { spawnSync } = require("node:child_process");
const {
  resolveClaudeCodeAccount,
  resolveClaudeCodeOauthToken,
} = require("../claude_auth");
const { apiBase, envWithApiKey, request, requestJson, resolveApiKey } = require("../http");
const { numberOption, positiveNumberOption, requiredOption, tokenCountOption } = require("../options");
const {
  dockerContainerState,
  dockerListHireContainers,
  dockerListHireStateVolumes,
  dockerName,
  removeContainerByName,
  dockerRemoveVolume,
  dockerVolumeExists,
  ensureDockerImage,
  forceKillProcess,
  hireIdFromContainerName,
  hireIdFromVolumeName,
  hireStateVolumeName,
  removeContainerByNameAsync,
  restartContainerByName,
  runtimeStateInitCommand,
  runtimeStateMounts,
  sandboxUserCommand,
  shellQuote,
  startSandboxContainer,
  startContainerByName,
  stopContainerByName,
  terminateChild,
  terminateProcessGroup,
} = require("./labor-sandbox");
const {
  TUNNEL_AVAILABILITY_TIMEOUT_MS,
  createSandboxHealthProbe,
  createTunnelAvailabilityState,
  formatTunnelUnavailableWarning,
  startCloudflareTunnel,
  tunnelAvailabilityTimeoutSeconds,
} = require("./labor-tunnel");

const LABOR_STATUSES = new Set(["draft", "available", "occupied", "inactive", "all"]);
const ACTIVE_LABOR_RESOURCE_STATUSES = new Set(["draft", "available", "occupied"]);
const DEFAULT_DAILY_RATE_UAT = 50;
const PLAN_MONTHLY_COST_UAT = {
  pro: 20 * 10, // $20/month = 200 UAT/month
  team: 50 * 10, // $50/month = 500 UAT/month
  enterprise: 200 * 10, // $200/month = 2000 UAT/month
};
// Default per-day raw totalTokens cap suggested for opencode labors.
// Enforcement is currently opencode-only (see docs/spec/2026-06-23-labor-daily-token-cap-spec.md);
// other runtimes have no per-prompt usage feed, so we don't suggest a cap for them.
const DEFAULT_DAILY_TOKEN_CAP = 1_000_000; // 1M tokens/day
const LABOR_CONTROL_TIMEOUT_MS = 10_000;
const SANDBOX_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_SANDBOX_IMAGE = "ryanxdocker/sandbox-clawlabor:0.4.4";
const DEFAULT_GATEKEEPER_PROMPT = "Accept only safe, legal, well-scoped requests that can be completed by this local agent. Refuse requests requiring private credentials, illegal activity, or work outside the published description.";
const MAX_TUNNEL_RESTART_ATTEMPTS = 3;
const NANO_FACTOR = 1e9;
const CLAUDE_CODE_INSTALL_HINT = "Install Claude Code CLI, not Claude Desktop. See https://docs.anthropic.com/en/docs/claude-code/quickstart or run `npm install -g @anthropic-ai/claude-code`, then run `claude auth login`.";

function formatLogTimestamp(now = Date.now) {
  const parts = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(now()));
  const valueByType = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const offset = formatLogTimezoneOffset(valueByType.timeZoneName);
  return `${valueByType.year}-${valueByType.month}-${valueByType.day} ${valueByType.hour}:${valueByType.minute}:${valueByType.second} ${offset}`;
}

function formatLogTimezoneOffset(timeZoneName) {
  if (!timeZoneName || timeZoneName === "GMT") return "GMT+00:00";
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(timeZoneName);
  if (!match) return timeZoneName;
  const [, sign, hour, minute = "00"] = match;
  return `GMT${sign}${hour.padStart(2, "0")}:${minute}`;
}

function createTimestampedStdout(stdout, now = Date.now) {
  const write = stdout || (() => {});
  return (text) => {
    const timestamp = formatLogTimestamp(now);
    const linePrefix = `[${timestamp}] `;
    const formatted = String(text)
      .split("\n")
      .map((line) => (line ? `${linePrefix}${line}` : line))
      .join("\n");
    write(formatted);
  };
}

function processAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

function laborServeLockPath(deps, port) {
  const path = require("path");
  const os = require("os");
  const base = (deps.env && deps.env.XDG_STATE_HOME) ||
    path.join(os.homedir(), ".local", "state");
  return path.join(base, "clawlabor", `labor-serve-port-${port}.lock`);
}

function acquireLaborServeLock(deps, { runtime, laborId, port }) {
  const fs = require("fs");
  const path = require("path");
  const lockPath = laborServeLockPath(deps, port);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const existing = JSON.parse(raw);
    if (processAlive(Number(existing.pid))) {
      throw new Error(
        `Another clawlabor labor-serve is already using local port ${existing.port || port} ` +
        `(pid ${existing.pid}, runtime ${existing.runtime || "unknown"}, labor ${existing.labor_id || "unknown"}). ` +
        "Stop that process before starting another one, or choose a different --port.",
      );
    }
  } catch (err) {
    if (err && err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
  }
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    labor_id: laborId,
    runtime,
    port,
    started_at: new Date().toISOString(),
  }));
  return () => {
    try {
      const raw = fs.readFileSync(lockPath, "utf8");
      const current = JSON.parse(raw);
      if (Number(current.pid) === process.pid) fs.unlinkSync(lockPath);
    } catch (_err) {
      /* noop */
    }
  };
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

// What to inject into the per-hire `docker run` so the runtime can authenticate.
// Returns { env: {NAME: value}, mounts: [{host, container, ro}] }. Throws a clear
// error if the runtime's local credentials are missing. Never reads secret content.
async function resolveRuntimeSandboxCredentials(runtime, deps) {
  if (runtime === "claude") {
    const claudeOauth = await resolveClaudeCodeOauthToken(deps);
    if (!claudeOauth.token) {
      const authHint = claudeOauth.authStatusOk
        ? "Claude Code is logged in, but the local claude.ai OAuth access token is missing or expired. Run `claude setup-token`, then retry `clawlabor labor-start --runtime claude`."
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
  defaultDailyTokenCap = null,
}) {
  const suggestedDailyRate = hostPlan && PLAN_MONTHLY_COST_UAT[hostPlan?.toLowerCase()]
    ? Math.ceil(PLAN_MONTHLY_COST_UAT[hostPlan.toLowerCase()] / 30)
    : DEFAULT_DAILY_RATE_UAT;
  const installed = probe.status === "pass";
  const publishParts = [
    "clawlabor labor-publish",
    `--runtime ${runtime}`,
    `--name ${shellQuote(publishName)}`,
    `--description ${shellQuote(`${publishName}${hostPlan ? ` (${hostPlan} plan)` : ""} backed by the local ${name} runtime.`)}`,
    `--daily-rate ${suggestedDailyRate}`,
  ];
  if (defaultDailyTokenCap) {
    publishParts.push(`--daily-token-cap ${defaultDailyTokenCap}`);
  }
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
    suggested_daily_token_cap: defaultDailyTokenCap,
    requirements,
    publish_command_template: publishParts.join(" "),
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
  if (agent.suggested_daily_token_cap) {
    summary.suggested_daily_token_cap = agent.suggested_daily_token_cap;
  }
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
    // When there is no existing labor, labor-start auto-publishes and forwards
    // the same suggested rate / token cap. When a labor already exists, the
    // cap is immutable post-publish (see labor-start guard), so we only surface
    // --runtime here.
    const startParts = [`clawlabor labor-start --runtime ${agent.runtime}`];
    if (!existing) {
      startParts.push(`--daily-rate ${agent.suggested_daily_rate_uat}`);
      if (agent.suggested_daily_token_cap) {
        startParts.push(`--daily-token-cap ${agent.suggested_daily_token_cap}`);
      }
    }
    summary.start_command = startParts.join(" ");
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
    ACTIVE_LABOR_RESOURCE_STATUSES.has(item.status),
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
      ACTIVE_LABOR_RESOURCE_STATUSES.has(item.status),
    );
  } catch (_err) {
    return [];
  }
}

async function activeHiresForLabor(deps, laborId, { timeoutMs = null } = {}) {
  const requestPromise = requestJson(deps, "GET", `/labor/${laborId}/hires?status=active`, {});
  const result = timeoutMs === null
    ? await requestPromise
    : await withTimeout(requestPromise, timeoutMs, "labor active hire poll");
  return result.items || [];
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
        : CLAUDE_CODE_INSTALL_HINT,
      next: claude.status === "pass" ? null : CLAUDE_CODE_INSTALL_HINT,
    },
    {
      name: "claude_code_oauth",
      status: claudeOauth.token ? "pass" : "fail",
      detail: claudeOauth.token
        ? "Claude Code claude.ai OAuth token is available"
        : claudeOauth.authStatusOk
          ? "Claude Code auth status passed, but the local claude.ai OAuth access token is missing or expired. Run `claude setup-token`, then retry `clawlabor labor-start --runtime claude`."
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
      defaultDailyTokenCap: DEFAULT_DAILY_TOKEN_CAP,
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
    daily_token_cap: resource.daily_token_cap ?? null,
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
  const dailyTokenCap = tokenCountOption(options, "daily-token-cap");
  const runtime = options.runtime || "claude";
  if (!["claude", "opencode"].includes(runtime)) {
    throw new Error(`labor-publish supports --runtime claude or opencode; ${runtime} has no labor-serve support yet.`);
  }
  if (dailyTokenCap !== undefined && runtime !== "opencode") {
    throw new Error(
      `--daily-token-cap is currently opencode-only; ${runtime} hires do not report per-prompt token usage yet, so the cap would never trip. ` +
      "Re-run with --runtime opencode, or omit --daily-token-cap.",
    );
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
  if (dailyTokenCap !== undefined) {
    body.daily_token_cap = dailyTokenCap;
  }
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
  const inventory = JSON.parse(await commandLaborAgents({ verbose: true }, deps));
  const agent = (inventory.agents || []).find((a) => a.runtime === runtime);
  const canServe = Boolean(agent && (agent.can_serve || agent.ready_to_serve));
  if (!agent || !canServe) {
    const failedRequirements = Array.isArray(agent && agent.requirements)
      ? agent.requirements.filter((item) => item && item.status !== "pass")
      : [];
    const needs = (agent && agent.needs) ? agent.needs.join(", ") : "runtime not serveable";
    const details = failedRequirements
      .map((item) => item.detail)
      .filter(Boolean)
      .join(" ");
    const hint = details ? ` ${details}` : " Run `clawlabor labor-agents --verbose` for diagnostics.";
    throw new Error(`Cannot start ${runtime} labor yet; ${needs}.${hint}`);
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
    const publishOptions = {
      runtime,
      name: options.name || defaults.name,
      description: options.description || defaults.description,
      "daily-rate": options["daily-rate"] || String(DEFAULT_DAILY_RATE_UAT),
      tier: options.tier,
    };
    if (options["daily-token-cap"] !== undefined) {
      publishOptions["daily-token-cap"] = options["daily-token-cap"];
    }
    const publishOut = await commandLaborPublish(publishOptions, deps);
    laborId = JSON.parse(publishOut).labor_resource_id;
  } else if (options["daily-token-cap"] !== undefined) {
    const dailyRate = options["daily-rate"] || String(DEFAULT_DAILY_RATE_UAT);
    const unpublishCommand = `clawlabor labor-unpublish --labor ${laborId}`;
    const restartCommand = `clawlabor labor-start --runtime ${runtime} --daily-rate ${dailyRate} --daily-token-cap ${options["daily-token-cap"]}`;
    const err = new Error(
      `Cannot change --daily-token-cap on existing labor ${laborId}. A labor's cap is fixed at publish time; to change it you must unpublish the listing first and then run labor-start again. Execute next_steps in order.`,
    );
    err.errorCode = "labor_cap_immutable_on_existing_labor";
    err.labor_id = laborId;
    err.runtime = runtime;
    err.next_steps = [
      { step: 1, run: unpublishCommand, why: "Mark the existing listing inactive so labor-start can publish a new one." },
      { step: 2, run: restartCommand, why: "Re-publish with the new cap and serve in one go." },
    ];
    throw err;
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
  const image = options.image || DEFAULT_SANDBOX_IMAGE;
  const spawn = deps.spawn || require("child_process").spawn;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());
  const stdout = createTimestampedStdout(deps.stdout, now);
  const sandboxStartupTimeoutMs = deps.sandboxStartupTimeoutMs || SANDBOX_STARTUP_TIMEOUT_MS;
  const sellerApiKey = resolveApiKey(deps.env);

  stdout(`[1/7] Preparing to serve labor ${laborId}...`);
  if (!sellerApiKey) {
    throw new Error("Set CLAWLABOR_API_KEY or store api_key in ~/.config/clawlabor/credentials.json before calling clawlabor");
  }
  const releaseServeLock = acquireLaborServeLock(deps, { runtime, laborId, port });
  try {
  const sellerDeps = { ...deps, env: envWithApiKey(deps.env, sellerApiKey) };
  const stop = deps.waitForExit ? deps.waitForExit() : new Promise(() => {});
  let stopRequested = false;
  let shutdownRequested = false;
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
    shutdownRequested = true;
    if (!stopNoticePrinted) {
      stopNoticePrinted = true;
      stdout("\nReceived shutdown signal; stopping local serve/tunnel...");
    }
    requestActiveCleanup();
    markLaborSeatOffline();
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
      const hires = await Promise.race([
        activeHiresForLabor(sellerDeps, laborId, { timeoutMs: LABOR_CONTROL_TIMEOUT_MS }),
        stop.then(() => {
          requestStop();
          return null;
        }),
      ]);
      if (!hires) return null;
      const active = hires[0] || null;
      if (active) return active;
      await interruptibleSleep(5000);
    }
    return null;
  }

  async function cleanupRuntime({ hireId, containerName, container, ownsContainer, tunnel, tunnelRuntime, cleanedUpRef, preserveContainer = false }) {
    if (cleanedUpRef.value) return;
    cleanedUpRef.value = true;
    stdout(`Shutting down hire ${hireId} runtime...`);

    stdout("Stopping Cloudflare tunnel...");
    tunnel = tunnelRuntime?.currentTunnel ? tunnelRuntime.currentTunnel() : tunnel;
    terminateProcessGroup(tunnel, "SIGTERM", deps);
    await forceKillProcess(tunnel, 3000, deps);

    if (ownsContainer) {
      stdout("Stopping sandbox container...");
      if (container) {
        terminateChild(container);
        await forceKillProcess(container, 2000, deps);
      } else {
        stopContainerByName(containerName, deps);
      }

      if (preserveContainer) {
        stdout("Sandbox container stopped and preserved for this active hire; rerun labor-start to resume with the same container filesystem.");
      } else {
        stdout("Removing docker container...");
        await removeContainerByNameAsync({ spawn, containerName });
      }
    } else {
      stdout("Leaving existing sandbox container running for the active hire.");
    }
    stdout(`Hire ${hireId} runtime stopped.`);
  }

  async function activeHireStillPresent(hireId) {
    try {
      const hires = await activeHiresForLabor(sellerDeps, laborId, { timeoutMs: LABOR_CONTROL_TIMEOUT_MS });
      return hires.some((hire) => String(hire.id) === String(hireId));
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

    ensureDockerImage(image, deps, stdout, { logPrefix: "[6/7]" });

    const probeHealth = createSandboxHealthProbe({
      deps: { ...deps, withTimeout },
      sandboxToken: sandbox_token,
      timeoutMs: LABOR_CONTROL_TIMEOUT_MS,
    });
    const spawnSandboxContainer = () => startSandboxContainer({
      spawn,
      stdout,
      image,
      port,
      runtime,
      hireId,
      containerName,
      sandboxToken: sandbox_token,
      sandboxCreds,
      runtimeEnv,
      logPrefix: "[6/7]",
    });

    async function ensureSandboxContainerRunning() {
      const state = dockerContainerState(containerName, deps);
      if (state === "running") {
        if (await probeHealth(localHealthUrl)) {
          stdout(`[6/7] Reusing existing sandbox container ${containerName}.`);
          return { container: null, ownsContainer: true };
        }
        stdout(`[6/7] Existing sandbox container ${containerName} is running but unhealthy; restarting it.`);
        if (restartContainerByName(containerName, deps)) {
          await interruptibleSleep(2000);
          if (await probeHealth(localHealthUrl)) {
            stdout(`[6/7] Existing sandbox container ${containerName} recovered after restart.`);
            return { container: null, ownsContainer: true };
          }
        }
        stdout(`[6/7] Removing unhealthy sandbox container ${containerName}; container filesystem may be lost.`);
        removeContainerByName(containerName, deps);
      } else if (state) {
        stdout(`[6/7] Resuming stopped sandbox container ${containerName} (${state}).`);
        if (startContainerByName(containerName, deps)) {
          for (let i = 0; i < 15; i += 1) {
            await interruptibleSleep(1000);
            if (await probeHealth(localHealthUrl)) {
              stdout(`[6/7] Resumed sandbox container ${containerName}.`);
              return { container: null, ownsContainer: true };
            }
          }
        }
        stdout(`[6/7] Stopped sandbox container ${containerName} did not become healthy; removing it and rebuilding.`);
        removeContainerByName(containerName, deps);
      }
      return { container: spawnSandboxContainer(), ownsContainer: true };
    }

    let { container, ownsContainer } = await ensureSandboxContainerRunning();
    const cleanedUpRef = { value: false };
    let tunnel = null;
    let tunnelLogs = [];
    let tunnelState = { exited: false, exitSummary: null };

    let hireRunning = true;
    let warnedTunnelDown = false;
    let tunnelTimeoutReported = false;
    let tunnelGraceNoticePrinted = false;
    let healingSandbox = false;
    let tunnelAvailability = null;
    let tunnelRuntime = null;
    let tunnelRestartAttempts = 0;

    async function cleanupCurrentHire() {
      await cleanupRuntime({
        hireId,
        containerName,
        container,
        ownsContainer,
        tunnel,
        tunnelRuntime,
        cleanedUpRef,
        preserveContainer: shutdownRequested && hireRunning,
      });
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

        const state = dockerContainerState(containerName, deps);
        if (state === "running") {
          stdout(`\n⚠️  Sandbox container is unhealthy; restarting ${containerName}.\n`);
          if (restartContainerByName(containerName, deps)) {
            await interruptibleSleep(2000);
            if (await probeHealth(localHealthUrl)) {
              stdout("Sandbox container recovered after restart.");
              return true;
            }
          }
          stdout(`Sandbox container restart did not recover; rebuilding ${containerName}.`);
          removeContainerByName(containerName, deps);
        } else if (state) {
          stdout(`\n⚠️  Sandbox container ${containerName} is stopped (${state}); starting it for the active hire.\n`);
          if (startContainerByName(containerName, deps)) {
            await interruptibleSleep(2000);
            if (await probeHealth(localHealthUrl)) {
              stdout("Sandbox container recovered after start.");
              return true;
            }
          }
          stdout(`Sandbox container start did not recover; rebuilding ${containerName}.`);
          removeContainerByName(containerName, deps);
        } else {
          stdout(`\n⚠️  Sandbox container ${containerName} is not running; rebuilding it for the active hire.\n`);
        }

        container = spawnSandboxContainer();
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

    async function waitForInitialSandboxHealth() {
      stdout(`[6/7] Waiting for sandbox local health before starting tunnel...`);
      for (let i = 0; i < tunnelAvailabilityTimeoutSeconds(sandboxStartupTimeoutMs) && hireRunning; i += 1) {
        if (await probeHealth(localHealthUrl)) return true;
        if (stopRequested) return false;
        await interruptibleSleep(1000);
      }
      return false;
    }

    async function reportInitialSandboxUnavailable() {
      const error = {
        reason: "sandbox_unhealthy",
        detail: `Sandbox local health check failed for ${localHealthUrl}`,
        local_health_url: localHealthUrl,
        startup_timeout_ms: sandboxStartupTimeoutMs,
      };
      try {
        await withTimeout(
          requestJson(sellerDeps, "POST", `/labor/hires/${hireId}/heartbeat`, { body: { healthy: false, error } }),
          LABOR_CONTROL_TIMEOUT_MS,
          "hire heartbeat",
        );
      } catch (_err) {
        /* best effort */
      }
    }

    async function reportHireInterrupted() {
      const error = {
        reason: "seller_shutdown",
        detail: "Seller stopped the local labor runtime while this hire is still active.",
      };
      try {
        await withTimeout(
          requestJson(sellerDeps, "POST", `/labor/hires/${hireId}/heartbeat`, { body: { healthy: false, error } }),
          LABOR_CONTROL_TIMEOUT_MS,
          "hire shutdown heartbeat",
        );
      } catch (_err) {
        /* best effort */
      }
    }

    async function reportTunnelUnavailable() {
      if (!(await activeHireStillPresent(hireId))) {
        hireRunning = false;
        return;
      }
      if (warnedTunnelDown) return;
      warnedTunnelDown = true;
      stdout(formatTunnelUnavailableWarning({ publicHealthUrl, laborId, tunnelState, tunnelLogs }));
    }

    async function restartTunnelAfterTimeout() {
      if (!tunnelRuntime || typeof tunnelRuntime.restart !== "function") return false;
      if (tunnelRestartAttempts >= MAX_TUNNEL_RESTART_ATTEMPTS) return false;
      tunnelRestartAttempts += 1;
      stdout(
        `Public tunnel unreachable for more than ${tunnelAvailabilityTimeoutSeconds()}s; ` +
          `restarting Cloudflare tunnel (${tunnelRestartAttempts}/${MAX_TUNNEL_RESTART_ATTEMPTS}).`,
      );
      tunnel = await tunnelRuntime.restart("public tunnel unreachable");
      tunnelAvailability.reset();
      tunnelGraceNoticePrinted = false;
      tunnelTimeoutReported = false;
      warnedTunnelDown = false;
      return true;
    }

    async function heartbeatOnce() {
      let healthy = await probeHealth(publicHealthUrl, { publicTunnel: true });
      let heartbeatBody = { healthy };

      if (!healthy) {
        const localOk = await probeHealth(localHealthUrl);
        if (localOk) {
          tunnelAvailability.markUnavailable();
          if (hireRunning && tunnelAvailability.withinGracePeriod()) {
            healthy = true;
            heartbeatBody = { healthy: true };
            if (!tunnelGraceNoticePrinted) {
              tunnelGraceNoticePrinted = true;
              stdout(
                `Tunnel is not reachable yet; allowing up to ${tunnelAvailabilityTimeoutSeconds()}s ` +
                  `for Cloudflare propagation before reporting OFFLINE (${tunnelAvailability.remainingSeconds()}s remaining).`,
              );
            }
          } else if (hireRunning) {
            if (await restartTunnelAfterTimeout()) {
              healthy = true;
              heartbeatBody = { healthy: true };
              tunnelAvailability.markUnavailable();
            } else {
              if (!tunnelTimeoutReported) {
                tunnelTimeoutReported = true;
                await reportTunnelUnavailable();
                stdout(
                  `\n⚠️  Public tunnel has been unreachable for more than ` +
                    `${tunnelAvailabilityTimeoutSeconds()}s; reporting OFFLINE to the platform.\n`,
                );
              }
              heartbeatBody = { healthy: false, error: tunnelAvailability.failurePayload() };
            }
          }
        } else {
          warnedTunnelDown = false;
          tunnelAvailability.reset();
          tunnelTimeoutReported = false;
          tunnelGraceNoticePrinted = false;
          const recovered = await selfHealSandbox();
          if (recovered) {
            healthy = await probeHealth(publicHealthUrl, { publicTunnel: true });
            heartbeatBody = { healthy };
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
        tunnelAvailability.reset();
        tunnelTimeoutReported = false;
        tunnelGraceNoticePrinted = false;
        tunnelRestartAttempts = 0;
        heartbeatBody = { healthy: true };
      }

      try {
        await withTimeout(
          requestJson(sellerDeps, "POST", `/labor/hires/${hireId}/heartbeat`, { body: heartbeatBody }),
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

    if (!(await waitForInitialSandboxHealth())) {
      await reportInitialSandboxUnavailable();
      throw new Error(`Sandbox did not become locally healthy within ${tunnelAvailabilityTimeoutSeconds(sandboxStartupTimeoutMs)}s: ${localHealthUrl}`);
    }

    tunnelRuntime = startCloudflareTunnel({
      spawn,
      stdout,
      tunnelToken: tunnel_token,
      cleanedUpRef,
      isStopRequested: () => stopRequested,
      stopTunnel: async (child) => {
        terminateProcessGroup(child, "SIGTERM", deps);
        await forceKillProcess(child, 3000, deps);
      },
      logPrefix: "[7/7]",
    });
    tunnel = tunnelRuntime.tunnel;
    tunnelLogs = tunnelRuntime.logs;
    tunnelState = tunnelRuntime.state;
    tunnelAvailability = createTunnelAvailabilityState({
      now,
      publicHealthUrl,
      localHealthUrl,
      tunnelState,
      tunnelLogs,
      timeoutMs: TUNNEL_AVAILABILITY_TIMEOUT_MS,
    });

    stdout(`Hire ${hireId} public URL assigned: https://${hostname}`);
    stdout("Waiting for tunnel availability check...");

    stdout("Checking public tunnel reachability...");
    let tunnelAvailable = false;
    for (let i = 0; i < tunnelAvailabilityTimeoutSeconds() && hireRunning; i += 1) {
      const localOk = await probeHealth(localHealthUrl);
      if (localOk && await probeHealth(publicHealthUrl, { publicTunnel: true })) {
        tunnelAvailable = true;
        stdout("Sandbox is healthy and the public tunnel is reachable; ready for work.");
        break;
      }
      if (localOk) {
        tunnelAvailability.markUnavailable();
      }
      await (stopRequested ? sleep(1000) : interruptibleSleep(1000));
    }

    if (!tunnelAvailable && hireRunning && !stopRequested) {
      const localOk = await probeHealth(localHealthUrl);
      if (localOk) {
        tunnelAvailability.markUnavailable();
      } else {
        stdout(`\n⚠️  Sandbox is not locally healthy, so tunnel availability cannot be verified yet.\n`);
      }
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
      // still live. Report an unhealthy heartbeat instead so buyers see the
      // hire go offline immediately while the platform keeps the recovery
      // record. The hire's named state volume is also preserved so the seller
      // can resume with the same agent state on the next `labor-serve`.
      await reportHireInterrupted();
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
  } finally {
    releaseServeLock();
  }
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
  const containers = dockerListHireContainers(deps);
  if (volumes.length === 0 && containers.length === 0) {
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
      const hires = await activeHiresForLabor(deps, labor.id);
      for (const hire of hires) {
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
  for (const containerName of containers) {
    const hireId = hireIdFromContainerName(containerName);
    if (!hireId) continue;
    if (activeHireIds.has(hireId)) {
      kept.push({ type: "container", container: containerName, reason: "active-hire" });
      continue;
    }
    if (dryRun) {
      removed.push({ type: "container", container: containerName, hire_id: hireId, dry_run: true });
      continue;
    }
    removeContainerByName(containerName, deps);
    removed.push({ type: "container", container: containerName, hire_id: hireId });
  }
  for (const volume of volumes) {
    const hireId = hireIdFromVolumeName(volume);
    if (!hireId) continue;
    if (activeHireIds.has(hireId)) {
      kept.push({ type: "volume", volume, reason: "active-hire" });
      continue;
    }
    if (dryRun) {
      removed.push({ type: "volume", volume, hire_id: hireId, dry_run: true });
      continue;
    }
    if (dockerRemoveVolume(volume, deps)) {
      removed.push({ type: "volume", volume, hire_id: hireId });
    } else {
      failed.push({ type: "volume", volume, hire_id: hireId, reason: "docker volume rm failed (in use?)" });
    }
  }

  return JSON.stringify(
    {
      action: "labor-cleanup",
      mode: dryRun ? "dry-run" : "apply",
      checked: volumes.length + containers.length,
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
  formatLogTimestamp,
};
