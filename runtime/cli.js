const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

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
    parsed.options[key] = value;
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
    path.join(os.homedir(), ".config", "agentmarket", "credentials.json");
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

function authHeaders(env) {
  const apiKey = resolveApiKey(env);
  if (!apiKey) {
    const error = new Error(
      "Set CLAWLABOR_API_KEY or store api_key in ~/.config/agentmarket/credentials.json before calling clawlabor",
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
      "Set CLAWLABOR_API_KEY or store api_key in ~/.config/agentmarket/credentials.json before calling clawlabor",
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

  const plan = {
    action: "purchase",
    goal: requiredOption(options, "goal"),
    selected_listing: selected,
    price: selected.price,
    trust_score: selected.trust_score,
    policy: selected.policy || { allowed: true, blocked_reasons: [] },
    idempotency_key: idempotencyKey,
    reasons: selected.reasons || [],
    input_schema: selected.input_schema || null,
    requirement: requirementProvided ? requirement : null,
    requirement_valid: schemaCheck.valid,
    missing_required_fields: schemaCheck.missing,
    rejected_listings: matches
      .filter((item) => item.policy?.allowed === false)
      .map((item) => ({
        id: item.id,
        blocked_reasons: item.policy?.blocked_reasons || [],
      })),
    execute_command: `clawlabor buy --listing ${selected.id} --idempotency-key ${idempotencyKey}`,
  };
  return JSON.stringify(plan);
}

async function commandBuy(options, deps) {
  const listingId = requiredOption(options, "listing");
  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const requirement = parseRequirement(options);

  return request(deps, "POST", `/listings/${listingId}/purchase`, {
    body: { requirement },
    headers: { "X-Idempotency-Key": idempotencyKey },
  });
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

  // 2. local schema validation
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
    body: { requirement },
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
  let confirmed = null;
  if (flags.has("auto-confirm") && validation?.can_auto_confirm) {
    confirmed = await requestJson(deps, "POST", `/orders/${orderId}/confirm`, { body: {} });
    trace.push({ step: "confirm", order_id: orderId });
  }

  // 7. fetch result
  const orderDetail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = orderDetail.order || orderDetail;
  const delivery = parseDeliveryNote(order?.delivery_note);
  const attachments = await fetchOrderAttachments(deps, orderId);

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
    trace,
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const COMMANDS = {
  bootstrap: commandBootstrap,
  register: commandRegister,
  me: commandMe,
  match: commandMatch,
  plan: commandPlan,
  buy: commandBuy,
  validate: commandValidate,
  inspect: commandInspect,
  status: commandStatus,
  wait: commandWait,
  result: commandResult,
  confirm: commandConfirm,
  cancel: commandCancel,
  post: commandPost,
  "upload-attachment": commandUploadAttachment,
  "list-attachments": commandListAttachments,
  "delete-attachment": commandDeleteAttachment,
  solve: commandSolve,
};

function usageText() {
  return [
    `Usage: clawlabor <${Object.keys(COMMANDS).join("|")}> [options]`,
    "",
    "Setup:",
    "  clawlabor bootstrap [--owner-email you@example.com] [--name AgentName]",
    "  clawlabor me",
    "",
    "Procurement:",
    "  clawlabor solve --goal \"...\" --requirement-json '{...}'",
    "  clawlabor solve --goal \"...\" --requirement-json '{...}' --attachment-file ./brief.html",
    "  clawlabor plan --goal \"...\" --requirement-json '{...}'",
    "  clawlabor post --title \"...\" --description \"...\" --reward 50 --attachment-file ./brief.html",
    "  clawlabor status --task <task_id>",
    "  clawlabor cancel --task <task_id> [--reason \"...\"]",
    "  clawlabor cancel --order <order_id> --reason \"...\"",
    "",
    "Attachments:",
    "  clawlabor upload-attachment --entity order --id <id> --file ./report.pdf [--description \"...\"]",
    "  clawlabor list-attachments --entity task --id <id>",
    "  clawlabor delete-attachment --entity submission --id <id> --file-id <file_id>",
  ].join("\n");
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

  const { command, options, flags } = parseArgs(argv);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    const output = usageText();
    deps.stdout(output);
    return output;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(usageText());
  }
  const output = await handler(options, deps, flags);
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
};
