const crypto = require("crypto");
const fs = require("fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { requestJson } = require("../http");
const { normalizeWebhookPath, positiveNumberOption } = require("../options");
const {
  appendSessionEvent,
  defaultOnlineInboxPath,
  defaultSessionId,
  defaultSessionRoot,
  ensureSession,
  inboxHasEvent,
  readSessionState,
  sessionCursorFor,
  sessionEventTarget,
  sessionEvents,
  sessionInboxPath,
  sessionInstructions,
  sessionManifestPath,
  sessionPromptPath,
  writeInboxEvent,
  writeJsonFile,
  writeSessionCursor,
  writeSessionState,
} = require("../session");

function generateWebhookSecret() {
  return crypto.randomBytes(16).toString("hex");
}

function verifyWebhookSignature(payload, signature, secret) {
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  if (expectedBytes.length !== signatureBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBytes, signatureBytes);
}

function extractPublicUrl(text) {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? match[0].replace(/[)\],.]+$/, "") : null;
}

function tunnelWebhookUrl(publicUrl, receiverPath) {
  return `${publicUrl.replace(/\/+$/, "")}${normalizeWebhookPath(receiverPath)}`;
}

async function drainRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function startServer(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function waitForSignals() {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function spawnCapture(deps, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (deps.spawn || spawn)(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || deps.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const err = new Error(`${command} exited with code ${code}: ${stderr || stdout}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function sendHeartbeat(deps) {
  try {
    await requestJson(deps, "POST", "/agents/heartbeat", { body: {} });
    return true;
  } catch (_err) {
    return false;
  }
}

function tunnelInstallHint(command) {
  const commandName = command || "cloudflared";
  if (commandName !== "cloudflared") {
    return `Ensure ${commandName} is installed and available on PATH, or pass --webhook-url with an existing public HTTPS receiver URL.`;
  }
  return [
    "Install cloudflared and retry, or pass --webhook-url with an existing public HTTPS receiver URL.",
    "macOS: brew install cloudflared",
    "Other platforms: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  ].join(" ");
}

async function commandOnline(options, deps, flags = new Set()) {
  const host = options.host || "127.0.0.1";
  const port = positiveNumberOption(options, "port") || 8787;
  const receiverPath = normalizeWebhookPath(options.path || "/webhooks/clawlabor");
  const inboxFile = options["inbox-file"] || defaultOnlineInboxPath(deps.env);
  const sessionRoot = options["session-root"] || defaultSessionRoot(deps.env);
  const currentSessionId = options["session-id"] || defaultSessionId(deps.env);
  const webhookSecret = options["webhook-secret"] || generateWebhookSecret();
  const explicitWebhookUrl = options["webhook-url"] || null;
  const noTunnel = flags.has("no-tunnel") || options["tunnel-command"] === "none";
  const tunnelCommand = explicitWebhookUrl || noTunnel
    ? null
    : options["tunnel-command"] || "cloudflared";

  if (!explicitWebhookUrl && !tunnelCommand) {
    throw new Error(
      "Missing reachability config: provide --webhook-url or allow the default Cloudflare tunnel.",
    );
  }

  const localUrl = `http://${host}:${port}${receiverPath}`;
  const sessionState = readSessionState(sessionRoot);
  sessionState.current_session_id = currentSessionId;
  ensureSession(
    sessionRoot,
    sessionState,
    currentSessionId,
    {
      kind: "current",
      role: "current",
      context_id: null,
      purpose: "Current Hermes/agent runtime session for buyer-side results and general events",
    },
    null,
  );
  writeSessionState(sessionRoot, sessionState);

  const server = (deps.createServer || http.createServer)(async (req, res) => {
    try {
      const method = (req.method || "GET").toUpperCase();
      const requestPath = (req.url || "").split("?")[0];

      if (method === "GET" && requestPath === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, receiver_url: localUrl }));
        return;
      }

      if (method !== "POST" || requestPath !== receiverPath) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const rawBody = await drainRequestBody(req);
      if (webhookSecret) {
        const signature = req.headers?.["x-webhook-signature"];
        if (!signature || !verifyWebhookSignature(rawBody, String(signature), webhookSecret)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_signature" }));
          return;
        }
      }

      let event = null;
      try {
        event = JSON.parse(rawBody.toString("utf8"));
      } catch (_err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }

      if (!event || typeof event.event_id !== "number" || !event.event_type) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_event" }));
        return;
      }

      const envelope = {
        received_at: new Date().toISOString(),
        ...event,
      };
      const duplicateGlobalEvent = inboxHasEvent(inboxFile, event.event_id);
      if (!duplicateGlobalEvent) {
        writeInboxEvent(inboxFile, envelope);
      }

      const state = readSessionState(sessionRoot);
      state.current_session_id = state.current_session_id || currentSessionId;
      const target = sessionEventTarget(event, state.current_session_id, state);
      if (target) {
        const session = ensureSession(
          sessionRoot,
          state,
          target.sessionId,
          target.meta,
          envelope,
        );
        session.last_event_id = Math.max(Number(session.last_event_id || 0), Number(event.event_id || 0));
        session.updated_at = new Date().toISOString();
        state.sessions[target.sessionId] = session;
        appendSessionEvent(sessionRoot, target.sessionId, envelope);
        writeJsonFile(sessionManifestPath(sessionRoot, target.sessionId), session);
        writeSessionState(sessionRoot, state);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        received: true,
        duplicate: duplicateGlobalEvent,
        event_id: event.event_id,
        session_id: target ? target.sessionId : null,
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await startServer(server, host, port);

  let tunnelProcess = null;
  let resolvedWebhookUrl = explicitWebhookUrl;
  let tunnelReadyResolve = null;
  let tunnelReadyReject = null;
  const tunnelReady = tunnelCommand && !resolvedWebhookUrl
    ? new Promise((resolve, reject) => {
        tunnelReadyResolve = resolve;
        tunnelReadyReject = reject;
      })
    : Promise.resolve();
  if (tunnelCommand) {
    try {
      tunnelProcess = (deps.spawn || spawn)(
        tunnelCommand,
        ["tunnel", "--url", localUrl],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      await closeServer(server);
      throw new Error(
        `Failed to start tunnel command "${tunnelCommand}": ${err.message}. ${tunnelInstallHint(tunnelCommand)}`,
      );
    }

    const updateFromOutput = async (chunk) => {
      const url = extractPublicUrl(chunk.toString("utf8"));
      if (!url || resolvedWebhookUrl) return;
      resolvedWebhookUrl = tunnelWebhookUrl(url, receiverPath);
      try {
        await requestJson(deps, "PATCH", "/agents/me", {
          body: {
            webhook_url: resolvedWebhookUrl,
            webhook_secret: webhookSecret,
          },
        });
        tunnelReadyResolve?.(resolvedWebhookUrl);
      } catch (err) {
        tunnelReadyReject?.(err);
      }
    };

    tunnelProcess.stdout?.on("data", (chunk) => {
      void updateFromOutput(chunk);
    });
    tunnelProcess.stderr?.on("data", (chunk) => {
      void updateFromOutput(chunk);
    });

    tunnelProcess.once("error", (err) => {
      const wrapped = new Error(
        `Failed to start tunnel command "${tunnelCommand}": ${err.message}. ${tunnelInstallHint(tunnelCommand)}`,
      );
      wrapped.cause = err;
      tunnelReadyReject?.(wrapped);
    });

    tunnelProcess.once("exit", (code) => {
      if (!resolvedWebhookUrl) {
        tunnelReadyReject?.(
          new Error(`Tunnel command exited before publishing a public URL (code ${code})`),
        );
      }
    });
  }

  try {
    if (resolvedWebhookUrl) {
      await requestJson(deps, "PATCH", "/agents/me", {
        body: {
          webhook_url: resolvedWebhookUrl,
          webhook_secret: webhookSecret,
        },
      });
    } else if (tunnelCommand) {
      await tunnelReady;
    }
  } catch (err) {
    if (tunnelProcess && !tunnelProcess.killed) {
      tunnelProcess.kill("SIGTERM");
    }
    await closeServer(server);
    throw err;
  }

  const heartbeatOk = await sendHeartbeat(deps);
  const heartbeatIntervalMs = (positiveNumberOption(options, "heartbeat-interval") || 60) * 1000;
  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat(deps);
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  const output = {
    action: "online",
    status: "ready",
    started_at: new Date().toISOString(),
    receiver_url: localUrl,
    inbox_file: inboxFile,
    session_root: sessionRoot,
    current_session_id: currentSessionId,
    current_session_prompt: sessionPromptPath(sessionRoot, currentSessionId),
    webhook_url: resolvedWebhookUrl,
    webhook_secret: webhookSecret,
    tunnel_command: tunnelCommand || null,
    heartbeat_ok: heartbeatOk,
    heartbeat_interval_seconds: Math.floor(heartbeatIntervalMs / 1000),
    next: "Keep this process alive; incoming webhooks will be written to global and session inboxes. Hermes can run clawlabor session --action next to get work for the current session.",
  };

  const stderr = deps.stderr || ((text) => process.stderr.write(`${text}\n`));
  stderr(
    `[clawlabor online] ready webhook=${resolvedWebhookUrl || "(local-only)"} ` +
      `listen=${host}:${port} session=${currentSessionId} ` +
      `heartbeat_ok=${heartbeatOk} interval=${Math.floor(heartbeatIntervalMs / 1000)}s`,
  );
  deps.stdout(JSON.stringify(output));

  const exitPromise =
    typeof deps.waitForExit === "function" ? deps.waitForExit() : deps.waitForExit || waitForSignals();
  await exitPromise;

  try {
    clearInterval(heartbeatTimer);
    if (tunnelProcess && !tunnelProcess.killed) {
      tunnelProcess.kill("SIGTERM");
    }
  } catch (_err) {
    // best effort
  }

  await closeServer(server);

  return undefined;
}

async function commandSession(options, deps) {
  const action = options.action || "next";
  const sessionRoot = options["session-root"] || defaultSessionRoot(deps.env);
  const state = readSessionState(sessionRoot);
  const sessionId = options["session-id"] || state.current_session_id || defaultSessionId(deps.env);

  if (action === "list") {
    const sessions = Object.values(state.sessions || {}).map((session) => {
      const cursor = sessionCursorFor(sessionRoot, session.session_id);
      const pending = sessionEvents(sessionRoot, session.session_id)
        .filter((event) => Number(event.event_id || 0) > Number(cursor.last_acked_event_id || 0));
      return {
        ...session,
        inbox_file: sessionInboxPath(sessionRoot, session.session_id),
        prompt_file: sessionPromptPath(sessionRoot, session.session_id),
        pending_count: pending.length,
        last_acked_event_id: cursor.last_acked_event_id || 0,
      };
    });
    return JSON.stringify({
      action: "list",
      current_session_id: state.current_session_id || null,
      session_root: sessionRoot,
      sessions,
    });
  }

  const session = state.sessions?.[sessionId];
  if (!session) {
    return JSON.stringify({
      action,
      session_id: sessionId,
      found: false,
      next: "Start clawlabor online or check clawlabor session --action list.",
    });
  }

  if (action === "show") {
    const cursor = sessionCursorFor(sessionRoot, sessionId);
    const pending = sessionEvents(sessionRoot, sessionId)
      .filter((event) => Number(event.event_id || 0) > Number(cursor.last_acked_event_id || 0));
    return JSON.stringify({
      action: "show",
      found: true,
      session,
      inbox_file: sessionInboxPath(sessionRoot, sessionId),
      prompt_file: sessionPromptPath(sessionRoot, sessionId),
      pending_count: pending.length,
      last_acked_event_id: cursor.last_acked_event_id || 0,
    });
  }

  if (action === "prompt") {
    const promptFile = sessionPromptPath(sessionRoot, sessionId);
    return fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : sessionInstructions(session, null);
  }

  if (action === "ack") {
    const eventId = positiveNumberOption(options, "event-id");
    if (eventId === undefined) {
      throw new Error("Missing required --event-id for session ack");
    }
    writeSessionCursor(sessionRoot, sessionId, eventId);
    return JSON.stringify({
      action: "ack",
      session_id: sessionId,
      event_id: eventId,
      status: "acknowledged",
    });
  }

  if (action === "next") {
    const cursor = sessionCursorFor(sessionRoot, sessionId);
    const nextEvent = sessionEvents(sessionRoot, sessionId)
      .find((event) => Number(event.event_id || 0) > Number(cursor.last_acked_event_id || 0));
    if (!nextEvent) {
      return JSON.stringify({
        action: "next",
        session_id: sessionId,
        event: null,
        pending: false,
        prompt_file: sessionPromptPath(sessionRoot, sessionId),
        next: "No pending ClawLabor events for this session.",
      });
    }
    return JSON.stringify({
      action: "next",
      session_id: sessionId,
      pending: true,
      event: nextEvent,
      prompt_file: sessionPromptPath(sessionRoot, sessionId),
      instructions: sessionInstructions(session, nextEvent),
      next: `Handle event ${nextEvent.event_id}, then run clawlabor session --action ack --session-id ${sessionId} --event-id ${nextEvent.event_id}.`,
    });
  }

  throw new Error("--action must be one of: list, show, prompt, next, ack");
}

const SELLER_PROMPT_HEADER = [
  "You are the seller agent for an isolated ClawLabor order session.",
  "Fulfill exactly this order, and do not mix it with other orders or sessions.",
  "Follow the ClawLabor skill instructions already loaded in this runtime for marketplace conduct and delivery quality.",
  "Use the SKU/listing description, input schema, buyer requirement, messages, and attachments as the contract.",
  "Use the order details, messages, and attachments to decide what to do next.",
  "Do not invent requirements beyond the SKU description and buyer requirement.",
];

function buildSellerPrompt(sessionId, orderForAdapter) {
  return [
    SELLER_PROMPT_HEADER[0].replace(
      "for an isolated ClawLabor order session.",
      `for isolated ClawLabor order session ${sessionId}.`,
    ),
    ...SELLER_PROMPT_HEADER.slice(1),
    "",
    "Order:",
    JSON.stringify(orderForAdapter, null, 2),
  ].join("\n");
}

const ADAPTERS = {
  hermes: {
    defaultCommand: "hermes",
    buildArgs(prompt, options) {
      const args = [
        "chat",
        "-q",
        prompt,
        "--ignore-rules",
        "--skills",
        options.skills || "clawlabor",
        "--max-turns",
        String(positiveNumberOption(options, "max-turns") || 20),
        "-Q",
        "--source",
        "tool",
      ];
      if (options.model) args.push("--model", options.model);
      if (options.provider) args.push("--provider", options.provider);
      return args;
    },
  },
  claude: {
    defaultCommand: "claude",
    buildArgs(prompt, options) {
      // -p / --print: non-interactive; --dangerously-skip-permissions: seller
      // adapter must run unattended. Opt out via CLAWLABOR_SERVE_NO_BYPASS=1.
      const args = ["-p", prompt];
      const noBypass =
        options["no-permission-bypass"] ||
        (options.env || {}).CLAWLABOR_SERVE_NO_BYPASS === "1";
      if (!noBypass) args.push("--dangerously-skip-permissions");
      if (options.model) args.push("--model", options.model);
      if (options["append-system-prompt"]) {
        args.push("--append-system-prompt", options["append-system-prompt"]);
      }
      return args;
    },
  },
  codex: {
    defaultCommand: "codex",
    buildArgs(prompt, options) {
      // `codex exec` is the non-interactive entry point. Sandbox stays at the
      // user's codex default; let the operator override via --sandbox.
      const args = ["exec", prompt];
      if (options.model) args.push("--model", options.model);
      if (options.sandbox) args.push("--sandbox", options.sandbox);
      return args;
    },
  },
};

const ADAPTER_NAMES = Object.keys(ADAPTERS);

function resolveAdapterCommand(adapter, options) {
  // Per-adapter override (legacy: --hermes-command). Generic: --adapter-command.
  const legacyKey = `${adapter}-command`;
  return (
    options["adapter-command"] ||
    options[legacyKey] ||
    ADAPTERS[adapter].defaultCommand
  );
}

async function runAdapterForOrderSession({
  deps,
  adapter,
  sessionRoot,
  sessionId,
  event,
  order,
  options,
}) {
  const spec = ADAPTERS[adapter];
  if (!spec) {
    throw new Error(
      `--adapter "${adapter}" is not supported. Available: ${ADAPTER_NAMES.join(", ")}.`,
    );
  }
  const eventPayload = event?.payload || {};
  const orderForAdapter = {
    ...order,
    requirement: order?.requirement || eventPayload.requirement || null,
    input_schema: order?.input_schema || eventPayload.input_schema || null,
    service_sku_id: order?.service_sku_id || eventPayload.service_sku_id || null,
    endpoint_capability: order?.endpoint_capability || eventPayload.endpoint_capability || null,
    event_payload: eventPayload,
  };
  const prompt = buildSellerPrompt(sessionId, orderForAdapter);
  const command = resolveAdapterCommand(adapter, options);
  const args = spec.buildArgs(prompt, { ...options, env: deps.env });
  const cwd = options.cwd || deps.env.CLAWLABOR_SERVE_CWD || process.cwd();
  const result = await spawnCapture(deps, command, args, {
    cwd,
    env: {
      ...deps.env,
      CLAWLABOR_SESSION_ROOT: sessionRoot,
      CLAWLABOR_SESSION_ID: sessionId,
      CLAWLABOR_SERVE_ADAPTER: adapter,
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function processSellerOrderSession({ deps, adapter, sessionRoot, session, event, options }) {
  const orderId = event?.payload?.order_id || session.context_id;
  if (!orderId) {
    throw new Error(`Session ${session.session_id} has no order_id`);
  }

  const orderDetail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = orderDetail.order || orderDetail;
  if (order.status === "created" || order.status === "pending_accept" || order.status === "pending_acceptance") {
    await requestJson(deps, "POST", `/orders/${orderId}/accept`, { body: {} });
  }

  const refreshedDetail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const refreshedOrder = refreshedDetail.order || refreshedDetail;
  await runAdapterForOrderSession({
    deps,
    adapter,
    sessionRoot,
    sessionId: session.session_id,
    event,
    order: refreshedOrder,
    options,
  });
  writeSessionCursor(sessionRoot, session.session_id, event.event_id);
  return {
    session_id: session.session_id,
    order_id: orderId,
    event_id: event.event_id,
    status: refreshedOrder.status || order.status || "notified",
    delivery_note: refreshedOrder.delivery_note || null,
  };
}

async function serveOnce(options, deps) {
  const adapter = options.adapter || "hermes";
  if (!ADAPTERS[adapter]) {
    throw new Error(
      `--adapter "${adapter}" is not supported. Available: ${ADAPTER_NAMES.join(", ")}.`,
    );
  }
  const sessionRoot = options["session-root"] || defaultSessionRoot(deps.env);
  const state = readSessionState(sessionRoot);
  const processed = [];
  const errors = [];

  for (const session of Object.values(state.sessions || {})) {
    if (!(session.kind === "order" && session.role === "seller")) continue;
    const cursor = sessionCursorFor(sessionRoot, session.session_id);
    const event = sessionEvents(sessionRoot, session.session_id)
      .find((item) =>
        item.event_type === "order.received" &&
        Number(item.event_id || 0) > Number(cursor.last_acked_event_id || 0)
      );
    if (!event) continue;
    try {
      processed.push(await processSellerOrderSession({ deps, adapter, sessionRoot, session, event, options }));
    } catch (err) {
      errors.push({
        session_id: session.session_id,
        event_id: event.event_id,
        error: err.message,
      });
    }
  }
  return { processed, errors };
}

async function commandServe(options, deps, flags) {
  const pollInterval = positiveNumberOption(options, "poll-interval") || 5;
  const once = flags.has("once");
  const output = {
    action: "serve",
    adapter: options.adapter || "hermes",
    session_root: options["session-root"] || defaultSessionRoot(deps.env),
    processed: [],
    errors: [],
  };

  if (once) {
    const result = await serveOnce(options, deps);
    output.processed.push(...result.processed);
    output.errors.push(...result.errors);
    return JSON.stringify(output);
  }

  const stderr = deps.stderr || ((text) => process.stderr.write(`${text}\n`));
  stderr(
    `[clawlabor serve] ready adapter=${output.adapter} ` +
      `session_root=${output.session_root} poll=${pollInterval}s`,
  );
  deps.stdout(JSON.stringify({
    action: "serve",
    status: "ready",
    started_at: new Date().toISOString(),
    adapter: output.adapter,
    session_root: output.session_root,
    poll_interval: pollInterval,
    next: "Keep this process alive next to clawlabor online; seller order sessions will be fulfilled by Hermes.",
  }));

  const exitPromise =
    typeof deps.waitForExit === "function" ? deps.waitForExit() : deps.waitForExit || waitForSignals();
  let exiting = false;
  exitPromise.then(() => {
    exiting = true;
  });

  while (!exiting) {
    const result = await serveOnce(options, deps);
    for (const item of result.processed) {
      deps.stdout(JSON.stringify({ action: "served", ...item }));
    }
    for (const item of result.errors) {
      deps.stdout(JSON.stringify({ action: "serve_error", ...item }));
    }
    await Promise.race([
      exitPromise,
      deps.sleep(pollInterval * 1000),
    ]);
  }
  return undefined;
}

module.exports = {
  commandOnline,
  commandServe,
  commandSession,
  serveOnce,
  // exposed for testing
  _internals: {
    ADAPTERS,
    ADAPTER_NAMES,
    buildSellerPrompt,
    resolveAdapterCommand,
  },
};
