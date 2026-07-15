// Host-side telemetry supervisor for labor-serve (design doc §8.2, Phase 2).
//
// Three jobs, all best-effort and wrapped so telemetry NEVER breaks the
// supervisor heartbeat loop:
//   1. `docker events` subscription      -> die/oom/kill/health_status envelopes
//   2. `docker stats` sampling           -> mem_pressure envelope on threshold crossing
//   3. WAL segment consumption + relay   -> tail bind-mounted events-*.ndjson,
//      merge with host envelopes, POST /labor/hires/{id}/telemetry/relay, then
//      delete fully-relayed CLOSED segments ("upload a batch, clean a batch").
//
// The container writes the WAL; only the host deletes closed segments. The
// active (highest-seq) segment is tailed via a byte-offset sidecar and never
// deleted; an incomplete trailing line is skipped until it is completed.

const { spawnSync: nodeSpawnSync, spawn: nodeSpawn } = require("node:child_process");
const nodeCrypto = require("node:crypto");
const nodeFs = require("node:fs");
const nodePath = require("node:path");

const MEM_PRESSURE_RATIO = 0.9; // emit mem_pressure when mem usage >= 90% of limit
const RELAY_MAX_RECORDS = 1000;
const RELAY_MAX_BYTES = 1024 * 1024; // 1MB
const SEGMENT_RE = /^events-(.+)-(\d+)\.ndjson$/;

function uuid(deps = {}) {
  const c = deps.crypto || nodeCrypto;
  return c.randomUUID();
}

function nowIso(deps = {}) {
  const now = deps.now || (() => Date.now());
  return new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Build a host-vantage envelope conforming to the wire contract. `hire_id` is
// intentionally NOT included in the record body (it comes from the URL path).
function hostEnvelope({ incarnation, kind, severity, code, message, attrs }, deps = {}) {
  return {
    id: uuid(deps),
    incarnation: incarnation || uuid(deps),
    vantage: "host",
    kind,
    severity,
    code,
    ts: nowIso(deps),
    message: message || "",
    attrs: attrs || {},
  };
}

// -------------------------------------------------------------------------
// docker events -> envelope mapping
// -------------------------------------------------------------------------

// Parse one `docker events --format '{{json .}}'` line. Returns a normalized
// { action, exitCode, cf } or null for events we don't care about.
function parseDockerEventLine(line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch (_err) {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;
  // docker events uses `Action` (e.g. "die", "oom", "kill",
  // "health_status: unhealthy") and `status` on older daemons.
  const rawAction = String(evt.Action || evt.status || "").toLowerCase();
  const action = rawAction.split(":")[0].trim();
  const attributes = (evt.Actor && evt.Actor.Attributes) || {};
  const exitCode = attributes.exitCode !== undefined ? Number(attributes.exitCode) : undefined;
  return { action, rawAction, exitCode, attributes };
}

// Inspect a container's terminal state for die/oom enrichment.
function inspectContainerState(containerName, deps = {}) {
  const run = deps.spawnSync || nodeSpawnSync;
  try {
    const result = run(
      "docker",
      ["inspect", "-f", "{{json .State}}", containerName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (result.status !== 0) return null;
    return JSON.parse(String(result.stdout || "").trim());
  } catch (_err) {
    return null;
  }
}

// Turn a parsed docker event into a host envelope, enriching `die` events with
// `docker inspect .State`. Returns an envelope or null.
function dockerEventToEnvelope(parsed, { containerName, incarnation }, deps = {}) {
  if (!parsed || !parsed.action) return null;
  const { action } = parsed;
  if (action === "oom") {
    return hostEnvelope({
      incarnation,
      kind: "crash",
      severity: "fatal",
      code: "oom_killed",
      message: "container OOM-killed",
      attrs: { exit_code: 137 },
    }, deps);
  }
  if (action === "die" || action === "kill") {
    const state = inspectContainerState(containerName, deps);
    const exitCode = state && state.ExitCode !== undefined
      ? Number(state.ExitCode)
      : (parsed.exitCode !== undefined ? parsed.exitCode : undefined);
    const oomKilled = !!(state && state.OOMKilled);
    if (oomKilled || exitCode === 137) {
      return hostEnvelope({
        incarnation,
        kind: "crash",
        severity: "fatal",
        code: "oom_killed",
        message: "container OOM-killed",
        attrs: { exit_code: 137 },
      }, deps);
    }
    return hostEnvelope({
      incarnation,
      kind: "event",
      severity: exitCode === 0 ? "info" : "error",
      code: "container_exit",
      message: `container exited${exitCode !== undefined ? ` with code ${exitCode}` : ""}`,
      attrs: {
        exit_code: exitCode,
        error: (state && state.Error) || undefined,
      },
    }, deps);
  }
  if (action === "health_status") {
    const unhealthy = /unhealthy/.test(parsed.rawAction || "");
    if (!unhealthy) return null;
    return hostEnvelope({
      incarnation,
      kind: "event",
      severity: "warn",
      code: "container_exit",
      message: "container reported unhealthy",
      attrs: { health: "unhealthy" },
    }, deps);
  }
  return null;
}

// -------------------------------------------------------------------------
// docker stats -> mem_pressure
// -------------------------------------------------------------------------

// Parse a `docker stats --no-stream --format '{{json .}}'` MemUsage string
// like "1.5GiB / 2GiB" into { used, limit } bytes. Returns null if unparsable.
function parseMemUsage(memUsage) {
  if (!memUsage || typeof memUsage !== "string") return null;
  const parts = memUsage.split("/");
  if (parts.length !== 2) return null;
  const used = parseSize(parts[0].trim());
  const limit = parseSize(parts[1].trim());
  if (used === null || limit === null || limit <= 0) return null;
  return { used, limit };
}

function parseSize(text) {
  const m = /^([\d.]+)\s*([A-Za-z]*)$/.exec(text);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const unit = m[2].toLowerCase();
  const factors = {
    "": 1, b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  };
  const factor = factors[unit];
  if (factor === undefined) return null;
  return value * factor;
}

// Sample docker stats once. Returns { ratio, used, limit } or null.
function sampleDockerStats(containerName, deps = {}) {
  const run = deps.spawnSync || nodeSpawnSync;
  try {
    const result = run(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", containerName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (result.status !== 0) return null;
    const line = String(result.stdout || "").trim().split("\n")[0];
    if (!line) return null;
    const stats = JSON.parse(line);
    const mem = parseMemUsage(stats.MemUsage);
    if (!mem) return null;
    return { ratio: mem.used / mem.limit, used: mem.used, limit: mem.limit };
  } catch (_err) {
    return null;
  }
}

// -------------------------------------------------------------------------
// WAL segment consumption
// -------------------------------------------------------------------------

// List segment files in the logs dir, sorted by (incarnation, seq) with seq
// numeric ascending. Returns [{ name, incarnation, seq, path }].
function listSegments(logsDir, deps = {}) {
  const fs = deps.fs || nodeFs;
  let entries;
  try {
    entries = fs.readdirSync(logsDir);
  } catch (_err) {
    return [];
  }
  const segments = [];
  for (const name of entries) {
    const m = SEGMENT_RE.exec(name);
    if (!m) continue;
    segments.push({
      name,
      incarnation: m[1],
      seq: Number(m[2]),
      path: nodePath.join(logsDir, name),
    });
  }
  segments.sort((a, b) => {
    if (a.incarnation !== b.incarnation) return a.incarnation < b.incarnation ? -1 : 1;
    return a.seq - b.seq;
  });
  return segments;
}

function offsetPath(segmentPath) {
  return `${segmentPath}.offset`;
}

function readOffset(segmentPath, deps = {}) {
  const fs = deps.fs || nodeFs;
  try {
    const raw = fs.readFileSync(offsetPath(segmentPath), "utf8");
    const n = Number(String(raw).trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (_err) {
    return 0;
  }
}

function writeOffset(segmentPath, offset, deps = {}) {
  const fs = deps.fs || nodeFs;
  try {
    fs.writeFileSync(offsetPath(segmentPath), String(offset));
  } catch (_err) {
    /* best effort */
  }
}

// Read new bytes from a segment starting at `fromOffset`. Parses only COMPLETE
// newline-terminated lines; an incomplete trailing line is left unconsumed so
// `newOffset` points at its start. For a CLOSED segment the caller passes the
// whole file (it always ends in a newline once rotated) so everything is read.
// Returns { records, newOffset }.
function readSegmentFrom(segmentPath, fromOffset, deps = {}) {
  const fs = deps.fs || nodeFs;
  let buf;
  try {
    buf = fs.readFileSync(segmentPath);
  } catch (_err) {
    return { records: [], newOffset: fromOffset };
  }
  if (fromOffset >= buf.length) return { records: [], newOffset: buf.length };
  const slice = buf.slice(fromOffset);
  const lastNl = slice.lastIndexOf(0x0a);
  if (lastNl === -1) {
    // No complete line yet; skip the incomplete trailing line entirely.
    return { records: [], newOffset: fromOffset };
  }
  const complete = slice.slice(0, lastNl + 1).toString("utf8");
  const records = [];
  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (_err) {
      // Skip a corrupt line rather than stalling the whole relay.
    }
  }
  return { records, newOffset: fromOffset + lastNl + 1 };
}

// -------------------------------------------------------------------------
// Batching helpers
// -------------------------------------------------------------------------

// Split records into batches capped at RELAY_MAX_RECORDS / RELAY_MAX_BYTES.
function batchRecords(records) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const rec of records) {
    const size = Buffer.byteLength(JSON.stringify(rec)) + 1;
    if (current.length > 0 &&
        (current.length >= RELAY_MAX_RECORDS || currentBytes + size > RELAY_MAX_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(rec);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// -------------------------------------------------------------------------
// Orphan WAL cleanup
// -------------------------------------------------------------------------

// List the hire-name dirs under ~/.clawlabor/hires. Returns [dockerName,...].
function listHireLogsDirs(deps = {}) {
  const fs = deps.fs || nodeFs;
  const os = require("os");
  const home = (deps.env && deps.env.HOME) || os.homedir();
  const base = nodePath.join(home, ".clawlabor", "hires");
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (_err) {
    return [];
  }
}

function hireLogsDirPath(dockerNameStr, deps = {}) {
  const os = require("os");
  const home = (deps.env && deps.env.HOME) || os.homedir();
  return nodePath.join(home, ".clawlabor", "hires", dockerNameStr, "logs");
}

// Remove the ~/.clawlabor/hires/<name> dir tree. Best-effort.
function removeHireLogsDir(dockerNameStr, deps = {}) {
  const fs = deps.fs || nodeFs;
  const os = require("os");
  const home = (deps.env && deps.env.HOME) || os.homedir();
  const dir = nodePath.join(home, ".clawlabor", "hires", dockerNameStr);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (_err) {
    return false;
  }
}

// -------------------------------------------------------------------------
// Host telemetry controller — wires events + stats + WAL relay for one hire.
// -------------------------------------------------------------------------

// Factory. All I/O is injected via deps so tests can mock spawn/spawnSync/fs/
// fetch. `relay(records)` should POST the batch and resolve truthy only on a
// 2xx/204; typically the caller passes a function that calls
// requestJson(sellerDeps, "POST", `/labor/hires/${hireId}/telemetry/relay`, ...).
function createHostTelemetry({
  containerName,
  logsDir,
  relay,
  stdout = () => {},
  deps = {},
}) {
  const log = (msg) => {
    try { stdout(msg); } catch (_err) { /* noop */ }
  };
  // Host envelopes captured from docker events / stats / supervisor errors,
  // pending merge into the next relay pass.
  let pendingHostEnvelopes = [];
  let eventsChild = null;
  let eventsBuffer = "";
  let memPressureActive = false; // threshold-crossing latch for mem_pressure
  let stopped = false;
  // Reuse a single incarnation for host-vantage envelopes for this run.
  const incarnation = uuid(deps);

  function enqueue(envelope) {
    if (envelope) pendingHostEnvelopes.push(envelope);
  }

  // Public: let the supervisor push its own host envelopes (tunnel_exit,
  // image_pull_failed, port_conflict, ...).
  function emit({ kind, severity, code, message, attrs }) {
    try {
      enqueue(hostEnvelope({ incarnation, kind, severity, code, message, attrs }, deps));
    } catch (_err) { /* telemetry must not throw into the supervisor */ }
  }

  // 1. docker events subscription (long-lived child).
  function startEvents() {
    if (eventsChild) return;
    try {
      const spawn = deps.spawn || nodeSpawn;
      eventsChild = spawn(
        "docker",
        ["events", "--filter", `container=${containerName}`, "--format", "{{json .}}"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      if (!eventsChild || !eventsChild.stdout) {
        eventsChild = null;
        return;
      }
      eventsChild.stdout.setEncoding && eventsChild.stdout.setEncoding("utf8");
      eventsChild.stdout.on("data", (chunk) => {
        try {
          eventsBuffer += String(chunk);
          let idx;
          while ((idx = eventsBuffer.indexOf("\n")) !== -1) {
            const line = eventsBuffer.slice(0, idx);
            eventsBuffer = eventsBuffer.slice(idx + 1);
            const parsed = parseDockerEventLine(line);
            const env = dockerEventToEnvelope(parsed, { containerName, incarnation }, deps);
            if (env) enqueue(env);
          }
        } catch (_err) { /* never break the supervisor */ }
      });
      if (typeof eventsChild.on === "function") {
        eventsChild.on("error", () => { /* docker events unsupported; degrade */ });
      }
    } catch (_err) {
      eventsChild = null;
      log("Telemetry: docker events subscription unavailable (best effort).");
    }
  }

  // 2. docker stats sampling (one-shot per tick; threshold-crossing only).
  function sampleStats() {
    try {
      const sample = sampleDockerStats(containerName, deps);
      if (!sample) return;
      if (sample.ratio >= MEM_PRESSURE_RATIO) {
        if (!memPressureActive) {
          memPressureActive = true;
          enqueue(hostEnvelope({
            incarnation,
            kind: "metric",
            severity: "warn",
            code: "mem_pressure",
            message: `container memory at ${(sample.ratio * 100).toFixed(0)}% of limit`,
            attrs: { mem_used: sample.used, mem_limit: sample.limit, ratio: sample.ratio },
          }, deps));
        }
      } else if (sample.ratio < MEM_PRESSURE_RATIO * 0.95) {
        // Hysteresis: only re-arm once we drop clearly below threshold.
        memPressureActive = false;
      }
    } catch (_err) { /* best effort */ }
  }

  // 3. WAL consumption + relay. Merges WAL records with pending host
  // envelopes, batches, relays, then deletes fully-relayed CLOSED segments.
  async function relayPass() {
    try {
      sampleStats();
      const segments = listSegments(logsDir, deps);
      // Highest (incarnation, seq) among segments is the active one — never
      // deleted, tailed via offset. All lower-seq segments are closed.
      const activeIdx = segments.length - 1;
      const collected = [];
      const closedFullyRead = []; // { segment } eligible for deletion after 204
      const offsetUpdates = []; // { path, offset }

      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        const isActive = i === activeIdx;
        const fromOffset = readOffset(seg.path, deps);
        const { records, newOffset } = readSegmentFrom(seg.path, fromOffset, deps);
        if (records.length > 0) collected.push(...records);
        offsetUpdates.push({ path: seg.path, offset: newOffset });
        if (!isActive) {
          // Closed: consumed fully once offset reaches EOF (readSegmentFrom
          // reads to the last newline; a rotated segment ends in a newline).
          closedFullyRead.push(seg);
        }
      }

      const hostEnvelopes = pendingHostEnvelopes;
      const allRecords = [...collected, ...hostEnvelopes];
      if (allRecords.length === 0) {
        // Still persist any offset advances (e.g. skipped blank tails).
        for (const u of offsetUpdates) writeOffset(u.path, u.offset, deps);
        return { relayed: 0, deletedSegments: 0 };
      }

      const batches = batchRecords(allRecords);
      let relayedCount = 0;
      let allOk = true;
      for (const batch of batches) {
        const batchId = uuid(deps);
        let ok = false;
        try {
          ok = await relay({ batch_id: batchId, records: batch });
        } catch (_err) {
          ok = false;
        }
        if (ok) {
          relayedCount += batch.length;
        } else {
          allOk = false;
          break; // stop on first failure; unrelayed data stays in WAL / pending
        }
      }

      if (allOk) {
        // Only advance offsets + clear pending host envelopes on full success.
        for (const u of offsetUpdates) writeOffset(u.path, u.offset, deps);
        pendingHostEnvelopes = [];
        // Delete fully-relayed CLOSED segments ("clean a batch"). Never delete
        // the active segment.
        let deleted = 0;
        const fs = deps.fs || nodeFs;
        for (const seg of closedFullyRead) {
          try {
            fs.rmSync(seg.path, { force: true });
            fs.rmSync(offsetPath(seg.path), { force: true });
            deleted += 1;
          } catch (_err) { /* best effort */ }
        }
        return { relayed: relayedCount, deletedSegments: deleted };
      }
      // Partial failure: do NOT advance offsets or delete; retry next pass.
      return { relayed: relayedCount, deletedSegments: 0, failed: true };
    } catch (_err) {
      log("Telemetry: relay pass failed (best effort).");
      return { relayed: 0, deletedSegments: 0, failed: true };
    }
  }

  function stop() {
    stopped = true;
    if (eventsChild) {
      try {
        if (typeof eventsChild.kill === "function") eventsChild.kill("SIGTERM");
      } catch (_err) { /* noop */ }
      eventsChild = null;
    }
  }

  return {
    start: startEvents,
    emit,
    relayPass,
    stop,
    // exposed for tests / final flush
    _pending: () => pendingHostEnvelopes,
    _isStopped: () => stopped,
    incarnation,
  };
}

module.exports = {
  MEM_PRESSURE_RATIO,
  RELAY_MAX_RECORDS,
  RELAY_MAX_BYTES,
  uuid,
  nowIso,
  hostEnvelope,
  parseDockerEventLine,
  inspectContainerState,
  dockerEventToEnvelope,
  parseMemUsage,
  parseSize,
  sampleDockerStats,
  listSegments,
  offsetPath,
  readOffset,
  writeOffset,
  readSegmentFrom,
  batchRecords,
  listHireLogsDirs,
  hireLogsDirPath,
  removeHireLogsDir,
  createHostTelemetry,
  _internal: { nodeSpawn },
};
