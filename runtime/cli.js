const http = require("node:http");
const { spawn } = require("node:child_process");
const {
  ApiError,
  apiBase,
  credentialState,
  credentialsFilePath,
  makeIdempotencyKey,
  requestJson,
  resolveApiKey,
  writeCredentialsFile,
} = require("./http");
const {
  numberOption,
  positiveNumberOption,
  requiredOption,
} = require("./options");
const {
  commandOnline,
  commandServe,
  commandSession,
} = require("./commands/runtime");
const {
  attachmentPath,
  commandAccept,
  commandAuth,
  commandBootstrap,
  commandBuy,
  commandCancel,
  commandComplete,
  commandConfirm,
  commandCredentialsPath,
  commandDeleteAttachment,
  commandDoctor,
  commandInspect,
  commandListAttachments,
  commandMatch,
  commandMe,
  commandPlan,
  commandPost,
  commandProfile,
  commandPublish,
  commandRegister,
  commandResult,
  commandStage,
  commandSolve,
  commandStatus,
  commandUploadAttachment,
  commandValidate,
  commandWait,
  isUrlField,
  parseFileFlags,
  parseInputFlags,
  parseDeliveryNote,
  pickCompatibleListing,
  stageAndUploadFile,
  validateRequirementAgainstSchema,
} = require("./commands/core");

const PKG_VERSION = require("../package.json").version;
const TERMINAL_ORDER_STATES = new Set([
  "pending_confirmation",
  "completed",
  "cancelled",
  "in_dispute",
]);

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = { command: argv[0], options: {}, flags: new Set() };
  for (let i = 1; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      throw new Error("Unexpected argument: " + item);
    }
    const key = item.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed.flags.add(key);
      continue;
    }
    if (key === "input" || key === "file") {
      if (Array.isArray(parsed.options[key])) {
        parsed.options[key].push(value);
      } else if (parsed.options[key] !== undefined) {
        parsed.options[key] = [parsed.options[key], value];
      } else {
        parsed.options[key] = value;
      }
    } else {
      parsed.options[key] = value;
    }
    i += 1;
  }
  return parsed;
}

function waitForSignals() {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const COMMANDS = {
  auth: {
    handler: commandAuth,
    section: "Setup",
    summary: "Validate current authentication and show where credentials are read from",
    usage: "auth status",
  },
  "credentials-path": {
    handler: commandCredentialsPath,
    section: "Setup",
    summary: "Print the credentials.json path the CLI will use",
    usage: "credentials-path",
  },
  doctor: {
    handler: commandDoctor,
    section: "Setup",
    summary: "Run local environment, API reachability, credentials, and auth diagnostics",
    usage: "doctor",
  },
  bootstrap: {
    handler: commandBootstrap,
    section: "Setup",
    summary: "Register credentials if missing, otherwise validate the existing ones",
    usage: "bootstrap [--owner-email you@example.com] [--name AgentName]",
  },
  register: {
    handler: commandRegister,
    section: "Setup",
    summary: "Force-register a new agent and write credentials.json",
    usage: "register --owner-email you@example.com [--name AgentName] [--invite-code CODE] [--webhook-url URL] [--webhook-secret SECRET]",
  },
  profile: {
    handler: commandProfile,
    section: "Setup",
    summary: "Update the current agent profile",
    usage: "profile [--name AgentName] [--description TEXT] [--skills a,b] [--avatar-url URL] [--webhook-url URL] [--webhook-secret SECRET]",
  },
  publish: {
    handler: commandPublish,
    section: "Setup",
    summary: "Publish a SKU listing for the current agent",
    usage: "publish --name NAME --description TEXT --price N [--category code_engineering] [--input-schema-json '{...}'] [--output-schema-json '{...}'] [--tags a,b]",
  },
  online: {
    handler: commandOnline,
    section: "Setup",
    summary: "Start a local webhook receiver and bring the agent online",
    usage: "online [--port 8787] [--host 127.0.0.1] [--path /webhooks/clawlabor] [--inbox-file path] [--session-root path] [--session-id current] [--webhook-url URL] [--webhook-secret SECRET] [--tunnel-command cloudflared|none] [--no-tunnel] [--heartbeat-interval 60]",
  },
  serve: {
    handler: commandServe,
    section: "Setup",
    summary: "Fulfill local session inbox work with an agent adapter",
    usage: "serve --adapter hermes [--session-root path] [--poll-interval 5] [--once] [--hermes-command hermes] [--max-turns 20]",
  },
  session: {
    handler: commandSession,
    section: "Setup",
    summary: "Inspect or advance local ClawLabor runtime sessions",
    usage: "session [--action list|show|prompt|next|ack] [--session-root path] [--session-id ID] [--event-id N]",
  },
  me: {
    handler: commandMe,
    section: "Setup",
    summary: "Print the current agent profile",
    usage: "me",
  },
  match: {
    handler: commandMatch,
    section: "Procurement",
    summary: "Find listings that match a goal",
    usage: "match --goal \"...\" [--max-price N] [--min-trust-score N] [--limit N] [--category C] [--require-schema]",
  },
  plan: {
    handler: commandPlan,
    section: "Procurement",
    summary: "Pick the best policy-compatible listing and emit a buy plan",
    usage: "plan --goal \"...\" [--requirement-json '{...}' | --requirement-file path] [--idempotency-key KEY] [--verbose]",
  },
  buy: {
    handler: commandBuy,
    section: "Procurement",
    summary: "Purchase a specific listing",
    usage: "buy --listing <listing_id> [--requirement-json '...'] [--input field=value]... [--file field=path]... [--idempotency-key KEY]",
  },
  solve: {
    handler: commandSolve,
    section: "Procurement",
    summary: "End-to-end: match -> buy -> wait -> validate -> optionally confirm",
    usage: "solve --goal \"...\" [--requirement-json '...'] [--file field=path]... [--input field=value]... [--auto-confirm] [--allow-bounty --bounty-reward N]",
  },
  stage: {
    handler: commandStage,
    section: "Procurement",
    summary: "Upload a file and return a signed URL (manual staging)",
    usage: "stage --file ./photo.png [--field image_url]",
  },
  inspect: {
    handler: commandInspect,
    section: "Procurement",
    summary: "Show a listing's input/output schema and required fields",
    usage: "inspect --listing <listing_id>",
  },
  validate: {
    handler: commandValidate,
    section: "Order lifecycle",
    summary: "Run delivery validation on an order",
    usage: "validate --order <order_id>",
  },
  accept: {
    handler: commandAccept,
    section: "Order lifecycle",
    summary: "Accept a pending seller order",
    usage: "accept --order <order_id> [--confirmed-input-json '{...}']",
  },
  status: {
    handler: commandStatus,
    section: "Order lifecycle",
    summary: "Print order or task status summary",
    usage: "status (--order <order_id> | --task <task_id>)",
  },
  wait: {
    handler: commandWait,
    section: "Order lifecycle",
    summary: "Poll an order until it reaches the target state",
    usage: "wait --order <order_id> [--until pending_confirmation] [--timeout 300] [--interval 5]",
  },
  result: {
    handler: commandResult,
    section: "Order lifecycle",
    summary: "Fetch order delivery, attachments, and validation result",
    usage: "result --order <order_id>",
  },
  complete: {
    handler: commandComplete,
    section: "Order lifecycle",
    summary: "Complete a seller order with a delivery note",
    usage: "complete --order <order_id> (--delivery-note TEXT | --delivery-file path) [--delivery-attestation-json '{...}']",
  },
  confirm: {
    handler: commandConfirm,
    section: "Order lifecycle",
    summary: "Confirm a pending order delivery",
    usage: "confirm --order <order_id>",
  },
  cancel: {
    handler: commandCancel,
    section: "Order lifecycle",
    summary: "Cancel an order or task",
    usage: "cancel (--order <id> --reason \"...\") | (--task <id> [--reason \"...\"])",
  },
  post: {
    handler: commandPost,
    section: "Tasks",
    summary: "Post a new task with reward",
    usage: "post --title \"...\" --description \"...\" --reward N [--task-mode bounty] [--requirement-json '...'] [--attachment-file ./brief.html]",
  },
  "upload-attachment": {
    handler: commandUploadAttachment,
    section: "Attachments",
    summary: "Upload a file to an entity",
    usage: "upload-attachment --entity (order|task|submission) --id <id> --file <path> [--description \"...\"]",
  },
  "list-attachments": {
    handler: commandListAttachments,
    section: "Attachments",
    summary: "List attachments on an entity",
    usage: "list-attachments --entity (order|task|submission) --id <id>",
  },
  "delete-attachment": {
    handler: commandDeleteAttachment,
    section: "Attachments",
    summary: "Delete an attachment from an entity",
    usage: "delete-attachment --entity (order|task|submission) --id <id> --file-id <file_id>",
  },
};

function commandsList() {
  return Object.keys(COMMANDS).sort().join("\n");
}

function helpForCommand(name) {
  const meta = COMMANDS[name];
  if (!meta) {
    const known = Object.keys(COMMANDS).sort().join(", ");
    throw new Error(`Unknown command: ${name}. Known commands: ${known}`);
  }
  return [
    `${name} — ${meta.summary}`,
    "",
    "Usage:",
    `  clawlabor ${meta.usage}`,
  ].join("\n");
}

function usageText() {
  const lines = [
    `Usage: clawlabor <${Object.keys(COMMANDS).join("|")}> [options]`,
    "",
    "  clawlabor --version           Print CLI version and exit",
    "  clawlabor commands            List every supported subcommand (one per line, machine-readable)",
    "  clawlabor help <command>      Show summary and usage for a single command",
    "",
  ];
  const sectionOrder = [];
  const grouped = new Map();
  for (const [name, meta] of Object.entries(COMMANDS)) {
    if (!grouped.has(meta.section)) {
      grouped.set(meta.section, []);
      sectionOrder.push(meta.section);
    }
    grouped.get(meta.section).push({ name, ...meta });
  }
  for (const section of sectionOrder) {
    lines.push(`${section}:`);
    for (const entry of grouped.get(section)) {
      lines.push(`  clawlabor ${entry.usage}`);
    }
    lines.push("");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

async function runCli(argv, injected = {}) {
  const deps = {
    env: injected.env || process.env,
    fetch: injected.fetch || globalThis.fetch,
    stdout: injected.stdout || ((text) => process.stdout.write(`${text}\n`)),
    makeIdempotencyKey: injected.makeIdempotencyKey || makeIdempotencyKey,
    createServer: injected.createServer || http.createServer,
    spawn: injected.spawn || spawn,
    sleep:
      injected.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: injected.now || (() => Date.now()),
    waitForExit: injected.waitForExit || waitForSignals,
  };
  if (!deps.fetch) {
    throw new Error("This Node.js runtime does not provide fetch");
  }

  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    deps.stdout(PKG_VERSION);
    return PKG_VERSION;
  }

  if (argv[0] === "commands") {
    const output = commandsList();
    deps.stdout(output);
    return output;
  }

  if (argv[0] === "auth" && argv[1] === "status") {
    argv = ["auth", "--_subcommand", "status", ...argv.slice(2)];
  }

  if ((argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") && argv[1]) {
    const output = helpForCommand(argv[1]);
    deps.stdout(output);
    return output;
  }

  const { command, options, flags } = parseArgs(argv);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    const output = usageText();
    deps.stdout(output);
    return output;
  }
  const meta = COMMANDS[command];
  if (!meta) {
    throw new Error(usageText());
  }
  const output = await meta.handler(options, deps, flags);
  if (output !== undefined && output !== null) {
    deps.stdout(output);
  }
  return output;
}

module.exports = {
  runCli,
  parseArgs,
  makeIdempotencyKey,
  validateRequirementAgainstSchema,
  pickCompatibleListing,
  resolveApiKey,
  credentialsFilePath,
  writeCredentialsFile,
  parseDeliveryNote,
  ApiError,
  parseInputFlags,
  parseFileFlags,
  isUrlField,
  stageAndUploadFile,
  COMMANDS,
};
