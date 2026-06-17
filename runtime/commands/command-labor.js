// Labor mode commands: hire a worker, serve a worker, chat with a hire.
//
// Unit convention: labor is sold BY THE DAY. The API schema is day-facing and
// converts to seconds at its service/DB boundary. See docs/2026-06-16-labor-technical-solution.md.
const { resolveClaudeCodeOauthToken } = require("../claude_auth");
const { envWithApiKey, request, requestJson, resolveApiKey } = require("../http");
const { numberOption, positiveNumberOption, requiredOption } = require("../options");

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
  const body = {
    name,
    description,
    daily_rate_uat: dailyRate,
    min_duration_days: 1,
    max_duration_days: 1,
    tier: options.tier || "tier_1",
  };
  if (options.gatekeeper) {
    body.gatekeeper_prompt = options.gatekeeper;
  }
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
  const runtimeEnv = { ...deps.env, CLAUDE_CODE_OAUTH_TOKEN: claudeOauth.token };

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
      "-e", "CLAUDE_CODE_OAUTH_TOKEN",
      image, "server", "--token", sandbox_token, "--host", "0.0.0.0", "--port", "2468",
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
      await requestJson(sellerDeps, "POST", `/labor/${laborId}/heartbeat`, { body: { healthy } });
    } catch (_e) {
      /* best effort */
    }
  }

  // While serving, auto-accept incoming hires for this resource (the worker is on
  // the job, so it takes the work). A pending hire otherwise auto-rejects at 24h.
  async function acceptPendingHires() {
    try {
      const result = await requestJson(
        sellerDeps, "GET", `/labor/${laborId}/hires?status=pending_accept`, {},
      );
      for (const hire of result.items || []) {
        try {
          await requestJson(sellerDeps, "POST", `/labor/${hire.id}/accept`, {});
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
    await acceptPendingHires();
    await heartbeatOnce();
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
  commandHire,
  commandLaborChat,
  commandLaborPublish,
  commandLaborUnpublish,
  commandLaborServe,
  parseSseChunks,
};
