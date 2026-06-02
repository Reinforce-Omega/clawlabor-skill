const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const path = require("path");
const {
  ApiError,
  apiBase,
  credentialState,
  credentialsFilePath,
  makeIdempotencyKey,
  makePublishIdempotencyKey,
  request,
  requestJson,
  requestJsonNoAuth,
  requestMultipart,
  resolveApiKey,
  writeCredentialsFile,
} = require("../http");
const {
  numberOption,
  positiveNumberOption,
  requiredOption,
} = require("../options");

const TERMINAL_ORDER_STATES = new Set([
  "pending_confirmation",
  "completed",
  "cancelled",
  "in_dispute",
]);

function readAttachmentOptions(options, fileOptionName = "file") {
  const filePath = ensureUploadPathAllowed(requiredOption(options, fileOptionName));
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

// ---------------------------------------------------------------------------
// attachment staging helpers
// ---------------------------------------------------------------------------

const URL_FIELD_SUFFIXES = ["_url", "_uri"];
const BLOCKED_EXTENSIONS = new Set([".exe", ".bat", ".sh", ".dll", ".ps1", ".cmd", ".vbs", ".js"]);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

// Hard blocklist for upload paths: protects against prompt-injected agents
// being tricked into exfiltrating local secrets. Users extend it via
// CLAWLABOR_UPLOAD_BLOCKLIST (colon-separated absolute paths).
const SENSITIVE_HOME_PREFIXES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".config/clawlabor",
  ".config/gcloud",
  ".config/gh",
  ".config/op",
  ".config/anthropic",
  ".claude",
  ".codex",
  ".openclaw",
  ".hermes",
];
const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /(^|[._-])credentials?($|[._-])/i,
  /(^|[._-])secrets?($|[._-])/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.key$/i,
];

function expandUser(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureUploadPathAllowed(localPath, env = process.env) {
  if (!localPath) {
    throw new Error("Upload path is required");
  }
  const resolved = path.resolve(expandUser(localPath));
  let realPath = resolved;
  try {
    realPath = fs.realpathSync(resolved);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // Path does not exist yet; later fs.statSync will surface the error.
  }
  const home = os.homedir();
  const extraRaw = (env.CLAWLABOR_UPLOAD_BLOCKLIST || "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rawEntry) => path.resolve(expandUser(rawEntry)));

  const candidates = resolved === realPath ? [resolved] : [resolved, realPath];

  for (const candidate of candidates) {
    const base = path.basename(candidate);
    for (const pattern of SENSITIVE_BASENAME_PATTERNS) {
      if (pattern.test(base)) {
        throw new Error(
          `Refusing to upload sensitive file: ${candidate} (basename matches ${pattern}). ` +
          "If this is a deliberate user-authorized upload, copy/rename the file to a non-sensitive path first.",
        );
      }
    }
    for (const rel of SENSITIVE_HOME_PREFIXES) {
      const blocked = path.join(home, rel);
      if (candidate === blocked || candidate.startsWith(`${blocked}${path.sep}`)) {
        throw new Error(
          `Refusing to upload from protected location: ${candidate} (under ${blocked}). ` +
          "Move the file outside this directory before uploading.",
        );
      }
    }
    for (const entry of extraRaw) {
      if (candidate === entry || candidate.startsWith(`${entry}${path.sep}`)) {
        throw new Error(
          `Refusing to upload: ${candidate} matches CLAWLABOR_UPLOAD_BLOCKLIST entry ${entry}.`,
        );
      }
    }
  }

  return realPath;
}

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
  const { field } = entry;
  const localPath = ensureUploadPathAllowed(entry.localPath, deps.env);
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

function matchBody(options, flags, env, { defaultLimit } = {}) {
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

  const explicitLimit = numberOption(options, "limit");
  if (explicitLimit !== undefined) {
    body.limit = explicitLimit;
  } else if (defaultLimit !== undefined) {
    body.limit = defaultLimit;
  }

  const requireSchema = flags && flags.has("require-schema");
  if (requireSchema) {
    body.require_schema = true;
  } else if (policy.require_schema === true) {
    body.require_schema = true;
  }

  const maxCompletionSeconds = positiveNumberOption(options, "max-completion-seconds");
  if (maxCompletionSeconds !== undefined) {
    body.max_completion_seconds = maxCompletionSeconds;
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

function describeRequiredFields(schema) {
  if (!schema || typeof schema !== "object" || !schema.properties) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.map((name) => {
    const prop = schema.properties[name] || {};
    const exampleFromProp = prop.example !== undefined
      ? prop.example
      : (Array.isArray(prop.examples) && prop.examples.length > 0 ? prop.examples[0] : null);
    return {
      name,
      type: prop.type || "string",
      format: prop.format || null,
      description: prop.description || null,
      enum: Array.isArray(prop.enum) ? prop.enum : null,
      default: prop.default !== undefined ? prop.default : null,
      example: exampleFromProp,
    };
  });
}

function buildSampleRequirement(schema, providedRequirement) {
  const sample = providedRequirement ? { ...providedRequirement } : {};
  if (!schema || typeof schema !== "object" || !schema.properties) return sample;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    const current = sample[name];
    if (current !== undefined && current !== null && current !== "") continue;
    const prop = schema.properties[name] || {};
    if (prop.example !== undefined) {
      sample[name] = prop.example;
    } else if (Array.isArray(prop.examples) && prop.examples.length > 0) {
      sample[name] = prop.examples[0];
    } else if (prop.default !== undefined) {
      sample[name] = prop.default;
    } else if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      sample[name] = prop.enum[0];
    } else {
      const typeTag = prop.type || "string";
      const formatTag = prop.format ? `:${prop.format}` : "";
      sample[name] = `<TODO:${name}:${typeTag}${formatTag}>`;
    }
  }
  return sample;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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

function summarizeOutputSchema(schema) {
  if (!schema || typeof schema !== "object") return null;
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  return {
    type: schema.type || null,
    fields: Object.keys(props),
  };
}

function candidateListingForPlan(listing, requirement) {
  const schemaCheck = validateRequirementAgainstSchema(requirement || {}, listing?.input_schema);
  return {
    ...compactListingForPlan(listing),
    description: listing?.description || null,
    tags: Array.isArray(listing?.tags) ? listing.tags : [],
    score: listing?.score ?? null,
    reasons: Array.isArray(listing?.reasons) ? listing.reasons : [],
    input_schema: listing?.input_schema || null,
    output_schema_summary: summarizeOutputSchema(listing?.output_schema),
    schema_compatibility: {
      valid: schemaCheck.valid,
      missing_required_fields: schemaCheck.missing,
    },
    decision: {
      allowed: listing?.policy?.allowed !== false,
      blocked_reasons: listing?.policy?.blocked_reasons || [],
      // Source of truth for verbosity is the server; client never truncates.
      why_matched: listing?.match_explanation || "",
      how_to_use: listing?.invocation_guidance || [],
    },
  };
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

function defaultAgentName(env) {
  const base = env.HERMES_AGENT_NAME || env.USER || "HermesAgent";
  return `${base}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "HermesAgent";
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

module.exports = {
  ApiError,
  attachmentPath,
  apiBase,
  buildSampleRequirement,
  candidateListingForPlan,
  compactListingForPlan,
  describeRequiredFields,
  credentialState,
  credentialsFileMode,
  credentialsFilePath,
  defaultAgentName,
  deriveBountyFromGoal,
  diagnosticStatus,
  ensureUploadPathAllowed,
  fetchOrderAttachments,
  fetchOrderCancellationContext,
  guessMimeType,
  hasUriSchemaField,
  isStrictUrlField,
  matchBody,
  loadPolicy,
  isUrlField,
  makeIdempotencyKey,
  makePublishIdempotencyKey,
  numberOption,
  parseFileFlags,
  parseDeliveryNote,
  parseInputFlags,
  parseJsonOption,
  parseRequirement,
  pickCompatibleListing,
  positiveNumberOption,
  readAttachmentOptions,
  request,
  requestJson,
  requestJsonNoAuth,
  requestMultipart,
  resolveApiKey,
  requiredOption,
  shellQuote,
  stageAndUploadFile,
  stringOptionFromFile,
  summarizeOrderMessages,
  TERMINAL_ORDER_STATES,
  uploadAttachment,
  validateRequirementAgainstSchema,
  writeCredentialsFile,
};
