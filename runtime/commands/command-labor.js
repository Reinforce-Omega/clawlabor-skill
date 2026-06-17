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
const { numberOption, positiveNumberOption, requiredOption } = require("../options");

const LABOR_STATUSES = new Set(["draft", "available", "occupied", "inactive", "all"]);
const DEFAULT_DAILY_RATE_UAT = 50;
const PLAN_MONTHLY_COST_UAT = {
  pro: 20 * 10, // $20/month = 200 UAT/month
  team: 50 * 10, // $50/month = 500 UAT/month
  enterprise: 200 * 10, // $200/month = 2000 UAT/month
};const LABOR_CONTROL_TIMEOUT_MS = 10_000;
const DEFAULT_GATEKEEPER_PROMPT = "Accept only safe, legal, well-scoped requests that can be completed by this local agent. Refuse requests requiring private credentials, illegal activity, or work outside the published description.";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
  id,
  name,
  runtime,
  command,
  probe,
  readyToServe,
  serveStatus,
}) {
  const suggestedDailyRate = hostPlan && PLAN_MONTHLY_COST_UAT[hostPlan?.toLowerCase()]
    ? Math.ceil(PLAN_MONTHLY_COST_UAT[hostPlan.toLowerCase()] / 30)
    : DEFAULT_DAILY_RATE_UAT;  const installed = probe.status === "pass";
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
    suggested_daily_rate_uat: suggestedDailyRate,    requirements,
    publish_command_template: [
      "clawlabor labor-publish",
      `--name ${shellQuote(publishName)}`,
      `--description ${shellQuote(`${publishName} backed by the local ${name} runtime.`)}`,
      `--daily-rate ${suggestedDailyRate}`,    ].join(" "),
    serve_command_template: readyToServe
      ? "clawlabor labor-serve --labor <labor_resource_id>"
      : null,
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
    suggested_daily_rate_uat: agent.suggested_daily_rate_uat,    can_serve: agent.ready_to_serve,
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
  if (agent.ready_to_serve && existing) {
    summary.serve_command = `clawlabor labor-serve --labor ${existing.id}`;
    summary.start_command = summary.serve_command;
  } else if (agent.ready_to_serve) {
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
      error_code: err.errorCode || "api_error",
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
    balance: agent.balance,
    online: agent.is_online,
  };
  if (agent.frozen !== null && agent.frozen !== undefined) {
    compact.frozen = agent.frozen;
  }
  return compact;
}

async function activeLaborResourcesForHostAccount(deps, hostAccount) {
  if (!hostAccount || !hostAccount.id) return [];
  const list = await requestJson(deps, "GET", "/labor/list?limit=100");
  const me = await requestJson(deps, "GET", "/agents/me");
  const owner = me.agent || me;
  const ownerId = owner && owner.id ? String(owner.id) : null;
  return (list.items || []).filter((item) =>
    String(item.seller_agent_id) === ownerId &&
    (
      (
        item.host_account_provider === hostAccount.provider &&
        item.host_account_id === hostAccount.id
      ) ||
      (!item.host_account_provider && !item.host_account_id)
    ) &&
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
    const provider = resource.host_account_provider;
    if (provider === "claude" || (!provider && !byRuntime.claude)) {
      byRuntime.claude = resource;
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
          : "Run `claude auth status` and make sure it shows authMethod claude.ai with an active subscription",
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
    hostPlan: claudeAccount.plan,  });
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
            ? "Codex CLI is installed locally; ClawLabor labor-serve is not wired to start Codex-backed sandbox sessions yet"
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
      readyToServe: false,
      serveStatus: opencode.status === "pass"
        ? "candidate_not_wired_to_labor_serve"
        : "not_installed",
      requirements: [
        {
          name: "opencode_cli",
          status: opencode.status,
          command: "opencode --version",
          version: opencode.version,
          detail: opencode.status === "pass"
            ? "OpenCode CLI is installed locally; ClawLabor labor-serve is not wired to start OpenCode-backed sandbox sessions yet"
            : opencode.on_path
              ? "OpenCode CLI is on PATH but failed to run; repair the local OpenCode install before publishing an OpenCode-backed labor runtime"
              : "Install OpenCode CLI before publishing an OpenCode-backed labor runtime",
          error: opencode.error,
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
async function commandLaborList(options, deps) {
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
  if (!options.all) {
    const me = await requestJson(deps, "GET", "/agents/me");
    owner = me.agent || me;
  }
  const ownerId = owner && owner.id ? String(owner.id) : null;
  const items = (list.items || [])
    .filter((item) => options.all || String(item.seller_agent_id) === ownerId)
    .map(compactLaborResource);

  return JSON.stringify(
    {
      action: "labor-list",
      scope: options.all ? "all" : "mine",
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
  const hostAccount = await resolveClaudeCodeAccount(deps);
  if (hostAccount.provider === "claude" && hostAccount.logged_in && hostAccount.id) {
    const existing = await activeLaborResourcesForHostAccount(deps, hostAccount);
    if (existing.length > 0) {
      const ids = existing.map((item) => `${item.id}(${item.status})`).join(", ");
      throw new Error(
        `This host Claude account is already listed as labor: ${ids}. ` +
        "Use `clawlabor labor-list` to inspect it or `clawlabor labor-unpublish --labor <id>` before publishing again.",
      );
    }
  }
  const body = {
    name,
    description,
    daily_rate_uat: dailyRate,
    min_duration_days: 1,
    max_duration_days: 1,
    tier: options.tier || "tier_1",
  };
  if (hostAccount.provider === "claude" && hostAccount.logged_in && hostAccount.id) {
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
  if (runtime !== "claude") {
    throw new Error("labor-start currently supports --runtime claude");
  }

  const marketplaceAgent = await currentMarketplaceAgent(deps);
  if (marketplaceAgent.status !== "authenticated") {
    throw new Error("Authenticate before starting labor. Run `clawlabor auth status`.");
  }

  const agent = await claudeRuntimeAgent(deps);
  if (!agent.ready_to_serve) {
    const missing = missingRequirementNames(agent).join(", ") || "unknown requirements";
    throw new Error(`Cannot start ${runtime} labor yet; missing: ${missing}. Run \`clawlabor labor-agents --verbose\` for diagnostics.`);
  }

  const existing = existingLaborByRuntime(
    await currentSellerLaborResources(deps, marketplaceAgent),
  )[runtime];
  let laborId = existing && existing.id;
  if (!laborId) {
    const publishOut = await commandLaborPublish(
      {
        name: options.name || "Claude Code Labor",
        description: options.description || "Claude Code Labor backed by the local Claude Code Sandbox runtime.",
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
  if (runtime !== "claude") {
    throw new Error("labor-serve currently supports --runtime claude");
  }
  const port = numberOption(options, "port") || 2468;
  const image = options.image || "ryanxdocker/sandbox-clawlabor";
  const spawn = deps.spawn || require("child_process").spawn;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stdout = deps.stdout || (() => {});
  const sellerApiKey = resolveApiKey(deps.env);
  if (!sellerApiKey) {
    throw new Error("Set CLAWLABOR_API_KEY or store api_key in ~/.config/clawlabor/credentials.json before calling clawlabor");
  }
  const sellerDeps = { ...deps, env: envWithApiKey(deps.env, sellerApiKey) };
  const claudeOauth = await resolveClaudeCodeOauthToken(deps);
  if (!claudeOauth.token) {
    const authHint = claudeOauth.authStatusOk
      ? "Claude Code is logged in, but no fresh local claude.ai OAuth token was available. Open Claude Code once or wait for any Claude session limit to reset, then retry."
      : "Run `claude auth status` and make sure it shows authMethod claude.ai with an active subscription.";
    throw new Error(
      `labor-serve requires a working local Claude Code claude.ai subscription login. ${authHint}`,
    );
  }

  const provisioned = await requestJson(sellerDeps, "POST", `/labor/${laborId}/serve`, {});
  const { tunnel_token, sandbox_token, hostname } = provisioned;
  const containerName = `clawlabor-labor-${laborId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  const runtimeEnv = {
    ...deps.env,
    CLAWLABOR_AGENT_RUNTIME: runtime,
    CLAUDE_CODE_OAUTH_TOKEN: claudeOauth.token,
  };

  // If another container is already bound to this port, stop it first.
  // docker run will fail with a bind-mount conflict otherwise.
  try {
    const { execSync } = require("child_process");
    const occupied = execSync(
      `docker ps --filter "publish=${port}" --format '{{.Names}}'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (occupied) {
      execSync(`docker rm -f ${occupied}`, { stdio: "ignore" });
      stdout(`Stopped existing container ${occupied} occupying port ${port}\n`);
    }
  } catch (_e) {
    /* best effort — if the command fails, let docker run surface the real error */
  }

  // Sandbox runtime: bound to localhost (only cloudflared reaches it), --token enforced.
  // Detached (-d): the container lifecycle is independent of this process's stdio;
  // it is torn down explicitly via `docker rm -f <name>` on exit. (Foreground docker
  // run coupled to a backgrounded parent is fragile — the container can die with the
  // parent's stdio.)
  const container = spawn(
    "docker",
    [
      "run", "-d", "--rm", "--name", containerName, "-p", `127.0.0.1:${port}:2468`,
      "-e", "CLAWLABOR_AGENT_RUNTIME",
      "-e", "CLAUDE_CODE_OAUTH_TOKEN",
      "--entrypoint", "sh",
      image,
      "-lc",
      [
        `sandbox-agent install-agent ${shellQuote(runtime)}`,
        `exec sandbox-agent server --token ${shellQuote(sandbox_token)} --host 0.0.0.0 --port 2468`,
      ].join(" && "),
    ],
    { stdio: "ignore", env: runtimeEnv },
  );
  // cloudflared connects the platform-managed tunnel to the local container.
  const tunnel = spawn("cloudflared", ["tunnel", "run", "--token", tunnel_token], {
    stdio: "inherit",
  });

  stdout(`labor ${laborId} serving at https://${hostname}\n`);

  let running = true;
  const stop = deps.waitForExit ? deps.waitForExit() : new Promise(() => {});
  stop.then(() => {
    running = false;
  });

  async function heartbeatOnce() {
    let healthy = false;
    try {
      const resp = await deps.fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { Authorization: `Bearer ${sandbox_token}` },
      });
      healthy = !!resp.ok;
    } catch (_e) {
      healthy = false;
    }
    try {
      await withTimeout(
        requestJson(sellerDeps, "POST", `/labor/${laborId}/heartbeat`, { body: { healthy } }),
        LABOR_CONTROL_TIMEOUT_MS,
        "labor heartbeat",
      );
    } catch (_e) {
      /* best effort */
    }
  }

  // While serving, auto-accept incoming hires for this resource (the worker is on
  // the job, so it takes the work). A pending hire otherwise auto-rejects at 24h.
  async function acceptPendingHires() {
    try {
      const result = await withTimeout(
        requestJson(sellerDeps, "GET", `/labor/${laborId}/hires?status=pending_accept`, {}),
        LABOR_CONTROL_TIMEOUT_MS,
        "labor pending hire poll",
      );
      for (const hire of result.items || []) {
        try {
          await withTimeout(
            requestJson(sellerDeps, "POST", `/labor/${hire.id}/accept`, {}),
            LABOR_CONTROL_TIMEOUT_MS,
            "labor hire accept",
          );
          stdout(`accepted hire ${hire.id}\n`);
        } catch (_e) {
          /* skip this hire; try again next tick */
        }
      }
    } catch (_e) {
      /* best effort */
    }
  }

  async function tick() {
    await heartbeatOnce();
    await acceptPendingHires();
  }

  // Wait for the container to accept requests before the first heartbeat, so the
  // resource isn't briefly flagged offline during the ~10s container startup.
  for (let i = 0; i < 30; i += 1) {
    try {
      const r = await deps.fetch(`http://127.0.0.1:${port}/v1/health`, {
        headers: { Authorization: `Bearer ${sandbox_token}` },
      });
      if (r.ok) break;
    } catch (_e) {
      /* not up yet */
    }
    await sleep(1000);
  }

  await tick();
  while (running) {
    await sleep(60000);
    if (!running) break;
    await tick();
  }

  try { container.kill && container.kill(); } catch (_e) { /* noop */ }
  try { tunnel && tunnel.kill && tunnel.kill(); } catch (_e) { /* noop */ }
  try { spawn("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch (_e) { /* noop */ }
  try { await requestJson(sellerDeps, "DELETE", `/labor/${laborId}/serve`, {}); } catch (_e) { /* noop */ }

  return JSON.stringify(
    { action: "labor-serve", labor_id: laborId, hostname, status: "stopped" },
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
  parseSseChunks,
};
