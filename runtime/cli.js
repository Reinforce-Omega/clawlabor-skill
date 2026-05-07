const fs = require("fs");
const crypto = require("crypto");

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

function authHeaders(env) {
  const apiKey = env.CLAWLABOR_API_KEY;
  if (!apiKey) {
    throw new Error("Set CLAWLABOR_API_KEY before calling clawlabor");
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
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

async function requestJson(deps, method, path, options) {
  const text = await request(deps, method, path, options);
  return text ? JSON.parse(text) : {};
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

// ---------------------------------------------------------------------------
// command implementations
// ---------------------------------------------------------------------------

async function commandMatch(options, deps, flags) {
  const body = matchBody(options, flags, deps.env);
  const text = await request(deps, "POST", "/listings/match", { body });
  return text;
}

async function commandPlan(options, deps, flags) {
  const body = matchBody(options, flags, deps.env);
  const matchResult = await requestJson(deps, "POST", "/listings/match", { body });
  const matches = Array.isArray(matchResult.matches) ? matchResult.matches : [];
  const selected = matches.find((item) => item.policy?.allowed !== false);
  if (!selected) {
    throw new Error("No policy-compatible ClawLabor listing matched this goal");
  }

  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const requirement = (options["requirement-json"] || options["requirement-file"])
    ? parseRequirement(options)
    : null;
  const schemaCheck = requirement
    ? validateRequirementAgainstSchema(requirement, selected.input_schema)
    : { valid: true, missing: [] };

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
    requirement,
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
  const orderId = requiredOption(options, "order");
  const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = detail.order || detail;
  const summary = {
    id: order?.id,
    status: order?.status,
    has_delivery: Boolean(order?.delivery_note),
    delivery_validation: order?.delivery_validation || null,
    accept_deadline: order?.accept_deadline || null,
    confirm_deadline: order?.confirm_deadline || null,
    accepted_at: order?.accepted_at || null,
    completed_at: order?.completed_at || null,
    confirmed_at: order?.confirmed_at || null,
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
      return JSON.stringify({ id: last.id, status, reached: true, waited_ms: deps.now() - start });
    }
    if (TERMINAL_ORDER_STATES.has(status) && status !== until) {
      return JSON.stringify({
        id: last.id,
        status,
        reached: false,
        reason: "terminal_state_before_target",
        waited_ms: deps.now() - start,
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

async function commandResult(options, deps) {
  const orderId = requiredOption(options, "order");
  const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = detail.order || detail;
  const delivery = parseDeliveryNote(order?.delivery_note);
  return JSON.stringify({
    id: order?.id,
    status: order?.status,
    delivery_format: delivery.format,
    delivery: delivery.value,
    delivery_validation: order?.delivery_validation || null,
  });
}

async function commandConfirm(options, deps) {
  const orderId = requiredOption(options, "order");
  return request(deps, "POST", `/orders/${orderId}/confirm`, { body: {} });
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
  return request(deps, "POST", "/tasks", { body });
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

  const selected = allowed[0];

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

  return JSON.stringify({
    action: confirmed ? "completed" : "delivered",
    order_id: orderId,
    listing_id: selected.id,
    validation,
    delivery_format: delivery.format,
    delivery: delivery.value,
    auto_confirmed: Boolean(confirmed),
    trace,
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const COMMANDS = {
  match: commandMatch,
  plan: commandPlan,
  buy: commandBuy,
  validate: commandValidate,
  inspect: commandInspect,
  status: commandStatus,
  wait: commandWait,
  result: commandResult,
  confirm: commandConfirm,
  post: commandPost,
  solve: commandSolve,
};

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
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(
      `Usage: clawlabor <${Object.keys(COMMANDS).join("|")}> [options]`,
    );
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
  parseDeliveryNote,
  ApiError,
};
