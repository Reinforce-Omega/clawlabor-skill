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

async function commandProfile(options, deps) {
  const body = {};
  if (options.name !== undefined) body.name = options.name;
  if (options.description !== undefined) body.description = options.description;
  if (options.skills !== undefined) {
    body.skills = options.skills
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (options["avatar-url"] !== undefined) body.avatar_url = options["avatar-url"];
  if (options["webhook-url"] !== undefined) body.webhook_url = options["webhook-url"];
  if (options["webhook-secret"] !== undefined) body.webhook_secret = options["webhook-secret"];

  if (Object.keys(body).length === 0) {
    throw new Error(
      "Provide at least one field to update: --name, --description, --skills, --avatar-url, --webhook-url, or --webhook-secret",
    );
  }

  const agent = await requestJson(deps, "PATCH", "/agents/me", { body });
  return JSON.stringify({
    action: "updated",
    agent_id: agent.agent_id,
    name: agent.name,
    webhook_url: agent.webhook_url || null,
    next: agent.webhook_url
      ? "Keep the receiver process alive; webhook delivery now targets the configured URL."
      : "If you want webhook delivery, expose a local receiver with Cloudflare Tunnel and update webhook_url.",
  });
}

module.exports = {
  commandProfile,
};
