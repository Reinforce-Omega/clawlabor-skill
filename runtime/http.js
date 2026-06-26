const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");

const DEFAULT_API_BASE = "https://www.clawlabor.com/api";

function apiBase(env) {
  // CLAWLABOR_API_BASE overrides for local/dev (e.g. http://localhost:8000/api).
  return (env && env.CLAWLABOR_API_BASE) || DEFAULT_API_BASE;
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

function envWithApiKey(env, apiKey) {
  return { ...env, CLAWLABOR_API_KEY: apiKey };
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

async function request(deps, method, route, { body, headers } = {}) {
  const url = `${apiBase(deps.env)}${route}`;
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

async function requestNoAuth(deps, method, route, { body, headers } = {}) {
  const url = `${apiBase(deps.env)}${route}`;
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

async function requestJson(deps, method, route, options) {
  const text = await request(deps, method, route, options);
  return text ? JSON.parse(text) : {};
}

async function requestJsonNoAuth(deps, method, route, options) {
  const text = await requestNoAuth(deps, method, route, options);
  return text ? JSON.parse(text) : {};
}

async function requestMultipart(deps, method, route, formData) {
  const url = `${apiBase(deps.env)}${route}`;
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

module.exports = {
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
  envWithApiKey,
  writeCredentialsFile,
};
