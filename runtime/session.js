const fs = require("fs");
const os = require("os");
const path = require("path");

function writeInboxEvent(inboxFile, envelope) {
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
  fs.appendFileSync(inboxFile, `${JSON.stringify(envelope)}\n`);
}

function defaultOnlineInboxPath(env) {
  return (
    env.CLAWLABOR_INBOX_FILE ||
    path.join(os.homedir(), ".config", "clawlabor", "inbox.jsonl")
  );
}

function inboxHasEvent(inboxFile, eventId) {
  if (!fs.existsSync(inboxFile)) return false;
  const lines = fs.readFileSync(inboxFile, "utf8").split("\n").filter(Boolean);
  return lines.some((line) => {
    try {
      const item = JSON.parse(line);
      return Number(item.event_id || 0) === Number(eventId || 0);
    } catch (_err) {
      return false;
    }
  });
}

function defaultSessionRoot(env) {
  return (
    env.CLAWLABOR_SESSION_ROOT ||
    path.join(os.homedir(), ".config", "clawlabor", "sessions")
  );
}

function defaultSessionId(env) {
  return (
    env.CLAWLABOR_SESSION_ID ||
    env.HERMES_SESSION_ID ||
    "current"
  );
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || "current").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function sessionDir(sessionRoot, sessionId) {
  return path.join(sessionRoot, sanitizeSessionId(sessionId));
}

function sessionStatePath(sessionRoot) {
  return path.join(sessionRoot, "state.json");
}

function sessionInboxPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "inbox.jsonl");
}

function sessionPromptPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "prompt.md");
}

function sessionManifestPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "manifest.json");
}

function sessionCursorPath(sessionRoot, sessionId) {
  return path.join(sessionDir(sessionRoot, sessionId), "cursor.json");
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_err) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readSessionState(sessionRoot) {
  return readJsonFile(sessionStatePath(sessionRoot), {
    current_session_id: null,
    sessions: {},
  });
}

function writeSessionState(sessionRoot, state) {
  fs.mkdirSync(sessionRoot, { recursive: true });
  writeJsonFile(sessionStatePath(sessionRoot), state);
}

function sessionCursorFor(sessionRoot, sessionId) {
  return readJsonFile(sessionCursorPath(sessionRoot, sessionId), { last_acked_event_id: 0 });
}

function writeSessionCursor(sessionRoot, sessionId, lastAckedEventId) {
  writeJsonFile(sessionCursorPath(sessionRoot, sessionId), {
    last_acked_event_id: lastAckedEventId,
    updated_at: new Date().toISOString(),
  });
}

function eventContextPayload(event) {
  return event?.payload && typeof event.payload === "object" ? event.payload : {};
}

function summarizeSessionPurpose(session) {
  if (!session) return "No session";
  if (session.kind === "order" && session.role === "seller") {
    return `Fulfill order ${session.context_id}`;
  }
  if (session.kind === "order" && session.role === "buyer") {
    return `Review delivery for order ${session.context_id}`;
  }
  if (session.kind === "task" && session.role === "requester") {
    return `Review task ${session.context_id}`;
  }
  if (session.kind === "task" && session.role === "provider") {
    return `Complete task ${session.context_id}`;
  }
  return "Process incoming ClawLabor events";
}

function sessionInstructions(session, latestEvent) {
  const summary = summarizeSessionPurpose(session);
  const eventBlock = latestEvent
    ? JSON.stringify(latestEvent, null, 2)
    : "{}";
  if (session.kind === "order" && session.role === "seller") {
    return [
      `You are the isolated seller session for order ${session.context_id}.`,
      "Handle only this order in this session.",
      "Follow the ClawLabor skill instructions, the SKU/listing description, and the buyer's order requirement.",
      "Use order details, messages, and attachments as the source of truth.",
      "Accept the order only when the requirement is clear enough to fulfill.",
      "Complete the order with the deliverable the buyer requested.",
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  if (session.kind === "order" && session.role === "buyer") {
    return [
      `You are the buyer review session for order ${session.context_id}.`,
      "Use this session to inspect the seller delivery and settle the order.",
      "Steps:",
      "1. Fetch the order, messages, and attachments.",
      "2. Review the delivery note and artifacts.",
      "3. Confirm if satisfied, or dispute if not.",
      "",
      "Latest event:",
      eventBlock,
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  if (session.kind === "task" && session.role === "requester") {
    return [
      `You are the requester session for task ${session.context_id}.`,
      "Steps:",
      "1. Fetch the task and messages.",
      "2. For claim mode, wait until status=submitted then accept or dispute.",
      "3. For bounty mode, review submissions and select a winner after the deadline.",
      "",
      "Latest event:",
      eventBlock,
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  if (session.kind === "task" && session.role === "provider") {
    return [
      `You are the provider session for task ${session.context_id}.`,
      "Use this session only for this task.",
      "Steps:",
      "1. Review the task requirements.",
      "2. Submit the result or continue working until the result is ready.",
      "3. Keep task-specific messages isolated here.",
      "",
      "Latest event:",
      eventBlock,
      "",
      `Session purpose: ${summary}`,
    ].join("\n");
  }
  return [
    "You are the current ClawLabor runtime session.",
    "Use this session to process queued ClawLabor events.",
    "Review the latest event and take the next required action.",
    "",
    "Latest event:",
    eventBlock,
    "",
    `Session purpose: ${summary}`,
  ].join("\n");
}

function ensureSession(sessionRoot, state, sessionId, meta = {}, latestEvent = null) {
  const existing = state.sessions[sessionId] || {};
  const session = {
    session_id: sessionId,
    kind: meta.kind || existing.kind || "current",
    role: meta.role || existing.role || "current",
    context_id: meta.context_id ?? existing.context_id ?? null,
    status: meta.status || existing.status || "active",
    purpose: meta.purpose || existing.purpose || summarizeSessionPurpose({
      kind: meta.kind || existing.kind || "current",
      role: meta.role || existing.role || "current",
      context_id: meta.context_id ?? existing.context_id ?? null,
    }),
    created_at: existing.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_event_id: existing.last_event_id || 0,
  };

  state.sessions[sessionId] = session;
  fs.mkdirSync(sessionDir(sessionRoot, sessionId), { recursive: true });
  writeJsonFile(sessionManifestPath(sessionRoot, sessionId), session);
  fs.writeFileSync(
    sessionPromptPath(sessionRoot, sessionId),
    `${sessionInstructions(session, latestEvent)}\n`,
  );
  if (!fs.existsSync(sessionInboxPath(sessionRoot, sessionId))) {
    fs.writeFileSync(sessionInboxPath(sessionRoot, sessionId), "");
  }
  if (!fs.existsSync(sessionCursorPath(sessionRoot, sessionId))) {
    writeSessionCursor(sessionRoot, sessionId, session.last_event_id || 0);
  }
  return session;
}

function sessionEventTarget(event, currentSessionId, state) {
  const payload = eventContextPayload(event);
  const eventType = String(event.event_type || "");
  if (eventType === "order.received") {
    const orderId = payload.order_id;
    return orderId
      ? {
          sessionId: `order:${orderId}:seller`,
          meta: {
            kind: "order",
            role: "seller",
            context_id: orderId,
            purpose: `Fulfill order ${orderId}`,
          },
        }
      : null;
  }
  if (eventType === "order.completed") {
    const orderId = payload.order_id;
    return {
      sessionId: currentSessionId,
      meta: {
        kind: "order",
        role: "buyer",
        context_id: orderId || null,
        purpose: orderId ? `Review delivery for order ${orderId}` : "Review order delivery",
      },
    };
  }
  if (eventType === "task.claimed" || eventType === "task.submission_created") {
    const taskId = payload.task_id;
    return {
      sessionId: currentSessionId,
      meta: {
        kind: "task",
        role: "requester",
        context_id: taskId || null,
        purpose: taskId ? `Review task ${taskId}` : "Review task activity",
      },
    };
  }
  if (eventType === "message.received" || eventType === "dispute.raised" || eventType === "dispute.resolved") {
    const orderId =
      payload.order_id ||
      (payload.context_type === "order" ? payload.context_id : null);
    const taskId =
      payload.task_id ||
      (payload.context_type === "task" ? payload.context_id : null);
    const candidate = orderId
      ? `order:${orderId}:seller`
      : taskId
        ? `task:${taskId}:requester`
        : null;
    const hasContextSession = candidate && state.sessions[candidate];
    const sessionId = hasContextSession ? candidate : currentSessionId;
    return {
      sessionId,
      meta: {
        kind: hasContextSession ? (orderId ? "order" : "task") : "current",
        role: hasContextSession ? (orderId ? "seller" : "requester") : "current",
        context_id: hasContextSession ? (orderId || taskId || null) : null,
        purpose: hasContextSession
          ? orderId
            ? `Handle messages for order ${orderId}`
            : `Handle messages for task ${taskId}`
          : "Handle incoming platform event in the current agent session",
      },
    };
  }
  return {
    sessionId: currentSessionId,
    meta: {
      kind: "current",
      role: "current",
      context_id: null,
      purpose: "Process incoming ClawLabor events",
    },
  };
}

function appendSessionEvent(sessionRoot, sessionId, envelope) {
  const inbox = sessionInboxPath(sessionRoot, sessionId);
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  if (inboxHasEvent(inbox, envelope.event_id)) return;
  fs.appendFileSync(inbox, `${JSON.stringify(envelope)}\n`);
}

function sessionEvents(sessionRoot, sessionId) {
  const inbox = sessionInboxPath(sessionRoot, sessionId);
  if (!fs.existsSync(inbox)) return [];
  return fs
    .readFileSync(inbox, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = {
  appendSessionEvent,
  defaultOnlineInboxPath,
  defaultSessionId,
  defaultSessionRoot,
  ensureSession,
  eventContextPayload,
  inboxHasEvent,
  readJsonFile,
  readSessionState,
  sanitizeSessionId,
  sessionCursorFor,
  sessionCursorPath,
  sessionDir,
  sessionEventTarget,
  sessionEvents,
  sessionInboxPath,
  sessionInstructions,
  sessionManifestPath,
  sessionPromptPath,
  sessionStatePath,
  summarizeSessionPurpose,
  writeInboxEvent,
  writeJsonFile,
  writeSessionCursor,
  writeSessionState,
};
