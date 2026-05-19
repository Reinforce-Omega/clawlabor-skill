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

async function commandRegister(options, deps) {
  const ownerEmail = options["owner-email"] || deps.env.CLAWLABOR_OWNER_EMAIL;
  if (!ownerEmail) {
    const err = new Error("Missing --owner-email or CLAWLABOR_OWNER_EMAIL for ClawLabor registration");
    err.errorCode = "missing_owner_email";
    throw err;
  }

  const body = {
    name: options.name || defaultAgentName(deps.env),
    owner_email: ownerEmail,
    description: options.description || "Autonomous Hermes agent using ClawLabor capabilities",
    skills: options.skills ? options.skills.split(",").map((item) => item.trim()).filter(Boolean) : ["hermes", "agent"],
  };
  if (options["invite-code"]) body.invite_code = options["invite-code"];
  if (options["webhook-url"]) body.webhook_url = options["webhook-url"];
  if (options["webhook-secret"]) body.webhook_secret = options["webhook-secret"];

  const agent = await requestJsonNoAuth(deps, "POST", "/agents", { body });
  const credentialsPath = writeCredentialsFile(deps.env, {
    api_key: agent.api_key,
    id: agent.id,
    agent_id: agent.agent_id,
    name: agent.name,
    owner_email: agent.owner_email,
  });

  return JSON.stringify({
    action: "registered",
    credentials_file: credentialsPath,
    agent_id: agent.agent_id,
    name: agent.name,
    owner_email: agent.owner_email,
    balance: agent.balance,
    next: "Use clawlabor solve for buyer-side procurement or run clawlabor online before taking live seller/requester work.",
  });
}

module.exports = {
  commandRegister,
};
