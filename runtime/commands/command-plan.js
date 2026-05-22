const {
  apiBase,
  attachmentPath,
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
  const rejectedListings = matches
    .filter((item) => item.policy?.allowed === false)
    .map((item) => ({
      id: item.id,
      blocked_reasons: item.policy?.blocked_reasons || [],
    }));

  const plan = {
    action: "solve",
    goal: requiredOption(options, "goal"),
    listing: compactListingForPlan(selected),
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
    execute_command: `clawlabor buy --listing ${selected.id} --idempotency-key ${idempotencyKey}`,
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
