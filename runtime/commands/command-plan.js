const {
  apiBase,
  attachmentPath,
  candidateListingForPlan,
  compactListingForPlan,
  credentialState,
  credentialsFileMode,
  credentialsFilePath,
  defaultAgentName,
  deriveBountyFromGoal,
  diagnosticStatus,
  fetchOrderAttachments,
  fetchOrderCancellationContext,
  guessMimeType,
  hasUriSchemaField,
  isStrictUrlField,
  isUrlField,
  loadPolicy,
  makePublishIdempotencyKey,
  matchBody,
  numberOption,
  parseDeliveryNote,
  parseFileFlags,
  parseInputFlags,
  parseJsonOption,
  parseRequirement,
  pickCompatibleListing,
  positiveNumberOption,
  readAttachmentOptions,
  request,
  requestJson,
  requestJsonNoAuth,
  requestMultipart,
  resolveApiKey,
  requiredOption,
  stageAndUploadFile,
  stringOptionFromFile,
  summarizeOrderMessages,
  TERMINAL_ORDER_STATES,
  uploadAttachment,
  validateRequirementAgainstSchema,
  writeCredentialsFile,
} = require("./shared");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function solveCommand(options, flags, goal, requirementProvided, requirement, idempotencyKey) {
  const parts = ["clawlabor", "solve", "--goal", shellQuote(goal)];
  if (options["requirement-file"]) {
    parts.push("--requirement-file", shellQuote(options["requirement-file"]));
  } else if (requirementProvided) {
    parts.push("--requirement-json", shellQuote(JSON.stringify(requirement)));
  }
  if (options["policy-file"]) {
    parts.push("--policy-file", shellQuote(options["policy-file"]));
  }
  if (options["max-completion-seconds"]) {
    parts.push("--max-completion-seconds", shellQuote(options["max-completion-seconds"]));
  }
  if (flags.has("require-schema")) {
    parts.push("--require-schema");
  }
  parts.push("--idempotency-key", shellQuote(idempotencyKey));
  return parts.join(" ");
}

async function commandPlan(options, deps, flags) {
  const body = matchBody(options, flags, deps.env);
  const matchResult = await requestJson(deps, "POST", "/listings/match", { body });
  const matches = Array.isArray(matchResult.matches) ? matchResult.matches : [];
  const requirementProvided = Boolean(options["requirement-json"] || options["requirement-file"]);
  const requirement = requirementProvided ? parseRequirement(options) : {};
  const selected = pickCompatibleListing(matches, requirement);
  if (!selected) {
    throw new Error("No policy-compatible ClawLabor listing matched this goal");
  }

  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const schemaCheck = validateRequirementAgainstSchema(requirement, selected.input_schema);
  const policy = selected.policy || { allowed: true, blocked_reasons: [] };
  const candidates = matches
    .filter((item) => item.policy?.allowed !== false)
    .map((item) => candidateListingForPlan(item, requirement));
  const rejectedListings = matches
    .filter((item) => item.policy?.allowed === false)
    .map((item) => ({
      id: item.id,
      blocked_reasons: item.policy?.blocked_reasons || [],
    }));

  const goal = requiredOption(options, "goal");
  const plan = {
    action: "solve",
    goal,
    listing: compactListingForPlan(selected),
    candidates,
    decision: {
      allowed: policy.allowed !== false,
      blocked_reasons: policy.blocked_reasons || [],
      why_matched: selected.match_explanation || "",
      how_to_use: selected.invocation_guidance || [],
    },
    idempotency_key: idempotencyKey,
    input: {
      schema: selected.input_schema || null,
      requirement: requirementProvided ? requirement : null,
      valid: schemaCheck.valid,
      missing_required_fields: schemaCheck.missing,
    },
    execute_command: solveCommand(options, flags, goal, requirementProvided, requirement, idempotencyKey),
    legacy_buy_command: `clawlabor buy --listing ${selected.id} --idempotency-key ${idempotencyKey}`,
  };
  if (flags.has("verbose")) {
    plan.debug = {
      selected_listing: selected,
      policy,
      reasons: selected.reasons || [],
      rejected_listings: rejectedListings,
      raw_match: matchResult,
    };
  }
  return JSON.stringify(plan);
}

module.exports = {
  commandPlan,
};
