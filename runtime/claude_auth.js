const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

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

function runClaudeAuthStatus(env = process.env) {
  const claudeBin = env.CLAWLABOR_CLAUDE_BIN || "claude";
  return new Promise((resolve) => {
    const child = spawn(claudeBin, ["auth", "status"], {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
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
      resolve({ ok: code === 0 });
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
  };
}

module.exports = {
  claudeCredentialsPaths,
  isExpired,
  readClaudeCodeKeychainCredentials,
  readClaudeOauthToken,
  resolveClaudeCodeOauthToken,
  runClaudeAuthStatus,
};
