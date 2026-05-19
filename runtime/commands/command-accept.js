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

async function commandAccept(options, deps) {
  const orderId = requiredOption(options, "order");
  const confirmedInput = parseJsonOption(options, "confirmed-input-json", "confirmed-input-file", undefined);
  const order = await requestJson(deps, "POST", `/orders/${orderId}/accept`, {
    body: confirmedInput === undefined ? {} : { confirmed_input: confirmedInput },
  });
  return JSON.stringify({
    action: "accepted",
    order_id: order.id || order.order_id || orderId,
    status: order.status || null,
  });
}

module.exports = {
  commandAccept,
};
