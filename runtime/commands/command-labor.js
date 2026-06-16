// Labor mode commands: hire a worker, serve a worker, chat with a hire.
const { request, requestJson } = require("../http");
const { numberOption, positiveNumberOption, requiredOption } = require("../options");

// ---------------------------------------------------------------------------
// hire — buy exclusive use of a labor resource for N hours
// ---------------------------------------------------------------------------
async function commandHire(options, deps) {
  const listing = requiredOption(options, "listing");
  const hours = positiveNumberOption(options, "hours");
  if (hours === undefined) {
    throw new Error("Missing required --hours");
  }
  const body = { labor_resource_id: listing, duration_hours: hours };
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
      duration_hours: hire.duration_hours,
      frozen_nano: hire.frozen_nano,
    },
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

  const provisioned = await requestJson(deps, "POST", `/labor/${laborId}/serve`, {});
  const { tunnel_token, sandbox_token, hostname } = provisioned;

  // Sandbox runtime: bound to localhost (only cloudflared reaches it), --token enforced.
  const container = spawn(
    "docker",
    [
      "run", "--rm", "-p", `127.0.0.1:${port}:2468`,
      "-e", "CLAUDE_CODE_OAUTH_TOKEN",
      image, "server", "--token", sandbox_token, "--host", "0.0.0.0", "--port", "2468",
    ],
    { stdio: "inherit", env: deps.env },
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
      await requestJson(deps, "POST", `/labor/${laborId}/heartbeat`, { body: { healthy } });
    } catch (_e) {
      /* best effort */
    }
  }

  await heartbeatOnce();
  while (running) {
    await sleep(60000);
    if (!running) break;
    await heartbeatOnce();
  }

  try { container.kill && container.kill(); } catch (_e) { /* noop */ }
  try { tunnel.kill && tunnel.kill(); } catch (_e) { /* noop */ }
  try { await requestJson(deps, "DELETE", `/labor/${laborId}/serve`, {}); } catch (_e) { /* noop */ }

  return JSON.stringify(
    { action: "labor-serve", labor_id: laborId, hostname, status: "stopped" },
    null,
    2,
  );
}

module.exports = { commandHire, commandLaborChat, commandLaborServe, parseSseChunks };
