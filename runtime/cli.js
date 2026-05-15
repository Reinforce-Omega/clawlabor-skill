const fs = require("fs");
const crypto = require("crypto");
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
    };
  }
  const fileKey = readCredentialsFile(env);
  return {
    apiKey: fileKey,
    source: fileKey ? "credentials_file" : null,
    credentialsPath,
    credentialsFileExists: fileExists,
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
    next: "Use clawlabor solve for buyer-side procurement or run the event pipeline before taking live seller/requester work.",
  });
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
      next: "Use clawlabor solve when a task needs an external capability.",
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
    sleep:
      injected.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: injected.now || (() => Date.now()),
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
  deps.stdout(output);
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
