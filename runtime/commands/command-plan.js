const {
  apiBase,
  attachmentPath,
  buildSampleRequirement,
  candidateListingForPlan,
  compactListingForPlan,
  describeRequiredFields,
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
  // plan is "buy preview", not discovery: ask the server for top 5 by default.
  // Users wanting more switching candidates pass --candidates N (forwarded as body.limit).
  const candidateLimitOpt = numberOption(options, "candidates");
  const candidateLimit = candidateLimitOpt && candidateLimitOpt > 0 ? candidateLimitOpt : 5;
  if (options["limit"] === undefined) {
    options = { ...options, limit: String(candidateLimit) };
  }
  const body = matchBody(options, flags, deps.env, { defaultLimit: candidateLimit });
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
  const requiredFields = describeRequiredFields(selected.input_schema);
  const sampleRequirement = buildSampleRequirement(selected.input_schema, requirement);
  const policy = selected.policy || { allowed: true, blocked_reasons: [] };

  // Server already enforced the limit (body.limit set above). Reorder so selected
  // is always first; no extra slicing here.
  const allowedMatches = matches.filter((item) => item.policy?.allowed !== false);
  const reorderedAllowed = [
    ...(selected ? [selected] : []),
    ...allowedMatches.filter((item) => item.id !== selected?.id),
  ];
  const candidates = reorderedAllowed.map((item) => candidateListingForPlan(item, requirement));
  const candidatesTruncated = candidates.length >= candidateLimit;
  const rejectedListings = matches
    .filter((item) => item.policy?.allowed === false)
    .map((item) => ({
      id: item.id,
      blocked_reasons: item.policy?.blocked_reasons || [],
    }));

  const goal = requiredOption(options, "goal");
  const command = solveCommand(options, flags, goal, true, sampleRequirement, idempotencyKey);
  const blockedBy = schemaCheck.valid
    ? []
    : schemaCheck.missing.map(
        (field) => `Replace <TODO:${field}:...> in sample_requirement before running command`,
      );
  const plan = {
    next_action: {
      type: "execute_solve",
      terminal: false,
      decision_required: true,
      ready: schemaCheck.valid,
      command,
      blocked_by: blockedBy,
    },
    goal,
    listing: compactListingForPlan(selected),
    candidates,
    candidates_meta: {
      returned: candidates.length,
      requested_limit: candidateLimit,
      possibly_truncated: candidatesTruncated,
      hint: candidatesTruncated
        ? `Showing ${candidates.length} candidates (server limit hit). Pass --candidates N (max 50) for more, or --verbose for full debug.`
        : null,
    },
    idempotency_key: idempotencyKey,
    input: {
      requirement: requirementProvided ? requirement : null,
      valid: schemaCheck.valid,
      missing_required_fields: schemaCheck.missing,
      required_fields: requiredFields,
      sample_requirement: sampleRequirement,
      sample_requirement_hint:
        schemaCheck.valid
          ? "Requirement covers all required fields; sample_requirement equals your input."
          : "Replace any <TODO:fieldname:type[:format]> placeholders with real values, then pass via --requirement-json.",
    },
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
