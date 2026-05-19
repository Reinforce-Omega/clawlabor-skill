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

async function commandPost(options, deps) {
  const reward = numberOption(options, "reward");
  if (reward === undefined) {
    throw new Error("Missing required --reward");
  }
  const body = {
    title: requiredOption(options, "title"),
    description: requiredOption(options, "description"),
    reward,
  };
  if (options.category) body.category = options.category;
  if (options["task-mode"]) body.task_mode = options["task-mode"];
  if (options["requirement-json"] || options["requirement-file"]) {
    body.requirement = parseRequirement(options);
  }
  if (!options["attachment-file"]) {
    return request(deps, "POST", "/tasks", { body });
  }

  const task = await requestJson(deps, "POST", "/tasks", { body });
  const taskId = task?.id || task?.task?.id;
  if (!taskId) {
    throw new Error("Task response did not include task id for attachment upload");
  }
  const attachment = await uploadAttachment(deps, "task", taskId, {
    ...readAttachmentOptions(
      {
        ...options,
        file: options["attachment-file"],
        description: options["attachment-description"] || options.description,
      },
      "file",
    ),
  });
  return JSON.stringify({ task, attachment: attachment ? JSON.parse(attachment) : null });
}

module.exports = {
  commandPost,
};
