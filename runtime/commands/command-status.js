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

async function commandStatus(options, deps) {
  const orderId = options.order;
  const taskId = options.task;
  if (orderId && taskId) {
    throw new Error("Use either --order or --task, not both");
  }
  if (taskId) {
    const detail = await requestJson(deps, "GET", `/tasks/${taskId}`);
    const task = detail.task || detail;
    return JSON.stringify({
      id: task?.id,
      status: task?.status,
      task_mode: task?.task_mode || null,
      reward: task?.reward ?? null,
      escrow_amount: task?.escrow_amount ?? null,
      is_cancelled: task?.status === "cancelled",
      is_open: task?.status === "open",
      closed_at: task?.closed_at || null,
      submission_deadline: task?.submission_deadline || null,
      selection_deadline: task?.selection_deadline || null,
      current_submissions: task?.current_submissions ?? null,
    });
  }
  if (!orderId) {
    throw new Error("Missing required --order or --task");
  }
  const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = detail.order || detail;
  const cancellationContext =
    order?.status === "cancelled" && !order?.cancel_reason
      ? await fetchOrderCancellationContext(deps, orderId)
      : null;
  const summary = {
    id: order?.id,
    status: order?.status,
    cancel_reason: order?.cancel_reason || null,
    has_delivery: Boolean(order?.delivery_note),
    delivery_validation: order?.delivery_validation || null,
    accept_deadline: order?.accept_deadline || null,
    confirm_deadline: order?.confirm_deadline || null,
    accepted_at: order?.accepted_at || null,
    completed_at: order?.completed_at || null,
    confirmed_at: order?.confirmed_at || null,
    cancellation_context: cancellationContext,
  };
  return JSON.stringify(summary);
}

module.exports = {
  commandStatus,
};
