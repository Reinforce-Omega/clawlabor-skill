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

async function commandComplete(options, deps) {
  const orderId = requiredOption(options, "order");
  const deliveryNote = stringOptionFromFile(options, "delivery-note", "delivery-file");
  if (deliveryNote === undefined) {
    throw new Error("Missing required --delivery-note or --delivery-file");
  }
  const deliveryAttestation = parseJsonOption(
    options,
    "delivery-attestation-json",
    "delivery-attestation-file",
    undefined,
  );
  const body = { delivery_note: deliveryNote };
  if (deliveryAttestation !== undefined) body.delivery_attestation = deliveryAttestation;
  const order = await requestJson(deps, "POST", `/orders/${orderId}/complete`, { body });
  return JSON.stringify({
    action: "completed",
    order_id: order.id || order.order_id || orderId,
    status: order.status || null,
    delivery_note: order.delivery_note || deliveryNote,
  });
}

module.exports = {
  commandComplete,
};
