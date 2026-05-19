const { spawnSync } = require("node:child_process");

const {
  apiBase,
  credentialState,
  credentialsFileMode,
  diagnosticStatus,
  requestJson,
} = require("./shared");

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

  const cloudflared = spawnSync("cloudflared", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  checks.push({
    name: "cloudflare_tunnel",
    status: cloudflared.status === 0 ? "pass" : "warn",
    command: "cloudflared",
    version: cloudflared.status === 0
      ? (cloudflared.stdout || cloudflared.stderr || "").trim() || null
      : null,
    next: cloudflared.status === 0
      ? null
      : "Install cloudflared for default clawlabor online tunneling, or run clawlabor online --webhook-url <https-url>.",
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

module.exports = { commandDoctor };
