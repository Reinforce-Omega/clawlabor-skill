const dns = require("node:dns").promises;
const https = require("node:https");

const CLOUDFLARE_RESOLVERS = ["1.1.1.1", "1.0.0.1"];
const TUNNEL_LOG_LINE_LIMIT = 12;
const TUNNEL_AVAILABILITY_TIMEOUT_MS = 180_000;
const DEFAULT_CLOUDFLARED_PROTOCOL = "http2";

function tunnelAvailabilityTimeoutSeconds(timeoutMs = TUNNEL_AVAILABILITY_TIMEOUT_MS) {
  return Math.ceil(timeoutMs / 1000);
}

async function resolveViaCloudflare(hostname) {
  const previous = dns.getServers();
  try {
    dns.setServers(CLOUDFLARE_RESOLVERS);
    const [v4, v6] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);
    return [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
  } finally {
    try { dns.setServers(previous); } catch (_err) { /* noop */ }
  }
}

function httpsGetViaResolvedIp(url, token, ip, timeoutMs) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const family = ip.includes(":") ? 6 : 4;
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: ip,
        family,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Host: parsed.hostname,
        },
        servername: parsed.hostname,
        timeout: timeoutMs,
      },
      (resp) => {
        resp.resume();
        resp.once("end", () => resolve(resp.statusCode >= 200 && resp.statusCode < 300));
      },
    );
    req.once("timeout", () => req.destroy(new Error("health probe timeout")));
    req.once("error", () => resolve(false));
    req.end();
  });
}

async function probePublicHealthWithDnsFallback(url, token, timeoutMs) {
  try {
    const ips = await resolveViaCloudflare(new URL(url).hostname);
    for (const ip of ips) {
      if (await httpsGetViaResolvedIp(url, token, ip, timeoutMs)) return true;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

function appendLogLines(buffer, chunk, limit = TUNNEL_LOG_LINE_LIMIT) {
  const lines = String(chunk || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  buffer.push(...lines);
  if (buffer.length > limit) {
    buffer.splice(0, buffer.length - limit);
  }
}

function cloudflaredArgs(tunnelToken, protocol = DEFAULT_CLOUDFLARED_PROTOCOL) {
  const args = ["tunnel", "--no-autoupdate", "--grace-period=3s"];
  if (protocol) args.push("--protocol", protocol);
  args.push("run", "--token", tunnelToken);
  return args;
}

function formatRecentLogs(buffer) {
  if (!buffer.length) return "";
  return `\nRecent cloudflared logs:\n${buffer.map((line) => `   ${line}`).join("\n")}\n`;
}

function createTunnelAvailabilityState({
  now,
  publicHealthUrl,
  localHealthUrl,
  tunnelState,
  tunnelLogs,
  timeoutMs = TUNNEL_AVAILABILITY_TIMEOUT_MS,
}) {
  let unavailableSince = null;
  return {
    markUnavailable() {
      if (unavailableSince === null) unavailableSince = now();
    },
    reset() {
      unavailableSince = null;
    },
    elapsedMs() {
      return unavailableSince === null ? 0 : now() - unavailableSince;
    },
    withinGracePeriod() {
      return unavailableSince !== null && this.elapsedMs() < timeoutMs;
    },
    remainingSeconds() {
      return Math.max(0, Math.ceil((timeoutMs - this.elapsedMs()) / 1000));
    },
    failurePayload() {
      return {
        reason: "tunnel_unreachable",
        detail: `Public tunnel health check failed for ${publicHealthUrl}`,
        public_health_url: publicHealthUrl,
        local_health_url: localHealthUrl,
        tunnel_unavailable_since_ms: this.elapsedMs(),
        tunnel_exit_summary: tunnelState.exitSummary,
        recent_cloudflared_logs: tunnelLogs.slice(-TUNNEL_LOG_LINE_LIMIT),
      };
    },
  };
}

function formatTunnelUnavailableWarning({ publicHealthUrl, laborId, tunnelState, tunnelLogs }) {
  const tunnelStatus = tunnelState.exited && tunnelState.exitSummary
    ? `\n   ${tunnelState.exitSummary}.`
    : "";
  return (
    `\n⚠️  Sandbox is healthy locally but unreachable over the public tunnel ` +
    `(${publicHealthUrl}). Buyers can't reach it, so the platform will mark this ` +
    `hire sandbox OFFLINE.${tunnelStatus}\n   The Cloudflare tunnel likely dropped (free-plan tunnels often ` +
    `exit with error 1033). To recover: stop this process (Ctrl+C) and re-run\n` +
    `     clawlabor labor-serve --labor ${laborId}\n` +
    formatRecentLogs(tunnelLogs)
  );
}

function startCloudflareTunnel({
  spawn,
  stdout,
  tunnelToken,
  cleanedUpRef,
  isStopRequested,
  logPrefix = "[7/7]",
}) {
  stdout(`${logPrefix} Starting Cloudflare tunnel...`);
  const logs = [];
  const state = { exited: false, exitSummary: null, protocol: DEFAULT_CLOUDFLARED_PROTOCOL };
  let currentTunnel = null;

  function spawnTunnel(protocol = DEFAULT_CLOUDFLARED_PROTOCOL) {
    const tunnel = spawn(
      "cloudflared",
      cloudflaredArgs(tunnelToken, protocol),
      { stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    currentTunnel = tunnel;
    state.exited = false;
    state.exitSummary = null;
    state.protocol = protocol || "auto";
    return tunnel;
  }

  function attachHandlers(tunnel) {
    tunnel.stdout?.on("data", (chunk) => appendLogLines(logs, chunk));
    tunnel.stderr?.on("data", (chunk) => appendLogLines(logs, chunk));
    if (!tunnel.stdout || !tunnel.stderr || typeof tunnel.once !== "function") return;
    tunnel.once("error", (err) => {
      state.exited = true;
      state.exitSummary = `cloudflared failed to start: ${(err && err.message) || err || "unknown error"}`;
      if (!cleanedUpRef.value && !isStopRequested()) {
        stdout(`\n⚠️  ${state.exitSummary}${formatRecentLogs(logs)}`);
      }
    });
    tunnel.once("exit", (code, signal) => {
      const isCurrent = currentTunnel === tunnel;
      if (!isCurrent) {
        return;
      }
      state.exited = true;
      state.exitSummary = `cloudflared exited${code === null || code === undefined ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
      if (!cleanedUpRef.value && !isStopRequested()) {
        stdout(`\n⚠️  ${state.exitSummary}${formatRecentLogs(logs)}`);
      }
    });
  }

  attachHandlers(spawnTunnel());

  return { tunnel: currentTunnel, currentTunnel: () => currentTunnel, logs, state };
}

function createSandboxHealthProbe({ deps, sandboxToken, timeoutMs }) {
  return async function probeHealth(url, { publicTunnel = false } = {}) {
    try {
      const resp = await deps.withTimeout(
        deps.fetch(url, { headers: { Authorization: `Bearer ${sandboxToken}` } }),
        timeoutMs,
        "health probe",
      );
      return !!resp.ok;
    } catch (_err) {
      if (!publicTunnel) return false;
      const fallbackProbe = deps.probePublicHealthWithDnsFallback ||
        ((probeUrl, token) => probePublicHealthWithDnsFallback(probeUrl, token, timeoutMs));
      try {
        return await fallbackProbe(url, sandboxToken);
      } catch (_fallbackErr) {
        return false;
      }
    }
  };
}

module.exports = {
  TUNNEL_AVAILABILITY_TIMEOUT_MS,
  TUNNEL_LOG_LINE_LIMIT,
  tunnelAvailabilityTimeoutSeconds,
  createTunnelAvailabilityState,
  createSandboxHealthProbe,
  formatRecentLogs,
  formatTunnelUnavailableWarning,
  cloudflaredArgs,
  probePublicHealthWithDnsFallback,
  startCloudflareTunnel,
};
