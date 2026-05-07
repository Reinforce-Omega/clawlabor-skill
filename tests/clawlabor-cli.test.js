const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  runCli,
  validateRequirementAgainstSchema,
  pickCompatibleListing,
  resolveApiKey,
  credentialsFilePath,
  parseDeliveryNote,
} = require("../runtime/cli");

const BASE_ENV = {
  CLAWLABOR_API_KEY: "test-key",
  CLAWLABOR_API_BASE: "https://api.example.test/api",
};

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
  assert.deepEqual(JSON.parse(calls[0].options.body), { requirement: { url: "https://example.com" } });
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

test("plan exposes input_schema, missing-field check, and rejected listings", async () => {
  const { fetch } = recordingFetch([
    matchRoute("POST", "/listings/match", {
      status: 200,
      body: JSON.stringify({
        matches: [
          {
            id: "sku-123",
            name: "Research",
            price: 20,
            trust_score: 92,
            input_schema: { type: "object", required: ["url", "question"] },
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
    ],
    { env: BASE_ENV, fetch, stdout: (t) => out.push(t), makeIdempotencyKey: () => "fixed-key" },
  );
  const plan = JSON.parse(out[0]);
  assert.equal(plan.selected_listing.id, "sku-123");
  assert.deepEqual(plan.input_schema.required, ["url", "question"]);
  assert.equal(plan.requirement_valid, false);
  assert.deepEqual(plan.missing_required_fields, ["question"]);
  assert.deepEqual(plan.rejected_listings, [
    { id: "sku-cheap", blocked_reasons: ["trust_below_minimum"] },
  ]);
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
  assert.equal(plan.selected_listing.id, "sku-url");
  assert.equal(plan.requirement_valid, true);
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
  assert.equal(plan.requirement, null);
  assert.equal(plan.requirement_valid, false);
  assert.deepEqual(plan.missing_required_fields, ["url"]);
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
        },
      }),
    }),
  ]);
  const out = [];
  await runCli(["result", "--order", "order-1"], { env: BASE_ENV, fetch, stdout: (t) => out.push(t) });
  const data = JSON.parse(out[0]);
  assert.equal(data.delivery_format, "json");
  assert.deepEqual(data.delivery.opportunities, ["a", "b"]);
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
  assert.equal(calls.length, 1);
});

test("confirm posts to confirm endpoint", async () => {
  const { fetch, calls } = recordingFetch([
    matchRoute("POST", "/orders/order-1/confirm", { status: 200, body: '{"id":"order-1","status":"completed"}' }),
  ]);
  await runCli(["confirm", "--order", "order-1"], { env: BASE_ENV, fetch, stdout: () => {} });
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "{}");
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
  assert.equal(fs.existsSync(path.join(target, "bin", "clawlabor.js")), true);
  assert.equal(fs.existsSync(path.join(target, "runtime", "cli.js")), true);
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
