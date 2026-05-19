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

async function commandBuy(options, deps) {
  const listingId = requiredOption(options, "listing");
  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const requirement = parseRequirement(options);

  const inputEntries = parseInputFlags(options["input"] ? [].concat(options["input"]) : []);
  const fileEntries = parseFileFlags(options["file"] ? [].concat(options["file"]) : []);
  const stagedResults = [];
  for (const e of fileEntries) {
    if (!isUrlField(e.field)) {
      throw new Error(`Field "${e.field}" does not look like a URL field.`);
    }
    const staged = await stageAndUploadFile(deps, e);
    stagedResults.push(staged);
    requirement[staged.field] = staged.signedUrl;
  }
  for (const e of inputEntries.filter((x) => !x.isFile)) {
    requirement[e.field] = e.value;
  }

  return request(deps, "POST", `/listings/${listingId}/purchase`, {
    body: {
      requirement,
      staged_attachment_ids: stagedResults.map((s) => s.stagedId),
    },
    headers: { "X-Idempotency-Key": idempotencyKey },
  });
}

module.exports = {
  commandBuy,
};
