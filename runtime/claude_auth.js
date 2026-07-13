const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

// Anthropic OAuth constants. client_id is a public OAuth identifier (not a
// secret — security relies on PKCE + authorization code). This is the same
// value Claude Code and pi-ai use, hardcoded for the same reason they do:
// it's a stable public value bound to the Claude Code product.
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REFRESH_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 30_000;

function claudeCredentialsPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  return [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude-oauth-credentials.json"),
  ];
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_err) {
    return null;
  }
}

function accessTokenFromCredentials(data, now = Date.now()) {
  const oauth = data && data.claudeAiOauth;
  const token = oauth && oauth.accessToken;
  if (typeof token !== "string" || token.length === 0) return null;
  if (isExpired(oauth.expiresAt, now)) return null;
  return token;
}

function isExpired(value, now = Date.now()) {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return value < now;
  if (typeof value === "string") {
    const millis = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    return Number.isFinite(millis) ? millis < now : false;
  }
  return false;
}

function readClaudeCodeKeychainCredentials(env = process.env) {
  if (process.platform !== "darwin") return null;
  const securityBin = env.CLAWLABOR_SECURITY_BIN || "security";
  const result = spawnSync(
    securityBin,
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
}

function readClaudeOauthToken(env = process.env, now = Date.now(), deps = {}) {
  for (const file of claudeCredentialsPaths(env)) {
    const data = readJsonFile(file);
    const token = accessTokenFromCredentials(data, now);
    if (token) return token;
  }
  const readKeychainCredentials = deps.readClaudeCodeKeychainCredentials || readClaudeCodeKeychainCredentials;
  const keychainRaw = readKeychainCredentials(env);
  if (keychainRaw) {
    try {
      const token = accessTokenFromCredentials(JSON.parse(keychainRaw), now);
      if (token) return token;
    } catch (_err) {
      // Ignore malformed keychain payloads; callers will surface a normal auth hint.
    }
  }
  return null;
}

// --- OAuth token refresh ---

function readRefreshTokenFromCredentials(data) {
  const oauth = data && data.claudeAiOauth;
  const token = oauth && oauth.refreshToken;
  if (typeof token !== "string" || token.length === 0) return null;
  return token;
}

async function refreshClaudeOauthToken(refreshToken, deps = {}) {
  const fetchFn = deps.fetch || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    const response = await fetchFn(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.access_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - REFRESH_SAFETY_MARGIN_MS,
    };
  } catch (_err) {
    return null;
  }
}

function writeCredentialsToPath(filePath, credentials) {
  try {
    const existing = readJsonFile(filePath) || {};
    existing.claudeAiOauth = {
      ...(existing.claudeAiOauth && typeof existing.claudeAiOauth === "object" ? existing.claudeAiOauth : {}),
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (_err) { /* best effort */ }
    return true;
  } catch (_err) {
    return false;
  }
}

// Update the Claude Code keychain entry so Claude Code's own copy of the
// (rotated) refresh token stays valid after we refresh on its behalf.
function writeClaudeCodeKeychainCredentials(env = process.env, payload) {
  if (process.platform !== "darwin") return false;
  if (typeof payload !== "string" || payload.length === 0) return false;
  const securityBin = env.CLAWLABOR_SECURITY_BIN || "security";
  const account = env.USER || os.userInfo().username;
  const result = spawnSync(
    securityBin,
    ["add-generic-password", "-U", "-s", "Claude Code-credentials", "-a", account, "-w", payload],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0;
}

function parseClaudeAuthStatus(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function runClaudeAuthStatus(env = process.env) {
  const claudeBin = env.CLAWLABOR_CLAUDE_BIN || "claude";
  return new Promise((resolve) => {
    const child = spawn(claudeBin, ["auth", "status"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch (_err) { /* noop */ }
      resolve(false);
    }, 10000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        raw: stdout || stderr || "",
        account: parseClaudeAuthStatus(stdout || stderr || ""),
      });
    });
  });
}

async function resolveClaudeCodeOauthToken(deps = {}) {
  const env = deps.env || process.env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: env.CLAUDE_CODE_OAUTH_TOKEN, source: "env" };
  }
  if (deps.readClaudeOauthToken) {
    const token = deps.readClaudeOauthToken(env);
    if (token) return { token, source: "credentials" };
  } else {
    const token = readClaudeOauthToken(env, Date.now(), deps);
    if (token) return { token, source: "credentials" };
  }

  // Access token expired or missing — try OAuth refresh using stored refresh token.
  const refreshTokenFn = deps.refreshClaudeOauthToken || refreshClaudeOauthToken;
  for (const file of claudeCredentialsPaths(env)) {
    const data = readJsonFile(file);
    if (!data) continue;
    const refreshToken = readRefreshTokenFromCredentials(data);
    if (!refreshToken) continue;
    const refreshed = await refreshTokenFn(refreshToken, deps);
    if (!refreshed) continue;
    if (writeCredentialsToPath(file, refreshed)) {
      return { token: refreshed.accessToken, source: "refreshed" };
    }
  }

  // Try keychain for refresh token (macOS only). On success, write the rotated
  // tokens back to the keychain too — Claude Code reads the keychain first, and
  // leaving the old refresh token there could invalidate its own login.
  const readKeychain = deps.readClaudeCodeKeychainCredentials || readClaudeCodeKeychainCredentials;
  const writeKeychain = deps.writeClaudeCodeKeychainCredentials || writeClaudeCodeKeychainCredentials;
  const keychainRaw = readKeychain(env);
  if (keychainRaw) {
    try {
      const data = JSON.parse(keychainRaw);
      const refreshToken = readRefreshTokenFromCredentials(data);
      if (refreshToken) {
        const refreshed = await refreshTokenFn(refreshToken, deps);
        if (refreshed) {
          const [primaryPath] = claudeCredentialsPaths(env);
          if (writeCredentialsToPath(primaryPath, refreshed)) {
            data.claudeAiOauth = {
              ...(data.claudeAiOauth && typeof data.claudeAiOauth === "object" ? data.claudeAiOauth : {}),
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
            };
            // Best effort: the file copy above is already enough for clawlabor itself.
            writeKeychain(env, JSON.stringify(data));
            return { token: refreshed.accessToken, source: "refreshed_from_keychain" };
          }
        }
      }
    } catch (_err) { /* ignore */ }
  }

  // Last resort: spawn `claude auth status` to trigger indirect refresh.
  const authStatus = deps.runClaudeAuthStatus || runClaudeAuthStatus;
  const status = await authStatus(env);

  if (deps.readClaudeOauthToken) {
    const token = deps.readClaudeOauthToken(env);
    if (token) return { token, source: "credentials_after_status" };
  } else {
    const token = readClaudeOauthToken(env, Date.now(), deps);
    if (token) return { token, source: "credentials_after_status" };
  }

  return {
    token: null,
    source: null,
    authStatusOk: !!(status && status.ok),
    authStatus: status || null,
  };
}

async function resolveClaudeCodeAccount(deps = {}) {
  const env = deps.env || process.env;
  const authStatus = deps.runClaudeAuthStatus || runClaudeAuthStatus;
  // A present CLAUDE_CODE_OAUTH_TOKEN forces `claude auth status` into
  // inference-only mode, which hides the email/org/subscription profile. That
  // token is only the serving credential, not the host identity, so query with
  // it stripped to surface the real claude.ai subscription login for display.
  const identityEnv = { ...env };
  delete identityEnv.CLAUDE_CODE_OAUTH_TOKEN;
  const status = await authStatus(identityEnv);
  const account = status && status.account ? status.account : null;
  if (!account || !account.loggedIn) {
    return {
      provider: "claude",
      logged_in: false,
      id: null,
      label: null,
      email: null,
      org_id: null,
      org_name: null,
      plan: null,
      quota: null,
      status: status && status.ok ? "unknown_account" : "not_logged_in",
    };
  }
  const email = account.email || null;
  const orgId = account.orgId || null;
  const plan = account.subscriptionType || null;
  const id = orgId ? `org:${orgId}` : email ? `email:${email}` : null;
  return {
    provider: "claude",
    logged_in: true,
    id,
    label: orgId && account.orgName ? `${account.orgName} (${plan || "unknown"})` : email,
    email,
    org_id: orgId,
    org_name: account.orgName || null,
    plan,
    quota: null,
    quota_status: "not_exposed_by_claude_auth_status",
    auth_method: account.authMethod || null,
    api_provider: account.apiProvider || null,
    status: id ? "identified" : "logged_in_unidentified",
  };
}

module.exports = {
  claudeCredentialsPaths,
  isExpired,
  parseClaudeAuthStatus,
  readClaudeCodeKeychainCredentials,
  readClaudeOauthToken,
  readRefreshTokenFromCredentials,
  refreshClaudeOauthToken,
  resolveClaudeCodeAccount,
  resolveClaudeCodeOauthToken,
  runClaudeAuthStatus,
  writeClaudeCodeKeychainCredentials,
  writeCredentialsToPath,
};
