const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const test = require("node:test");
const {
  runCli,
  validateRequirementAgainstSchema,
  pickCompatibleListing,
  resolveApiKey,
  credentialsFilePath,
  parseDeliveryNote,
  COMMANDS,
} = require("../runtime/cli");
const {
  isExpired,
  readClaudeCodeKeychainCredentials,
  readClaudeOauthToken,
  resolveClaudeCodeOauthToken,
} = require("../runtime/claude_auth");

const DEFAULT_API_BASE = "https://www.clawlabor.com/api";

const BASE_ENV = {
  CLAWLABOR_API_KEY: "test-key",
};

function tempTestFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-cli-test-")), name);
}

function recordingFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const route = routes.find((r) => r.match({ url, options }));
    if (!route) {
      throw new Error(`No mock route matched ${options?.method || "GET"} ${url}`);
    }
    const result = typeof route.respond === "function" ? route.respond({ url, options }) : route.respond;
    return {
      ok: result.ok ?? (result.status >= 200 && result.status < 300),
      status: result.status ?? 200,
      text: async () => Buffer.isBuffer(result.body) ? result.body.toString("utf8") : (result.body ?? ""),
      arrayBuffer: async () => {
        const body = result.body ?? "";
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      },
    };
  };
  return { calls, fetch: fetchImpl };
}

function matchRoute(method, pathSuffix, respond) {
  return {
    match: ({ url, options }) =>
      (options.method || "GET") === method && url.endsWith(pathSuffix),
    respond,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function laborServeStopAfterHireTeardown() {
  const stop = deferred();
  return {
    stop,
    route: {
      match: ({ url, options }) =>
        options.method === "DELETE" && /\/labor\/hires\/[^/]+\/serve$/.test(url),
      respond: () => {
        stop.resolve();
        return { status: 204, body: "" };
      },
    },
  };
}

function createMockResponse() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = body;
    },
  };
}

// ---------------------------------------------------------------------------
// existing surface (regression)
// ---------------------------------------------------------------------------

test("match posts an agent-native capability matching request", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/listings/match", { status: 200, body: '{"matches":[]}' }),
  ]);
  const out = [];
  await runCli(
    ["match", "--goal", "Analyze competitor website", "--category", "research_analysis", "--max-price", "30"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.clawlabor.com/api/listings/match");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    goal: "Analyze competitor website",
    category: "research_analysis",
    max_price: 30,
  });
  assert.equal(out[0], '{"matches":[]}');
});

test("match forwards --require-schema to the backend", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/listings/match", { status: 200, body: '{"matches":[]}' }),
  ]);
  await runCli(
    ["match", "--goal", "X", "--require-schema"],
    { env: BASE_ENV, fetch, stdout: () => {} },
  );
  assert.equal(JSON.parse(calls[0].options.body).require_schema, true);
});

test("match rejects non-positive --max-price before calling API", async () => {
  const { fetch, calls } = recordingFetch([]);
  await assert.rejects(
    runCli(
      ["match", "--goal", "Analyze competitor", "--max-price", "0"],
      { env: BASE_ENV, fetch, stdout: () => {} },
    ),
    /--max-price must be greater than or equal to 1/,
  );
  assert.equal(calls.length, 0);
});

test("help prints usage without requiring credentials", async () => {
  const out = [];
  await runCli(["--help"], {
    env: {},
    fetch: async () => {
      throw new Error("should not call API");
    },
    stdout: (t) => out.push(t),
  });
  assert.match(out[0], /Usage: clawlabor/);
  assert.match(out[0], /bootstrap/);
  assert.match(out[0], /solve/);
});

test("credentials-path prints the configured credentials file", async () => {
  const credentialsFile = tempTestFile("credentials.json");
  const out = [];

  await runCli(["credentials-path"], {
    env: { CLAWLABOR_CREDENTIALS_FILE: credentialsFile },
    fetch: async () => {
      throw new Error("should not call API");
    },
    stdout: (t) => out.push(t),
  });

  assert.equal(out[0], credentialsFile);
});

test("api-base prints the compiled API base", async () => {
  const out = [];

  await runCli(["api-base"], {
    env: {},
    fetch: async () => {
      throw new Error("should not call API");
    },
    stdout: (t) => out.push(t),
  });

  assert.equal(out[0], DEFAULT_API_BASE);
});

test("auth status reports missing credentials without calling the API", async () => {
  const credentialsFile = tempTestFile("credentials.json");
  const out = [];

  await runCli(["auth", "status"], {
    env: {
      CLAWLABOR_CREDENTIALS_FILE: credentialsFile,
    },
    fetch: async () => {
      throw new Error("should not call API");
    },
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.authenticated, false);
  assert.equal(result.api_base, DEFAULT_API_BASE);
  assert.equal(result.api_key_source, null);
  assert.equal(result.credentials_file, credentialsFile);
  assert.equal(result.credentials_file_exists, false);
  assert.equal(result.action, "missing_credentials");
});

test("auth status validates CLAWLABOR_API_KEY credentials", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ agent_id: "agent_env", name: "Env Agent", balance: 42 }),
    }),
  ]);
  const out = [];

  await runCli(["auth", "status"], {
    env: BASE_ENV,
    fetch,
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.authenticated, true);
  assert.equal(result.api_key_source, "CLAWLABOR_API_KEY");
  assert.equal(result.agent_id, "agent_env");
  assert.equal(result.name, "Env Agent");
  assert.equal(result.balance, 42);
  assert.equal(result.api_key, undefined);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
});

test("auth status validates credentials from credentials file", async () => {
  const credentialsFile = tempTestFile("credentials.json");
  fs.writeFileSync(credentialsFile, JSON.stringify({ api_key: "file-key" }));
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ agent: { agent_id: "agent_file", name: "File Agent" } }),
    }),
  ]);
  const out = [];

  await runCli(["auth", "status"], {
    env: {
          CLAWLABOR_CREDENTIALS_FILE: credentialsFile,
    },
    fetch,
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.authenticated, true);
  assert.equal(result.api_key_source, "credentials_file");
  assert.equal(result.credentials_file, credentialsFile);
  assert.equal(result.credentials_file_exists, true);
  assert.equal(result.agent_id, "agent_file");
  assert.equal(result.api_key, undefined);
  assert.equal(calls[0].options.headers.Authorization, "Bearer file-key");
});

test("doctor reports missing credentials but still checks API health", async () => {
  const credentialsFile = tempTestFile("credentials.json");
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/health", { status: 200, body: '{"status":"ok"}' }),
  ]);
  const out = [];

  await runCli(["doctor"], {
    env: {
      CLAWLABOR_CREDENTIALS_FILE: credentialsFile,
    },
    fetch,
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.ok, false);
  assert.equal(result.status, "fail");
  assert.equal(result.credentials_file, credentialsFile);
  assert.equal(result.checks.find((check) => check.name === "api_reachable").status, "pass");
  assert.equal(result.checks.find((check) => check.name === "credentials").status, "fail");
  assert.equal(result.checks.find((check) => check.name === "auth").error_code, "missing_credentials");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.clawlabor.com/api/health");
});

test("doctor validates auth without leaking the API key", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ agent_id: "agent_env", name: "Env Agent", balance: 42 }),
    }),
  ]);
  const out = [];

  await runCli(["doctor"], {
    env: BASE_ENV,
    fetch,
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  const auth = result.checks.find((check) => check.name === "auth");
  assert.equal(result.ok, true);
  assert.equal(auth.status, "pass");
  assert.equal(auth.agent_id, "agent_env");
  assert.equal(result.api_key, undefined);
  assert.equal(JSON.stringify(result).includes("test-key"), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, "Bearer test-key");
});

test("doctor reports malformed credentials file as a diagnostic failure", async () => {
  const credentialsFile = tempTestFile("credentials.json");
  fs.writeFileSync(credentialsFile, "{not-json");
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/health", { status: 200, body: '{"status":"ok"}' }),
  ]);
  const out = [];

  await runCli(["doctor"], {
    env: {
          CLAWLABOR_CREDENTIALS_FILE: credentialsFile,
    },
    fetch,
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  const credentials = result.checks.find((check) => check.name === "credentials");
  assert.equal(result.ok, false);
  assert.equal(credentials.status, "fail");
  assert.match(credentials.error, /JSON/);
  assert.equal(calls.length, 1);
});

test("bootstrap validates existing credentials without registering again", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-bootstrap-"));
  const credentialsFile = path.join(tempDir, "credentials.json");
  fs.writeFileSync(credentialsFile, JSON.stringify({ api_key: "file-key" }));
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ agent_id: "agent_existing", name: "Existing", balance: 100 }),
    }),
  ]);
  const out = [];

  await runCli(["bootstrap"], {
    env: {
          CLAWLABOR_CREDENTIALS_FILE: credentialsFile,
    },
    fetch,
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.action, "credentials_valid");
  assert.equal(result.agent_id, "agent_existing");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer file-key");
});

test("register creates an agent and stores credentials", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-register-"));
  const credentialsFile = path.join(tempDir, "credentials.json");
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/agents", {
      status: 201,
      body: JSON.stringify({
        id: "agent-uuid",
        agent_id: "agent_new",
        name: "HermesBuyer",
        owner_email: "agent@example.com",
        api_key: "new-key",
        balance: 100,
      }),
    }),
  ]);
  const out = [];

  await runCli(
    ["register", "--owner-email", "agent@example.com", "--name", "HermesBuyer"],
    {
      env: {
              CLAWLABOR_CREDENTIALS_FILE: credentialsFile,
      },
      fetch,
      stdout: (t) => out.push(t),
    },
  );

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.owner_email, "agent@example.com");
  assert.equal(body.name, "HermesBuyer");
  assert.equal(calls[0].options.headers.Authorization, undefined);

  const saved = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
  assert.equal(saved.api_key, "new-key");
  assert.equal(saved.agent_id, "agent_new");
  assert.equal(JSON.parse(out[0]).action, "registered");
});

test("profile updates the current agent webhook configuration", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("PATCH", "/agents/me", {
      status: 200,
      body: JSON.stringify({
        agent_id: "agent_existing",
        name: "Agent Existing",
        webhook_url: "https://example.trycloudflare.com/webhooks/clawlabor",
      }),
    }),
  ]);
  const out = [];

  await runCli(
    [
      "profile",
      "--webhook-url",
      "https://example.trycloudflare.com/webhooks/clawlabor",
      "--webhook-secret",
      "0123456789abcdef0123456789abcdef",
    ],
    {
      env: {
              CLAWLABOR_API_KEY: "file-key",
      },
      fetch,
      stdout: (t) => out.push(t),
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].options.headers.Authorization, "Bearer file-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    webhook_url: "https://example.trycloudflare.com/webhooks/clawlabor",
    webhook_secret: "0123456789abcdef0123456789abcdef",
  });
  const result = JSON.parse(out[0]);
  assert.equal(result.action, "updated");
  assert.equal(result.webhook_url, "https://example.trycloudflare.com/webhooks/clawlabor");
});

test("publish creates a SKU listing for the current agent", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/listings", {
      status: 201,
      body: JSON.stringify({
        listing: {
          id: "listing-code-1",
          name: "Hermes Code Writer",
          price: 25,
          category: "code_engineering",
          status: "active",
          input_schema: {
            type: "object",
            required: ["task"],
            properties: { task: { type: "string" } },
          },
        },
      }),
    }),
  ]);
  const out = [];
  await runCli(
    [
      "publish",
      "--name",
      "Hermes Code Writer",
      "--description",
      "Writes small code changes and returns a concise patch.",
      "--price",
      "25",
      "--category",
      "code_engineering",
      "--input-schema-json",
      '{"type":"object","required":["task"],"properties":{"task":{"type":"string"}}}',
      "--tags",
      "code,hermes",
      "--idempotency-key",
      "publish-code-1",
    ],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );

  assert.equal(calls[0].options.method, "POST");
  assert.ok(calls[0].url.endsWith("/listings"));
  assert.equal(calls[0].options.headers["Idempotency-Key"], "publish-code-1");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: "Hermes Code Writer",
    description: "Writes small code changes and returns a concise patch.",
    price: 25,
    input_schema: {
      type: "object",
      required: ["task"],
      properties: { task: { type: "string" } },
    },
    output_schema: null,
    example_input: null,
    example_output: null,
    tags: ["code", "hermes"],
    category: "code_engineering",
  });
  const result = JSON.parse(out[0]);
  assert.equal(result.action, "published");
  assert.equal(result.listing_id, "listing-code-1");
});

test("accept and complete seller order lifecycle commands", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/orders/order-1/accept", {
      status: 200,
      body: JSON.stringify({ id: "order-1", status: "in_progress" }),
    }),
    matchRoute("POST", "/orders/order-1/complete", {
      status: 200,
      body: JSON.stringify({
        id: "order-1",
        status: "pending_confirmation",
        delivery_note: "Implemented the requested code change.",
      }),
    }),
  ]);
  const out = [];
  await runCli(["accept", "--order", "order-1"], {
    env: BASE_ENV,
    fetch,
    stdout: (t) => out.push(t),
  });
  await runCli(["complete", "--order", "order-1", "--delivery-note", "Implemented the requested code change."], {
    env: BASE_ENV,
    fetch,
    stdout: (t) => out.push(t),
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    delivery_note: "Implemented the requested code change.",
  });
  assert.equal(JSON.parse(out[0]).action, "accepted");
  assert.equal(JSON.parse(out[1]).action, "completed");
});

test("online starts a receiver and writes webhook events to inbox", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-online-"));
  const inboxFile = path.join(tempDir, "inbox.jsonl");
  const sessionRoot = path.join(tempDir, "sessions");
  const requestSecret = "0123456789abcdef0123456789abcdef";
  const wait = deferred();
  let handler = null;
  const server = {
    listen(_port, _host, cb) {
      cb?.();
    },
    close(cb) {
      cb?.();
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };
  const { fetch, calls } = recordingFetch([
    matchRoute("PATCH", "/agents/me", {
      status: 200,
      body: JSON.stringify({
        agent_id: "agent_existing",
        name: "Agent Existing",
        webhook_url: "https://example.trycloudflare.com/webhooks/clawlabor",
      }),
    }),
    matchRoute("POST", "/agents/heartbeat", {
      status: 200,
      body: JSON.stringify({ ok: true }),
    }),
  ]);
  const out = [];
  let spawnCalled = false;

  const run = runCli(
    [
      "online",
      "--webhook-url",
      "https://example.trycloudflare.com/webhooks/clawlabor",
      "--webhook-secret",
      requestSecret,
      "--inbox-file",
      inboxFile,
      "--session-root",
      sessionRoot,
      "--session-id",
      "hermes-current",
      "--port",
      "8787",
    ],
    {
      env: {
              CLAWLABOR_API_KEY: "file-key",
      },
      fetch,
      stdout: (t) => out.push(t),
      createServer: (cb) => {
        handler = cb;
        return server;
      },
      spawn: () => {
        spawnCalled = true;
        throw new Error("should not start a tunnel when --webhook-url is provided");
      },
      waitForExit: wait.promise,
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(handler, "receiver should be created");
  assert.equal(spawnCalled, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    webhook_url: "https://example.trycloudflare.com/webhooks/clawlabor",
    webhook_secret: requestSecret,
  });

  const buyerPayload = {
    event_id: 98,
    event_type: "order.completed",
    payload: { order_id: "order-buyer-98" },
    created_at: "2026-05-19T00:00:00.000Z",
  };
  const buyerBody = Buffer.from(JSON.stringify(buyerPayload));
  const buyerSignature = crypto.createHmac("sha256", requestSecret).update(buyerBody).digest("hex");
  const buyerReq = Readable.from([buyerBody]);
  buyerReq.method = "POST";
  buyerReq.url = "/webhooks/clawlabor";
  buyerReq.headers = { "x-webhook-signature": buyerSignature };
  const buyerRes = createMockResponse();
  await handler(buyerReq, buyerRes);

  assert.equal(buyerRes.statusCode, 200);
  assert.equal(JSON.parse(buyerRes.body).session_id, "hermes-current");

  const payload = {
    event_id: 99,
    event_type: "order.received",
    payload: { order_id: "order-99" },
    created_at: "2026-05-19T00:00:00.000Z",
  };
  const body = Buffer.from(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", requestSecret).update(body).digest("hex");
  const req = Readable.from([body]);
  req.method = "POST";
  req.url = "/webhooks/clawlabor";
  req.headers = { "x-webhook-signature": signature };
  const res = createMockResponse();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).session_id, "order:order-99:seller");
  const retryReq = Readable.from([body]);
  retryReq.method = "POST";
  retryReq.url = "/webhooks/clawlabor";
  retryReq.headers = { "x-webhook-signature": signature };
  const retryRes = createMockResponse();
  await handler(retryReq, retryRes);

  assert.equal(retryRes.statusCode, 200);
  assert.equal(JSON.parse(retryRes.body).duplicate, true);
  assert.ok(fs.existsSync(inboxFile));
  const lines = fs.readFileSync(inboxFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const stored = JSON.parse(lines[1]);
  assert.equal(stored.event_id, 99);
  assert.equal(stored.event_type, "order.received");
  assert.equal(stored.payload.order_id, "order-99");

  assert.ok(fs.existsSync(path.join(sessionRoot, "hermes-current", "inbox.jsonl")));
  assert.ok(fs.existsSync(path.join(sessionRoot, "order_order-99_seller", "inbox.jsonl")));
  assert.equal(
    fs.readFileSync(path.join(sessionRoot, "order_order-99_seller", "inbox.jsonl"), "utf8").trim().split("\n").length,
    1,
  );
  assert.match(
    fs.readFileSync(path.join(sessionRoot, "order_order-99_seller", "prompt.md"), "utf8"),
    /SKU\/listing description, and the buyer's order requirement/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(sessionRoot, "order_order-99_seller", "prompt.md"), "utf8"),
    /Latest event/,
  );

  const buyerMessagePayload = {
    event_id: 100,
    event_type: "message.received",
    payload: { order_id: "buyer-order-without-seller-session", content: "Any update?" },
    created_at: "2026-05-19T00:00:01.000Z",
  };
  const buyerMessageBody = Buffer.from(JSON.stringify(buyerMessagePayload));
  const buyerMessageSignature = crypto.createHmac("sha256", requestSecret).update(buyerMessageBody).digest("hex");
  const buyerMessageReq = Readable.from([buyerMessageBody]);
  buyerMessageReq.method = "POST";
  buyerMessageReq.url = "/webhooks/clawlabor";
  buyerMessageReq.headers = { "x-webhook-signature": buyerMessageSignature };
  const buyerMessageRes = createMockResponse();
  await handler(buyerMessageReq, buyerMessageRes);

  assert.equal(buyerMessageRes.statusCode, 200);
  assert.equal(JSON.parse(buyerMessageRes.body).session_id, "hermes-current");

  const sessionOut = [];
  await runCli(["session", "--action", "next", "--session-root", sessionRoot, "--session-id", "hermes-current"], {
    env: BASE_ENV,
    fetch: async () => {
      throw new Error("session next should not call API");
    },
    stdout: (t) => sessionOut.push(t),
  });
  const sessionNext = JSON.parse(sessionOut[0]);
  assert.equal(sessionNext.pending, true);
  assert.equal(sessionNext.event.event_type, "order.completed");
  assert.equal(sessionNext.event.payload.order_id, "order-buyer-98");

  wait.resolve();
  await run;

  const result = JSON.parse(out[0]);
  assert.equal(result.action, "online");
  assert.equal(result.receiver_url, "http://127.0.0.1:8787/webhooks/clawlabor");
  assert.equal(result.current_session_id, "hermes-current");
  assert.equal(result.heartbeat_ok, true);
});

test("serve --adapter hermes processes isolated seller order sessions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-serve-hermes-"));
  const sessionRoot = path.join(tempDir, "sessions");
  const sessionDir = path.join(sessionRoot, "order_order-serve-1_seller");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionRoot, "state.json"),
    JSON.stringify({
      current_session_id: "hermes-current",
      sessions: {
        "order:order-serve-1:seller": {
          session_id: "order:order-serve-1:seller",
          kind: "order",
          role: "seller",
          context_id: "order-serve-1",
          purpose: "Fulfill order order-serve-1",
          last_event_id: 501,
        },
      },
    }),
  );
  fs.writeFileSync(path.join(sessionDir, "cursor.json"), JSON.stringify({ last_acked_event_id: 0 }));
  fs.writeFileSync(
    path.join(sessionDir, "inbox.jsonl"),
    `${JSON.stringify({
      event_id: 501,
      event_type: "order.received",
      payload: {
        order_id: "order-serve-1",
        requirement: { task: "Write a JavaScript add function from the event payload" },
        input_schema: { type: "object", required: ["task"] },
        service_sku_id: "sku-serve-1",
      },
      created_at: "2026-05-19T00:00:00.000Z",
    })}\n`,
  );

  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const method = options.method || "GET";
    if (method === "GET" && url.endsWith("/orders/order-serve-1")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          order: {
            id: "order-serve-1",
            status: "pending_accept",
          },
        }),
      };
    }
    throw new Error(`No mock route matched ${method} ${url}`);
  };

  const spawnCalls = [];
  const fakeSpawn = (_command, args) => {
    spawnCalls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit("data", "Here is the implementation: function add(a, b) { return a + b; }");
      child.emit("exit", 0);
    });
    return child;
  };

  const out = [];
  await runCli(
    [
      "serve",
      "--adapter",
      "hermes",
      "--once",
      "--session-root",
      sessionRoot,
      "--hermes-command",
      "hermes",
    ],
    {
      env: BASE_ENV,
      fetch,
      spawn: fakeSpawn,
      stdout: (t) => out.push(t),
    },
  );

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], "chat");
  const hermesPrompt = spawnCalls[0][spawnCalls[0].indexOf("-q") + 1];
  assert.match(hermesPrompt, /Use the SKU\/listing description, input schema, buyer requirement, messages, and attachments as the contract/);
  assert.match(hermesPrompt, /The serve wrapper only delivered this event to you/);
  assert.match(hermesPrompt, /Write a JavaScript add function from the event payload/);
  assert.doesNotMatch(hermesPrompt, /code-writing SKU order/);
  assert.ok(calls.every((call) => !call.url.endsWith("/orders/order-serve-1/accept")));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sessionDir, "cursor.json"), "utf8")).last_acked_event_id,
    501,
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.processed[0].order_id, "order-serve-1");
  assert.equal(result.processed[0].status, "pending_accept");
});

test("serve --adapter hermes acks seller order after notifying Hermes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-serve-empty-"));
  const sessionRoot = path.join(tempDir, "sessions");
  const sessionDir = path.join(sessionRoot, "order_order-empty_seller");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionRoot, "state.json"),
    JSON.stringify({
      current_session_id: "hermes-current",
      sessions: {
        "order:order-empty:seller": {
          session_id: "order:order-empty:seller",
          kind: "order",
          role: "seller",
          context_id: "order-empty",
          purpose: "Fulfill order order-empty",
          last_event_id: 601,
        },
      },
    }),
  );
  fs.writeFileSync(path.join(sessionDir, "cursor.json"), JSON.stringify({ last_acked_event_id: 0 }));
  fs.writeFileSync(
    path.join(sessionDir, "inbox.jsonl"),
    `${JSON.stringify({
      event_id: 601,
      event_type: "order.received",
      payload: { order_id: "order-empty", requirement: { task: "Return something" } },
      created_at: "2026-05-19T00:00:00.000Z",
    })}\n`,
  );

  const calls = [];
  let orderEmptyGetCount = 0;
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const method = options.method || "GET";
    if (method === "GET" && url.endsWith("/orders/order-empty")) {
      orderEmptyGetCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ order: { id: "order-empty", status: "in_progress" } }),
      };
    }
    if (method === "GET" && url.endsWith("/orders/order-empty/attachments")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ files: [], file_count: 0, total_size: 0 }),
      };
    }
    throw new Error(`No mock route matched ${method} ${url}`);
  };

  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit("data", "   \n");
      child.emit("exit", 0);
    });
    return child;
  };

  const out = [];
  await runCli(
    [
      "serve",
      "--adapter",
      "hermes",
      "--once",
      "--session-root",
      sessionRoot,
      "--hermes-command",
      "hermes",
    ],
    {
      env: BASE_ENV,
      fetch,
      spawn: fakeSpawn,
      stdout: (t) => out.push(t),
    },
  );

  assert.ok(calls.every((call) => !call.url.endsWith("/orders/order-empty/complete")));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sessionDir, "cursor.json"), "utf8")).last_acked_event_id,
    601,
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.processed.length, 1);
  assert.equal(result.processed[0].status, "in_progress");
});

test("online defaults to Cloudflare tunnel discovery and writes the public URL back to the profile", async () => {
  const wait = deferred();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-online-tunnel-"));
  const tunnel = new EventEmitter();
  tunnel.stdout = new EventEmitter();
  tunnel.stderr = new EventEmitter();
  tunnel.kill = () => {
    tunnel.killed = true;
  };
  const server = {
    listen(_port, _host, cb) {
      cb?.();
    },
    close(cb) {
      cb?.();
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };
  const { fetch, calls } = recordingFetch([
    matchRoute("PATCH", "/agents/me", {
      status: 200,
      body: JSON.stringify({
        agent_id: "agent_existing",
        name: "Agent Existing",
        webhook_url: "https://agent.example.com/webhooks/clawlabor",
      }),
    }),
    matchRoute("POST", "/agents/heartbeat", {
      status: 200,
      body: JSON.stringify({ ok: true }),
    }),
  ]);
  const out = [];
  const spawnCalls = [];

  const run = runCli(
    [
      "online",
      "--webhook-secret",
      "abcdef0123456789abcdef0123456789",
      "--inbox-file",
      path.join(tempDir, "inbox.jsonl"),
      "--session-root",
      path.join(tempDir, "sessions"),
      "--port",
      "8787",
    ],
    {
      env: {
              CLAWLABOR_API_KEY: "file-key",
      },
      fetch,
      stdout: (t) => out.push(t),
      createServer: () => server,
      spawn: (command, args) => {
        spawnCalls.push({ command, args });
        return tunnel;
      },
      waitForExit: wait.promise,
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(spawnCalls, [{
    command: "cloudflared",
    args: ["tunnel", "--url", "http://127.0.0.1:8787/webhooks/clawlabor"],
  }]);
  tunnel.stderr.emit("data", "Your quick Tunnel has been created! Visit https://www.cloudflare.com/website-terms/ for terms\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  tunnel.stdout.emit("data", "Visit https://abc.trycloudflare.com for the public URL\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    webhook_url: "https://abc.trycloudflare.com/webhooks/clawlabor",
    webhook_secret: "abcdef0123456789abcdef0123456789",
  });

  wait.resolve();
  await run;

  const result = JSON.parse(out[0]);
  assert.equal(result.webhook_url, "https://abc.trycloudflare.com/webhooks/clawlabor");
  assert.equal(result.tunnel_command, "cloudflared");
});

test("online closes the receiver when the default tunnel cannot start", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-online-missing-tunnel-"));
  let closed = false;
  const server = {
    listen(_port, _host, cb) {
      cb?.();
    },
    close(cb) {
      closed = true;
      cb?.();
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };

  await assert.rejects(
    runCli(
      [
        "online",
        "--inbox-file",
        path.join(tempDir, "inbox.jsonl"),
        "--session-root",
        path.join(tempDir, "sessions"),
      ],
      {
        env: BASE_ENV,
        fetch: async () => {
          throw new Error("should not call API before tunnel URL is known");
        },
        stdout: () => {},
        createServer: () => server,
        spawn: () => {
          const err = new Error("spawn cloudflared ENOENT");
          err.code = "ENOENT";
          throw err;
        },
      },
    ),
    /Install cloudflared/,
  );
  assert.equal(closed, true);
});

test("register requires owner email", async () => {
  await assert.rejects(
    runCli(["register"], {
      env: {},
      fetch: async () => {
        throw new Error("should not call API");
      },
      stdout: () => {},
    }),
    (err) => err.errorCode === "missing_owner_email",
  );
});

test("buy creates a purchase request with idempotency", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/listings/sku-123/purchase", { status: 201, body: '{"id":"order-123"}' }),
  ]);
  await runCli(
    ["buy", "--listing", "sku-123", "--requirement-json", '{"url":"https://example.com"}'],
    { env: BASE_ENV, fetch, stdout: () => {}, makeIdempotencyKey: () => "fixed-key" },
  );
  assert.equal(calls[0].options.headers["X-Idempotency-Key"], "fixed-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), { requirement: { url: "https://example.com" }, staged_attachment_ids: [] });
});

test("status surfaces structured cancel_reason without message fallback", async () => {
  const fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/orders/order-123") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          order: {
            id: "order-123",
            status: "cancelled",
            delivery_note: null,
            delivery_validation: null,
            accept_deadline: "2026-05-07T10:00:00Z",
            confirm_deadline: null,
            accepted_at: null,
            completed_at: null,
            confirmed_at: null,
            cancel_reason: "Seller found the upstream source unavailable.",
          },
        }),
      };
    }
    if (pathname === "/api/orders/order-123/messages") {
      throw new Error("message fallback should not run when cancel_reason is present");
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const out = [];
  await runCli(["status", "--order", "order-123"], {
    env: BASE_ENV,
    fetch,
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancel_reason, "Seller found the upstream source unavailable.");
  assert.equal(result.cancellation_context, null);
});

test("wait falls back to cancellation context when cancel_reason is absent", async () => {
  const fetch = async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/orders/order-123") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ order: { id: "order-123", status: "cancelled" } }),
      };
    }
    if (pathname === "/api/orders/order-123/messages") {
      assert.equal(options.method, "GET");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            messages: [
              {
                id: "msg-1",
                sender_id: "seller-1",
                sender: { name: "Seller One" },
                content: "Order cancelled: I could not access the required attachment.",
                created_at: "2026-05-07T09:10:00Z",
              },
            ],
          }),
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const out = [];
  await runCli(["wait", "--order", "order-123", "--until", "pending_confirmation", "--timeout", "1", "--interval", "1"], {
    env: BASE_ENV,
    fetch,
    stdout: (t) => out.push(t),
    sleep: async () => {},
    now: (() => {
      let current = 0;
      return () => {
        current += 100;
        return current;
      };
    })(),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.reached, false);
  assert.equal(result.reason, "terminal_state_before_target");
  assert.equal(result.cancel_reason, null);
  assert.equal(result.cancellation_context.latest_message.content, "Order cancelled: I could not access the required attachment.");
});

test("match applies local policy defaults", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-policy-"));
  const policyFile = path.join(tempDir, "policy.json");
  fs.writeFileSync(
    policyFile,
    JSON.stringify({
      per_order_limit_uat: 50,
      min_trust_score: 80,
      allowed_categories: ["research_analysis"],
      require_schema: true,
    }),
  );
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/listings/match", { status: 200, body: '{"matches":[]}' }),
  ]);
  await runCli(
    ["match", "--goal", "Analyze competitor", "--policy-file", policyFile],
    { env: BASE_ENV, fetch, stdout: () => {} },
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    goal: "Analyze competitor",
    category: "research_analysis",
    max_price: 50,
    min_trust_score: 80,
    require_schema: true,
  });
});

test("plan emits a compact agent-facing purchase plan", async () => {
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-123",
            title: "Research",
            description: "Long listing text that should not be duplicated in the default plan.",
            price: 20,
            category: "research_analysis",
            trust_score: 92,
            status: "active",
            inventory: 1,
            tags: ["research"],
            input_schema: { type: "object", required: ["url", "question"] },
            policy: { allowed: true, blocked_reasons: [] },
            reasons: ["category_match"],
            match_explanation: "Matched because the task needs public evidence.",
            invocation_guidance: ["Expected outcome: sourced research brief"],
          },
          {
            id: "sku-cheap",
            policy: { allowed: false, blocked_reasons: ["trust_below_minimum"] },
          },
        ],
      }),
    }),
  ]);
  const out = [];
  await runCli(
    [
      "plan",
      "--goal",
      "Analyze",
      "--requirement-json",
      '{"url":"https://x.com"}',
    ],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t), makeIdempotencyKey: () => "fixed-key" },
  );
  const plan = JSON.parse(out[0]);
  assert.deepEqual(plan.listing, {
    id: "sku-123",
    title: "Research",
    price: 20,
    category: "research_analysis",
    trust_score: 92,
    status: "active",
    inventory: 1,
  });
  // next_action replaces top-level action/execute_command/decision.
  assert.equal(plan.next_action.type, "execute_solve");
  assert.equal(plan.next_action.terminal, false);
  assert.equal(plan.next_action.ready, false); // missing "question" field
  assert.deepEqual(plan.next_action.blocked_by, [
    "Replace <TODO:question:...> in sample_requirement before running command",
  ]);
  // This mock's input_schema declares `required` but no `properties`, so
  // buildSampleRequirement can't infer a placeholder value for "question" —
  // it stays absent from sample_requirement. blocked_by still flags it via
  // schemaCheck.missing so the agent knows to add it.
  assert.equal(
    plan.next_action.command,
    "clawlabor solve --goal 'Analyze' --requirement-json '{\"url\":\"https://x.com\"}' --idempotency-key 'fixed-key'",
  );

  // input.* (no input.schema anymore — selected schema lives on candidates[0])
  assert.deepEqual(plan.input.requirement, { url: "https://x.com" });
  assert.equal(plan.input.valid, false);
  assert.deepEqual(plan.input.missing_required_fields, ["question"]);

  // candidates[0] is the single authoritative selected listing view.
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].id, "sku-123");
  assert.equal(plan.candidates[0].description, "Long listing text that should not be duplicated in the default plan.");
  assert.deepEqual(plan.candidates[0].tags, ["research"]);
  assert.deepEqual(plan.candidates[0].input_schema.required, ["url", "question"]);
  assert.equal(plan.candidates[0].schema_compatibility.valid, false);
  assert.deepEqual(plan.candidates[0].schema_compatibility.missing_required_fields, ["question"]);
  assert.equal(plan.candidates[0].decision.why_matched, "Matched because the task needs public evidence.");
  assert.deepEqual(plan.candidates[0].decision.how_to_use, ["Expected outcome: sourced research brief"]);

  // Redundant views removed.
  assert.equal(plan.action, undefined, "top-level action replaced by next_action.type");
  assert.equal(plan.decision, undefined, "top-level decision is a duplicate of candidates[0].decision");
  assert.equal(plan.execute_command, undefined, "execute_command replaced by next_action.command");
  assert.equal(plan.raw_execute_command, undefined);
  assert.equal(plan.legacy_buy_command, undefined);
  assert.equal(plan.input.schema, undefined, "input.schema is a duplicate of candidates[0].input_schema");
  assert.equal(plan.selected_listing, undefined);
  assert.equal(plan.match_explanation, undefined);
  assert.equal(plan.invocation_guidance, undefined);
  assert.equal(plan.rejected_listings, undefined);
  assert.equal(plan.debug, undefined);

  // listing summary kept for "what did plan pick" at-a-glance.
  assert.deepEqual(plan.listing, {
    id: "sku-123",
    title: "Research",
    price: 20,
    category: "research_analysis",
    trust_score: 92,
    status: "active",
    inventory: 1,
  });
});

test("plan --verbose includes raw match debug data", async () => {
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-123",
            title: "Research",
            price: 20,
            input_schema: { type: "object", required: ["url"] },
            policy: { allowed: true, blocked_reasons: [] },
            reasons: ["category_match"],
          },
          {
            id: "sku-cheap",
            policy: { allowed: false, blocked_reasons: ["trust_below_minimum"] },
          },
        ],
      }),
    }),
  ]);
  const out = [];
  await runCli(
    [
      "plan",
      "--goal",
      "Analyze",
      "--requirement-json",
      '{"url":"https://x.com"}',
      "--verbose",
    ],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t), makeIdempotencyKey: () => "fixed-key" },
  );
  const plan = JSON.parse(out[0]);
  assert.equal(plan.listing.id, "sku-123");
  assert.equal(plan.debug.selected_listing.id, "sku-123");
  assert.deepEqual(plan.debug.reasons, ["category_match"]);
  assert.deepEqual(plan.debug.rejected_listings, [
    { id: "sku-cheap", blocked_reasons: ["trust_below_minimum"] },
  ]);
  assert.equal(plan.debug.raw_match.matches.length, 2);
});

test("plan chooses a schema-compatible allowed listing", async () => {
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-repo",
            price: 30,
            input_schema: { type: "object", required: ["repo_url"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
          {
            id: "sku-url",
            price: 25,
            input_schema: { type: "object", required: ["url"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
  ]);
  const out = [];
  await runCli(
    ["plan", "--goal", "Analyze site", "--requirement-json", '{"url":"https://example.com"}'],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t), makeIdempotencyKey: () => "fixed-key" },
  );
  const plan = JSON.parse(out[0]);
  assert.equal(plan.listing.id, "sku-url");
  assert.equal(plan.input.valid, true);
  assert.match(plan.next_action.command, /^clawlabor solve --goal 'Analyze site'/);
  assert.equal(plan.next_action.command.includes("clawlabor buy"), false);
  assert.equal(plan.next_action.type, "execute_solve");
  // selected listing is prepended so agents see the chosen one first.
  assert.deepEqual(plan.candidates.map((candidate) => candidate.id), ["sku-url", "sku-repo"]);
  assert.deepEqual(
    plan.candidates.map((candidate) => candidate.schema_compatibility),
    [
      { valid: true, missing_required_fields: [] },
      { valid: false, missing_required_fields: ["repo_url"] },
    ],
  );
});

test("plan reports missing required fields when requirement is omitted", async () => {
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-url",
            price: 25,
            input_schema: { type: "object", required: ["url"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
  ]);
  const out = [];
  await runCli(
    ["plan", "--goal", "Analyze site"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t), makeIdempotencyKey: () => "fixed-key" },
  );
  const plan = JSON.parse(out[0]);
  assert.equal(plan.input.requirement, null);
  assert.equal(plan.input.valid, false);
  assert.deepEqual(plan.input.missing_required_fields, ["url"]);
});

test("validate calls delivery validation endpoint", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/orders/order-123/validate-delivery", {
      status: 200,
      body: '{"verdict":"valid"}',
    }),
  ]);
  await runCli(["validate", "--order", "order-123"], { env: BASE_ENV, fetch, stdout: () => {} });
  assert.equal(calls[0].url, "https://www.clawlabor.com/api/orders/order-123/validate-delivery");
});

test("message sends an order message", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/orders/order-123/messages", {
      status: 200,
      body: JSON.stringify({
        message: { id: "msg-1", content: "Need the missing CSV." },
      }),
    }),
  ]);
  const out = [];
  await runCli(
    ["message", "--order", "order-123", "--content", "Need the missing CSV."],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  const result = JSON.parse(out[0]);
  const body = JSON.parse(calls[0].options.body);

  assert.equal(result.action, "sent");
  assert.equal(result.entity, "order");
  assert.equal(body.content, "Need the missing CSV.");
});

test("message lists task messages", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/tasks/task-123/messages?limit=2", {
      status: 200,
      body: JSON.stringify({
        data: [
          { id: "msg-1", content: "First" },
          { id: "msg-2", content: "Second" },
        ],
      }),
    }),
  ]);
  const out = [];
  await runCli(
    ["message", "--task", "task-123", "--limit", "2"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  const result = JSON.parse(out[0]);

  assert.equal(calls[0].url, "https://www.clawlabor.com/api/tasks/task-123/messages?limit=2");
  assert.equal(result.entity, "task");
  assert.equal(result.count, 2);
  assert.equal(result.messages[1].content, "Second");
});

// ---------------------------------------------------------------------------
// new commands
// ---------------------------------------------------------------------------

test("inspect summarizes listing schema", async () => {
  const { fetch } = recordingFetch([
    matchRoute("GET", "/listings/sku-123", {
      status: 200,
      body: JSON.stringify({
        listing: {
          id: "sku-123",
          name: "Competitor research",
          price: 20,
          trust_score: 92,
          category: "research_analysis",
          input_schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
          output_schema: { type: "object" },
        },
      }),
    }),
  ]);
  const out = [];
  await runCli(["inspect", "--listing", "sku-123"], { env: BASE_ENV, fetch, stdout: (t) => out.push(t) });
  const summary = JSON.parse(out[0]);
  assert.equal(summary.id, "sku-123");
  assert.equal(summary.has_input_schema, true);
  assert.equal(summary.has_output_schema, true);
  assert.deepEqual(summary.required_fields, ["url"]);
});

test("status returns concise order summary", async () => {
  const { fetch } = recordingFetch([
    matchRoute("GET", "/orders/order-1", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-1",
          status: "pending_confirmation",
          delivery_note: "{\"report\":\"ok\"}",
          delivery_validation: { verdict: "valid" },
        },
      }),
    }),
  ]);
  const out = [];
  await runCli(["status", "--order", "order-1"], { env: BASE_ENV, fetch, stdout: (t) => out.push(t) });
  const summary = JSON.parse(out[0]);
  assert.equal(summary.status, "pending_confirmation");
  assert.equal(summary.has_delivery, true);
  assert.equal(summary.delivery_validation.verdict, "valid");
});

test("wait polls until target status", async () => {
  let calls = 0;
  const fetch = async (url) => {
    calls += 1;
    const status = calls < 3 ? "in_progress" : "pending_confirmation";
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ order: { id: "order-1", status } }),
    };
  };
  let nowVal = 0;
  const out = [];
  await runCli(
    ["wait", "--order", "order-1", "--timeout", "60", "--interval", "1"],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      sleep: async (ms) => {
        nowVal += ms;
      },
      now: () => nowVal,
    },
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.reached, true);
  assert.equal(result.status, "pending_confirmation");
  assert.equal(calls, 3);
});

test("wait returns timeout when target never reached", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ order: { id: "order-1", status: "in_progress" } }),
    };
  };
  let nowVal = 0;
  const out = [];
  await runCli(
    ["wait", "--order", "order-1", "--timeout", "5", "--interval", "1"],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      sleep: async (ms) => {
        nowVal += ms;
      },
      now: () => nowVal,
    },
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.reached, false);
  assert.equal(result.reason, "timeout");
});

test("result parses JSON delivery_note", async () => {
  const { fetch } = recordingFetch([
    matchRoute("GET", "/orders/order-1", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-1",
          status: "pending_confirmation",
          delivery_note: JSON.stringify({ report: "ok", opportunities: ["a", "b"] }),
          delivery_attestation: {
            version: "1",
            seller: { status: "passed", metrics: { render_ms: 42 } },
          },
        },
      }),
    }),
  ]);
  const out = [];
  await runCli(["result", "--order", "order-1"], { env: BASE_ENV, fetch, stdout: (t) => out.push(t) });
  const data = JSON.parse(out[0]);
  assert.equal(data.delivery_format, "json");
  assert.deepEqual(data.delivery.opportunities, ["a", "b"]);
  assert.equal(data.delivery_attestation.seller.metrics.render_ms, 42);
});

test("result surfaces structured cancel_reason on cancelled orders", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/orders/order-2", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-2",
          status: "cancelled",
          delivery_note: null,
          cancel_reason: "Seller could not access the source file.",
        },
      }),
    }),
  ]);
  const out = [];
  await runCli(["result", "--order", "order-2"], { env: BASE_ENV, fetch, stdout: (t) => out.push(t) });
  const data = JSON.parse(out[0]);
  assert.equal(data.cancel_reason, "Seller could not access the source file.");
  assert.equal(data.cancellation_context, null);
  assert.equal(calls.length, 2);
});

test("result includes delivery attachments with download URLs", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/orders/order-1", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-1",
          status: "pending_confirmation",
          delivery_note: "See attached report.",
        },
      }),
    }),
    matchRoute("GET", "/orders/order-1/attachments", {
      status: 200,
      body: JSON.stringify({
        files: [
          {
            file_id: "file-delivery",
            filename: "report.pdf",
            content_type: "application/pdf",
            size: 1234,
            download_url: "https://storage.example.test/report.pdf?sig=abc",
            file_type: "seller_delivery",
          },
          {
            file_id: "file-input",
            filename: "brief.txt",
            content_type: "text/plain",
            size: 12,
            download_url: "https://storage.example.test/brief.txt?sig=abc",
            file_type: "buyer_material",
          },
        ],
        file_count: 2,
        total_size: 1246,
      }),
    }),
  ]);
  const out = [];
  await runCli(["result", "--order", "order-1"], { env: BASE_ENV, fetch, stdout: (t) => out.push(t) });
  const data = JSON.parse(out[0]);

  assert.equal(calls[1].url, "https://www.clawlabor.com/api/orders/order-1/attachments");
  assert.equal(data.attachments.file_count, 2);
  assert.equal(data.attachments.delivery_file_count, 1);
  assert.equal(data.attachments.delivery_files[0].download_url, "https://storage.example.test/report.pdf?sig=abc");
});

test("download-attachment downloads by file_id to output path", async () => {
  const outPath = tempTestFile("report.pdf");
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/orders/order-1/attachments", {
      status: 200,
      body: JSON.stringify({
        files: [
          {
            file_id: "file-delivery",
            filename: "report.pdf",
            download_url: "https://storage.example.test/report.pdf?sig=abc",
          },
        ],
      }),
    }),
    {
      match: ({ url, options }) =>
        (options.method || "GET") === "GET" && url === "https://storage.example.test/report.pdf?sig=abc",
      respond: { status: 200, body: Buffer.from("pdf bytes") },
    },
  ]);
  const out = [];

  await runCli(
    ["download-attachment", "--entity", "order", "--id", "order-1", "--file-id", "file-delivery", "--out", outPath],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );

  const result = JSON.parse(out[0]);
  assert.equal(calls[0].url, "https://www.clawlabor.com/api/orders/order-1/attachments");
  assert.equal(calls[1].url, "https://storage.example.test/report.pdf?sig=abc");
  assert.equal(result.path, outPath);
  assert.equal(result.bytes, 9);
  assert.equal(fs.readFileSync(outPath, "utf8"), "pdf bytes");
});

test("download-attachment rejects duplicate filenames", async () => {
  const { fetch } = recordingFetch([
    matchRoute("GET", "/orders/order-1/attachments", {
      status: 200,
      body: JSON.stringify({
        files: [
          { file_id: "file-1", filename: "report.pdf", download_url: "https://storage.example.test/1" },
          { file_id: "file-2", filename: "report.pdf", download_url: "https://storage.example.test/2" },
        ],
      }),
    }),
  ]);

  await assert.rejects(
    runCli(
      ["download-attachment", "--entity", "order", "--id", "order-1", "--filename", "report.pdf"],
      { env: BASE_ENV, fetch, stdout: () => {} },
    ),
    /Multiple attachments named report\.pdf; use --file-id instead/,
  );
});

test("confirm posts to confirm endpoint", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/orders/order-1/confirm", { status: 200, body: '{"id":"order-1","status":"completed"}' }),
  ]);
  await runCli(["confirm", "--order", "order-1"], { env: BASE_ENV, fetch, stdout: () => {} });
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "{}");
});

test("status can fetch a task without treating open zero escrow as cancelled", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/tasks/task-1", {
      status: 200,
      body: JSON.stringify({
        id: "task-1",
        status: "open",
        task_mode: "bounty",
        reward: 50,
        escrow_amount: 0,
        current_submissions: 0,
      }),
    }),
  ]);
  const out = [];

  await runCli(["status", "--task", "task-1"], {
    env: BASE_ENV,
    fetch,
    stdout: (t) => out.push(t),
  });

  assert.equal(calls[0].url, "https://www.clawlabor.com/api/tasks/task-1");
  const result = JSON.parse(out[0]);
  assert.equal(result.status, "open");
  assert.equal(result.escrow_amount, 0);
  assert.equal(result.is_open, true);
  assert.equal(result.is_cancelled, false);
});

test("cancel posts to task cancel endpoint with reason", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/tasks/task-1/cancel", {
      status: 200,
      body: '{"id":"task-1","status":"cancelled"}',
    }),
  ]);

  await runCli(["cancel", "--task", "task-1", "--reason", "no longer needed"], {
    env: BASE_ENV,
    fetch,
    stdout: () => {},
  });

  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { reason: "no longer needed" });
});

test("cancel posts to order cancel endpoint with reason", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/orders/order-1/cancel", {
      status: 200,
      body: '{"id":"order-1","status":"cancelled"}',
    }),
  ]);

  await runCli(["cancel", "--order", "order-1", "--reason", "buyer cancelled"], {
    env: BASE_ENV,
    fetch,
    stdout: () => {},
  });

  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { reason: "buyer cancelled" });
});

test("post creates a bounty task", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/tasks", { status: 201, body: '{"id":"task-1"}' }),
  ]);
  await runCli(
    [
      "post",
      "--title",
      "Do research",
      "--description",
      "Please analyze the competitor at example.com.",
      "--reward",
      "100",
      "--task-mode",
      "bounty",
    ],
    { env: BASE_ENV, fetch, stdout: () => {} },
  );
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.title, "Do research");
  assert.equal(body.reward, 100);
  assert.equal(body.task_mode, "bounty");
});

test("upload-attachment posts multipart file without JSON content-type", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-upload-"));
  const filePath = path.join(tempDir, "report.html");
  fs.writeFileSync(filePath, "<html>ok</html>");
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/orders/order-123/attachments", {
      status: 201,
      body: JSON.stringify({ file_id: "file-1", filename: "brief.html" }),
    }),
  ]);
  const out = [];

  await runCli(
    [
      "upload-attachment",
      "--entity",
      "order",
      "--id",
      "order-123",
      "--file",
      filePath,
      "--filename",
      "brief.html",
      "--content-type",
      "text/html",
      "--description",
      "Buyer material",
    ],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(calls[0].options.headers["Content-Type"], undefined);
  assert.equal(calls[0].options.body.get("description"), "Buyer material");
  const uploaded = calls[0].options.body.get("file");
  assert.equal(uploaded.name, "brief.html");
  assert.equal(uploaded.type, "text/html");
  assert.equal(JSON.parse(out[0]).file_id, "file-1");
});

test("post uploads attachment after task creation when attachment-file is provided", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-post-attach-"));
  const filePath = path.join(tempDir, "brief.html");
  fs.writeFileSync(filePath, "<html>brief</html>");
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/tasks", { status: 201, body: '{"id":"task-1"}' }),
    matchRoute("POST", "/tasks/task-1/attachments", {
      status: 201,
      body: '{"file_id":"file-task-1","filename":"brief.html"}',
    }),
  ]);
  const out = [];

  await runCli(
    [
      "post",
      "--title",
      "Render HTML",
      "--description",
      "Render the attached HTML file into a PNG.",
      "--reward",
      "50",
      "--attachment-file",
      filePath,
      "--filename",
      "brief.html",
      "--content-type",
      "text/html",
      "--attachment-description",
      "Source HTML",
    ],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );

  assert.equal(calls[0].url, "https://www.clawlabor.com/api/tasks");
  assert.equal(calls[1].url, "https://www.clawlabor.com/api/tasks/task-1/attachments");
  assert.equal(calls[1].options.body.get("description"), "Source HTML");
  assert.equal(JSON.parse(out[0]).attachment.file_id, "file-task-1");
});

test("list and delete attachment map entity aliases to API paths", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/tasks/task-1/attachments", {
      status: 200,
      body: '{"files":[],"file_count":0,"total_size":0}',
    }),
    matchRoute("DELETE", "/task-submissions/sub-1/attachments/file-1", {
      status: 204,
      body: "",
    }),
  ]);

  await runCli(
    ["list-attachments", "--entity", "task", "--id", "task-1"],
    { env: BASE_ENV, fetch, stdout: () => {} },
  );
  await runCli(
    ["delete-attachment", "--entity", "submission", "--id", "sub-1", "--file-id", "file-1"],
    { env: BASE_ENV, fetch, stdout: () => {} },
  );

  assert.equal(calls[0].url, "https://www.clawlabor.com/api/tasks/task-1/attachments");
  assert.equal(
    calls[1].url,
    "https://www.clawlabor.com/api/task-submissions/sub-1/attachments/file-1",
  );
});

// ---------------------------------------------------------------------------
// solve orchestrator
// ---------------------------------------------------------------------------

test("solve runs match → buy → wait → validate → confirm", async () => {
  const routes = [
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-1",
            price: 20,
            trust_score: 90,
            input_schema: { type: "object", required: ["url"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
    matchRoute("POST", "/listings/sku-1/purchase", {
      status: 201,
      body: '{"id":"order-9"}',
    }),
    matchRoute("GET", "/orders/order-9", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-9",
          status: "pending_confirmation",
          delivery_note: '{"report":"ok"}',
        },
      }),
    }),
    matchRoute("POST", "/orders/order-9/validate-delivery", {
      status: 200,
      body: '{"verdict":"valid","can_auto_confirm":true,"overall_score":1.0}',
    }),
    matchRoute("POST", "/orders/order-9/confirm", {
      status: 200,
      body: '{"id":"order-9","status":"completed"}',
    }),
  ];
  const { fetch, calls } = recordingFetch(routes);
  let nowVal = 0;
  const out = [];
  await runCli(
    [
      "solve",
      "--goal",
      "Analyze competitor",
      "--requirement-json",
      '{"url":"https://example.com"}',
      "--auto-confirm",
      "--timeout",
      "60",
      "--interval",
      "1",
    ],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      makeIdempotencyKey: () => "fixed",
      sleep: async (ms) => {
        nowVal += ms;
      },
      now: () => nowVal,
    },
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.action, "completed");
  assert.equal(result.order_id, "order-9");
  assert.equal(result.auto_confirmed, true);
  assert.equal(result.delivery_format, "json");
  // Confirm endpoint hit
  assert.ok(calls.some((c) => c.url.endsWith("/orders/order-9/confirm")));
});

test("solve uploads attachment after purchase before waiting for delivery", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-solve-attach-"));
  const filePath = path.join(tempDir, "brief.html");
  fs.writeFileSync(filePath, "<html>brief</html>");
  const routes = [
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-1",
            price: 20,
            trust_score: 90,
            input_schema: { type: "object", required: ["instructions"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
    matchRoute("POST", "/listings/sku-1/purchase", {
      status: 201,
      body: '{"id":"order-attach"}',
    }),
    matchRoute("POST", "/orders/order-attach/attachments", {
      status: 201,
      body: '{"file_id":"file-order-1","filename":"brief.html"}',
    }),
    matchRoute("GET", "/orders/order-attach", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-attach",
          status: "pending_confirmation",
          delivery_note: "done",
        },
      }),
    }),
    matchRoute("POST", "/orders/order-attach/validate-delivery", {
      status: 200,
      body: '{"verdict":"valid","can_auto_confirm":false}',
    }),
  ];
  const { fetch, calls } = recordingFetch(routes);
  const out = [];

  await runCli(
    [
      "solve",
      "--goal",
      "Render attached HTML",
      "--requirement-json",
      '{"instructions":"Render the attached source HTML file."}',
      "--attachment-file",
      filePath,
      "--filename",
      "brief.html",
      "--content-type",
      "text/html",
      "--attachment-description",
      "Source HTML",
      "--timeout",
      "60",
      "--interval",
      "1",
    ],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      makeIdempotencyKey: () => "fixed",
      sleep: async () => {},
      now: () => 0,
    },
  );

  const urls = calls.map((call) => call.url);
  assert.ok(urls.indexOf("https://www.clawlabor.com/api/listings/sku-1/purchase") < urls.indexOf("https://www.clawlabor.com/api/orders/order-attach/attachments"));
  assert.ok(urls.indexOf("https://www.clawlabor.com/api/orders/order-attach/attachments") < urls.indexOf("https://www.clawlabor.com/api/orders/order-attach"));
  assert.equal(calls[2].options.body.get("description"), "Source HTML");
  assert.equal(
    JSON.parse(out[0]).trace.some((step) => step.step === "upload_attachment"),
    true,
  );
});

test("solve returns wait action instead of blocking indefinitely", async () => {
  const routes = [
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-wait",
            price: 20,
            input_schema: { type: "object", required: ["input"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
    matchRoute("POST", "/listings/sku-wait/purchase", {
      status: 201,
      body: '{"id":"order-wait"}',
    }),
    matchRoute("GET", "/orders/order-wait", {
      status: 200,
      body: JSON.stringify({ order: { id: "order-wait", status: "in_progress" } }),
    }),
  ];
  const { fetch } = recordingFetch(routes);
  let nowVal = 0;
  const out = [];
  await runCli(
    [
      "solve",
      "--goal",
      "Long task",
      "--requirement-json",
      '{"input":"x"}',
      "--timeout",
      "1",
      "--interval",
      "1",
    ],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      makeIdempotencyKey: () => "fixed",
      sleep: async (ms) => {
        nowVal += ms;
      },
      now: () => nowVal,
    },
  );

  const result = JSON.parse(out[0]);
  assert.equal(result.action, "wait");
  assert.equal(result.order_id, "order-wait");
  assert.equal(result.status, "in_progress");
  assert.equal(result.check_after_seconds, 300);
  assert.equal(result.check_after_iso, "1970-01-01T00:05:01.000Z");
  assert.equal(result.resume_command, "clawlabor solve --resume-order order-wait");
  assert.deepEqual(result.next_action, {
    type: "wait",
    terminal: false,
    reason: "seller_is_working",
    check_after_seconds: 300,
    check_after_iso: "1970-01-01T00:05:01.000Z",
    command: "clawlabor solve --resume-order order-wait",
    non_blocking: true,
    scheduling_note: "Do not sleep or block. Schedule next_action.command as a background task or cron job to run at check_after_iso, then return control to the user.",
  });
  assert.equal(result.retry_policy.initial_solve_repeat_safe, false);
  assert.equal(result.retry_policy.duplicate_purchase_risk, true);
  assert.equal(result.retry_policy.resume_command, "clawlabor solve --resume-order order-wait");
});

test("solve --resume-order returns needs_buyer_response for seller message", async () => {
  const routes = [
    matchRoute("GET", "/orders/order-msg", {
      status: 200,
      body: JSON.stringify({ order: { id: "order-msg", status: "in_progress" } }),
    }),
    matchRoute("GET", "/orders/order-msg/messages?limit=20", {
      status: 200,
      body: JSON.stringify({
        messages: [
          {
            id: "msg-1",
            sender_id: "seller-1",
            content: "Please clarify the target audience.",
            created_at: "2026-05-20T10:00:00Z",
          },
        ],
      }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: "buyer-1", agent_id: "buyer-agent" }),
    }),
  ];
  const { fetch } = recordingFetch(routes);
  const out = [];
  await runCli(
    ["solve", "--resume-order", "order-msg"],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      now: () => 0,
    },
  );

  const result = JSON.parse(out[0]);
  assert.equal(result.action, "needs_buyer_response");
  assert.equal(result.latest_message.id, "msg-1");
  assert.equal(result.next_command, "clawlabor message --order order-msg --content <reply>");
  assert.equal(result.resume_command, "clawlabor solve --resume-order order-msg");
  assert.deepEqual(result.next_action, {
    type: "reply",
    terminal: false,
    decision_required: true,
    command: "clawlabor message --order order-msg --content <reply>",
    after_command: "clawlabor solve --resume-order order-msg",
  });
  assert.equal(result.retry_policy.initial_solve_repeat_safe, false);
  assert.equal(result.retry_policy.resume_command, "clawlabor solve --resume-order order-msg");
});

test("solve --resume-order returns wait when no counterparty message is pending", async () => {
  const routes = [
    matchRoute("GET", "/orders/order-idle", {
      status: 200,
      body: JSON.stringify({ order: { id: "order-idle", status: "pending_accept" } }),
    }),
    matchRoute("GET", "/orders/order-idle/messages?limit=20", {
      status: 200,
      body: JSON.stringify({ messages: [] }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: "buyer-1", agent_id: "buyer-agent" }),
    }),
  ];
  const { fetch } = recordingFetch(routes);
  const out = [];
  await runCli(
    ["solve", "--resume-order", "order-idle"],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      now: () => 0,
    },
  );

  const result = JSON.parse(out[0]);
  assert.equal(result.action, "wait");
  assert.equal(result.status, "pending_accept");
  assert.equal(result.check_after_seconds, 60);
  assert.equal(result.check_after_iso, "1970-01-01T00:01:00.000Z");
  assert.deepEqual(result.next_action, {
    type: "wait",
    terminal: false,
    reason: "waiting_for_seller_state_change",
    check_after_seconds: 60,
    check_after_iso: "1970-01-01T00:01:00.000Z",
    command: "clawlabor solve --resume-order order-idle",
    non_blocking: true,
    scheduling_note: "Do not sleep or block. Schedule next_action.command as a background task or cron job to run at check_after_iso, then return control to the user.",
  });
  assert.equal(result.retry_policy.initial_solve_repeat_safe, false);
  assert.equal(result.retry_policy.resume_command, "clawlabor solve --resume-order order-idle");
});

test("solve buys the first schema-compatible allowed listing", async () => {
  const routes = [
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-repo",
            price: 20,
            input_schema: { type: "object", required: ["repo_url"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
          {
            id: "sku-url",
            price: 25,
            input_schema: { type: "object", required: ["url"] },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
    matchRoute("POST", "/listings/sku-url/purchase", {
      status: 201,
      body: '{"id":"order-10"}',
    }),
    matchRoute("GET", "/orders/order-10", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-10",
          status: "pending_confirmation",
          delivery_note: "done",
        },
      }),
    }),
    matchRoute("POST", "/orders/order-10/validate-delivery", {
      status: 200,
      body: '{"verdict":"valid","can_auto_confirm":false}',
    }),
  ];
  const { fetch, calls } = recordingFetch(routes);
  const out = [];
  await runCli(
    [
      "solve",
      "--goal",
      "Analyze competitor",
      "--requirement-json",
      '{"url":"https://example.com"}',
      "--timeout",
      "60",
      "--interval",
      "1",
    ],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      makeIdempotencyKey: () => "fixed",
      sleep: async () => {},
      now: () => 0,
    },
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.listing_id, "sku-url");
  assert.ok(calls.some((c) => c.url.endsWith("/listings/sku-url/purchase")));
});

test("solve falls back to bounty when no match and --allow-bounty", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/listings/match", { status: 200, body: '{"matches":[]}' }),
    matchRoute("POST", "/tasks", { status: 201, body: '{"id":"task-42"}' }),
  ]);
  const out = [];
  await runCli(
    [
      "solve",
      "--goal",
      "Build me a brand new image classifier and ship a polished web demo for it",
      "--allow-bounty",
      "--bounty-reward",
      "500",
    ],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.action, "posted_bounty");
  assert.equal(result.task_id, "task-42");
  const taskBody = JSON.parse(calls[1].options.body);
  assert.equal(taskBody.reward, 500);
  assert.equal(taskBody.task_mode, "bounty");
  assert.ok(taskBody.title.length >= 5);
  assert.ok(taskBody.description.length >= 20);
});

test("solve refuses when no match and --allow-bounty not set", async () => {
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", { status: 200, body: '{"matches":[]}' }),
  ]);
  await assert.rejects(
    runCli(["solve", "--goal", "Anything"], {
      env: BASE_ENV,
      fetch,
      stdout: () => {},
    }),
    (err) => err.errorCode === "no_match",
  );
});

test("solve fails fast when requirement misses required schema fields", async () => {
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-1",
            title: "Deep Researcher",
            price: 20,
            trust_score: 90,
            input_schema: {
              type: "object",
              required: ["url", "question"],
              properties: {
                url: { type: "string", format: "uri", description: "Page to analyze" },
                question: {
                  type: "string",
                  description: "What you want to know",
                  example: "What is the company's pricing model?",
                },
              },
            },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
  ]);
  await assert.rejects(
    runCli(
      [
        "solve",
        "--goal",
        "Analyze",
        "--requirement-json",
        '{"url":"https://x.com"}',
      ],
      { env: BASE_ENV, fetch, stdout: () => {} },
    ),
    (err) => {
      if (err.errorCode !== "requirement_invalid") return false;
      if (!err.missing.includes("question")) return false;
      if (err.listingId !== "sku-1") return false;
      if (err.listingTitle !== "Deep Researcher") return false;
      if (!Array.isArray(err.missingFieldHints)) return false;
      const questionHint = err.missingFieldHints.find((f) => f.name === "question");
      if (!questionHint || questionHint.description !== "What you want to know") return false;
      if (questionHint.example !== "What is the company's pricing model?") return false;
      if (!err.sampleRequirement || err.sampleRequirement.url !== "https://x.com") return false;
      if (err.sampleRequirement.question !== "What is the company's pricing model?") return false;
      if (!err.planCommand || !err.planCommand.startsWith("clawlabor plan --goal")) return false;
      if (!err.rerunCommand || !err.rerunCommand.includes("--requirement-json")) return false;
      return true;
    },
  );
});

test("plan defaults body.limit to 5 and forwards --candidates N", async () => {
  const stubMatches = (limit) => ({
    matches: Array.from({ length: limit }, (_, i) => ({
      id: `sku-${i}`,
      title: `Stub ${i}`,
      price: 5,
      trust_score: 80,
      input_schema: { type: "object", required: [] },
      policy: { allowed: true, blocked_reasons: [] },
    })),
  });
  const captureRequests = [];
  const stdout = () => {};
  const recordingFetchWithCapture = (responses) => ({
    fetch: async (url, init) => {
      captureRequests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return responses.shift();
    },
  });

  // default: --candidates not passed → body.limit=5
  {
    captureRequests.length = 0;
    const { fetch } = recordingFetchWithCapture([
      { ok: true, status: 200, text: async () => JSON.stringify(stubMatches(5)) },
    ]);
    await runCli(["plan", "--goal", "anything"], { env: BASE_ENV, fetch, stdout });
    assert.equal(captureRequests[0].body.limit, 5, "default plan limit should be 5");
  }

  // --candidates 20 → body.limit=20
  {
    captureRequests.length = 0;
    const { fetch } = recordingFetchWithCapture([
      { ok: true, status: 200, text: async () => JSON.stringify(stubMatches(20)) },
    ]);
    await runCli(["plan", "--goal", "anything", "--candidates", "20"], {
      env: BASE_ENV,
      fetch,
      stdout,
    });
    assert.equal(captureRequests[0].body.limit, 20, "--candidates N should forward to body.limit");
  }

  // explicit --limit always wins over --candidates
  {
    captureRequests.length = 0;
    const { fetch } = recordingFetchWithCapture([
      { ok: true, status: 200, text: async () => JSON.stringify(stubMatches(3)) },
    ]);
    await runCli(
      ["plan", "--goal", "anything", "--candidates", "20", "--limit", "3"],
      { env: BASE_ENV, fetch, stdout },
    );
    assert.equal(captureRequests[0].body.limit, 3, "explicit --limit overrides --candidates");
  }
});

test("plan returns required_fields with metadata and a pre-filled sample_requirement", async () => {
  const captured = [];
  const stdout = (line) => captured.push(line);
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-1",
            title: "Web Search",
            price: 5,
            trust_score: 80,
            input_schema: {
              type: "object",
              required: ["question", "language"],
              properties: {
                question: { type: "string", description: "The query" },
                language: { type: "string", enum: ["en", "zh"], default: "en" },
              },
            },
            policy: { allowed: true, blocked_reasons: [] },
          },
        ],
      }),
    }),
  ]);
  await runCli(["plan", "--goal", "search for deepseek news"], {
    env: BASE_ENV,
    fetch,
    stdout,
  });
  const plan = JSON.parse(captured.join(""));
  assert.ok(Array.isArray(plan.input.required_fields));
  assert.equal(plan.input.required_fields.length, 2);
  const questionField = plan.input.required_fields.find((f) => f.name === "question");
  assert.equal(questionField.description, "The query");
  assert.equal(plan.input.sample_requirement.language, "en"); // from default
  assert.equal(plan.input.sample_requirement.question, "<TODO:question:string>");
  assert.ok(plan.next_action.command.includes("--requirement-json"));
  assert.ok(plan.next_action.command.includes("<TODO:question:string>"));
  assert.equal(plan.next_action.ready, false);
});

test("ApiError surfaces insufficient_credits classification", async () => {
  const fetch = async () => ({
    ok: false,
    status: 402,
    text: async () => '{"detail":"insufficient_credits"}',
  });
  await assert.rejects(
    runCli(["confirm", "--order", "order-1"], { env: BASE_ENV, fetch, stdout: () => {} }),
    (err) => err.errorCode === "insufficient_credits" && err.status === 402,
  );
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("validateRequirementAgainstSchema flags missing required fields", () => {
  const result = validateRequirementAgainstSchema(
    { url: "https://x" },
    { required: ["url", "question"] },
  );
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ["question"]);
});

test("pickCompatibleListing prefers schema-compatible allowed listings", () => {
  const listing = pickCompatibleListing(
    [
      { id: "a", policy: { allowed: true }, input_schema: { required: ["repo_url"] } },
      { id: "b", policy: { allowed: true }, input_schema: { required: ["url"] } },
    ],
    { url: "https://example.com" },
  );
  assert.equal(listing.id, "b");
});

test("resolveApiKey reads explicit credentials file fallback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-creds-"));
  const credentialsFile = path.join(tempDir, "credentials.json");
  fs.writeFileSync(credentialsFile, JSON.stringify({ api_key: "file-key" }));
  assert.equal(resolveApiKey({ CLAWLABOR_CREDENTIALS_FILE: credentialsFile }), "file-key");
  assert.equal(
    resolveApiKey({ CLAWLABOR_API_KEY: "env-key", CLAWLABOR_CREDENTIALS_FILE: credentialsFile }),
    "env-key",
  );
});

test("credentialsFilePath uses explicit path before default", () => {
  assert.equal(
    credentialsFilePath({ CLAWLABOR_CREDENTIALS_FILE: "/tmp/clawlabor-creds.json" }),
    "/tmp/clawlabor-creds.json",
  );
  assert.equal(
    credentialsFilePath({}),
    path.join(os.homedir(), ".config", "clawlabor", "credentials.json"),
  );
});

test("parseDeliveryNote handles json and plain text", () => {
  assert.deepEqual(parseDeliveryNote('{"a":1}'), { format: "json", value: { a: 1 } });
  assert.deepEqual(parseDeliveryNote("plain"), { format: "text", value: "plain" });
  assert.deepEqual(parseDeliveryNote(""), { format: "empty", value: null });
});

test("bin emits JSON error and exits nonzero without API key", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-empty-home-"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "clawlabor.js"), "match", "--goal", "x"],
    {
      env: {
        ...process.env,
        HOME: tempHome,
        CLAWLABOR_API_KEY: "",
        CLAWLABOR_CREDENTIALS_FILE: path.join(tempHome, "missing-credentials.json"),
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  const err = JSON.parse(result.stderr);
  assert.equal(err.error_code, "missing_credentials");
  assert.match(err.error, /CLAWLABOR_API_KEY/);
});

test("bin adds next guidance for insufficient credits", () => {
  const script = `
    global.fetch = async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({ detail: "insufficient_credits" }),
    });
    process.argv = ["node", "clawlabor", "buy", "--listing", "sku-123"];
    require("./bin/clawlabor.js");
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      CLAWLABOR_API_KEY: "test-key",
        },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  const err = JSON.parse(result.stderr);
  assert.equal(err.error_code, "insufficient_credits");
  assert.match(err.next, /Run clawlabor me/);
  assert.match(err.next, /lower --max-price/);
});

test("clawlabor install --help returns help action without copying files", async () => {
  // Silence the installer's console.log to keep test output clean.
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const out = [];
    await runCli(["install", "--help"], {
      env: {},
      fetch: async () => {
        throw new Error("install must not call the marketplace API");
      },
      stdout: (text) => out.push(text),
    });
    const result = JSON.parse(out[0]);
    assert.equal(result.action, "help");
    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.failed, []);
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
});

test("clawlabor install links agent dirs to the npm-global canonical when present", async () => {
  // Build a fake npm-global root containing a clawlabor package, plus a fresh
  // HOME so we never touch the real ~/.claude etc.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-link-"));
  const fakeNpmRoot = path.join(tmpRoot, "node_modules");
  const canonical = path.join(fakeNpmRoot, "clawlabor");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, "SKILL.md"), "stub\n");
  const tmpHome = path.join(tmpRoot, "home");
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true }); // detection picks claude

  const originalHome = process.env.HOME;
  const originalOverride = process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
  process.env.HOME = tmpHome;
  process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = fakeNpmRoot;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const out = [];
    await runCli(["install", "--claude"], {
      env: {},
      fetch: async () => { throw new Error("install must not call API"); },
      stdout: (text) => out.push(text),
    });
    const result = JSON.parse(out[0]);
    assert.equal(result.action, "install");
    assert.equal(result.installed.length, 1);
    assert.equal(result.installed[0].mode, "link");
    assert.equal(result.installed[0].target, canonical);
    // Verify the symlink actually exists and points where we expect.
    const linkPath = path.join(tmpHome, ".claude", "skills", "clawlabor");
    const lstat = fs.lstatSync(linkPath);
    assert.ok(lstat.isSymbolicLink(), "claude skill dir should be a symlink");
    assert.equal(fs.readlinkSync(linkPath), canonical);
  } finally {
    console.log = originalLog;
    if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalOverride) process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = originalOverride;
    else delete process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("clawlabor install falls back to copy mode when canonical is a symlink", async () => {
  // npm i -g . or npm link creates a symlink at the global package path.
  // If we symlink agent skill dirs to that, writes go straight to the source repo.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-symlink-canonical-"));
  const fakeNpmRoot = path.join(tmpRoot, "node_modules");
  const realSourceDir = path.join(tmpRoot, "real-source");
  const fakeCanonical = path.join(fakeNpmRoot, "clawlabor");

  // Create a "source repo" with enough files to be copyable.
  fs.mkdirSync(realSourceDir, { recursive: true });
  fs.writeFileSync(path.join(realSourceDir, "package.json"), "{}\n");
  fs.writeFileSync(path.join(realSourceDir, "SKILL.md"), "stub\n");
  fs.mkdirSync(path.join(realSourceDir, "runtime"), { recursive: true });
  fs.writeFileSync(path.join(realSourceDir, "runtime", "http.js"), "// stub\n");

  // npm global "package" is a symlink pointing to the real source dir.
  fs.mkdirSync(fakeNpmRoot, { recursive: true });
  fs.symlinkSync(realSourceDir, fakeCanonical, "dir");

  const tmpHome = path.join(tmpRoot, "home");
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });

  const originalHome = process.env.HOME;
  const originalOverride = process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
  process.env.HOME = tmpHome;
  process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = fakeNpmRoot;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const out = [];
    await runCli(["install", "--claude"], {
      env: {},
      fetch: async () => { throw new Error("install must not call API"); },
      stdout: (text) => out.push(text),
    });
    const result = JSON.parse(out.join(""));
    assert.equal(result.action, "install");
    assert.equal(result.installed.length, 1, "should install for exactly one platform");
    assert.equal(result.installed[0].mode, "copy", "must fall back to copy when canonical is a symlink");
    assert.ok(!result.installed[0].target, "should not have a symlink target");

    const skillDir = result.installed[0].dir;
    const lstat = fs.lstatSync(skillDir);
    assert.ok(lstat.isDirectory(), "skill dir should be a real directory, not a symlink");
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")), "copied files must exist");
  } finally {
    console.log = originalLog;
    if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalOverride) process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = originalOverride;
    else delete process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("clawlabor install falls back to copy mode when canonical does not exist", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-copy-"));
  const fakeNpmRoot = path.join(tmpRoot, "node_modules");
  fs.mkdirSync(fakeNpmRoot, { recursive: true });   // empty — no clawlabor/ subdir
  const tmpHome = path.join(tmpRoot, "home");
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });

  const originalHome = process.env.HOME;
  const originalOverride = process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
  process.env.HOME = tmpHome;
  process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = fakeNpmRoot;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const out = [];
    await runCli(["install", "--claude"], {
      env: {},
      fetch: async () => { throw new Error("install must not call API"); },
      stdout: (text) => out.push(text),
    });
    const result = JSON.parse(out[0]);
    assert.equal(result.action, "install");
    assert.equal(result.installed[0].mode, "copy", "should fall back to copy when canonical missing");
    const installedPath = path.join(tmpHome, ".claude", "skills", "clawlabor", "SKILL.md");
    assert.ok(fs.existsSync(installedPath), "SKILL.md should be copied to target");
  } finally {
    console.log = originalLog;
    if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalOverride) process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = originalOverride;
    else delete process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("clawlabor install copy mode replaces a dangling symlink target", async () => {
  // Reproduces the ENOENT bug: a prior symlink-mode install left the agent
  // skill dir as a symlink, then the global package it pointed at was removed,
  // leaving a dangling symlink. Copy mode must clear it instead of failing.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-dangling-"));
  const fakeNpmRoot = path.join(tmpRoot, "node_modules");
  fs.mkdirSync(fakeNpmRoot, { recursive: true }); // empty — no clawlabor/ subdir
  const tmpHome = path.join(tmpRoot, "home");
  fs.mkdirSync(path.join(tmpHome, ".claude", "skills"), { recursive: true });

  // Create a dangling symlink where the skill dir should go.
  const skillDir = path.join(tmpHome, ".claude", "skills", "clawlabor");
  fs.symlinkSync(path.join(tmpRoot, "missing-global"), skillDir, "dir");

  const originalHome = process.env.HOME;
  const originalOverride = process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
  process.env.HOME = tmpHome;
  process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = fakeNpmRoot;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const out = [];
    await runCli(["install", "--claude"], {
      env: {},
      fetch: async () => { throw new Error("install must not call API"); },
      stdout: (text) => out.push(text),
    });
    const result = JSON.parse(out[0]);
    assert.equal(result.action, "install");
    assert.deepEqual(result.failed, [], "install must not fail on a dangling symlink");
    assert.equal(result.installed[0].mode, "copy");
    const lstat = fs.lstatSync(skillDir);
    assert.ok(lstat.isDirectory(), "dangling symlink should be replaced by a real dir");
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")), "SKILL.md should be copied");
  } finally {
    console.log = originalLog;
    if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalOverride) process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = originalOverride;
    else delete process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("clawlabor install --copy forces copy mode even when canonical exists", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-forcecopy-"));
  const fakeNpmRoot = path.join(tmpRoot, "node_modules");
  const canonical = path.join(fakeNpmRoot, "clawlabor");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, "SKILL.md"), "stub\n");
  const tmpHome = path.join(tmpRoot, "home");
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });

  const originalHome = process.env.HOME;
  const originalOverride = process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
  process.env.HOME = tmpHome;
  process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = fakeNpmRoot;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const out = [];
    await runCli(["install", "--claude", "--copy"], {
      env: {},
      fetch: async () => { throw new Error("install must not call API"); },
      stdout: (text) => out.push(text),
    });
    const result = JSON.parse(out[0]);
    assert.equal(result.installed[0].mode, "copy", "--copy should override symlink preference");
  } finally {
    console.log = originalLog;
    if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
    if (originalOverride) process.env.CLAWLABOR_NPM_ROOT_OVERRIDE = originalOverride;
    else delete process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("clawlabor install --uninstall reports an uninstall action", async () => {
  // Point HOME at an empty temp dir so we never touch the real ~/.claude etc.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-install-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const originalLog = console.log;
  console.log = () => {};
  try {
    const out = [];
    await runCli(["install", "--uninstall"], {
      env: {},
      fetch: async () => {
        throw new Error("install must not call the marketplace API");
      },
      stdout: (text) => out.push(text),
    });
    const result = JSON.parse(out[0]);
    assert.equal(result.action, "uninstall");
    // Empty HOME → nothing to remove; not a failure.
    assert.deepEqual(result.removed, []);
  } finally {
    console.log = originalLog;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("every COMMANDS entry has handler, summary, usage, and section metadata", () => {
  for (const [name, meta] of Object.entries(COMMANDS)) {
    assert.equal(typeof meta.handler, "function", `${name} missing handler`);
    assert.equal(typeof meta.summary, "string", `${name} missing summary`);
    assert.ok(meta.summary.length > 0, `${name} has empty summary`);
    assert.equal(typeof meta.usage, "string", `${name} missing usage`);
    assert.ok(meta.usage.startsWith(name), `${name} usage should start with the command name, got: ${meta.usage}`);
    assert.equal(typeof meta.section, "string", `${name} missing section`);
  }
});

test("commands subcommand prints every registered command, one per line", async () => {
  const out = [];
  await runCli(["commands"], {
    env: {},
    fetch: async () => {
      throw new Error("commands must not call API");
    },
    stdout: (text) => out.push(text),
  });
  const listed = out[0].split("\n");
  const expected = Object.keys(COMMANDS).sort();
  assert.deepEqual(listed, expected);
});

test("usageText mentions every command, preventing help-text drift", async () => {
  const out = [];
  await runCli(["--help"], {
    env: {},
    fetch: async () => {
      throw new Error("help must not call API");
    },
    stdout: (text) => out.push(text),
  });
  for (const name of Object.keys(COMMANDS)) {
    assert.match(out[0], new RegExp(`\\b${name}\\b`), `usage text missing command: ${name}`);
  }
});

test("help <command> prints summary and usage for a known command", async () => {
  const out = [];
  await runCli(["help", "plan"], {
    env: {},
    fetch: async () => {
      throw new Error("help must not call API");
    },
    stdout: (text) => out.push(text),
  });
  assert.match(out[0], /^plan —/);
  assert.match(out[0], /Usage:/);
  assert.match(out[0], /clawlabor plan/);
});

test("help <command> rejects unknown command names", async () => {
  await assert.rejects(
    runCli(["help", "no-such-command"], {
      env: {},
      fetch: async () => {
        throw new Error("must not call API");
      },
      stdout: () => {},
    }),
    /Unknown command: no-such-command/,
  );
});

test("bin --help exits zero", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "clawlabor.js"), "--help"],
    {
      env: { ...process.env, CLAWLABOR_API_KEY: "" },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: clawlabor/);
});

test("installer supports Hermes target", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-hermes-home-"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "install.js"), "--hermes"],
    {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const target = path.join(tempHome, ".hermes", "skills", "clawlabor");
  assert.equal(fs.existsSync(path.join(target, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(target, "package.json")), true);
  assert.equal(fs.existsSync(path.join(target, "bin", "clawlabor.js")), true);
  assert.equal(fs.existsSync(path.join(target, "runtime", "cli.js")), true);

  const cli = spawnSync(process.execPath, [path.join(target, "bin", "clawlabor.js"), "--version"], {
    env: { ...process.env, CLAWLABOR_API_KEY: "" },
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^\d+\.\d+\.\d+/);
});

test("installer supports multiple explicit runtime targets", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-multi-home-"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "install.js"), "--claude", "--codex"],
    {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.existsSync(path.join(tempHome, ".claude", "skills", "clawlabor", "SKILL.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(tempHome, ".codex", "skills", "clawlabor", "SKILL.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(tempHome, ".openclaw", "skills", "clawlabor", "SKILL.md")),
    false,
  );
});

test("installer supports project-level Codex target", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-project-home-"));
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-project-"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "install.js"), "--project", "--codex"],
    {
      cwd: tempProject,
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.existsSync(path.join(tempProject, ".codex", "skills", "clawlabor", "SKILL.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(tempProject, ".claude", "skills", "clawlabor", "SKILL.md")),
    false,
  );
});

test("installer --project installs all project runtime targets by default", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-project-all-home-"));
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-project-all-"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "install.js"), "--project"],
    {
      cwd: tempProject,
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  for (const runtime of [".claude", ".openclaw", ".codex", ".hermes"]) {
    assert.equal(
      fs.existsSync(path.join(tempProject, runtime, "skills", "clawlabor", "SKILL.md")),
      true,
    );
  }
});

test("installer docs URL ignores API-base environment injection", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-local-docs-"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "install.js"), "--help"],
    {
      env: {
        ...process.env,
        HOME: tempHome,
        
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Docs:\n\s+https:\/\/www\.clawlabor\.com\/skill\.md/);
});

test("installer auto-detects Hermes when ~/.hermes exists", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-hermes-detect-"));
  fs.mkdirSync(path.join(tempHome, ".hermes"), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "install.js")],
    {
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.existsSync(path.join(tempHome, ".hermes", "skills", "clawlabor", "SKILL.md")),
    true,
  );
});

test("skill contract tells agents to discover marketplace capabilities before local workarounds", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");

  assert.match(skill, /Discovery-first trigger/);
  assert.match(skill, /marketplace is the source of truth/);
  assert.match(skill, /do not rely on this skill file to enumerate/);
  assert.match(skill, /clawlabor plan --goal "<requested deliverable>"/);
  // No `clawlabor plan` or `clawlabor solve` invocation in the doc should mention
  // --category or --max-completion-seconds. Both flags rely on unreliable SKU
  // metadata (mis-tagged categories, noisy avg_completion_seconds) and risk
  // filtering out the right listing. Lower-level `clawlabor match` may still use them.
  const invocationRegex = /clawlabor\s+(plan|solve)[^\n`]*/g;
  let m;
  while ((m = invocationRegex.exec(skill)) !== null) {
    const snippet = m[0];
    assert.ok(
      !/--category\b/.test(snippet),
      `plan/solve invocation must not surface --category: "${snippet}"`,
    );
    assert.ok(
      !/--max-completion-seconds\b/.test(snippet),
      `plan/solve invocation must not surface --max-completion-seconds: "${snippet}"`,
    );
  }
});

test("skill contract gives buyer guidance for insufficient credits", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");

  assert.match(skill, /insufficient_credits/);
  assert.match(skill, /Do not retry the same `buy` \/ `solve` \/ `post`/);
  assert.match(skill, /clawlabor status --self/);
  assert.match(skill, /lower `--max-price`/);
});

test("skill contract points agents to the message CLI without prescribing copy", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
  const workflow = fs.readFileSync(path.join(__dirname, "..", "WORKFLOW.md"), "utf8");

  assert.match(skill, /### Marketplace messages/);
  assert.match(skill, /clawlabor message --order <order_id>/);
  assert.match(skill, /clawlabor message --task <task_id>/);
  assert.doesNotMatch(skill, /Use these message templates/);
  assert.doesNotMatch(skill, /Clarify missing input before accepting/);
  assert.match(workflow, /clawlabor message --order <order_id> --content/);
  assert.match(workflow, /Raw fallback: `POST \/orders\/\{order_id\}\/messages`/);
});

// ---------------------------------------------------------------------------
// --input / --file parsing
// ---------------------------------------------------------------------------

test("parseInputFlags: @-prefix is a plain string value", () => {
  const { parseInputFlags } = require("../runtime/cli");
  const entries = parseInputFlags(["file_url=@/tmp/report.html", "format=png"]);
  assert.equal(entries.length, 2);
  const fileEntry = entries.find((e) => e.field === "file_url");
  assert.ok(!fileEntry.isFile);
  assert.equal(fileEntry.value, "@/tmp/report.html");
  const strEntry = entries.find((e) => e.field === "format");
  assert.ok(!strEntry.isFile);
  assert.equal(strEntry.value, "png");
});

test("parseFileFlags: field=path entry detected as file", () => {
  const { parseFileFlags } = require("../runtime/cli");
  const entries = parseFileFlags(["file_url=/tmp/report.html", "image_url=./photo.png"]);
  assert.deepEqual(entries, [
    { field: "file_url", isFile: true, localPath: "/tmp/report.html", source: "file" },
    { field: "image_url", isFile: true, localPath: "./photo.png", source: "file" },
  ]);
});

test("isUrlField: suffixes and schema uri only", () => {
  const { isUrlField } = require("../runtime/cli");
  assert.ok(isUrlField("image_url"));
  assert.ok(isUrlField("file_url"));
  assert.ok(isUrlField("source_pdf_url"));
  assert.ok(isUrlField("document_uri"));
  assert.ok(!isUrlField("file_path"));
  assert.ok(!isUrlField("image_data"));
  const schema = {
    properties: {
      file_path: { type: "string" },
      image_data: { type: "string" },
    },
  };
  assert.ok(!isUrlField("file_path", schema));
  assert.ok(!isUrlField("image_data", schema));
  assert.ok(!isUrlField("caption"));
  assert.ok(!isUrlField("format"));
});

test("isUrlField: schema uri format override", () => {
  const { isUrlField } = require("../runtime/cli");
  const schema = { properties: { caption: { type: "string", format: "uri" } } };
  assert.ok(isUrlField("caption", schema));
});

test("stageAndUploadFile: calls stage, PUT, confirm, returns signed URL", async () => {
  const { stageAndUploadFile } = require("../runtime/cli");
  const nodePath = require("node:path");
  const nodeFs = require("node:fs");

  const tmpFile = tempTestFile("test-staged.txt");
  nodeFs.writeFileSync(tmpFile, "hello world");

  const fetchCalls = [];
  const fakeFetch = async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method || "GET" });
    if (url.endsWith("/attachments/stage")) {
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          staged_attachment_id: "sta_test",
          upload_url: "https://s3.example.com/put",
          upload_url_expires_at: new Date().toISOString(),
          expires_at: new Date().toISOString(),
        }),
      };
    }
    if (url.endsWith("/confirm")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          staged_attachment_id: "sta_test",
          status: "uploaded",
          signed_download_url: "https://s3.example.com/get?sig=abc",
        }),
      };
    }
    // S3 PUT
    return { ok: true, status: 200, text: async () => "" };
  };

  const deps = {
    env: { CLAWLABOR_API_KEY: "test-key" },
    fetch: fakeFetch,
  };

  const result = await stageAndUploadFile(deps, { field: "file_url", localPath: tmpFile, isFile: true });

  assert.equal(result.stagedId, "sta_test");
  assert.equal(result.signedUrl, "https://s3.example.com/get?sig=abc");
  assert.equal(result.field, "file_url");

  const stageCalls = fetchCalls.filter((c) => c.url.endsWith("/attachments/stage"));
  assert.equal(stageCalls.length, 1);
  const s3PutCalls = fetchCalls.filter((c) => c.url.includes("s3.example.com") && c.method === "PUT");
  assert.equal(s3PutCalls.length, 1);
  const confirmCalls = fetchCalls.filter((c) => c.url.endsWith("/confirm"));
  assert.equal(confirmCalls.length, 1);

  const stageIdx = fetchCalls.findIndex((c) => c.url.endsWith("/attachments/stage"));
  const putIdx = fetchCalls.findIndex((c) => c.url.includes("s3.example.com") && c.method === "PUT");
  const confirmIdx = fetchCalls.findIndex((c) => c.url.endsWith("/confirm"));
  assert.ok(stageIdx < putIdx, "stage must precede PUT");
  assert.ok(putIdx < confirmIdx, "PUT must precede confirm");

  nodeFs.unlinkSync(tmpFile);
});

test("stageAndUploadFile: blocks JavaScript files before upload", async () => {
  const { stageAndUploadFile } = require("../runtime/cli");
  const nodePath = require("node:path");
  const nodeFs = require("node:fs");

  const tmpFile = tempTestFile("test-staged.js");
  nodeFs.writeFileSync(tmpFile, "console.log('nope');");

  await assert.rejects(
    () => stageAndUploadFile(
      {
        env: { CLAWLABOR_API_KEY: "test-key" },
        fetch: async () => {
          throw new Error("fetch should not be called");
        },
      },
      { field: "file_url", localPath: tmpFile, isFile: true },
    ),
    /Blocked file extension: \.js/,
  );

  nodeFs.unlinkSync(tmpFile);
});

test("solve with --file stages and injects URL into requirement", async () => {
  const { runCli } = require("../runtime/cli");
  const nodeFs = require("node:fs");

  const tmpFile = tempTestFile("test-file-input.png");
  nodeFs.writeFileSync(tmpFile, Buffer.alloc(16, 0xff));

  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || "GET", body: opts?.body });
    if (url.endsWith("/listings/match"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        matches: [{ id: "sku_1", price: 10, policy: { allowed: true },
          input_schema: { properties: { image_url: { type: "string", format: "uri" }, format: { type: "string" } }, required: ["image_url"] } }]
      })};
    if (url.endsWith("/attachments/stage"))
      return { ok: true, status: 201, text: async () => JSON.stringify({
        staged_attachment_id: "sta_file_1", upload_url: "https://s3.test/put-file",
        upload_url_expires_at: new Date().toISOString(), expires_at: new Date().toISOString()
      })};
    if (url.includes("s3.test/put-file"))
      return { ok: true, status: 200, text: async () => "" };
    if (url.endsWith("/confirm"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        staged_attachment_id: "sta_file_1", status: "uploaded",
        signed_download_url: "https://s3.test/get-file?sig=abc"
      })};
    if (url.endsWith("/purchase")) {
      const body = JSON.parse(opts.body);
      assert.equal(body.requirement.image_url, "https://s3.test/get-file?sig=abc");
      assert.equal(body.requirement.format, "png");
      assert.deepEqual(body.staged_attachment_ids, ["sta_file_1"]);
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: "ord_file_1" }) };
    }
    if (url.includes("/orders/ord_file_1/validate-delivery"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ verdict: "pass", can_auto_confirm: true }) };
    if (url.includes("/orders/ord_file_1/confirm"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "ord_file_1", status: "completed" }) };
    if (url.includes("/orders/ord_file_1/attachments"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ files: [], file_count: 0, total_size: 0 }) };
    if (url.includes("/orders/ord_file_1"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "ord_file_1", status: "completed", delivery_note: null }) };
    return { ok: false, status: 404, text: async () => "not found" };
  };

  await runCli(
    ["solve", "--goal", "convert to png", "--file", `image_url=${tmpFile}`, "--input", "format=png", "--auto-confirm"],
    { env: { CLAWLABOR_API_KEY: "k" }, fetch: fakeFetch, stdout: () => {} },
  );

  const matchIdx = calls.findIndex((c) => c.url.endsWith("/listings/match"));
  const stageIdx = calls.findIndex((c) => c.url.endsWith("/attachments/stage"));
  assert.ok(matchIdx < stageIdx, "match must precede staging");

  nodeFs.unlinkSync(tmpFile);
});

test("solve rejects legacy file field when selected listing has non-uri schema field", async () => {
  const { runCli } = require("../runtime/cli");
  const nodeFs = require("node:fs");

  const tmpFile = tempTestFile("test-file-path-input.png");
  nodeFs.writeFileSync(tmpFile, Buffer.alloc(16, 0xff));

  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || "GET", body: opts?.body });
    if (url.endsWith("/listings/match"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        matches: [{ id: "sku_1", price: 10, policy: { allowed: true },
          input_schema: { properties: { file_path: { type: "string" } }, required: ["file_path"] } }]
      })};
    return { ok: false, status: 404, text: async () => "not found" };
  };

  await assert.rejects(
    () => runCli(
      ["solve", "--goal", "convert to png", "--file", `file_path=${tmpFile}`],
      { env: { CLAWLABOR_API_KEY: "k" }, fetch: fakeFetch, stdout: () => {} },
    ),
    /Field "file_path" does not look like a URL field/,
  );

  assert.equal(calls.filter((c) => c.url.endsWith("/attachments/stage")).length, 0);
  nodeFs.unlinkSync(tmpFile);
});

test("buy with --file stages and injects URL into purchase", async () => {
  const { runCli } = require("../runtime/cli");
  const nodeFs = require("node:fs");

  const tmpFile = tempTestFile("test-buy-file-input.png");
  nodeFs.writeFileSync(tmpFile, Buffer.alloc(8, 0xaa));

  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || "GET", body: opts?.body });
    if (url.endsWith("/attachments/stage"))
      return { ok: true, status: 201, text: async () => JSON.stringify({
        staged_attachment_id: "sta_buy_file_1", upload_url: "https://s3.test/put-buy-file",
        upload_url_expires_at: new Date().toISOString(), expires_at: new Date().toISOString()
      })};
    if (url.includes("s3.test/put-buy-file"))
      return { ok: true, status: 200, text: async () => "" };
    if (url.endsWith("/confirm"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        staged_attachment_id: "sta_buy_file_1", status: "uploaded",
        signed_download_url: "https://s3.test/get-buy-file?sig=xyz"
      })};
    if (url.endsWith("/purchase")) {
      const body = JSON.parse(opts.body);
      assert.equal(body.requirement.image_url, "https://s3.test/get-buy-file?sig=xyz");
      assert.equal(body.requirement.format, "png");
      assert.deepEqual(body.staged_attachment_ids, ["sta_buy_file_1"]);
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: "ord_buy_file_1" }) };
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };

  await runCli(
    ["buy", "--listing", "sku_buy_1", "--file", `image_url=${tmpFile}`, "--input", "format=png"],
    { env: { CLAWLABOR_API_KEY: "k" }, fetch: fakeFetch, stdout: () => {} },
  );

  assert.ok(calls.find((c) => c.url.endsWith("/purchase")), "purchase was called");

  nodeFs.unlinkSync(tmpFile);
});

test("solve with --auto-confirm fires confirm and reports auto_confirm.fired=true", async () => {
  const { runCli } = require("../runtime/cli");

  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || "GET" });
    if (url.endsWith("/listings/match"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        matches: [{ id: "sku_1", price: 10, policy: { allowed: true },
          input_schema: { properties: { input: { type: "string" } }, required: ["input"] } }]
      })};
    if (url.endsWith("/purchase"))
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: "ord_1" }) };
    if (url.includes("/orders/ord_1/validate-delivery"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        verdict: "valid", overall_score: 0.95, can_auto_confirm: true,
        auto_confirm_policy: { min_score: 0.8, required_verdict: "valid" },
        auto_confirm_skip_reason: null,
      })};
    if (url.includes("/orders/ord_1/confirm"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "ord_1", status: "completed" }) };
    if (url.includes("/orders/ord_1/attachments"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ files: [], file_count: 0, total_size: 0 }) };
    if (url.includes("/orders/ord_1"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "ord_1", status: "pending_confirmation", delivery_note: null }) };
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const out = [];
  await runCli(
    ["solve", "--goal", "do thing", "--requirement-json", '{"input":"x"}', "--auto-confirm"],
    { env: { CLAWLABOR_API_KEY: "k" }, fetch: fakeFetch, stdout: (t) => out.push(t) },
  );

  const result = JSON.parse(out.join(""));
  assert.equal(result.auto_confirmed, true);
  assert.ok(result.auto_confirm, "auto_confirm block present");
  assert.equal(result.auto_confirm.requested, true);
  assert.equal(result.auto_confirm.fired, true);
  assert.equal(result.auto_confirm.skip_reason, null);
  assert.deepEqual(result.auto_confirm.policy, { min_score: 0.8, required_verdict: "valid" });
});

test("solve with --auto-confirm but low score reports skip_reason and next_action", async () => {
  const { runCli } = require("../runtime/cli");

  const fakeFetch = async (url, opts) => {
    if (url.endsWith("/listings/match"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        matches: [{ id: "sku_1", price: 10, policy: { allowed: true },
          input_schema: { properties: { input: { type: "string" } }, required: ["input"] } }]
      })};
    if (url.endsWith("/purchase"))
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: "ord_2" }) };
    if (url.includes("/orders/ord_2/validate-delivery"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        verdict: "partial", overall_score: 0.5, can_auto_confirm: false,
        auto_confirm_policy: { min_score: 0.8, required_verdict: "valid" },
        auto_confirm_skip_reason: "overall_score 0.50 below required 0.80",
      })};
    if (url.includes("/orders/ord_2/attachments"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ files: [], file_count: 0, total_size: 0 }) };
    if (url.includes("/orders/ord_2"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "ord_2", status: "pending_confirmation", delivery_note: null }) };
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const out = [];
  await runCli(
    ["solve", "--goal", "do thing", "--requirement-json", '{"input":"x"}', "--auto-confirm"],
    { env: { CLAWLABOR_API_KEY: "k" }, fetch: fakeFetch, stdout: (t) => out.push(t) },
  );

  const result = JSON.parse(out.join(""));
  assert.equal(result.auto_confirmed, false);
  assert.equal(result.action, "delivered");
  assert.equal(result.auto_confirm.requested, true);
  assert.equal(result.auto_confirm.fired, false);
  assert.equal(result.auto_confirm.skip_reason, "overall_score 0.50 below required 0.80");
  assert.equal(result.next_action.type, "review_delivery");
  assert.equal(result.next_action.command, "clawlabor confirm --order ord_2");
  assert.equal(result.retry_policy.initial_solve_repeat_safe, false);
  assert.equal(result.retry_policy.resume_command, "clawlabor solve --resume-order ord_2");
  assert.ok(
    result.auto_confirm.next_action.includes("clawlabor confirm --order ord_2"),
    `next_action should reference manual confirm: ${result.auto_confirm.next_action}`,
  );
});

test("solve without --auto-confirm reports auto_confirm.requested=false", async () => {
  const { runCli } = require("../runtime/cli");

  const fakeFetch = async (url, opts) => {
    if (url.endsWith("/listings/match"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        matches: [{ id: "sku_1", price: 10, policy: { allowed: true },
          input_schema: { properties: { input: { type: "string" } }, required: ["input"] } }]
      })};
    if (url.endsWith("/purchase"))
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: "ord_3" }) };
    if (url.includes("/orders/ord_3/validate-delivery"))
      return { ok: true, status: 200, text: async () => JSON.stringify({
        verdict: "valid", overall_score: 0.95, can_auto_confirm: true,
        auto_confirm_policy: { min_score: 0.8, required_verdict: "valid" },
        auto_confirm_skip_reason: null,
      })};
    if (url.includes("/orders/ord_3/attachments"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ files: [], file_count: 0, total_size: 0 }) };
    if (url.includes("/orders/ord_3"))
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "ord_3", status: "pending_confirmation", delivery_note: null }) };
    return { ok: false, status: 404, text: async () => "not found" };
  };

  const out = [];
  await runCli(
    ["solve", "--goal", "do thing", "--requirement-json", '{"input":"x"}'],
    { env: { CLAWLABOR_API_KEY: "k" }, fetch: fakeFetch, stdout: (t) => out.push(t) },
  );

  const result = JSON.parse(out.join(""));
  assert.equal(result.auto_confirmed, false);
  assert.equal(result.auto_confirm.requested, false);
  assert.equal(result.auto_confirm.fired, false);
  assert.equal(result.auto_confirm.skip_reason, null);
  assert.equal(result.next_action.type, "review_delivery");
  assert.equal(result.next_action.command, "clawlabor confirm --order ord_3");
  assert.equal(result.retry_policy.initial_solve_repeat_safe, false);
  assert.equal(result.retry_policy.resume_command, "clawlabor solve --resume-order ord_3");
});

test("orders --as seller --status pending_accept sends correct query and compacts response", async () => {
  const { commandOrders } = require("../runtime/commands/command-orders");

  const requestedUrls = [];
  const fakeFetch = async (url) => {
    requestedUrls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          orders: [
            {
              id: "ord_1",
              status: "pending_accept",
              role: "seller",
              listing_title: "URL Ingestion",
              price: 3,
              buyer: { id: "ag_buy", name: "BuyerBot" },
              created_at: "2026-05-20T10:00:00Z",
              updated_at: "2026-05-20T10:00:30Z",
              extra_field: "should_be_dropped_when_compact",
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
        }),
    };
  };
  const deps = {
    env: { CLAWLABOR_API_KEY: "test-key" },
    fetch: fakeFetch,
  };

  const out = await commandOrders(
    { as: "seller", status: "pending_accept", limit: 5 },
    deps,
  );
  const parsed = JSON.parse(out);

  assert.equal(requestedUrls.length, 1);
  assert.ok(requestedUrls[0].includes("/orders?"));
  assert.ok(requestedUrls[0].includes("role=seller"));
  assert.ok(requestedUrls[0].includes("status=pending_accept"));
  assert.ok(requestedUrls[0].includes("limit=5"));
  assert.equal(parsed.count, 1);
  assert.equal(parsed.filter.as, "seller");
  assert.equal(parsed.orders[0].id, "ord_1");
  assert.equal(parsed.orders[0].counterparty.name, "BuyerBot");
  assert.equal(parsed.orders[0].extra_field, undefined, "compact form drops extras");
});

test("orders --raw returns full payload without compacting", async () => {
  const { commandOrders } = require("../runtime/commands/command-orders");
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        orders: [{ id: "ord_2", extra: "kept" }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      }),
  });
  const deps = {
    env: { CLAWLABOR_API_KEY: "k" },
    fetch: fakeFetch,
  };
  const parsed = JSON.parse(await commandOrders({ raw: true }, deps));
  assert.equal(parsed.orders[0].extra, "kept");
});

test("orders --since filters by updated_at cutoff", async () => {
  const { commandOrders } = require("../runtime/commands/command-orders");
  const now = Date.now();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        orders: [
          { id: "fresh", updated_at: new Date(now - 60 * 1000).toISOString() },
          { id: "stale", updated_at: new Date(now - 7200 * 1000).toISOString() },
        ],
        pagination: {},
      }),
  });
  const deps = {
    env: { CLAWLABOR_API_KEY: "k" },
    fetch: fakeFetch,
  };
  const parsed = JSON.parse(await commandOrders({ since: "30m" }, deps));
  assert.equal(parsed.count, 1);
  assert.equal(parsed.orders[0].id, "fresh");
});

test("orders rejects invalid --as value", async () => {
  const { commandOrders } = require("../runtime/commands/command-orders");
  const deps = { env: {}, fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) };
  await assert.rejects(
    () => commandOrders({ as: "bogus" }, deps),
    /Unknown --as value/,
  );
});

test("serve adapter dispatch: hermes builds chat args with skill and max-turns", () => {
  const { _internals } = require("../runtime/commands/runtime");
  const args = _internals.ADAPTERS.hermes.buildArgs("ORDER-PROMPT", {
    "max-turns": 30,
    model: "minimax/minimax-m2.7",
    env: {},
  });
  assert.equal(args[0], "chat");
  assert.equal(args[1], "-q");
  assert.equal(args[2], "ORDER-PROMPT");
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("clawlabor"));
  assert.ok(args.includes("30"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("minimax/minimax-m2.7"));
});

test("serve adapter dispatch: claude builds -p with permission bypass by default", () => {
  const { _internals } = require("../runtime/commands/runtime");
  const args = _internals.ADAPTERS.claude.buildArgs("ORDER-PROMPT", { env: {} });
  assert.equal(args[0], "-p");
  assert.equal(args[1], "ORDER-PROMPT");
  assert.ok(
    args.includes("--dangerously-skip-permissions"),
    "claude adapter must bypass permissions for unattended serve",
  );
});

test("serve adapter dispatch: claude respects CLAWLABOR_SERVE_NO_BYPASS=1", () => {
  const { _internals } = require("../runtime/commands/runtime");
  const args = _internals.ADAPTERS.claude.buildArgs("ORDER-PROMPT", {
    env: { CLAWLABOR_SERVE_NO_BYPASS: "1" },
  });
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("serve adapter dispatch: codex uses exec subcommand", () => {
  const { _internals } = require("../runtime/commands/runtime");
  const args = _internals.ADAPTERS.codex.buildArgs("ORDER-PROMPT", {
    model: "gpt-5",
    sandbox: "workspace-write",
    env: {},
  });
  assert.equal(args[0], "exec");
  assert.equal(args[1], "ORDER-PROMPT");
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("gpt-5"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("workspace-write"));
});

test("serve adapter dispatch: resolveAdapterCommand honors --adapter-command override", () => {
  const { _internals } = require("../runtime/commands/runtime");
  assert.equal(_internals.resolveAdapterCommand("hermes", {}), "hermes");
  assert.equal(_internals.resolveAdapterCommand("claude", {}), "claude");
  assert.equal(_internals.resolveAdapterCommand("codex", {}), "codex");
  assert.equal(
    _internals.resolveAdapterCommand("hermes", { "adapter-command": "/custom/hermes" }),
    "/custom/hermes",
  );
  // back-compat: legacy --hermes-command still works
  assert.equal(
    _internals.resolveAdapterCommand("hermes", { "hermes-command": "/legacy/hermes" }),
    "/legacy/hermes",
  );
});

test("serve rejects unknown adapter with a list of supported ones", async () => {
  const { serveOnce } = require("../runtime/commands/runtime");
  const deps = { env: {}, fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) };
  await assert.rejects(
    () => serveOnce({ adapter: "bogus" }, deps),
    /adapter "bogus" is not supported.*hermes.*claude.*codex/,
  );
});

test("serve seller prompt embeds session id and order json", () => {
  const { _internals } = require("../runtime/commands/runtime");
  const prompt = _internals.buildSellerPrompt("session-XYZ", { id: "ord_1", status: "in_progress" });
  assert.ok(prompt.includes("session-XYZ"));
  assert.ok(prompt.includes('"id": "ord_1"'));
  assert.ok(prompt.includes("Do not invent requirements"));
});

test("status --self returns agent profile, balance, online state, and session counts", async () => {
  const { commandStatus } = require("../runtime/commands/command-status");

  const fakeFetch = async (url) => {
    assert.ok(url.endsWith("/agents/me"), `unexpected URL ${url}`);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "uuid-1",
          agent_id: "agent_abc",
          name: "TestAgent",
          owner_email: "test@example.com",
          balance: "123.45",
          frozen: "10.00",
          is_online: true,
          webhook_url: "https://example.com/hook",
          tasks_completed: 7,
          tasks_confirmed: 6,
          response_success_count: 5,
          response_timeout_count: 1,
          last_heartbeat_at: "2026-05-20T12:00:00Z",
        }),
    };
  };
  const deps = {
    env: { CLAWLABOR_API_KEY: "k" },
    fetch: fakeFetch,
  };
  const flags = new Set(["self"]);
  const out = await commandStatus({}, deps, flags);
  const parsed = JSON.parse(out);

  assert.equal(parsed.agent.name, "TestAgent");
  assert.equal(parsed.agent.agent_id, "agent_abc");
  assert.equal(parsed.balance, "123.45");
  assert.equal(parsed.is_online, true);
  assert.equal(parsed.webhook_url, "https://example.com/hook");
  assert.equal(parsed.tasks_completed, 7);
  // sessions may be null when no local session root exists; presence of the field is enough
  assert.ok("sessions" in parsed);
});

test("status --self rejects combining with --order or --task", async () => {
  const { commandStatus } = require("../runtime/commands/command-status");
  const deps = { env: {}, fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) };
  await assert.rejects(
    () => commandStatus({ order: "abc" }, deps, new Set(["self"])),
    /--self alone/,
  );
  await assert.rejects(
    () => commandStatus({ task: "xyz" }, deps, new Set(["self"])),
    /--self alone/,
  );
});

test("status without --self still requires --order or --task", async () => {
  const { commandStatus } = require("../runtime/commands/command-status");
  const deps = { env: {}, fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) };
  await assert.rejects(
    () => commandStatus({}, deps, new Set()),
    /Missing required --order or --task/,
  );
});

// ---------------------------------------------------------------------------
// ensureUploadPathAllowed: blocks sensitive paths regardless of agent intent
// ---------------------------------------------------------------------------

function withSandboxHome(name, fn) {
  test(name, async (t) => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-home-"));
    const originalHome = os.homedir();
    const originalHOME = process.env.HOME;
    const originalUSERPROFILE = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // os.homedir() caches via process.env.HOME on POSIX; verify before running
    if (os.homedir() !== tmpHome) {
      process.env.HOME = originalHOME;
      process.env.USERPROFILE = originalUSERPROFILE;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      t.skip(`os.homedir() did not pick up HOME override (got ${os.homedir()}, expected ${tmpHome})`);
      return;
    }
    try {
      await fn({ tmpHome });
    } finally {
      process.env.HOME = originalHOME;
      process.env.USERPROFILE = originalUSERPROFILE;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      assert.equal(os.homedir(), originalHome);
    }
  });
}

withSandboxHome("ensureUploadPathAllowed: normal path passes", async ({ tmpHome: _tmpHome }) => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  const tmpFile = tempTestFile("upload-ok.json");
  fs.writeFileSync(tmpFile, "{}");
  const out = ensureUploadPathAllowed(tmpFile, {});
  assert.equal(out, fs.realpathSync(tmpFile));
  fs.unlinkSync(tmpFile);
});

withSandboxHome("ensureUploadPathAllowed: missing path errors clearly", async () => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  assert.throws(
    () => ensureUploadPathAllowed("", {}),
    /Upload path is required/,
  );
});

withSandboxHome("ensureUploadPathAllowed: blocks files under ~/.ssh", async ({ tmpHome }) => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  const sshDir = path.join(tmpHome, ".ssh");
  fs.mkdirSync(sshDir);
  const keyFile = path.join(sshDir, "id_rsa");
  fs.writeFileSync(keyFile, "PRIVATE KEY");
  assert.throws(
    () => ensureUploadPathAllowed(keyFile, {}),
    /Refusing to upload/,
  );
});

withSandboxHome("ensureUploadPathAllowed: blocks ~/.config/clawlabor/credentials.json", async ({ tmpHome }) => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  const credDir = path.join(tmpHome, ".config", "clawlabor");
  fs.mkdirSync(credDir, { recursive: true });
  const credFile = path.join(credDir, "credentials.json");
  fs.writeFileSync(credFile, "{}");
  assert.throws(
    () => ensureUploadPathAllowed(credFile, {}),
    /Refusing to upload/,
  );
});

withSandboxHome("ensureUploadPathAllowed: blocks .env files by basename pattern", async () => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  const envFile = tempTestFile(".env");
  fs.writeFileSync(envFile, "SECRET=1");
  assert.throws(
    () => ensureUploadPathAllowed(envFile, {}),
    /matches \/\^\\\.env/,
  );
  fs.unlinkSync(envFile);
});

withSandboxHome("ensureUploadPathAllowed: blocks *.pem files anywhere", async () => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  const pemFile = tempTestFile("server.pem");
  fs.writeFileSync(pemFile, "-----BEGIN-----");
  assert.throws(
    () => ensureUploadPathAllowed(pemFile, {}),
    /Refusing to upload/,
  );
  fs.unlinkSync(pemFile);
});

withSandboxHome("ensureUploadPathAllowed: blocks symlinked decoys pointing to sensitive files", async ({ tmpHome }) => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  const awsDir = path.join(tmpHome, ".aws");
  fs.mkdirSync(awsDir);
  const credFile = path.join(awsDir, "credentials");
  fs.writeFileSync(credFile, "[default]");
  const decoy = tempTestFile("innocent-data.txt");
  fs.symlinkSync(credFile, decoy);
  assert.throws(
    () => ensureUploadPathAllowed(decoy, {}),
    /Refusing to upload/,
  );
  fs.unlinkSync(decoy);
});

withSandboxHome("ensureUploadPathAllowed: CLAWLABOR_UPLOAD_BLOCKLIST extends the blocklist", async () => {
  const { ensureUploadPathAllowed } = require("../runtime/cli");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-extra-"));
  const inside = path.join(tmpDir, "anything.txt");
  fs.writeFileSync(inside, "data");
  assert.throws(
    () => ensureUploadPathAllowed(inside, { CLAWLABOR_UPLOAD_BLOCKLIST: tmpDir }),
    /CLAWLABOR_UPLOAD_BLOCKLIST/,
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Labor mode: hire / labor-chat / labor-serve
// ---------------------------------------------------------------------------

test("hire posts a one-day labor hire and reports the frozen escrow", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/hire", {
      status: 201,
      body: JSON.stringify({
        id: "hire-1", status: "pending_accept", labor_resource_id: "labor-9",
        duration_days: 1, frozen_nano: 240000000000,
      }),
    }),
  ]);
  const out = [];
  await runCli(
    ["hire", "--listing", "labor-9", "--message", "hello"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  assert.equal(calls[0].url, "https://www.clawlabor.com/api/labor/hire");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.labor_resource_id, "labor-9");
  assert.equal(body.duration_days, 1); // one day, fixed
  assert.equal(body.message, "hello");
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.hire_id, "hire-1");
  assert.equal(parsed.duration_days, 1);
  assert.equal(parsed.status, "pending_accept");
});

test("labor-chat streams the SSE reply as plain text", async () => {
  const sse =
    'event: chunk\ndata: {"text": "Boil "}\n\n' +
    'event: chunk\ndata: {"text": "the egg 7 min."}\n\n' +
    'event: done\ndata: {"session_id": "s1"}\n\n';
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/hire-1/messages/stream", { status: 200, body: sse }),
  ]);
  const out = [];
  await runCli(
    ["labor-chat", "--hire", "hire-1", "--message", "how long to boil an egg?"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  assert.equal(JSON.parse(calls[0].options.body).content, "how long to boil an egg?");
  assert.equal(out.join(""), "Boil the egg 7 min.");
});

test("labor-chat surfaces an SSE error event", async () => {
  const sse = 'event: error\ndata: {"code": "seller_unreachable", "detail": "down"}\n\n';
  const { fetch } = recordingFetch([
    matchRoute("POST", "/labor/hire-1/messages/stream", { status: 200, body: sse }),
  ]);
  const out = [];
  await runCli(
    ["labor-chat", "--hire", "hire-1", "--message", "hi"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.error.code, "seller_unreachable");
});

function laborAgentsFetch() {
  return recordingFetch([
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({
        id: "seller-1",
        agent_id: "agent_seller",
        name: "Seller",
        owner_email: "seller@example.com",
        balance: "500.00",
        frozen: "10.00",
        is_online: true,
      }),
    }),
    matchRoute("GET", "/labor/list?limit=100", {
      status: 200,
      body: JSON.stringify({
        items: [{
          id: "labor-claude",
          seller_agent_id: "seller-1",
          name: "Claude Labor",
          status: "available",
          runtime: "claude",
          host_account_provider: "claude",
          host_account_id: "org:org-123",
        }],
        next_cursor: null,
      }),
    }),
  ]);
}

function laborAgentsDeps(fetch, out) {
  return {
    env: BASE_ENV,
    fetch,
    // Default: no local opencode auth (deterministic — tests that want opencode
    // serveable override fs with existsSync -> true).
    fs: { existsSync: () => false },
    stdout: (t) => out.push(t),
    readClaudeOauthToken: () => "oauth-token-123",
    runClaudeAuthStatus: async () => ({
      ok: true,
      account: {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "seller@example.com",
        orgId: "org-123",
        orgName: "Seller Team",
        subscriptionType: "team",
      },
    }),
    spawnSync: (cmd, args) => {
      const tool = cmd === "sh" ? args[3] : cmd;
      const status = ["claude", "codex", "opencode", "docker", "cloudflared"].includes(tool) ? 0 : 1;
      return {
        status,
        stdout: cmd === "sh" ? `/usr/bin/${tool}\n` : `${tool} version ok`,
        stderr: "",
      };
    },
  };
}

test("labor-agents reports concise local runtime inventory by default", async () => {
  const { fetch } = laborAgentsFetch();
  const out = [];
  await runCli(["labor-agents"], laborAgentsDeps(fetch, out));

  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.action, "labor-agents");
  assert.deepEqual(parsed.account, {
    status: "authenticated",
    name: "Seller",
    balance: "500.00",
    frozen: "10.00",
    online: true,
  });
  assert.deepEqual(parsed.host.claude, {
    provider: "claude",
    label: "Seller Team (team)",
    plan: "team",
  });
  assert.deepEqual(parsed.agents.map((agent) => agent.runtime), ["claude", "codex", "opencode"]);
  const claude = parsed.agents[0];
  assert.equal(claude.status, "ready_to_serve");
  assert.equal(claude.can_publish, true);
  assert.equal(claude.can_serve, true);
  assert.match(claude.publish_command, /labor-publish/);
  assert.equal(claude.publish_command.includes("<"), false);
  assert.equal(claude.publish_command.includes("--gatekeeper"), false);
  assert.equal(claude.labor_id, "labor-claude");
  // start_command converges publish+serve into one command (serve_command removed).
  assert.equal(claude.serve_command, undefined);
  assert.equal(claude.start_command, "clawlabor labor-start --runtime claude");
  assert.equal(claude.path, undefined);
  assert.equal(claude.requirements, undefined);
  const codex = parsed.agents[1];
  assert.equal(codex.status, "publish_only");
  assert.equal(codex.can_publish, true);
  assert.equal(codex.can_serve, false);
});

test("labor-agents shows auth failure instead of null account fields", async () => {
  const out = [];
  await runCli(
    ["labor-agents"],
    laborAgentsDeps(
      async (url) => {
        if (url.endsWith("/agents/me")) {
          return {
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ detail: "Invalid or expired token" }),
          };
        }
        if (url.endsWith("/labor/list?limit=100")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ items: [], next_cursor: null }),
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      out,
    ),
  );
  const parsed = JSON.parse(out.join(""));
  assert.deepEqual(parsed.account, {
    status: "unavailable",
    api_base: DEFAULT_API_BASE,
    reason: "unauthenticated",
    next: "Run clawlabor auth status.",
  });
  assert.equal(parsed.account.name, undefined);
  assert.equal(parsed.account.balance, undefined);
});

test("labor-agents gives a complete publish command before a labor exists", async () => {
  const out = [];
  await runCli(
    ["labor-agents"],
    laborAgentsDeps(
      async (url) => {
        if (url.endsWith("/agents/me")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              id: "seller-1",
              agent_id: "agent_seller",
              name: "Seller",
              balance: 500,
              frozen: 0,
            }),
          };
        }
        if (url.endsWith("/labor/list?limit=100")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ items: [], next_cursor: null }),
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      out,
    ),
  );
  const parsed = JSON.parse(out.join(""));
  const claude = parsed.agents[0];
  assert.match(claude.publish_command, /--name 'Claude Code Labor'/);
  assert.match(claude.publish_command, /--daily-rate 1/);
  assert.equal(claude.publish_command.includes("<"), false);
  assert.equal(claude.publish_command.includes("--gatekeeper"), false);
  assert.equal(claude.serve_command, undefined);
  assert.equal(claude.start_command, "clawlabor labor-start --runtime claude");
  assert.equal(claude.start_command.includes("<"), false);
});

test("labor-agents --verbose keeps diagnostic detail", async () => {
  const { fetch } = recordingFetch([
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({
        id: "seller-1",
        agent_id: "agent_seller",
        name: "Seller",
        owner_email: "seller@example.com",
        balance: "500.00",
        frozen: "10.00",
        is_online: true,
      }),
    }),
  ]);
  const out = [];
  await runCli(
    ["labor-agents", "--verbose"],
    laborAgentsDeps(fetch, out),
  );
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.action, "labor-agents");
  assert.deepEqual(parsed.agents.map((agent) => agent.id), [
    "claude-code-sandbox",
    "codex-sandbox",
    "opencode-sandbox",
  ]);
  const claude = parsed.agents[0];
  assert.equal(claude.ready_to_publish, true);
  assert.equal(claude.ready_to_serve, true);
  assert.equal(claude.host_account.id, "org:org-123");
  assert.equal(claude.host_account.plan, "team");
  assert.match(claude.publish_command_template, /labor-publish/);
  assert.equal(parsed.marketplace_agent.agent_id, "agent_seller");
  // marketplace_agent is the raw /agents/me payload (balance is a UAT string).
  assert.equal(parsed.marketplace_agent.balance, "500.00");
  const codex = parsed.agents[1];
  assert.equal(codex.present_on_path, true);
  assert.equal(codex.ready_to_publish, true);
  assert.equal(codex.ready_to_serve, false);
  assert.equal(codex.serve_status, "candidate_not_wired_to_labor_serve");
  const opencode = parsed.agents[2];
  assert.equal(opencode.ready_to_publish, true);
  assert.equal(opencode.ready_to_serve, false);
  assert.equal(opencode.serve_status, "needs_opencode_auth");
});

test("labor-serve provisions a tunnel, spawns runtime + cloudflared, heartbeats, and tears down", async () => {
  const spawned = [];
  const { stop, route: stopAfterHireTeardown } = laborServeStopAfterHireTeardown();
  let hirePolls = 0;
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/labor-9/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-9/hires"),
      respond: () => {
        hirePolls += 1;
        return {
          status: 200,
          body: hirePolls === 1
            ? '{"items":[{"id":"hire-1","status":"active"}]}'
            : '{"items":[]}',
        };
      },
    },
    matchRoute("POST", "/labor/hires/hire-1/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-1", tunnel_token: "TT", sandbox_token: "SBX", hostname: "hire-1.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-1/heartbeat", { status: 204, body: "" }),
    stopAfterHireTeardown,
    matchRoute("DELETE", "/labor/labor-9/serve", { status: 204, body: "" }),
  ]);
  const out = [];
  await runCli(
    ["labor-serve", "--labor", "labor-9"],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      readClaudeOauthToken: () => "oauth-token-123",
      spawn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts });
        return { kill() {} };
      },
      sleep: async () => {},
      waitForExit: () => stop.promise,
    },
  );

  // provisioned, started docker + cloudflared, heartbeat at least once, torn down
  assert.ok(calls.some((c) => c.url.endsWith("/labor/labor-9/serve") && c.options.method === "POST"));
  assert.equal(spawned[0].cmd, "docker");
  assert.match(spawned[0].args.join(" "), /--token 'SBX'/); // sandbox_token passed to server
  assert.ok(spawned[0].args.includes("--name"));
  assert.ok(spawned[0].args.includes("clawlabor-hire-hire-1"));
  assert.ok(spawned[0].args.includes("CLAWLABOR_AGENT_RUNTIME"));
  assert.ok(spawned[0].args.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  assert.equal(spawned[0].opts.env.CLAWLABOR_AGENT_RUNTIME, "claude");
  assert.ok(spawned[0].args.includes("--entrypoint"));
  assert.ok(spawned[0].args.includes("sh"));
  assert.match(spawned[0].args.join(" "), /sandbox-clawlabor install-agent 'claude'/);
  assert.match(spawned[0].args.join(" "), /sandbox-clawlabor server --token 'SBX'/);
  assert.ok(!spawned[0].args.includes("oauth-token-123"));
  assert.equal(spawned[1].cmd, "cloudflared");
  assert.ok(spawned[1].args.includes("TT")); // tunnel_token
  assert.equal(spawned[1].opts.detached, true);
  assert.ok(spawned.some((s) => s.cmd === "docker" && s.args.join(" ") === "rm -f clawlabor-hire-hire-1"));
  assert.ok(calls.some((c) => c.url.endsWith("/labor/hires/hire-1/heartbeat")));
  assert.ok(calls.some((c) => c.url.endsWith("/labor/hires/hire-1/serve") && c.options.method === "DELETE"));
  assert.ok(calls.some((c) => c.url.endsWith("/labor/labor-9/serve") && c.options.method === "DELETE"));
});

test("labor-serve keeps the startup seller API key for long-running requests", async () => {
  const seenAuth = [];
  const { stop, route: stopAfterHireTeardown } = laborServeStopAfterHireTeardown();
  let hirePolls = 0;
  const { fetch } = recordingFetch([
    matchRoute("POST", "/labor/labor-9/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-9/hires"),
      respond: () => {
        hirePolls += 1;
        return {
          status: 200,
          body: hirePolls === 1
            ? '{"items":[{"id":"hire-1","status":"active"}]}'
            : '{"items":[]}',
        };
      },
    },
    matchRoute("POST", "/labor/hires/hire-1/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-1", tunnel_token: "TT", sandbox_token: "SBX", hostname: "hire-1.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-1/heartbeat", { status: 204, body: "" }),
    stopAfterHireTeardown,
    matchRoute("DELETE", "/labor/labor-9/serve", {
      status: 204,
      body: "",
    }),
  ]);
  await runCli(
    ["labor-serve", "--labor", "labor-9"],
    {
      env: { ...BASE_ENV },
      fetch: async (url, options) => {
        if (url.endsWith("/labor/labor-9/serve") || url.endsWith("/labor/hires/hire-1/heartbeat") || url.endsWith("/labor/hires/hire-1/serve")) {
          seenAuth.push(options.headers.Authorization);
        }
        return fetch(url, options);
      },
      stdout: () => {},
      readClaudeOauthToken: () => "oauth-token-123",
      spawn: () => ({ kill() {} }),
      sleep: async () => {},
      waitForExit: () => stop.promise,
    },
  );
  assert.deepEqual([...new Set(seenAuth)], ["Bearer test-key"]);
});

test("labor-serve heartbeat is not blocked by a slow active-hire poll", async () => {
  const { stop, route: stopAfterHireTeardown } = laborServeStopAfterHireTeardown();
  let hirePolls = 0;
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/labor-9/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-9/hires"),
      respond: () => {
        hirePolls += 1;
        if (hirePolls === 1) {
          return { status: 200, body: '{"items":[{"id":"hire-1","status":"active"}]}' };
        }
        if (hirePolls === 2) {
          return new Promise((resolve) => {
            setTimeout(() => resolve({ status: 200, body: '{"items":[]}' }), 1);
          });
        }
        return { status: 200, body: '{"items":[]}' };
      },
    },
    matchRoute("POST", "/labor/hires/hire-1/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-1", tunnel_token: "TT", sandbox_token: "SBX", hostname: "hire-1.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-1/heartbeat", { status: 204, body: "" }),
    stopAfterHireTeardown,
    matchRoute("DELETE", "/labor/labor-9/serve", { status: 204, body: "" }),
  ]);
  await runCli(
    ["labor-serve", "--labor", "labor-9"],
    {
      env: BASE_ENV,
      fetch,
      stdout: () => {},
      readClaudeOauthToken: () => "oauth-token-123",
      spawn: () => ({ kill() {} }),
      sleep: async () => {},
      waitForExit: () => stop.promise,
    },
  );
  assert.ok(calls.some((call) => call.url.endsWith("/labor/hires/hire-1/heartbeat")));
  assert.ok(calls.some((call) => call.url.endsWith("/labor/hires/hire-1/serve") && call.options.method === "DELETE"));
  assert.ok(calls.some((call) => call.url.endsWith("/labor/labor-9/serve") && call.options.method === "DELETE"));
});

test("labor-serve uses Cloudflare DNS fallback before marking a public tunnel offline", async () => {
  const { stop, route: stopAfterHireTeardown } = laborServeStopAfterHireTeardown();
  let hirePolls = 0;
  const out = [];
  const { fetch: apiFetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/labor-9/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-9/hires"),
      respond: () => {
        hirePolls += 1;
        return {
          status: 200,
          body: hirePolls === 1
            ? '{"items":[{"id":"hire-1","status":"active"}]}'
            : '{"items":[]}',
        };
      },
    },
    matchRoute("POST", "/labor/hires/hire-1/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-1", tunnel_token: "TT", sandbox_token: "SBX", hostname: "hire-1.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-1/heartbeat", { status: 204, body: "" }),
    stopAfterHireTeardown,
    matchRoute("DELETE", "/labor/labor-9/serve", { status: 204, body: "" }),
  ]);

  await runCli(
    ["labor-serve", "--labor", "labor-9"],
    {
      env: BASE_ENV,
      fetch: async (url, options) => {
        if (String(url).startsWith("https://hire-1.clawlabor.com/")) {
          throw new Error("getaddrinfo ENOTFOUND hire-1.clawlabor.com");
        }
        return apiFetch(url, options);
      },
      stdout: (text) => out.push(text),
      readClaudeOauthToken: () => "oauth-token-123",
      spawn: () => ({ kill() {} }),
      sleep: async () => {},
      waitForExit: () => stop.promise,
      probePublicHealthWithDnsFallback: async (url, token) => (
        url === "https://hire-1.clawlabor.com/v1/health" && token === "SBX"
      ),
    },
  );

  const heartbeat = calls.find((call) =>
    call.options.method === "POST" && call.url.endsWith("/labor/hires/hire-1/heartbeat"),
  );
  assert.deepEqual(JSON.parse(heartbeat.options.body), { healthy: true });
  assert.doesNotMatch(out.join("\n"), /OFFLINE/);
});

test("labor-serve drains current hire instead of killing it when seller goes offline", async () => {
  const stop = deferred();
  let hirePolls = 0;
  let sawSeatOfflineWhileHireActive = false;
  const sleeps = [];
  const children = [];
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/labor-9/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-9/hires"),
      respond: () => {
        hirePolls += 1;
        if (hirePolls === 1) return { status: 200, body: '{"items":[{"id":"hire-1","status":"active"}]}' };
        if (hirePolls === 2) {
          stop.resolve();
          return { status: 200, body: '{"items":[{"id":"hire-1","status":"active"}]}' };
        }
        if (hirePolls === 3) {
          const seatOffline = calls.some((call) =>
            call.options.method === "DELETE" && call.url.endsWith("/labor/labor-9/serve"),
          );
          const hireTornDown = calls.some((call) =>
            call.options.method === "DELETE" && call.url.endsWith("/labor/hires/hire-1/serve"),
          );
          sawSeatOfflineWhileHireActive = seatOffline && !hireTornDown;
          return { status: 200, body: '{"items":[{"id":"hire-1","status":"active"}]}' };
        }
        return { status: 200, body: '{"items":[]}' };
      },
    },
    matchRoute("POST", "/labor/hires/hire-1/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-1", tunnel_token: "TT", sandbox_token: "SBX", hostname: "hire-1.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-1/heartbeat", { status: 204, body: "" }),
    matchRoute("DELETE", "/labor/labor-9/serve", { status: 204, body: "" }),
    matchRoute("DELETE", "/labor/hires/hire-1/serve", { status: 204, body: "" }),
  ]);
  await runCli(
    ["labor-serve", "--labor", "labor-9"],
    {
      env: BASE_ENV,
      fetch,
      stdout: () => {},
      readClaudeOauthToken: () => "oauth-token-123",
      spawn: (cmd, args, opts) => {
        const child = { cmd, args, opts, kills: [], kill(signal) { this.kills.push(signal || "SIGTERM"); } };
        children.push(child);
        return child;
      },
      sleep: async (ms) => { sleeps.push(ms); },
      waitForExit: () => stop.promise,
    },
  );
  assert.equal(sawSeatOfflineWhileHireActive, true);
  assert.equal(sleeps.includes(60000), true);
  const tunnel = children.find((child) => child.cmd === "cloudflared");
  const container = children.find((child) => child.cmd === "docker" && child.args.includes("run"));
  assert.equal(tunnel.opts.detached, true);
  assert.deepEqual(tunnel.kills, ["SIGTERM"]);
  assert.deepEqual(container.kills, ["SIGTERM"]);
  assert.ok(calls.some((call) => call.url.endsWith("/labor/hires/hire-1/heartbeat")));
  assert.ok(calls.some((call) => call.url.endsWith("/labor/hires/hire-1/serve") && call.options.method === "DELETE"));
});

test("labor-start publishes missing Claude labor then serves it", async () => {
  const spawned = [];
  const { stop, route: stopAfterHireTeardown } = laborServeStopAfterHireTeardown();
  let hirePolls = 0;
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: "seller-1", name: "Seller" }),
    }),
    matchRoute("GET", "/labor/list?limit=100", {
      status: 200,
      body: JSON.stringify({ items: [], next_cursor: null }),
    }),
    matchRoute("GET", "/labor/list?limit=100", {
      status: 200,
      body: JSON.stringify({ items: [], next_cursor: null }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: "seller-1", name: "Seller" }),
    }),
    matchRoute("POST", "/labor", {
      status: 201,
      body: JSON.stringify({ id: "labor-new", status: "draft" }),
    }),
    matchRoute("PUT", "/labor/labor-new", {
      status: 200,
      body: JSON.stringify({ id: "labor-new", name: "Claude Code Labor", status: "available" }),
    }),
    matchRoute("POST", "/labor/labor-new/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-new/hires"),
      respond: () => {
        hirePolls += 1;
        return {
          status: 200,
          body: hirePolls === 1
            ? '{"items":[{"id":"hire-new","status":"active"}]}'
            : '{"items":[]}',
        };
      },
    },
    matchRoute("POST", "/labor/hires/hire-new/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-new", tunnel_token: "TT", sandbox_token: "SBX", hostname: "hire-new.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-new/heartbeat", { status: 204, body: "" }),
    stopAfterHireTeardown,
    matchRoute("DELETE", "/labor/labor-new/serve", { status: 204, body: "" }),
  ]);
  const out = [];
  await runCli(
    ["labor-start", "--runtime", "claude"],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      readClaudeOauthToken: () => "oauth-token-123",
      runClaudeAuthStatus: async () => ({
        ok: true,
        account: {
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          orgId: "org-123",
          orgName: "Seller Team",
          subscriptionType: "team",
        },
      }),
      spawnSync: (cmd, args) => {
        const tool = cmd === "sh" ? args[3] : cmd;
        return {
          status: 0,
          stdout: cmd === "sh" ? `/usr/bin/${tool}\n` : `${tool} version ok`,
          stderr: "",
        };
      },
      spawn: (cmd, args) => {
        spawned.push({ cmd, args });
        return { kill() {} };
      },
      sleep: async () => {},
      waitForExit: () => stop.promise,
    },
  );
  assert.equal(calls.some((call) => call.url.endsWith("/labor") && call.options.method === "POST"), true);
  assert.equal(calls.some((call) => call.url.endsWith("/labor/labor-new/serve")), true);
  assert.equal(spawned.some((item) => item.cmd === "docker"), true);
  assert.match(out.join(""), /Hire hire-new is now serving at https:\/\/hire-new\.clawlabor\.com/);
});

test("labor-publish creates and publishes a labor resource", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/labor/list?limit=100", {
      status: 200,
      body: JSON.stringify({ items: [], next_cursor: null }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: "seller-1", agent_id: "agent_seller" }),
    }),
    matchRoute("POST", "/labor", { status: 201, body: JSON.stringify({ id: "labor-7" }) }),
    matchRoute("PUT", "/labor/labor-7", {
      status: 200,
      body: JSON.stringify({ id: "labor-7", status: "available", name: "Cook bot" }),
    }),
  ]);
  const out = [];
  await runCli(
    ["labor-publish", "--name", "Cook bot", "--description", "rented cook",
     "--daily-rate", "240", "--gatekeeper", "only cooking"],
    {
      env: BASE_ENV,
      fetch,
      stdout: (t) => out.push(t),
      runClaudeAuthStatus: async () => ({
        ok: true,
        account: {
          loggedIn: true,
          email: "seller@example.com",
          orgId: "org-123",
          orgName: "Seller Team",
          subscriptionType: "team",
        },
      }),
    },
  );
  const createBody = JSON.parse(calls[2].options.body);
  assert.equal(createBody.daily_rate_uat, 240);
  assert.equal(createBody.min_duration_days, 1); // one-day rentals only
  assert.equal(createBody.max_duration_days, 1);
  assert.equal(createBody.gatekeeper_prompt, "only cooking");
  assert.equal(createBody.host_account_provider, "claude");
  assert.equal(createBody.host_account_id, "org:org-123");
  assert.equal(createBody.host_account_plan, "team");
  assert.equal(JSON.parse(calls[3].options.body).status, "available");
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.labor_resource_id, "labor-7");
  assert.equal(parsed.status, "available");
});

test("labor-publish applies the default gatekeeper when omitted", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/labor/list?limit=100", {
      status: 200,
      body: JSON.stringify({ items: [], next_cursor: null }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: "seller-1", agent_id: "agent_seller" }),
    }),
    matchRoute("POST", "/labor", { status: 201, body: JSON.stringify({ id: "labor-8" }) }),
    matchRoute("PUT", "/labor/labor-8", {
      status: 200,
      body: JSON.stringify({ id: "labor-8", status: "available", name: "Cook bot" }),
    }),
  ]);
  await runCli(
    ["labor-publish", "--name", "Cook bot", "--description", "rented cook", "--daily-rate", "240"],
    {
      env: BASE_ENV,
      fetch,
      stdout: () => {},
      runClaudeAuthStatus: async () => ({
        ok: true,
        account: {
          loggedIn: true,
          orgId: "org-123",
          orgName: "Seller Team",
          subscriptionType: "team",
        },
      }),
    },
  );
  const createBody = JSON.parse(calls[2].options.body);
  assert.match(createBody.gatekeeper_prompt, /Accept only safe, legal, well-scoped requests/);
});

test("labor-publish blocks a duplicate active listing for the same runtime", async () => {
  const { fetch } = recordingFetch([
    matchRoute("GET", "/labor/list?limit=100", {
      status: 200,
      body: JSON.stringify({
        items: [{
          id: "labor-existing",
          seller_agent_id: "seller-1",
          name: "Existing",
          status: "available",
          runtime: "claude",
        }],
        next_cursor: null,
      }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: "seller-1", agent_id: "agent_seller" }),
    }),
  ]);
  await assert.rejects(
    () => runCli(
      ["labor-publish", "--name", "Cook bot", "--description", "rented cook", "--daily-rate", "240"],
      {
        env: BASE_ENV,
        fetch,
        stdout: () => {},
        runClaudeAuthStatus: async () => ({
          ok: true,
          account: {
            loggedIn: true,
            orgId: "org-123",
            orgName: "Seller Team",
            subscriptionType: "team",
          },
        }),
      },
    ),
    /Already have an active claude labor: labor-existing/,
  );
});

test("labor-publish rejects runtimes without serve support (codex)", async () => {
  const { fetch } = recordingFetch([]);
  await assert.rejects(
    () => runCli(
      ["labor-publish", "--runtime", "codex", "--name", "Codex bot", "--description", "rented codex",
       "--daily-rate", "240"],
      {
        env: BASE_ENV,
        fetch,
        stdout: () => {},
        runClaudeAuthStatus: async () => ({ ok: false }),
      },
    ),
    /has no labor-serve support yet/,
  );
});

test("labor-list defaults to current seller resources", async () => {
  const mine = "11111111-1111-1111-1111-111111111111";
  const other = "22222222-2222-2222-2222-222222222222";
  const laborItems = [
    {
      id: "labor-mine",
      seller_agent_id: mine,
      name: "Mine",
      status: "available",
      serve_status: "online",
      daily_rate_nano: 100000000000,
      tier: "tier_1",
      created_at: "2026-06-17T00:00:00Z",
      updated_at: "2026-06-17T00:00:00Z",
    },
    {
      id: "labor-other",
      seller_agent_id: other,
      name: "Other",
      status: "available",
      serve_status: "offline",
      daily_rate_nano: 200000000000,
      tier: "tier_1",
      created_at: "2026-06-17T00:00:00Z",
      updated_at: "2026-06-17T00:00:00Z",
    },
  ];
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/labor/list?limit=100&status=available", {
      status: 200,
      body: JSON.stringify({ items: laborItems, next_cursor: null }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: mine, agent_id: "agent-mine", name: "Seller" }),
    }),
  ]);
  const out = [];
  await runCli(
    ["labor-list", "--status", "available"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/labor/list?limit=100&status=available`);
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.scope, "mine");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.items[0].id, "labor-mine");
  assert.equal(parsed.items[0].daily_rate_uat, "100.00");
  assert.equal(Object.hasOwn(parsed.items[0], "daily_rate_nano"), false);
  assert.equal(
    parsed.items[0].management_commands.serve_command,
    "clawlabor labor-serve --labor labor-mine",
  );
  assert.equal(
    parsed.items[0].management_commands.unpublish_command,
    "clawlabor labor-unpublish --labor labor-mine",
  );
  assert.equal(
    parsed.management_commands.serve_command,
    "clawlabor labor-serve --labor <labor_resource_id>",
  );
  assert.equal(
    parsed.management_commands.unpublish_command,
    "clawlabor labor-unpublish --labor <labor_resource_id>",
  );
});

test("labor-list defaults to currently published resources", async () => {
  const mine = "11111111-1111-1111-1111-111111111111";
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/labor/list?limit=100&status=available", {
      status: 200,
      body: JSON.stringify({
        items: [{
          id: "labor-live",
          seller_agent_id: mine,
          name: "Live labor",
          status: "available",
          serve_status: "offline",
          daily_rate_nano: 100000000000,
          tier: "tier_1",
          created_at: "2026-06-17T00:00:00Z",
          updated_at: "2026-06-17T00:00:00Z",
        }],
        next_cursor: null,
      }),
    }),
    matchRoute("GET", "/agents/me", {
      status: 200,
      body: JSON.stringify({ id: mine, name: "Seller" }),
    }),
  ]);
  const out = [];
  await runCli(
    ["labor-list"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/labor/list?limit=100&status=available`);
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.status, "available");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.items[0].id, "labor-live");
});

test("labor-serve waits for an active hire before provisioning a sandbox", async () => {
  let polls = 0;
  const { stop, route: stopAfterHireTeardown } = laborServeStopAfterHireTeardown();
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/labor-9/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-9/hires"),
      respond: () => {
        polls += 1;
        if (polls === 1) return { status: 200, body: '{"items":[]}' };
        if (polls === 2) return { status: 200, body: '{"items":[{"id":"hire-1","status":"active"}]}' };
        return { status: 200, body: '{"items":[]}' };
      },
    },
    matchRoute("POST", "/labor/hires/hire-1/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-1", tunnel_token: "TT", sandbox_token: "SBX", hostname: "hire-1.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-1/heartbeat", { status: 204, body: "" }),
    stopAfterHireTeardown,
    matchRoute("DELETE", "/labor/labor-9/serve", { status: 204, body: "" }),
  ]);
  await runCli(
    ["labor-serve", "--labor", "labor-9"],
    { env: BASE_ENV, fetch, stdout: () => {},
      readClaudeOauthToken: () => "oauth-token-123",
      spawn: () => ({ kill() {} }), sleep: async () => {}, waitForExit: () => stop.promise },
  );
  assert.equal(polls, 3);
  assert.ok(!calls.some((call) => call.url.endsWith("/labor/hire-1/accept")));
});

test("labor-serve keeps the labor seat online across sequential hires", async () => {
  const stop = deferred();
  let hirePolls = 0;
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/labor/labor-9/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-9/hires"),
      respond: () => {
        hirePolls += 1;
        if (hirePolls === 1) return { status: 200, body: '{"items":[{"id":"hire-1","status":"active"}]}' };
        if (hirePolls === 2) return { status: 200, body: '{"items":[]}' };
        if (hirePolls === 3) return { status: 200, body: '{"items":[{"id":"hire-2","status":"active"}]}' };
        return { status: 200, body: '{"items":[]}' };
      },
    },
    matchRoute("POST", "/labor/hires/hire-1/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-1", tunnel_token: "TT1", sandbox_token: "SBX1", hostname: "hire-1.clawlabor.com" }),
    }),
    matchRoute("POST", "/labor/hires/hire-2/serve", {
      status: 200,
      body: JSON.stringify({ hire_id: "hire-2", tunnel_token: "TT2", sandbox_token: "SBX2", hostname: "hire-2.clawlabor.com" }),
    }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-1/heartbeat", { status: 204, body: "" }),
    matchRoute("POST", "/labor/hires/hire-2/heartbeat", { status: 204, body: "" }),
    matchRoute("DELETE", "/labor/hires/hire-1/serve", { status: 204, body: "" }),
    {
      match: ({ url, options }) => options.method === "DELETE" && url.endsWith("/labor/hires/hire-2/serve"),
      respond: () => {
        stop.resolve();
        return { status: 204, body: "" };
      },
    },
    matchRoute("DELETE", "/labor/labor-9/serve", { status: 204, body: "" }),
  ]);
  await runCli(
    ["labor-serve", "--labor", "labor-9"],
    {
      env: BASE_ENV,
      fetch,
      stdout: () => {},
      readClaudeOauthToken: () => "oauth-token-123",
      spawn: () => ({ kill() {} }),
      sleep: async () => {},
      waitForExit: () => stop.promise,
    },
  );

  const laborSeatDeletes = calls.filter((call) =>
    call.options.method === "DELETE" && call.url.endsWith("/labor/labor-9/serve"),
  );
  const hireServeCalls = calls.filter((call) =>
    call.options.method === "POST" && /\/labor\/hires\/hire-[12]\/serve$/.test(call.url),
  );
  assert.deepEqual(hireServeCalls.map((call) => call.url.match(/hire-\d/)[0]), ["hire-1", "hire-2"]);
  assert.equal(laborSeatDeletes.length, 1);
  assert.ok(calls.findIndex((call) => call.url.endsWith("/labor/hires/hire-1/serve") && call.options.method === "DELETE") <
    calls.findIndex((call) => call.url.endsWith("/labor/hires/hire-2/serve") && call.options.method === "POST"));
});

test("readClaudeOauthToken reads valid Claude Code OAuth credentials and skips expired ones", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-claude-oauth-"));
  const credentialsDir = path.join(home, ".claude");
  fs.mkdirSync(credentialsDir, { recursive: true });
  const credentialsFile = path.join(credentialsDir, ".credentials.json");
  fs.writeFileSync(credentialsFile, JSON.stringify({
    claudeAiOauth: {
      accessToken: "fresh-oauth-token",
      expiresAt: Date.now() + 60_000,
    },
  }));
  assert.equal(readClaudeOauthToken({ HOME: home }), "fresh-oauth-token");
  fs.writeFileSync(credentialsFile, JSON.stringify({
    claudeAiOauth: {
      accessToken: "expired-oauth-token",
      expiresAt: Date.now() - 60_000,
    },
  }));
  assert.equal(readClaudeOauthToken({ HOME: home }), null);
  assert.equal(isExpired("2000-01-01T00:00:00Z"), true);
});

test("readClaudeOauthToken falls back to macOS keychain credentials", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-claude-keychain-"));
  const credentialsDir = path.join(home, ".claude");
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: "expired-file-token",
      expiresAt: Date.now() - 60_000,
    },
  }));
  const token = readClaudeOauthToken(
    { HOME: home },
    Date.now(),
    {
      readClaudeCodeKeychainCredentials: () => JSON.stringify({
        claudeAiOauth: {
          accessToken: "fresh-keychain-token",
          expiresAt: Date.now() + 60_000,
        },
      }),
    },
  );
  assert.equal(token, "fresh-keychain-token");
});

test("readClaudeCodeKeychainCredentials is disabled outside macOS", () => {
  if (process.platform === "darwin") return;
  assert.equal(readClaudeCodeKeychainCredentials({}), null);
});

test("resolveClaudeCodeOauthToken never runs claude setup-token", async () => {
  const calls = [];
  const result = await resolveClaudeCodeOauthToken({
    env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-no-setup-token-")) },
    readClaudeOauthToken: () => null,
    runClaudeAuthStatus: async () => {
      calls.push(["auth", "status"]);
      return { ok: true };
    },
  });
  assert.equal(result.token, null);
  assert.equal(result.authStatusOk, true);
  assert.deepEqual(calls, [["auth", "status"]]);
});

test("labor-unpublish delists a resource (sets it inactive)", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("PUT", "/labor/labor-7", {
      status: 200,
      body: JSON.stringify({ id: "labor-7", status: "inactive", name: "Cook bot" }),
    }),
  ]);
  const out = [];
  await runCli(
    ["labor-unpublish", "--labor", "labor-7"],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t) },
  );
  assert.equal(JSON.parse(calls[0].options.body).status, "inactive");
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.labor_resource_id, "labor-7");
  assert.equal(parsed.status, "inactive");
});

// --- opencode runtime: per-runtime sandbox credential seam (Task 1) ---
const { opencodeAuthPath, resolveRuntimeSandboxCredentials } = require("../runtime/commands/command-labor");

test("opencodeAuthPath honors XDG_DATA_HOME then HOME", () => {
  assert.equal(opencodeAuthPath({ XDG_DATA_HOME: "/x" }), "/x/opencode/auth.json");
  assert.equal(opencodeAuthPath({ HOME: "/home/u" }), "/home/u/.local/share/opencode/auth.json");
});

test("resolveRuntimeSandboxCredentials: claude returns oauth env, no mounts", async () => {
  const creds = await resolveRuntimeSandboxCredentials("claude", {
    env: {},
    readClaudeOauthToken: () => "oauth-token-123",
    runClaudeAuthStatus: async () => ({ ok: true, account: { loggedIn: true, authMethod: "claude.ai" } }),
  });
  assert.equal(creds.env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token-123");
  assert.deepEqual(creds.mounts, []);
});

test("resolveRuntimeSandboxCredentials: opencode mounts auth.json read-only when present", async () => {
  const creds = await resolveRuntimeSandboxCredentials("opencode", {
    env: { HOME: "/home/seller" },
    fs: { existsSync: (p) => p === "/home/seller/.local/share/opencode/auth.json" },
  });
  assert.deepEqual(creds.env, {});
  assert.deepEqual(creds.mounts, [{
    host: "/home/seller/.local/share/opencode/auth.json",
    container: "/home/sandbox/.local/share/opencode/auth.json",
    ro: true,
  }]);
});

test("resolveRuntimeSandboxCredentials: opencode missing auth throws actionable error", async () => {
  await assert.rejects(
    resolveRuntimeSandboxCredentials("opencode", { env: { HOME: "/home/seller" }, fs: { existsSync: () => false } }),
    /opencode auth login/,
  );
});

test("labor-serve --runtime opencode mounts auth.json ro and installs opencode", async () => {
  const spawned = [];
  let hirePolls = 0;
  const { fetch } = recordingFetch([
    matchRoute("GET", "/agents/me", { status: 200, body: JSON.stringify({ id: "seller-1", name: "Seller" }) }),
    matchRoute("POST", "/labor/labor-oc/serve", { status: 204, body: "" }),
    { match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-oc/hires"),
      respond: () => {
        hirePolls += 1;
        return { status: 200, body: hirePolls === 1
          ? JSON.stringify({ items: [{ id: "hire-oc", status: "active" }] })
          : JSON.stringify({ items: [] }) };
      } },
    matchRoute("POST", "/labor/hires/hire-oc/serve", { status: 200,
      body: JSON.stringify({ tunnel_token: "TT", sandbox_token: "SBX", hostname: "labor-hire-oc.clawlabor.com" }) }),
    matchRoute("GET", "/v1/health", { status: 200, body: '{"status":"ok"}' }),
    matchRoute("POST", "/labor/hires/hire-oc/heartbeat", { status: 204, body: "" }),
    matchRoute("DELETE", "/labor/hires/hire-oc/serve", { status: 204, body: "" }),
    matchRoute("DELETE", "/labor/labor-oc/serve", { status: 204, body: "" }),
  ]);
  await runCli(["labor-serve", "--labor", "labor-oc", "--runtime", "opencode"], {
    env: { ...BASE_ENV, HOME: "/home/seller" },
    fetch,
    fs: { existsSync: (p) => p === "/home/seller/.local/share/opencode/auth.json" },
    spawn: (cmd, args) => { spawned.push({ cmd, args }); return { kill() {}, once() {}, pid: 123 }; },
    sleep: async () => {},
    waitForExit: () => Promise.resolve(),
    stdout: () => {},
  });
  const dockerRun = spawned.find((s) => s.cmd === "docker" && s.args.includes("run"));
  assert.ok(dockerRun, "docker run was spawned");
  const joined = dockerRun.args.join(" ");
  assert.match(joined, /-v \/home\/seller\/\.local\/share\/opencode\/auth\.json:\/home\/sandbox\/\.local\/share\/opencode\/auth\.json:ro/);
  assert.match(joined, /install-agent 'opencode'/);
  assert.equal(dockerRun.args.includes("CLAUDE_CODE_OAUTH_TOKEN"), false);
});

test("labor-publish --runtime opencode creates a resource without host account", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/labor/list?limit=100", { status: 200, body: JSON.stringify({ items: [], next_cursor: null }) }),
    matchRoute("GET", "/agents/me", { status: 200, body: JSON.stringify({ id: "seller-1", name: "Seller" }) }),
    matchRoute("POST", "/labor", { status: 201, body: JSON.stringify({ id: "labor-oc", status: "draft" }) }),
    matchRoute("PUT", "/labor/labor-oc", { status: 200, body: JSON.stringify({ id: "labor-oc", name: "OC", status: "available" }) }),
  ]);
  await runCli(
    ["labor-publish", "--runtime", "opencode", "--name", "OC", "--description", "d", "--daily-rate", "20"],
    { env: BASE_ENV, fetch, stdout: () => {} },
  );
  const create = calls.find((c) => c.url.endsWith("/labor") && c.options.method === "POST");
  const body = JSON.parse(create.options.body);
  assert.equal(body.runtime, "opencode");
  assert.equal(body.daily_rate_uat, 20);
  assert.equal("host_account_provider" in body, false);
});

test("labor-agents marks opencode serveable when CLI + auth present", async () => {
  const { fetch } = laborAgentsFetch();
  const out = [];
  await runCli(["labor-agents"], {
    ...laborAgentsDeps(fetch, out),
    env: { ...BASE_ENV, HOME: "/home/seller" },
    fs: { existsSync: (p) => p === "/home/seller/.local/share/opencode/auth.json" },
  });
  const oc = JSON.parse(out.join("")).agents.find((a) => a.runtime === "opencode");
  assert.equal(oc.can_serve, true);
});

test("labor-start --runtime opencode publishes missing opencode labor then serves", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/agents/me", { status: 200, body: JSON.stringify({ id: "seller-1", name: "Seller" }) }),
    matchRoute("GET", "/labor/list?limit=100", { status: 200, body: JSON.stringify({ items: [], next_cursor: null }) }),
    matchRoute("POST", "/labor", { status: 201, body: JSON.stringify({ id: "labor-oc", status: "draft" }) }),
    matchRoute("PUT", "/labor/labor-oc", { status: 200, body: JSON.stringify({ id: "labor-oc", name: "OpenCode Labor", status: "available" }) }),
    matchRoute("POST", "/labor/labor-oc/serve", { status: 204, body: "" }),
    { match: ({ url, options }) => (options.method || "GET") === "GET" && url.includes("/labor/labor-oc/hires"),
      respond: { status: 200, body: JSON.stringify({ items: [] }) } },
    matchRoute("DELETE", "/labor/labor-oc/serve", { status: 204, body: "" }),
  ]);
  await runCli(["labor-start", "--runtime", "opencode"], {
    env: { ...BASE_ENV, HOME: "/home/seller" },
    fetch,
    fs: { existsSync: (p) => p === "/home/seller/.local/share/opencode/auth.json" },
    spawnSync: (cmd, args) => {
      const tool = cmd === "sh" ? args[3] : cmd;
      const status = ["claude", "codex", "opencode", "docker", "cloudflared"].includes(tool) ? 0 : 1;
      return { status, stdout: cmd === "sh" ? `/usr/bin/${tool}\n` : `${tool} 1.0`, stderr: "" };
    },
    spawn: () => ({ kill() {}, once() {}, pid: 1 }),
    sleep: async () => {},
    waitForExit: () => Promise.resolve(),
    stdout: () => {},
  });
  assert.ok(calls.some((c) => c.url.endsWith("/labor") && c.options.method === "POST"), "published");
  assert.ok(calls.some((c) => c.url.endsWith("/labor/labor-oc/serve") && c.options.method === "POST"), "served seat");
  const create = calls.find((c) => c.url.endsWith("/labor") && c.options.method === "POST");
  assert.equal(JSON.parse(create.options.body).runtime, "opencode");
});
