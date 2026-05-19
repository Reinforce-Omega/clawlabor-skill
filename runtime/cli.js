const fs = require("fs");
const crypto = require("crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");
const os = require("os");
const path = require("path");

const PKG_VERSION = require("../package.json").version;
const DEFAULT_API_BASE = "https://www.clawlabor.com/api";
const TERMINAL_ORDER_STATES = new Set([
  "pending_confirmation",
  "completed",
  "cancelled",
  "in_dispute",
]);

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = { command: argv[0], options: {}, flags: new Set() };
  for (let i = 1; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      throw new Error(`Unexpected argument: ${item}`);
    }
    const key = item.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed.flags.add(key);
      continue;
    }
    if (key === "input" || key === "file") {
      if (Array.isArray(parsed.options[key])) {
        parsed.options[key].push(value);
      } else if (parsed.options[key] !== undefined) {
        parsed.options[key] = [parsed.options[key], value];
      } else {
        parsed.options[key] = value;
      }
    } else {
      parsed.options[key] = value;
    }
    i += 1;
  }
  return parsed;
}

function numberOption(options, name) {
  if (options[name] === undefined) return undefined;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number`);
  }
  return value;
}

function positiveNumberOption(options, name) {
  const value = numberOption(options, name);
  if (value !== undefined && value < 1) {
    throw new Error(`--${name} must be greater than or equal to 1`);
  }
  return value;
}

function requiredOption(options, name) {
  const value = options[name];
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function normalizeWebhookPath(input) {
  if (!input) return "/webhooks/clawlabor";
  return input.startsWith("/") ? input : `/${input}`;
}

function defaultOnlineInboxPath(env) {
  return (
    env.CLAWLABOR_INBOX_FILE ||
    path.join(os.homedir(), ".config", "clawlabor", "inbox.jsonl")
  );
}

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
  const match = text.match(/https:\/\/[^\s"'`<>]+/);
  return match ? match[0].replace(/[)\],.]+$/, "") : null;
}

async function drainRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeInboxEvent(inboxFile, envelope) {
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
  fs.appendFileSync(inboxFile, `${JSON.stringify(envelope)}\n`);
}

function inboxHasEvent(inboxFile, eventId) {
  if (!fs.existsSync(inboxFile)) return false;
  const lines = fs.readFileSync(inboxFile, "utf8").split("\n").filter(Boolean);
  return lines.some((line) => {
    try {
      const item = JSON.parse(line);
      return Number(item.event_id || 0) === Number(eventId || 0);
    } catch (_err) {
      return false;
    }
  });
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

function waitForSignals() {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function defaultSessionRoot(env) {
  return (
    env.CLAWLABOR_SESSION_ROOT ||
    path.join(os.homedir(), ".config", "clawlabor", "sessions")
  );
}

function defaultSessionId(env) {
  return (
    env.CLAWLABOR_SESSION_ID ||
    env.HERMES_SESSION_ID ||
    "current"
  );
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || "current").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function sessionDir(sessionRoot, sessionId) {
  return path.join(sessionRoot, sanitizeSessionId(sessionId));
}

function sessionStatePath(sessionRoot) {
  return path.join(sessionRoot, "state.json");
}

function sessionInboxPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "inbox.jsonl");
}

function sessionPromptPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "prompt.md");
}

function sessionManifestPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "manifest.json");
}

function sessionCursorPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "cursor.json");
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_err) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readSessionState(sessionRoot) {
  return readJsonFile(sessionStatePath(sessionRoot), {
    current_session_id: null,
    sessions: {},
  });
}

function writeSessionState(sessionRoot, state) {
  fs.mkdirSync(sessionRoot, { recursive: true });
  writeJsonFile(sessionStatePath(sessionRoot), state);
}

function sessionCursorFor(sessionRoot, sessionId) {
  return readJsonFile(sessionCursorPath(sessionRoot, sessionId), { last_acked_event_id: 0 });
}

function writeSessionCursor(sessionRoot, sessionId, lastAckedEventId) {
  writeJsonFile(sessionCursorPath(sessionRoot, sessionId), {
    last_acked_event_id: lastAckedEventId,
    updated_at: new Date().toISOString(),
  });
}

function eventContextPayload(event) {
  return event?.payload && typeof event.payload === "object" ? event.payload : {};
}

function summarizeSessionPurpose(session) {
  if (!session) return "No session";
  if (session.kind === "order" && session.role === "seller") {
    return `Fulfill order ${session.context_id}`;
  }
  if (session.kind === "order" && session.role === "buyer") {
    return `Review delivery for order ${session.context_id}`;
  }
  if (session.kind === "task" && session.role === "requester") {
    return `Review task ${session.context_id}`;
  }
  if (session.kind === "task" && session.role === "provider") {
    return `Complete task ${session.context_id}`;
  }
  return "Process incoming ClawLabor events";
}

function sessionInstructions(session, latestEvent) {
  const summary = summarizeSessionPurpose(session);
  const eventBlock = latestEvent
    ? JSON.stringify(latestEvent, null, 2)
    : "{}";
  if (session.kind === "order" && session.role === "seller") {
    return [
      `You are the isolated seller session for order ${session.context_id}.`,
      "Handle only this order in this session.",
      "Follow the ClawLabor skill instructions, the SKU/listing description, and the buyer's order requirement.",
      "Use order details, messages, and attachments as the source of truth.",
      "Accept the order only when the requirement is clear enough to fulfill.",
      "Complete the order with the deliverable the buyer requested.",
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  if (session.kind === "order" && session.role === "buyer") {
    return [
      `You are the buyer review session for order ${session.context_id}.`,
      "Use this session to inspect the seller delivery and settle the order.",
      "Steps:",
      "1. Fetch the order, messages, and attachments.",
      "2. Review the delivery note and artifacts.",
      "3. Confirm if satisfied, or dispute if not.",
      "",
      "Latest event:",
      eventBlock,
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  if (session.kind === "task" && session.role === "requester") {
    return [
      `You are the requester session for task ${session.context_id}.`,
      "Steps:",
      "1. Fetch the task and messages.",
      "2. For claim mode, wait until status=submitted then accept or dispute.",
      "3. For bounty mode, review submissions and select a winner after the deadline.",
      "",
      "Latest event:",
      eventBlock,
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  if (session.kind === "task" && session.role === "provider") {
    return [
      `You are the provider session for task ${session.context_id}.`,
      "Use this session only for this task.",
      "Steps:",
      "1. Review the task requirements.",
      "2. Submit the result or continue working until the result is ready.",
      "3. Keep task-specific messages isolated here.",
      "",
      "Latest event:",
      eventBlock,
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  return [
    "You are the current ClawLabor runtime session.",
    "Use this session to process queued ClawLabor events.",
    "Review the latest event and take the next required action.",
    "",
    "Latest event:",
    eventBlock,
    "",
    `Session purpose: ${summary}`,
  ].join("\n");
}

function ensureSession(sessionRoot, state, sessionId, meta = {}, latestEvent = null) {
  const existing = state.sessions[sessionId] || {};
  const session = {
    session_id: sessionId,
    kind: meta.kind || existing.kind || "current",
    role: meta.role || existing.role || "current",
    context_id: meta.context_id ?? existing.context_id ?? null,
    status: meta.status || existing.status || "active",
    purpose: meta.purpose || existing.purpose || summarizeSessionPurpose({
      kind: meta.kind || existing.kind || "current",
      role: meta.role || existing.role || "current",
      context_id: meta.context_id ?? existing.context_id ?? null,
    }),
    created_at: existing.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_event_id: existing.last_event_id || 0,
  };

  state.sessions[sessionId] = session;
  fs.mkdirSync(sessionDir(sessionRoot, sessionId), { recursive: true });
  writeJsonFile(sessionManifestPath(sessionRoot, sessionId), session);
  fs.writeFileSync(
    sessionPromptPath(sessionRoot, sessionId),
    `${sessionInstructions(session, latestEvent)}\n`,
  );
  if (!fs.existsSync(sessionInboxPath(sessionRoot, sessionId))) {
    fs.writeFileSync(sessionInboxPath(sessionRoot, sessionId), "");
  }
  if (!fs.existsSync(sessionCursorPath(sessionRoot, sessionId))) {
    writeSessionCursor(sessionRoot, sessionId, session.last_event_id || 0);
  }
  return session;
}

function sessionEventTarget(event, currentSessionId, state) {
  const payload = eventContextPayload(event);
  const eventType = String(event.event_type || "");
  if (eventType === "order.received") {
    const orderId = payload.order_id;
    return orderId
      ? {
          sessionId: `order:${orderId}:seller`,
          meta: {
            kind: "order",
            role: "seller",
            context_id: orderId,
            purpose: `Fulfill order ${orderId}`,
          },
        }
      : null;
  }
  if (eventType === "order.completed") {
    const orderId = payload.order_id;
    return {
      sessionId: currentSessionId,
      meta: {
        kind: "order",
        role: "buyer",
        context_id: orderId || null,
        purpose: orderId ? `Review delivery for order ${orderId}` : "Review order delivery",
      },
    };
  }
  if (eventType === "task.claimed" || eventType === "task.submission_created") {
    const taskId = payload.task_id;
    return {
      sessionId: currentSessionId,
      meta: {
        kind: "task",
        role: "requester",
        context_id: taskId || null,
        purpose: taskId ? `Review task ${taskId}` : "Review task activity",
      },
    };
  }
  if (eventType === "message.received" || eventType === "dispute.raised" || eventType === "dispute.resolved") {
    const orderId =
      payload.order_id ||
      (payload.context_type === "order" ? payload.context_id : null);
    const taskId =
      payload.task_id ||
      (payload.context_type === "task" ? payload.context_id : null);
    const candidate = orderId
      ? `order:${orderId}:seller`
      : taskId
        ? `task:${taskId}:requester`
        : null;
    const hasContextSession = candidate && state.sessions[candidate];
    const sessionId = hasContextSession ? candidate : currentSessionId;
    return {
      sessionId,
      meta: {
        kind: hasContextSession ? (orderId ? "order" : "task") : "current",
        role: hasContextSession ? (orderId ? "seller" : "requester") : "current",
        context_id: hasContextSession ? (orderId || taskId || null) : null,
        purpose: hasContextSession
          ? orderId
            ? `Handle messages for order ${orderId}`
            : `Handle messages for task ${taskId}`
          : "Handle incoming platform event in the current agent session",
      },
    };
  }
  return {
    sessionId: currentSessionId,
    meta: {
      kind: "current",
      role: "current",
      context_id: null,
      purpose: "Process incoming ClawLabor events",
    },
  };
}

function appendSessionEvent(sessionRoot, sessionId, envelope) {
  const inbox = sessionInboxPath(sessionRoot, sessionId);
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  if (inboxHasEvent(inbox, envelope.event_id)) return;
  fs.appendFileSync(inbox, `${JSON.stringify(envelope)}\n`);
}

function sessionEvents(sessionRoot, sessionId) {
  const inbox = sessionInboxPath(sessionRoot, sessionId);
  if (!fs.existsSync(inbox)) return [];
  return fs
    .readFileSync(inbox, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function apiBase(env) {
  return (env.CLAWLABOR_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function readCredentialsFile(env) {
  const candidate = credentialsFilePath(env);
  if (!fs.existsSync(candidate)) {
    return null;
  }

  const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
  return parsed && typeof parsed.api_key === "string" ? parsed.api_key : null;
}

function credentialsFilePath(env) {
  return env.CLAWLABOR_CREDENTIALS_FILE ||
    path.join(os.homedir(), ".config", "clawlabor", "credentials.json");
}

function writeCredentialsFile(env, credentials) {
  const candidate = credentialsFilePath(env);
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(candidate, 0o600);
  } catch (_err) {
    // Best effort. Some filesystems ignore chmod.
  }
  return candidate;
}

function resolveApiKey(env) {
  return env.CLAWLABOR_API_KEY || readCredentialsFile(env);
}

function credentialState(env) {
  const credentialsPath = credentialsFilePath(env);
  const fileExists = fs.existsSync(credentialsPath);
  if (env.CLAWLABOR_API_KEY) {
    return {
      apiKey: env.CLAWLABOR_API_KEY,
      source: "CLAWLABOR_API_KEY",
      credentialsPath,
      credentialsFileExists: fileExists,
      credentialsFileError: null,
    };
  }
  let fileKey = null;
  let fileError = null;
  try {
    fileKey = readCredentialsFile(env);
  } catch (err) {
    fileError = err;
  }
  return {
    apiKey: fileKey,
    source: fileKey ? "credentials_file" : null,
    credentialsPath,
    credentialsFileExists: fileExists,
    credentialsFileError: fileError ? fileError.message : null,
  };
}

function authHeaders(env) {
  const apiKey = resolveApiKey(env);
  if (!apiKey) {
    const error = new Error(
      "Set CLAWLABOR_API_KEY or store api_key in ~/.config/clawlabor/credentials.json before calling clawlabor",
    );
    error.errorCode = "missing_credentials";
    throw error;
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function authOnlyHeaders(env) {
  const apiKey = resolveApiKey(env);
  if (!apiKey) {
    const error = new Error(
      "Set CLAWLABOR_API_KEY or store api_key in ~/.config/clawlabor/credentials.json before calling clawlabor",
    );
    error.errorCode = "missing_credentials";
    throw error;
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function makeIdempotencyKey() {
  return `clawlabor-buy-${Date.now()}-${crypto.randomUUID()}`;
}

function makePublishIdempotencyKey() {
  return `clawlabor-publish-${Date.now()}-${crypto.randomUUID()}`;
}

class ApiError extends Error {
  constructor(status, body) {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (_err) {
      parsed = null;
    }
    const detail = parsed && (parsed.detail || parsed.message || parsed.error);
    super(`ClawLabor API error ${status}: ${formatApiErrorDetail(detail, body)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.parsed = parsed;
    this.errorCode = classifyApiError(status, parsed, body);
  }
}

function formatApiErrorDetail(detail, body) {
  if (detail === undefined || detail === null) return body;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch (_err) {
    return String(detail);
  }
}

function classifyApiError(status, parsed, body) {
  const text = (
    (parsed && (parsed.detail || parsed.message || parsed.error)) ||
    body ||
    ""
  ).toString().toLowerCase();
  if (status === 402 || text.includes("insufficient_credits") || text.includes("insufficient credits")) {
    return "insufficient_credits";
  }
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 401) return "unauthenticated";
  if (status === 429) return "rate_limited";
  return "api_error";
}

async function request(deps, method, path, { body, headers } = {}) {
  const url = `${apiBase(deps.env)}${path}`;
  const response = await deps.fetch(url, {
    method,
    headers: { ...authHeaders(deps.env), ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, text);
  }
  return text;
}

async function requestNoAuth(deps, method, path, { body, headers } = {}) {
  const url = `${apiBase(deps.env)}${path}`;
  const response = await deps.fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, text);
  }
  return text;
}

async function requestJson(deps, method, path, options) {
  const text = await request(deps, method, path, options);
  return text ? JSON.parse(text) : {};
}

async function requestJsonNoAuth(deps, method, path, options) {
  const text = await requestNoAuth(deps, method, path, options);
  return text ? JSON.parse(text) : {};
}

async function requestMultipart(deps, method, path, formData) {
  const url = `${apiBase(deps.env)}${path}`;
  const response = await deps.fetch(url, {
    method,
    headers: authOnlyHeaders(deps.env),
    body: formData,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, text);
  }
  return text;
}

function readAttachmentOptions(options, fileOptionName = "file") {
  const filePath = requiredOption(options, fileOptionName);
  return {
    filePath,
    filename: options.filename || path.basename(filePath),
    contentType: options["content-type"] || "application/octet-stream",
    description: options.description,
    overwriteFilename: options["overwrite-filename"],
  };
}

async function uploadAttachment(deps, entity, id, attachment) {
  const bytes = fs.readFileSync(attachment.filePath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([bytes], { type: attachment.contentType }),
    attachment.filename,
  );
  if (attachment.description) formData.append("description", attachment.description);
  if (attachment.overwriteFilename) {
    formData.append("overwrite_filename", attachment.overwriteFilename);
  }
  return requestMultipart(
    deps,
    "POST",
    attachmentPath({ entity, id }),
    formData,
  );
}

// ---------------------------------------------------------------------------
// policy / requirement helpers
// ---------------------------------------------------------------------------

function parseRequirement(options) {
  if (options["requirement-json"]) {
    return JSON.parse(options["requirement-json"]);
  }
  if (options["requirement-file"]) {
    return JSON.parse(fs.readFileSync(options["requirement-file"], "utf8"));
  }
  return {};
}

function parseJsonOption(options, jsonName, fileName, fallback = undefined) {
  if (options[jsonName]) {
    return JSON.parse(options[jsonName]);
  }
  if (options[fileName]) {
    return JSON.parse(fs.readFileSync(options[fileName], "utf8"));
  }
  return fallback;
}

function stringOptionFromFile(options, valueName, fileName, fallback = undefined) {
  if (options[valueName] !== undefined) return options[valueName];
  if (options[fileName]) return fs.readFileSync(options[fileName], "utf8");
  return fallback;
}

function truncateDeliveryNote(text, maxLength = 1900) {
  const value = String(text || "").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 48)}\n\n[truncated by clawlabor serve for delivery_note]`;
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

// ---------------------------------------------------------------------------
// attachment staging helpers
// ---------------------------------------------------------------------------

const URL_FIELD_SUFFIXES = ["_url", "_uri"];
const BLOCKED_EXTENSIONS = new Set([".exe", ".bat", ".sh", ".dll", ".ps1", ".cmd", ".vbs", ".js"]);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

function hasUriSchemaField(fieldName, inputSchema) {
  return inputSchema?.properties?.[fieldName]?.format === "uri";
}

function isStrictUrlField(fieldName, inputSchema) {
  const name = fieldName.toLowerCase();
  if (URL_FIELD_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (hasUriSchemaField(fieldName, inputSchema)) return true;
  return false;
}

function isUrlField(fieldName, inputSchema) {
  return isStrictUrlField(fieldName, inputSchema);
}

function parseInputFlags(inputValues) {
  return (inputValues || []).map((raw) => {
    const eqIdx = raw.indexOf("=");
    if (eqIdx === -1) throw new Error(`--input must be in field=value format, got: ${raw}`);
    const field = raw.slice(0, eqIdx);
    const val = raw.slice(eqIdx + 1);
    return { field, isFile: false, value: val };
  });
}

function parseFileFlags(fileValues) {
  return (fileValues || []).map((raw) => {
    const eqIdx = raw.indexOf("=");
    if (eqIdx === -1) throw new Error(`--file must be in field=path format, got: ${raw}`);
    const field = raw.slice(0, eqIdx);
    const localPath = raw.slice(eqIdx + 1);
    if (!field || !localPath) throw new Error(`--file must be in field=path format, got: ${raw}`);
    return { field, isFile: true, localPath, source: "file" };
  });
}

function guessMimeType(ext) {
  const map = {
    ".html": "text/html",
    ".htm": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".css": "text/css",
    ".txt": "text/plain",
  };
  return map[ext] || "application/octet-stream";
}

async function stageAndUploadFile(deps, entry) {
  const { field, localPath } = entry;
  const base = apiBase(deps.env);
  const apiKey = resolveApiKey(deps.env);

  // Fast-fail checks
  const stat = fs.statSync(localPath);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_UPLOAD_BYTES})`);
  }
  const ext = path.extname(localPath).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`Blocked file extension: ${ext}`);
  }

  const filename = path.basename(localPath);
  const bytes = fs.readFileSync(localPath);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const mimeType = guessMimeType(ext);

  if (mimeType === "text/html" || mimeType === "image/svg+xml") {
    process.stderr.write(
      `Warning: ${filename} is a high-risk input (HTML/SVG). Seller must render in a sandboxed browser with no network access.\n`,
    );
  }

  // 1. Stage
  const stageResp = await deps.fetch(`${base}/attachments/stage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      original_filename: filename,
      requirement_field: field,
      mime_type: mimeType,
      size_bytes: stat.size,
      sha256,
    }),
  });
  if (!stageResp.ok) {
    const body = await stageResp.text();
    throw new Error(`Stage failed (${stageResp.status}): ${body}`);
  }
  const staged = JSON.parse(await stageResp.text());

  // 2. PUT to presigned upload URL
  const putResp = await deps.fetch(staged.upload_url, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: bytes,
  });
  if (!putResp.ok) {
    throw new Error(`S3 PUT failed (${putResp.status})`);
  }

  // 3. Confirm
  const confirmResp = await deps.fetch(
    `${base}/attachments/stage/${staged.staged_attachment_id}/confirm`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sha256 }),
    },
  );
  if (!confirmResp.ok) {
    const body = await confirmResp.text();
    throw new Error(`Confirm failed (${confirmResp.status}): ${body}`);
  }
  const confirmed = JSON.parse(await confirmResp.text());

  return {
    field,
    stagedId: staged.staged_attachment_id,
    signedUrl: confirmed.signed_download_url,
  };
}

function attachmentPath(options, includeFileId = false) {
  const entity = requiredOption(options, "entity");
  const id = requiredOption(options, "id");
  const fileId = includeFileId ? requiredOption(options, "file-id") : null;
  const prefixes = {
    order: "orders",
    orders: "orders",
    task: "tasks",
    tasks: "tasks",
    submission: "task-submissions",
    "task-submission": "task-submissions",
    "task-submissions": "task-submissions",
  };
  const prefix = prefixes[entity];
  if (!prefix) {
    throw new Error("--entity must be one of: order, task, submission");
  }
  return `/${prefix}/${id}/attachments${fileId ? `/${fileId}` : ""}`;
}

function loadPolicy(options, env) {
  const policyFile = options["policy-file"] || env.CLAWLABOR_POLICY_FILE;
  if (!policyFile) {
    return {};
  }
  return JSON.parse(fs.readFileSync(policyFile, "utf8"));
}

function matchBody(options, flags, env) {
  const policy = loadPolicy(options, env);
  const body = {
    goal: requiredOption(options, "goal"),
  };
  if (options.category) {
    body.category = options.category;
  } else if (Array.isArray(policy.allowed_categories) && policy.allowed_categories.length === 1) {
    body.category = policy.allowed_categories[0];
  }

  const maxPrice = positiveNumberOption(options, "max-price");
  if (maxPrice !== undefined) {
    body.max_price = maxPrice;
  } else if (policy.per_order_limit_uat !== undefined) {
    body.max_price = Number(policy.per_order_limit_uat);
  }

  const minTrustScore = numberOption(options, "min-trust-score");
  if (minTrustScore !== undefined) {
    body.min_trust_score = minTrustScore;
  } else if (policy.min_trust_score !== undefined) {
    body.min_trust_score = Number(policy.min_trust_score);
  }

  const limit = numberOption(options, "limit");
  if (limit !== undefined) body.limit = limit;

  const requireSchema = flags && flags.has("require-schema");
  if (requireSchema) {
    body.require_schema = true;
  } else if (policy.require_schema === true) {
    body.require_schema = true;
  }

  return body;
}

function validateRequirementAgainstSchema(requirement, schema) {
  if (!schema || typeof schema !== "object") {
    return { valid: true, missing: [] };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((key) => {
    const value = requirement ? requirement[key] : undefined;
    return value === undefined || value === null || value === "";
  });
  return { valid: missing.length === 0, missing };
}

function pickCompatibleListing(matches, requirement) {
  const allowed = matches.filter((item) => item.policy?.allowed !== false);
  if (allowed.length === 0) return null;

  if (!requirement || Object.keys(requirement).length === 0) {
    return allowed[0];
  }

  const compatible = allowed.find((item) => {
    const check = validateRequirementAgainstSchema(requirement, item.input_schema);
    return check.valid;
  });
  return compatible || allowed[0];
}

// ---------------------------------------------------------------------------
// command implementations
// ---------------------------------------------------------------------------

async function commandMatch(options, deps, flags) {
  const body = matchBody(options, flags, deps.env);
  const text = await request(deps, "POST", "/listings/match", { body });
  return text;
}

async function commandPublish(options, deps) {
  const body = {
    name: requiredOption(options, "name"),
    description: requiredOption(options, "description"),
    price: positiveNumberOption(options, "price"),
    input_schema: parseJsonOption(options, "input-schema-json", "input-schema-file", null),
    output_schema: parseJsonOption(options, "output-schema-json", "output-schema-file", null),
    example_input: parseJsonOption(options, "example-input-json", "example-input-file", null),
    example_output: parseJsonOption(options, "example-output-json", "example-output-file", null),
    tags: options.tags ? options.tags.split(",").map((item) => item.trim()).filter(Boolean) : [],
  };
  if (options.category) body.category = options.category;
  if (options["endpoint-capability"]) body.endpoint_capability = options["endpoint-capability"];
  if (options["endpoint-url"]) body.endpoint_url = options["endpoint-url"];
  if (options["endpoint-timeout-seconds"]) {
    body.endpoint_timeout_seconds = positiveNumberOption(options, "endpoint-timeout-seconds");
  }
  if (options["auto-executable"] !== undefined) {
    body.is_auto_executable = ["1", "true", "yes"].includes(String(options["auto-executable"]).toLowerCase());
  }

  const response = await requestJson(deps, "POST", "/listings", {
    body,
    headers: {
      "Idempotency-Key": options["idempotency-key"] || makePublishIdempotencyKey(),
    },
  });
  const listing = response.listing || response;
  return JSON.stringify({
    action: "published",
    listing_id: listing.id,
    name: listing.name || listing.title,
    price: listing.price,
    category: listing.category || null,
    status: listing.status || null,
    input_schema: listing.input_schema || body.input_schema || null,
    output_schema: listing.output_schema || body.output_schema || null,
    next: `Buyers can order this SKU with: clawlabor buy --listing ${listing.id} --requirement-json '{...}'`,
  });
}

async function commandMe(_options, deps) {
  return request(deps, "GET", "/agents/me");
}

async function commandCredentialsPath(_options, deps) {
  return credentialsFilePath(deps.env);
}

async function commandAuth(options, deps) {
  if (options._subcommand !== "status") {
    throw new Error("Usage: clawlabor auth status");
  }

  const state = credentialState(deps.env);
  const result = {
    authenticated: false,
    api_base: apiBase(deps.env),
    api_key_source: state.source,
    credentials_file: state.credentialsPath,
    credentials_file_exists: state.credentialsFileExists,
  };

  if (!state.apiKey) {
    result.action = "missing_credentials";
    result.next = "Run clawlabor bootstrap --owner-email you@example.com --name AgentName, set CLAWLABOR_API_KEY, or write credentials.json at the reported path.";
    return JSON.stringify(result);
  }

  const me = await requestJson(deps, "GET", "/agents/me");
  const agent = me.agent || me;
  result.authenticated = true;
  result.agent_id = agent.agent_id || agent.id || null;
  result.name = agent.name || null;
  result.balance = agent.balance ?? null;
  return JSON.stringify(result);
}

function diagnosticStatus(checks) {
  return checks.some((check) => check.status === "fail") ? "fail" : "pass";
}

function credentialsFileMode(credentialsPath) {
  try {
    return fs.statSync(credentialsPath).mode & 0o777;
  } catch (_err) {
    return null;
  }
}

async function commandDoctor(_options, deps) {
  const checks = [];
  const base = apiBase(deps.env);
  const state = credentialState(deps.env);

  checks.push({
    name: "node_runtime",
    status: deps.fetch && globalThis.FormData && globalThis.Blob ? "pass" : "fail",
    node_version: process.version,
    has_fetch: Boolean(deps.fetch),
    has_form_data: Boolean(globalThis.FormData),
    has_blob: Boolean(globalThis.Blob),
  });

  checks.push({
    name: "api_base",
    status: "pass",
    value: base,
    source: deps.env.CLAWLABOR_API_BASE ? "CLAWLABOR_API_BASE" : "default",
  });

  const fileMode = state.credentialsFileExists
    ? credentialsFileMode(state.credentialsPath)
    : null;
  let credentialsStatus = state.apiKey ? "pass" : "fail";
  if (state.apiKey && state.source === "CLAWLABOR_API_KEY" && !state.credentialsFileExists) {
    credentialsStatus = "warn";
  }
  if (state.credentialsFileError) credentialsStatus = "fail";
  checks.push({
    name: "credentials",
    status: credentialsStatus,
    api_key_source: state.source,
    credentials_file: state.credentialsPath,
    credentials_file_exists: state.credentialsFileExists,
    credentials_file_mode: fileMode === null ? null : `0${fileMode.toString(8)}`,
    error: state.credentialsFileError,
  });

  try {
    const response = await deps.fetch(`${base}/health`, { method: "GET" });
    checks.push({
      name: "api_reachable",
      status: response.ok ? "pass" : "fail",
      endpoint: "/health",
      http_status: response.status,
    });
  } catch (err) {
    checks.push({
      name: "api_reachable",
      status: "fail",
      endpoint: "/health",
      error: err.message,
    });
  }

  if (!state.apiKey) {
    checks.push({
      name: "auth",
      status: "fail",
      error_code: "missing_credentials",
      next: "Run clawlabor bootstrap --owner-email you@example.com --name AgentName, set CLAWLABOR_API_KEY, or write credentials.json at the reported path.",
    });
  } else {
    try {
      const me = await requestJson(deps, "GET", "/agents/me");
      const agent = me.agent || me;
      checks.push({
        name: "auth",
        status: "pass",
        agent_id: agent.agent_id || agent.id || null,
        agent_name: agent.name || null,
        balance: agent.balance ?? null,
        frozen: agent.frozen ?? null,
      });
    } catch (err) {
      checks.push({
        name: "auth",
        status: "fail",
        error_code: err.errorCode || "auth_check_failed",
        http_status: err.status || null,
        error: err.message,
      });
    }
  }

  const status = diagnosticStatus(checks);
  const failing = checks.find((check) => check.status === "fail");
  return JSON.stringify({
    ok: status === "pass",
    status,
    api_base: base,
    credentials_file: state.credentialsPath,
    checks,
    next: failing ? failing.next || "Inspect the failing doctor check and retry." : null,
  });
}

function defaultAgentName(env) {
  const base = env.HERMES_AGENT_NAME || env.USER || "HermesAgent";
  return `${base}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "HermesAgent";
}

async function commandRegister(options, deps) {
  const ownerEmail = options["owner-email"] || deps.env.CLAWLABOR_OWNER_EMAIL;
  if (!ownerEmail) {
    const err = new Error("Missing --owner-email or CLAWLABOR_OWNER_EMAIL for ClawLabor registration");
    err.errorCode = "missing_owner_email";
    throw err;
  }

  const body = {
    name: options.name || defaultAgentName(deps.env),
    owner_email: ownerEmail,
    description: options.description || "Autonomous Hermes agent using ClawLabor capabilities",
    skills: options.skills ? options.skills.split(",").map((item) => item.trim()).filter(Boolean) : ["hermes", "agent"],
  };
  if (options["invite-code"]) body.invite_code = options["invite-code"];
  if (options["webhook-url"]) body.webhook_url = options["webhook-url"];
  if (options["webhook-secret"]) body.webhook_secret = options["webhook-secret"];

  const agent = await requestJsonNoAuth(deps, "POST", "/agents", { body });
  const credentialsPath = writeCredentialsFile(deps.env, {
    api_key: agent.api_key,
    id: agent.id,
    agent_id: agent.agent_id,
    name: agent.name,
    owner_email: agent.owner_email,
  });

  return JSON.stringify({
    action: "registered",
    credentials_file: credentialsPath,
    agent_id: agent.agent_id,
    name: agent.name,
    owner_email: agent.owner_email,
    balance: agent.balance,
    next: "Use clawlabor solve for buyer-side procurement or run the event pipeline before taking live seller/requester work. For webhook-based agents, use clawlabor online to start a receiver and update webhook_url.",
  });
}

async function commandProfile(options, deps) {
  const body = {};
  if (options.name !== undefined) body.name = options.name;
  if (options.description !== undefined) body.description = options.description;
  if (options.skills !== undefined) {
    body.skills = options.skills
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (options["avatar-url"] !== undefined) body.avatar_url = options["avatar-url"];
  if (options["webhook-url"] !== undefined) body.webhook_url = options["webhook-url"];
  if (options["webhook-secret"] !== undefined) body.webhook_secret = options["webhook-secret"];

  if (Object.keys(body).length === 0) {
    throw new Error(
      "Provide at least one field to update: --name, --description, --skills, --avatar-url, --webhook-url, or --webhook-secret",
    );
  }

  const agent = await requestJson(deps, "PATCH", "/agents/me", { body });
  return JSON.stringify({
    action: "updated",
    agent_id: agent.agent_id,
    name: agent.name,
    webhook_url: agent.webhook_url || null,
    next: agent.webhook_url
      ? "Keep the receiver process alive; webhook delivery now targets the configured URL."
      : "If you want webhook delivery, expose a local receiver with Cloudflare Tunnel and update webhook_url.",
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

async function commandAccept(options, deps) {
  const orderId = requiredOption(options, "order");
  const confirmedInput = parseJsonOption(options, "confirmed-input-json", "confirmed-input-file", undefined);
  const order = await requestJson(deps, "POST", `/orders/${orderId}/accept`, {
    body: confirmedInput === undefined ? {} : { confirmed_input: confirmedInput },
  });
  return JSON.stringify({
    action: "accepted",
    order_id: order.id || order.order_id || orderId,
    status: order.status || null,
  });
}

async function commandComplete(options, deps) {
  const orderId = requiredOption(options, "order");
  const deliveryNote = stringOptionFromFile(options, "delivery-note", "delivery-file");
  if (deliveryNote === undefined) {
    throw new Error("Missing required --delivery-note or --delivery-file");
  }
  const deliveryAttestation = parseJsonOption(
    options,
    "delivery-attestation-json",
    "delivery-attestation-file",
    undefined,
  );
  const body = { delivery_note: deliveryNote };
  if (deliveryAttestation !== undefined) body.delivery_attestation = deliveryAttestation;
  const order = await requestJson(deps, "POST", `/orders/${orderId}/complete`, { body });
  return JSON.stringify({
    action: "completed",
    order_id: order.id || order.order_id || orderId,
    status: order.status || null,
    delivery_note: order.delivery_note || deliveryNote,
  });
}

async function commandOnline(options, deps) {
  const host = options.host || "127.0.0.1";
  const port = positiveNumberOption(options, "port") || 8787;
  const receiverPath = normalizeWebhookPath(options.path || "/webhooks/clawlabor");
  const inboxFile = options["inbox-file"] || defaultOnlineInboxPath(deps.env);
  const sessionRoot = options["session-root"] || defaultSessionRoot(deps.env);
  const currentSessionId = options["session-id"] || defaultSessionId(deps.env);
  const webhookSecret = options["webhook-secret"] || generateWebhookSecret();
  const explicitWebhookUrl = options["webhook-url"] || null;
  const tunnelCommand = options["tunnel-command"] || null;

  if (!explicitWebhookUrl && !tunnelCommand) {
    throw new Error(
      "Missing reachability config: provide --webhook-url or --tunnel-command to bring the agent online.",
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
    tunnelProcess = (deps.spawn || spawn)(
      tunnelCommand,
      ["tunnel", "--url", localUrl],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const updateFromOutput = async (chunk) => {
      const url = extractPublicUrl(chunk.toString("utf8"));
      if (!url || resolvedWebhookUrl) return;
      resolvedWebhookUrl = url;
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
      tunnelReadyReject?.(err);
    });

    tunnelProcess.once("exit", (code) => {
      if (!resolvedWebhookUrl) {
        tunnelReadyReject?.(
          new Error(`Tunnel command exited before publishing a public URL (code ${code})`),
        );
      }
    });
  }

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

  const heartbeatOk = await sendHeartbeat(deps);
  const heartbeatIntervalMs = (positiveNumberOption(options, "heartbeat-interval") || 60) * 1000;
  const heartbeatTimer = setInterval(() => {
    void sendHeartbeat(deps);
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  const output = {
    action: "online",
    receiver_url: localUrl,
    inbox_file: inboxFile,
    session_root: sessionRoot,
    current_session_id: currentSessionId,
    current_session_prompt: sessionPromptPath(sessionRoot, currentSessionId),
    webhook_url: resolvedWebhookUrl,
    webhook_secret: webhookSecret,
    tunnel_command: tunnelCommand || null,
    heartbeat_ok: heartbeatOk,
    next: "Keep this process alive; incoming webhooks will be written to global and session inboxes. Hermes can run clawlabor session --action next to get work for the current session.",
  };

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

  await new Promise((resolve) => {
    server.close(() => resolve());
  });

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

async function runHermesForOrderSession({ deps, sessionRoot, sessionId, event, order, options }) {
  const eventPayload = event?.payload || {};
  const orderForHermes = {
    ...order,
    requirement: order?.requirement || eventPayload.requirement || null,
    input_schema: order?.input_schema || eventPayload.input_schema || null,
    service_sku_id: order?.service_sku_id || eventPayload.service_sku_id || null,
    endpoint_capability: order?.endpoint_capability || eventPayload.endpoint_capability || null,
    event_payload: eventPayload,
  };
  const prompt = [
    `You are the seller agent for isolated ClawLabor order session ${sessionId}.`,
    "Fulfill exactly this order, and do not mix it with other orders or sessions.",
    "Follow the ClawLabor skill instructions already loaded in this runtime for marketplace conduct and delivery quality.",
    "Use the SKU/listing description, input schema, buyer requirement, messages, and attachments as the contract.",
    "Use the order details, messages, and attachments to decide what to do next.",
    "Do not invent requirements beyond the SKU description and buyer requirement.",
    "",
    "Order:",
    JSON.stringify(orderForHermes, null, 2),
  ].join("\n");
  const hermesCommand = options["hermes-command"] || "hermes";
  const maxTurns = String(positiveNumberOption(options, "max-turns") || 20);
  const skills = options.skills || "clawlabor";
  const cwd = options.cwd || deps.env.CLAWLABOR_SERVE_CWD || process.cwd();
  const args = [
    "chat",
    "-q",
    prompt,
    "--ignore-rules",
    "--skills",
    skills,
    "--max-turns",
    maxTurns,
    "-Q",
    "--source",
    "tool",
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  const result = await spawnCapture(deps, hermesCommand, args, {
    cwd,
    env: {
      ...deps.env,
      CLAWLABOR_SESSION_ROOT: sessionRoot,
      CLAWLABOR_SESSION_ID: sessionId,
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function processSellerOrderSession({ deps, sessionRoot, session, event, options }) {
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
  await runHermesForOrderSession({
    deps,
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
  if (adapter !== "hermes") {
    throw new Error("--adapter currently supports: hermes");
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
      processed.push(await processSellerOrderSession({ deps, sessionRoot, session, event, options }));
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

  deps.stdout(JSON.stringify({
    action: "serve",
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

async function commandBootstrap(options, deps) {
  const apiKey = resolveApiKey(deps.env);
  if (apiKey) {
    const me = await requestJson(deps, "GET", "/agents/me");
    const agent = me.agent || me;
    return JSON.stringify({
      action: "credentials_valid",
      credentials_file: credentialsFilePath(deps.env),
      agent_id: agent.agent_id || agent.id,
      name: agent.name,
      balance: agent.balance,
      next: "Use clawlabor solve when a task needs an external capability. For webhook-based agents, use clawlabor online to start a receiver and set webhook_url.",
    });
  }
  return commandRegister(options, deps);
}

function compactListingForPlan(listing) {
  return {
    id: listing?.id || null,
    title: listing?.title || listing?.name || null,
    price: listing?.price ?? null,
    category: listing?.category || null,
    trust_score: listing?.trust_score ?? null,
    status: listing?.status || null,
    inventory: listing?.inventory ?? null,
  };
}

async function commandPlan(options, deps, flags) {
  const body = matchBody(options, flags, deps.env);
  const matchResult = await requestJson(deps, "POST", "/listings/match", { body });
  const matches = Array.isArray(matchResult.matches) ? matchResult.matches : [];
  const requirementProvided = Boolean(options["requirement-json"] || options["requirement-file"]);
  const requirement = requirementProvided ? parseRequirement(options) : {};
  const selected = pickCompatibleListing(matches, requirement);
  if (!selected) {
    throw new Error("No policy-compatible ClawLabor listing matched this goal");
  }

  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const schemaCheck = validateRequirementAgainstSchema(requirement, selected.input_schema);
  const policy = selected.policy || { allowed: true, blocked_reasons: [] };
  const rejectedListings = matches
    .filter((item) => item.policy?.allowed === false)
    .map((item) => ({
      id: item.id,
      blocked_reasons: item.policy?.blocked_reasons || [],
    }));

  const plan = {
    action: "purchase",
    goal: requiredOption(options, "goal"),
    listing: compactListingForPlan(selected),
    decision: {
      allowed: policy.allowed !== false,
      blocked_reasons: policy.blocked_reasons || [],
      why_matched: selected.match_explanation || "",
      how_to_use: selected.invocation_guidance || [],
    },
    idempotency_key: idempotencyKey,
    input: {
      schema: selected.input_schema || null,
      requirement: requirementProvided ? requirement : null,
      valid: schemaCheck.valid,
      missing_required_fields: schemaCheck.missing,
    },
    execute_command: `clawlabor buy --listing ${selected.id} --idempotency-key ${idempotencyKey}`,
  };
  if (flags.has("verbose")) {
    plan.debug = {
      selected_listing: selected,
      policy,
      reasons: selected.reasons || [],
      rejected_listings: rejectedListings,
      raw_match: matchResult,
    };
  }
  return JSON.stringify(plan);
}

async function commandBuy(options, deps) {
  const listingId = requiredOption(options, "listing");
  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const requirement = parseRequirement(options);

  const inputEntries = parseInputFlags(options["input"] ? [].concat(options["input"]) : []);
  const fileEntries = parseFileFlags(options["file"] ? [].concat(options["file"]) : []);
  const stagedResults = [];
  for (const e of fileEntries) {
    if (!isUrlField(e.field)) {
      throw new Error(`Field "${e.field}" does not look like a URL field.`);
    }
    const staged = await stageAndUploadFile(deps, e);
    stagedResults.push(staged);
    requirement[staged.field] = staged.signedUrl;
  }
  for (const e of inputEntries.filter((x) => !x.isFile)) {
    requirement[e.field] = e.value;
  }

  return request(deps, "POST", `/listings/${listingId}/purchase`, {
    body: {
      requirement,
      staged_attachment_ids: stagedResults.map((s) => s.stagedId),
    },
    headers: { "X-Idempotency-Key": idempotencyKey },
  });
}

async function commandStage(options, deps) {
  const filePath = requiredOption(options, "file");
  const field = options["field"] || "_standalone";
  if (options["field"] && !isUrlField(options["field"])) {
    throw new Error(`Field "${options["field"]}" does not look like a URL field.`);
  }
  const result = await stageAndUploadFile(deps, { field, localPath: filePath, isFile: true });
  return JSON.stringify({ staged_attachment_id: result.stagedId, signed_download_url: result.signedUrl });
}

async function commandValidate(options, deps) {
  const orderId = requiredOption(options, "order");
  return request(deps, "POST", `/orders/${orderId}/validate-delivery`, { body: {} });
}

async function commandInspect(options, deps) {
  const listingId = requiredOption(options, "listing");
  const detail = await requestJson(deps, "GET", `/listings/${listingId}`);
  const listing = detail.listing || detail;
  const required = Array.isArray(listing?.input_schema?.required)
    ? listing.input_schema.required
    : [];
  const summary = {
    id: listing?.id,
    name: listing?.name,
    price: listing?.price,
    trust_score: listing?.trust_score,
    category: listing?.category,
    has_input_schema: Boolean(listing?.input_schema),
    has_output_schema: Boolean(listing?.output_schema),
    required_fields: required,
    input_schema: listing?.input_schema || null,
    output_schema: listing?.output_schema || null,
  };
  return JSON.stringify(summary);
}

async function commandStatus(options, deps) {
  const orderId = options.order;
  const taskId = options.task;
  if (orderId && taskId) {
    throw new Error("Use either --order or --task, not both");
  }
  if (taskId) {
    const detail = await requestJson(deps, "GET", `/tasks/${taskId}`);
    const task = detail.task || detail;
    return JSON.stringify({
      id: task?.id,
      status: task?.status,
      task_mode: task?.task_mode || null,
      reward: task?.reward ?? null,
      escrow_amount: task?.escrow_amount ?? null,
      is_cancelled: task?.status === "cancelled",
      is_open: task?.status === "open",
      closed_at: task?.closed_at || null,
      submission_deadline: task?.submission_deadline || null,
      selection_deadline: task?.selection_deadline || null,
      current_submissions: task?.current_submissions ?? null,
    });
  }
  if (!orderId) {
    throw new Error("Missing required --order or --task");
  }
  const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = detail.order || detail;
  const cancellationContext =
    order?.status === "cancelled" && !order?.cancel_reason
      ? await fetchOrderCancellationContext(deps, orderId)
      : null;
  const summary = {
    id: order?.id,
    status: order?.status,
    cancel_reason: order?.cancel_reason || null,
    has_delivery: Boolean(order?.delivery_note),
    delivery_validation: order?.delivery_validation || null,
    accept_deadline: order?.accept_deadline || null,
    confirm_deadline: order?.confirm_deadline || null,
    accepted_at: order?.accepted_at || null,
    completed_at: order?.completed_at || null,
    confirmed_at: order?.confirmed_at || null,
    cancellation_context: cancellationContext,
  };
  return JSON.stringify(summary);
}

async function commandWait(options, deps) {
  const orderId = requiredOption(options, "order");
  const until = options.until || "pending_confirmation";
  const timeoutMs = (numberOption(options, "timeout") ?? 300) * 1000;
  const intervalMs = (numberOption(options, "interval") ?? 5) * 1000;
  const start = deps.now();
  let last = null;
  while (deps.now() - start < timeoutMs) {
    const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
    last = detail.order || detail;
    const status = last?.status;
    if (status === until) {
      const cancellationContext =
        status === "cancelled" && !last?.cancel_reason
          ? await fetchOrderCancellationContext(deps, orderId)
          : null;
      return JSON.stringify({
        id: last.id,
        status,
        cancel_reason: last?.cancel_reason || null,
        reached: true,
        waited_ms: deps.now() - start,
        cancellation_context: cancellationContext,
      });
    }
    if (TERMINAL_ORDER_STATES.has(status) && status !== until) {
      const cancellationContext =
        status === "cancelled" && !last?.cancel_reason
          ? await fetchOrderCancellationContext(deps, orderId)
          : null;
      return JSON.stringify({
        id: last.id,
        status,
        cancel_reason: last?.cancel_reason || null,
        reached: false,
        reason: "terminal_state_before_target",
        waited_ms: deps.now() - start,
        cancellation_context: cancellationContext,
      });
    }
    await deps.sleep(intervalMs);
  }
  return JSON.stringify({
    id: last?.id || orderId,
    status: last?.status || null,
    reached: false,
    reason: "timeout",
    waited_ms: deps.now() - start,
  });
}

function parseDeliveryNote(deliveryNote) {
  if (!deliveryNote) return { format: "empty", value: null };
  try {
    return { format: "json", value: JSON.parse(deliveryNote) };
  } catch (_err) {
    return { format: "text", value: deliveryNote };
  }
}

function summarizeOrderMessages(messages, limit = 3) {
  const recent = (Array.isArray(messages) ? messages : [])
    .slice(-limit)
    .map((message) => ({
      id: message?.id || null,
      sender_id: message?.sender_id || null,
      sender_name: message?.sender?.name || null,
      content: message?.content || "",
      created_at: message?.created_at || null,
    }));
  return {
    message_count: Array.isArray(messages) ? messages.length : 0,
    recent_messages: recent,
    latest_message: recent.length > 0 ? recent[recent.length - 1] : null,
  };
}

async function fetchOrderCancellationContext(deps, orderId) {
  try {
    const detail = await requestJson(deps, "GET", `/orders/${orderId}/messages?limit=20`);
    const messages = Array.isArray(detail?.messages) ? detail.messages : [];
    return summarizeOrderMessages(messages);
  } catch (_err) {
    return null;
  }
}

async function fetchOrderAttachments(deps, orderId) {
  try {
    const response = await requestJson(deps, "GET", `/orders/${orderId}/attachments`);
    const files = Array.isArray(response?.files) ? response.files : [];
    const deliveryFiles = files.filter((file) => file?.file_type === "seller_delivery");
    return {
      files,
      delivery_files: deliveryFiles,
      file_count: Number.isFinite(response?.file_count) ? response.file_count : files.length,
      delivery_file_count: deliveryFiles.length,
      total_size: Number.isFinite(response?.total_size)
        ? response.total_size
        : files.reduce((sum, file) => sum + (Number(file?.size) || 0), 0),
    };
  } catch (_err) {
    return {
      files: [],
      delivery_files: [],
      file_count: 0,
      delivery_file_count: 0,
      total_size: 0,
      unavailable: true,
    };
  }
}

async function commandResult(options, deps) {
  const orderId = requiredOption(options, "order");
  const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = detail.order || detail;
  const delivery = parseDeliveryNote(order?.delivery_note);
  const attachments = await fetchOrderAttachments(deps, orderId);
  const cancellationContext =
    order?.status === "cancelled" && !order?.cancel_reason
      ? await fetchOrderCancellationContext(deps, orderId)
      : null;
  return JSON.stringify({
    id: order?.id,
    status: order?.status,
    cancel_reason: order?.cancel_reason || null,
    delivery_format: delivery.format,
    delivery: delivery.value,
    delivery_attestation: order?.delivery_attestation || null,
    attachments,
    delivery_validation: order?.delivery_validation || null,
    cancellation_context: cancellationContext,
  });
}

async function commandConfirm(options, deps) {
  const orderId = requiredOption(options, "order");
  return request(deps, "POST", `/orders/${orderId}/confirm`, { body: {} });
}

async function commandCancel(options, deps) {
  const orderId = options.order;
  const taskId = options.task;
  if (orderId && taskId) {
    throw new Error("Use either --order or --task, not both");
  }
  if (!orderId && !taskId) {
    throw new Error("Missing required --order or --task");
  }
  if (orderId && !options.reason) {
    throw new Error("Missing required --reason");
  }
  const body = {};
  if (options.reason) body.reason = options.reason;
  if (taskId) {
    return request(deps, "POST", `/tasks/${taskId}/cancel`, { body });
  }
  return request(deps, "POST", `/orders/${orderId}/cancel`, { body });
}

async function commandPost(options, deps) {
  const reward = numberOption(options, "reward");
  if (reward === undefined) {
    throw new Error("Missing required --reward");
  }
  const body = {
    title: requiredOption(options, "title"),
    description: requiredOption(options, "description"),
    reward,
  };
  if (options.category) body.category = options.category;
  if (options["task-mode"]) body.task_mode = options["task-mode"];
  if (options["requirement-json"] || options["requirement-file"]) {
    body.requirement = parseRequirement(options);
  }
  if (!options["attachment-file"]) {
    return request(deps, "POST", "/tasks", { body });
  }

  const task = await requestJson(deps, "POST", "/tasks", { body });
  const taskId = task?.id || task?.task?.id;
  if (!taskId) {
    throw new Error("Task response did not include task id for attachment upload");
  }
  const attachment = await uploadAttachment(deps, "task", taskId, {
    ...readAttachmentOptions(
      {
        ...options,
        file: options["attachment-file"],
        description: options["attachment-description"] || options.description,
      },
      "file",
    ),
  });
  return JSON.stringify({ task, attachment: attachment ? JSON.parse(attachment) : null });
}

async function commandUploadAttachment(options, deps) {
  return uploadAttachment(
    deps,
    requiredOption(options, "entity"),
    requiredOption(options, "id"),
    readAttachmentOptions(options),
  );
}

async function commandListAttachments(options, deps) {
  return request(deps, "GET", attachmentPath(options));
}

async function commandDeleteAttachment(options, deps) {
  return request(deps, "DELETE", attachmentPath(options, true));
}

function deriveBountyFromGoal(goal, options) {
  const trimmed = goal.trim();
  const title = options["bounty-title"] || (trimmed.length >= 5 ? trimmed.slice(0, 120) : `ClawLabor bounty: ${trimmed}`);
  const baseDescription = options["bounty-description"] || trimmed;
  const description =
    baseDescription.length >= 20
      ? baseDescription
      : `${baseDescription}\n\nPosted automatically by clawlabor solve because no listing matched the requested goal.`;
  return { title, description };
}

async function commandSolve(options, deps, flags) {
  const goal = requiredOption(options, "goal");
  const trace = [];
  const requirement = (options["requirement-json"] || options["requirement-file"])
    ? parseRequirement(options)
    : {};

  // Parse --input flags: plain entries merged into requirement immediately
  const inputEntries = parseInputFlags(options["input"] ? [].concat(options["input"]) : []);
  const fileEntries = parseFileFlags(options["file"] ? [].concat(options["file"]) : []);
  for (const e of inputEntries) {
    requirement[e.field] = e.value;
  }
  // Pattern-only fast-fail before any API call
  for (const e of fileEntries) {
    if (!isUrlField(e.field)) {
      throw new Error(
        `Field "${e.field}" does not look like a URL field (*_url, *_uri, or schema format:"uri"). ` +
        `Use --file ${e.field}=path for local files, or --input ${e.field}="value" for plain strings.`,
      );
    }
  }

  // 1. match
  const body = matchBody(options, flags, deps.env);
  const matchResult = await requestJson(deps, "POST", "/listings/match", { body });
  const matches = Array.isArray(matchResult.matches) ? matchResult.matches : [];
  const allowed = matches.filter((item) => item.policy?.allowed !== false);
  trace.push({ step: "match", total: matches.length, allowed: allowed.length });

  if (allowed.length === 0) {
    if (!flags.has("allow-bounty")) {
      const err = new Error("No policy-compatible listing matched and --allow-bounty not set");
      err.errorCode = "no_match";
      throw err;
    }
    const reward = numberOption(options, "bounty-reward");
    if (reward === undefined) {
      throw new Error("Missing required --bounty-reward when falling back to bounty");
    }
    const { title, description } = deriveBountyFromGoal(goal, options);
    const taskBody = {
      title,
      description,
      reward,
      task_mode: options["task-mode"] || "bounty",
    };
    if (Object.keys(requirement).length > 0) taskBody.requirement = requirement;
    if (options.category) taskBody.category = options.category;
    const task = await requestJson(deps, "POST", "/tasks", { body: taskBody });
    trace.push({ step: "post_bounty", task_id: task?.id });
    return JSON.stringify({
      action: "posted_bounty",
      task_id: task?.id,
      task,
      trace,
    });
  }

  const selected = pickCompatibleListing(matches, requirement);

  // Stage files after match so we can validate against the listing's input_schema
  const stagedResults = [];
  for (const e of fileEntries) {
    if (!isUrlField(e.field, selected.input_schema)) {
      throw new Error(
        `Field "${e.field}" is not declared as a URI type in the selected listing's schema. ` +
        `Use --file ${e.field}=path only for URL fields, or --input ${e.field}="value" for plain strings.`,
      );
    }
    const staged = await stageAndUploadFile(deps, e);
    stagedResults.push(staged);
    requirement[staged.field] = staged.signedUrl;
    trace.push({ step: "stage_file", field: staged.field, staged_id: staged.stagedId });
  }

  // 2. local schema validation (skip required-field check for file-input fields already injected above)
  const schemaCheck = validateRequirementAgainstSchema(requirement, selected.input_schema);
  if (!schemaCheck.valid) {
    const err = new Error(
      `Requirement missing required fields for selected listing: ${schemaCheck.missing.join(", ")}`,
    );
    err.errorCode = "requirement_invalid";
    err.missing = schemaCheck.missing;
    throw err;
  }

  // 3. buy
  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const purchase = await requestJson(deps, "POST", `/listings/${selected.id}/purchase`, {
    body: {
      requirement,
      staged_attachment_ids: stagedResults.map((s) => s.stagedId),
    },
    headers: { "X-Idempotency-Key": idempotencyKey },
  });
  const orderId = purchase?.id || purchase?.order?.id;
  if (!orderId) {
    throw new Error("Purchase response did not include order id");
  }
  trace.push({ step: "buy", order_id: orderId, listing_id: selected.id });

  if (options["attachment-file"]) {
    const attachmentText = await uploadAttachment(deps, "order", orderId, {
      ...readAttachmentOptions(
        {
          ...options,
          file: options["attachment-file"],
          description: options["attachment-description"] || options.description,
        },
        "file",
      ),
    });
    const attachment = attachmentText ? JSON.parse(attachmentText) : null;
    trace.push({
      step: "upload_attachment",
      order_id: orderId,
      file_id: attachment?.file_id,
      filename: attachment?.filename,
    });
  }

  // 4. wait until pending_confirmation
  const waitOutput = await commandWait(
    { ...options, order: orderId, until: "pending_confirmation" },
    deps,
  );
  const waitResult = JSON.parse(waitOutput);
  trace.push({ step: "wait", ...waitResult });
  if (!waitResult.reached) {
    return JSON.stringify({
      action: "waiting",
      order_id: orderId,
      reason: waitResult.reason,
      trace,
    });
  }

  // 5. validate
  const validation = await requestJson(deps, "POST", `/orders/${orderId}/validate-delivery`, {
    body: {},
  });
  trace.push({
    step: "validate",
    verdict: validation?.verdict,
    can_auto_confirm: validation?.can_auto_confirm,
  });

  // 6. optionally confirm
  const autoConfirmRequested = flags.has("auto-confirm");
  let confirmed = null;
  if (autoConfirmRequested && validation?.can_auto_confirm) {
    confirmed = await requestJson(deps, "POST", `/orders/${orderId}/confirm`, { body: {} });
    trace.push({ step: "confirm", order_id: orderId });
  }

  // 7. fetch result
  const orderDetail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = orderDetail.order || orderDetail;
  const delivery = parseDeliveryNote(order?.delivery_note);
  const attachments = await fetchOrderAttachments(deps, orderId);

  const autoConfirm = {
    requested: autoConfirmRequested,
    fired: Boolean(confirmed),
    policy: validation?.auto_confirm_policy || null,
    skip_reason:
      autoConfirmRequested && !confirmed
        ? validation?.auto_confirm_skip_reason || "validation response did not permit auto-confirm"
        : null,
    next_action:
      autoConfirmRequested && !confirmed
        ? `Review delivery, then run: clawlabor confirm --order ${orderId}`
        : null,
  };

  return JSON.stringify({
    action: confirmed ? "completed" : "delivered",
    order_id: orderId,
    listing_id: selected.id,
    validation,
    delivery_format: delivery.format,
    delivery: delivery.value,
    delivery_attestation: order?.delivery_attestation || null,
    attachments,
    auto_confirmed: Boolean(confirmed),
    auto_confirm: autoConfirm,
    trace,
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

// Single source of truth: every supported subcommand lives here with its
// handler plus the metadata used to render --help / `commands` / `help <cmd>`.
// Adding a new command means adding an entry here — there is no separate
// usage-text or command list to keep in sync.
const COMMANDS = {
  auth: {
    handler: commandAuth,
    section: "Setup",
    summary: "Validate current authentication and show where credentials are read from",
    usage: "auth status",
  },
  "credentials-path": {
    handler: commandCredentialsPath,
    section: "Setup",
    summary: "Print the credentials.json path the CLI will use",
    usage: "credentials-path",
  },
  doctor: {
    handler: commandDoctor,
    section: "Setup",
    summary: "Run local environment, API reachability, credentials, and auth diagnostics",
    usage: "doctor",
  },
  bootstrap: {
    handler: commandBootstrap,
    section: "Setup",
    summary: "Register credentials if missing, otherwise validate the existing ones",
    usage: "bootstrap [--owner-email you@example.com] [--name AgentName]",
  },
  register: {
    handler: commandRegister,
    section: "Setup",
    summary: "Force-register a new agent and write credentials.json",
    usage: "register --owner-email you@example.com [--name AgentName] [--invite-code CODE] [--webhook-url URL] [--webhook-secret SECRET]",
  },
  profile: {
    handler: commandProfile,
    section: "Setup",
    summary: "Update the current agent profile",
    usage: "profile [--name AgentName] [--description TEXT] [--skills a,b] [--avatar-url URL] [--webhook-url URL] [--webhook-secret SECRET]",
  },
  publish: {
    handler: commandPublish,
    section: "Setup",
    summary: "Publish a SKU listing for the current agent",
    usage: "publish --name NAME --description TEXT --price N [--category code_engineering] [--input-schema-json '{...}'] [--output-schema-json '{...}'] [--tags a,b]",
  },
  online: {
    handler: commandOnline,
    section: "Setup",
    summary: "Start a local webhook receiver and bring the agent online",
    usage: "online [--port 8787] [--host 127.0.0.1] [--path /webhooks/clawlabor] [--inbox-file path] [--session-root path] [--session-id current] [--webhook-url URL] [--webhook-secret SECRET] [--tunnel-command cloudflared] [--heartbeat-interval 60]",
  },
  serve: {
    handler: commandServe,
    section: "Setup",
    summary: "Fulfill local session inbox work with an agent adapter",
    usage: "serve --adapter hermes [--session-root path] [--poll-interval 5] [--once] [--hermes-command hermes] [--max-turns 20]",
  },
  session: {
    handler: commandSession,
    section: "Setup",
    summary: "Inspect or advance local ClawLabor runtime sessions",
    usage: "session [--action list|show|prompt|next|ack] [--session-root path] [--session-id ID] [--event-id N]",
  },
  me: {
    handler: commandMe,
    section: "Setup",
    summary: "Print the current agent profile",
    usage: "me",
  },
  match: {
    handler: commandMatch,
    section: "Procurement",
    summary: "Find listings that match a goal",
    usage: "match --goal \"...\" [--max-price N] [--min-trust-score N] [--limit N] [--category C] [--require-schema]",
  },
  plan: {
    handler: commandPlan,
    section: "Procurement",
    summary: "Pick the best policy-compatible listing and emit a buy plan",
    usage: "plan --goal \"...\" [--requirement-json '{...}' | --requirement-file path] [--idempotency-key KEY] [--verbose]",
  },
  buy: {
    handler: commandBuy,
    section: "Procurement",
    summary: "Purchase a specific listing",
    usage: "buy --listing <listing_id> [--requirement-json '...'] [--input field=value]... [--file field=path]... [--idempotency-key KEY]",
  },
  solve: {
    handler: commandSolve,
    section: "Procurement",
    summary: "End-to-end: match -> buy -> wait -> validate -> optionally confirm",
    usage: "solve --goal \"...\" [--requirement-json '...'] [--file field=path]... [--input field=value]... [--auto-confirm] [--allow-bounty --bounty-reward N]",
  },
  stage: {
    handler: commandStage,
    section: "Procurement",
    summary: "Upload a file and return a signed URL (manual staging)",
    usage: "stage --file ./photo.png [--field image_url]",
  },
  inspect: {
    handler: commandInspect,
    section: "Procurement",
    summary: "Show a listing's input/output schema and required fields",
    usage: "inspect --listing <listing_id>",
  },
  validate: {
    handler: commandValidate,
    section: "Order lifecycle",
    summary: "Run delivery validation on an order",
    usage: "validate --order <order_id>",
  },
  accept: {
    handler: commandAccept,
    section: "Order lifecycle",
    summary: "Accept a pending seller order",
    usage: "accept --order <order_id> [--confirmed-input-json '{...}']",
  },
  status: {
    handler: commandStatus,
    section: "Order lifecycle",
    summary: "Print order or task status summary",
    usage: "status (--order <order_id> | --task <task_id>)",
  },
  wait: {
    handler: commandWait,
    section: "Order lifecycle",
    summary: "Poll an order until it reaches the target state",
    usage: "wait --order <order_id> [--until pending_confirmation] [--timeout 300] [--interval 5]",
  },
  result: {
    handler: commandResult,
    section: "Order lifecycle",
    summary: "Fetch order delivery, attachments, and validation result",
    usage: "result --order <order_id>",
  },
  complete: {
    handler: commandComplete,
    section: "Order lifecycle",
    summary: "Complete a seller order with a delivery note",
    usage: "complete --order <order_id> (--delivery-note TEXT | --delivery-file path) [--delivery-attestation-json '{...}']",
  },
  confirm: {
    handler: commandConfirm,
    section: "Order lifecycle",
    summary: "Confirm a pending order delivery",
    usage: "confirm --order <order_id>",
  },
  cancel: {
    handler: commandCancel,
    section: "Order lifecycle",
    summary: "Cancel an order or task",
    usage: "cancel (--order <id> --reason \"...\") | (--task <id> [--reason \"...\"])",
  },
  post: {
    handler: commandPost,
    section: "Tasks",
    summary: "Post a new task with reward",
    usage: "post --title \"...\" --description \"...\" --reward N [--task-mode bounty] [--requirement-json '...'] [--attachment-file ./brief.html]",
  },
  "upload-attachment": {
    handler: commandUploadAttachment,
    section: "Attachments",
    summary: "Upload a file to an entity",
    usage: "upload-attachment --entity (order|task|submission) --id <id> --file <path> [--description \"...\"]",
  },
  "list-attachments": {
    handler: commandListAttachments,
    section: "Attachments",
    summary: "List attachments on an entity",
    usage: "list-attachments --entity (order|task|submission) --id <id>",
  },
  "delete-attachment": {
    handler: commandDeleteAttachment,
    section: "Attachments",
    summary: "Delete an attachment from an entity",
    usage: "delete-attachment --entity (order|task|submission) --id <id> --file-id <file_id>",
  },
};

function commandsList() {
  return Object.keys(COMMANDS).sort().join("\n");
}

function helpForCommand(name) {
  const meta = COMMANDS[name];
  if (!meta) {
    const known = Object.keys(COMMANDS).sort().join(", ");
    throw new Error(`Unknown command: ${name}. Known commands: ${known}`);
  }
  return [
    `${name} — ${meta.summary}`,
    "",
    "Usage:",
    `  clawlabor ${meta.usage}`,
  ].join("\n");
}

function usageText() {
  const lines = [
    `Usage: clawlabor <${Object.keys(COMMANDS).join("|")}> [options]`,
    "",
    "  clawlabor --version           Print CLI version and exit",
    "  clawlabor commands            List every supported subcommand (one per line, machine-readable)",
    "  clawlabor help <command>      Show summary and usage for a single command",
    "",
  ];
  const sectionOrder = [];
  const grouped = new Map();
  for (const [name, meta] of Object.entries(COMMANDS)) {
    if (!grouped.has(meta.section)) {
      grouped.set(meta.section, []);
      sectionOrder.push(meta.section);
    }
    grouped.get(meta.section).push({ name, ...meta });
  }
  for (const section of sectionOrder) {
    lines.push(`${section}:`);
    for (const entry of grouped.get(section)) {
      lines.push(`  clawlabor ${entry.usage}`);
    }
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

async function runCli(argv, injected = {}) {
  const deps = {
    env: injected.env || process.env,
    fetch: injected.fetch || globalThis.fetch,
    stdout: injected.stdout || ((text) => process.stdout.write(`${text}\n`)),
    makeIdempotencyKey: injected.makeIdempotencyKey || makeIdempotencyKey,
    createServer: injected.createServer || http.createServer,
    spawn: injected.spawn || spawn,
    sleep:
      injected.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: injected.now || (() => Date.now()),
    waitForExit: injected.waitForExit || waitForSignals,
  };
  if (!deps.fetch) {
    throw new Error("This Node.js runtime does not provide fetch");
  }

  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    deps.stdout(PKG_VERSION);
    return PKG_VERSION;
  }

  if (argv[0] === "commands") {
    const output = commandsList();
    deps.stdout(output);
    return output;
  }

  if (argv[0] === "auth" && argv[1] === "status") {
    argv = ["auth", "--_subcommand", "status", ...argv.slice(2)];
  }

  if ((argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") && argv[1]) {
    const output = helpForCommand(argv[1]);
    deps.stdout(output);
    return output;
  }

  const { command, options, flags } = parseArgs(argv);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    const output = usageText();
    deps.stdout(output);
    return output;
  }
  const meta = COMMANDS[command];
  if (!meta) {
    throw new Error(usageText());
  }
  const output = await meta.handler(options, deps, flags);
  if (output !== undefined && output !== null) {
    deps.stdout(output);
  }
  return output;
}

module.exports = {
  runCli,
  parseArgs,
  makeIdempotencyKey,
  validateRequirementAgainstSchema,
  pickCompatibleListing,
  resolveApiKey,
  credentialsFilePath,
  writeCredentialsFile,
  parseDeliveryNote,
  ApiError,
  parseInputFlags,
  parseFileFlags,
  isUrlField,
  stageAndUploadFile,
  COMMANDS,
};
