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

const BASE_ENV = {
  CLAWLABOR_API_KEY: "test-key",
  CLAWLABOR_API_BASE: "https://api.example.test/api",
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
      text: async () => result.body ?? "",
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
  assert.equal(calls[0].url, "https://api.example.test/api/listings/match");
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

test("auth status reports missing credentials without calling the API", async () => {
  const credentialsFile = tempTestFile("credentials.json");
  const out = [];

  await runCli(["auth", "status"], {
    env: {
      CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
      CLAWLABOR_CREDENTIALS_FILE: credentialsFile,
    },
    fetch: async () => {
      throw new Error("should not call API");
    },
    stdout: (t) => out.push(t),
  });

  const result = JSON.parse(out[0]);
  assert.equal(result.authenticated, false);
  assert.equal(result.api_base, BASE_ENV.CLAWLABOR_API_BASE);
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
      CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
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
      CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
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
  assert.equal(calls[0].url, "https://api.example.test/api/health");
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
      CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
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
      CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
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
        CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
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
        CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
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
        CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
        CLAWLABOR_API_KEY: "file-key",
      },
      fetch,
      stdout: (t) => out.push(t),
      createServer: (cb) => {
        handler = cb;
        return server;
      },
      waitForExit: wait.promise,
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(handler, "receiver should be created");
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

  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/orders/order-serve-1", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-serve-1",
          status: "pending_accept",
        },
      }),
    }),
    matchRoute("POST", "/orders/order-serve-1/accept", {
      status: 200,
      body: JSON.stringify({ id: "order-serve-1", status: "in_progress" }),
    }),
    matchRoute("GET", "/orders/order-serve-1", {
      status: 200,
      body: JSON.stringify({
        order: {
          id: "order-serve-1",
          status: "in_progress",
        },
      }),
    }),
    matchRoute("POST", "/orders/order-serve-1/complete", {
      status: 200,
      body: JSON.stringify({ id: "order-serve-1", status: "pending_confirmation" }),
    }),
  ]);

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
  assert.match(hermesPrompt, /SKU\/listing description, input schema, buyer requirement/);
  assert.match(hermesPrompt, /Write a JavaScript add function from the event payload/);
  assert.match(hermesPrompt, /The wrapper has already fetched the order and will handle accept\/complete API calls/);
  assert.doesNotMatch(hermesPrompt, /code-writing SKU order/);
  const completeCall = calls.find((call) => call.url.endsWith("/orders/order-serve-1/complete"));
  assert.ok(completeCall);
  assert.match(JSON.parse(completeCall.options.body).delivery_note, /function add/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(sessionDir, "cursor.json"), "utf8")).last_acked_event_id,
    501,
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.processed[0].order_id, "order-serve-1");
});

test("serve --adapter hermes does not complete seller order when Hermes returns empty output", async () => {
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

  const { fetch, calls } = recordingFetch([
    matchRoute("GET", "/orders/order-empty", {
      status: 200,
      body: JSON.stringify({ order: { id: "order-empty", status: "in_progress" } }),
    }),
    matchRoute("GET", "/orders/order-empty", {
      status: 200,
      body: JSON.stringify({ order: { id: "order-empty", status: "in_progress" } }),
    }),
  ]);

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
    0,
  );
  const result = JSON.parse(out[0]);
  assert.equal(result.processed.length, 0);
  assert.match(result.errors[0].error, /empty delivery note/);
});

test("online can discover a tunnel public URL and write it back to the profile", async () => {
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

  const run = runCli(
    [
      "online",
      "--tunnel-command",
      "cloudflared",
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
        CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE,
        CLAWLABOR_API_KEY: "file-key",
      },
      fetch,
      stdout: (t) => out.push(t),
      createServer: () => server,
      spawn: () => tunnel,
      waitForExit: wait.promise,
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  tunnel.stdout.emit("data", "Visit https://abc.trycloudflare.com for the public URL\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    webhook_url: "https://abc.trycloudflare.com",
    webhook_secret: "abcdef0123456789abcdef0123456789",
  });

  wait.resolve();
  await run;

  const result = JSON.parse(out[0]);
  assert.equal(result.webhook_url, "https://abc.trycloudflare.com");
  assert.equal(result.tunnel_command, "cloudflared");
});

test("register requires owner email", async () => {
  await assert.rejects(
    runCli(["register"], {
      env: { CLAWLABOR_API_BASE: BASE_ENV.CLAWLABOR_API_BASE },
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
  assert.deepEqual(plan.input.schema.required, ["url", "question"]);
  assert.deepEqual(plan.input.requirement, { url: "https://x.com" });
  assert.equal(plan.input.valid, false);
  assert.deepEqual(plan.input.missing_required_fields, ["question"]);
  assert.equal(plan.decision.why_matched, "Matched because the task needs public evidence.");
  assert.deepEqual(plan.decision.how_to_use, ["Expected outcome: sourced research brief"]);
  assert.equal(plan.selected_listing, undefined);
  assert.equal(plan.match_explanation, undefined);
  assert.equal(plan.invocation_guidance, undefined);
  assert.equal(plan.rejected_listings, undefined);
  assert.equal(plan.input_schema, undefined);
  assert.equal(plan.debug, undefined);
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
  assert.equal(calls[0].url, "https://api.example.test/api/orders/order-123/validate-delivery");
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

  assert.equal(calls[1].url, "https://api.example.test/api/orders/order-1/attachments");
  assert.equal(data.attachments.file_count, 2);
  assert.equal(data.attachments.delivery_file_count, 1);
  assert.equal(data.attachments.delivery_files[0].download_url, "https://storage.example.test/report.pdf?sig=abc");
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

  assert.equal(calls[0].url, "https://api.example.test/api/tasks/task-1");
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

  assert.equal(calls[0].url, "https://api.example.test/api/tasks");
  assert.equal(calls[1].url, "https://api.example.test/api/tasks/task-1/attachments");
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

  assert.equal(calls[0].url, "https://api.example.test/api/tasks/task-1/attachments");
  assert.equal(
    calls[1].url,
    "https://api.example.test/api/task-submissions/sub-1/attachments/file-1",
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
  assert.ok(urls.indexOf("https://api.example.test/api/listings/sku-1/purchase") < urls.indexOf("https://api.example.test/api/orders/order-attach/attachments"));
  assert.ok(urls.indexOf("https://api.example.test/api/orders/order-attach/attachments") < urls.indexOf("https://api.example.test/api/orders/order-attach"));
  assert.equal(calls[2].options.body.get("description"), "Source HTML");
  assert.equal(
    JSON.parse(out[0]).trace.some((step) => step.step === "upload_attachment"),
    true,
  );
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
            price: 20,
            trust_score: 90,
            input_schema: { type: "object", required: ["url", "question"] },
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
    (err) => err.errorCode === "requirement_invalid" && err.missing.includes("question"),
  );
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
      CLAWLABOR_API_BASE: "https://api.example.test/api",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  const err = JSON.parse(result.stderr);
  assert.equal(err.error_code, "insufficient_credits");
  assert.match(err.next, /Run clawlabor me/);
  assert.match(err.next, /lower --max-price/);
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

test("installer derives local docs URL from CLAWLABOR_API_BASE", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawlabor-local-docs-"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "bin", "install.js"), "--help"],
    {
      env: {
        ...process.env,
        HOME: tempHome,
        CLAWLABOR_API_BASE: "http://localhost:3000/api",
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Docs:\n\s+http:\/\/localhost:3000\/skill\.md/);
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
  assert.match(skill, /clawlabor plan --goal "<describe the user's requested deliverable>"/);
  assert.match(skill, /omit `--category`/);
});

test("skill contract gives buyer guidance for insufficient credits", () => {
  const skill = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");

  assert.match(skill, /Buyer Credit Shortage/);
  assert.match(skill, /insufficient_credits/);
  assert.match(skill, /Do not retry the same purchase/);
  assert.match(skill, /clawlabor me/);
  assert.match(skill, /lower `--max-price`/);
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
    env: { CLAWLABOR_API_KEY: "test-key", CLAWLABOR_API_BASE: "https://api.test/api" },
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
        env: { CLAWLABOR_API_KEY: "test-key", CLAWLABOR_API_BASE: "https://api.test/api" },
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
    { env: { CLAWLABOR_API_KEY: "k", CLAWLABOR_API_BASE: "https://api.test/api" }, fetch: fakeFetch, stdout: () => {} },
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
      { env: { CLAWLABOR_API_KEY: "k", CLAWLABOR_API_BASE: "https://api.test/api" }, fetch: fakeFetch, stdout: () => {} },
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
    { env: { CLAWLABOR_API_KEY: "k", CLAWLABOR_API_BASE: "https://api.test/api" }, fetch: fakeFetch, stdout: () => {} },
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
    { env: { CLAWLABOR_API_KEY: "k", CLAWLABOR_API_BASE: "https://api.test/api" }, fetch: fakeFetch, stdout: (t) => out.push(t) },
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
    { env: { CLAWLABOR_API_KEY: "k", CLAWLABOR_API_BASE: "https://api.test/api" }, fetch: fakeFetch, stdout: (t) => out.push(t) },
  );

  const result = JSON.parse(out.join(""));
  assert.equal(result.auto_confirmed, false);
  assert.equal(result.action, "delivered");
  assert.equal(result.auto_confirm.requested, true);
  assert.equal(result.auto_confirm.fired, false);
  assert.equal(result.auto_confirm.skip_reason, "overall_score 0.50 below required 0.80");
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
    { env: { CLAWLABOR_API_KEY: "k", CLAWLABOR_API_BASE: "https://api.test/api" }, fetch: fakeFetch, stdout: (t) => out.push(t) },
  );

  const result = JSON.parse(out.join(""));
  assert.equal(result.auto_confirmed, false);
  assert.equal(result.auto_confirm.requested, false);
  assert.equal(result.auto_confirm.fired, false);
  assert.equal(result.auto_confirm.skip_reason, null);
});
