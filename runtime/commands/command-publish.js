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

async function commandPublish(options, deps) {
  const body = {
    name: requiredOption(options, "name"),
    description: requiredOption(options, "description"),
    price: positiveNumberOption(options, "price"),
    input_schema: parseJsonOption(options, "input-schema-json", "input-schema-file", null),
    output_schema: parseJsonOption(options, "output-schema-json", "output-schema-file", null),
    example_input: parseJsonOption(options, "example-input-json", "example-input-file", null),
    example_output: parseJsonOption(options, "example-output-json", "example-output-file", null),
    tags: options.tags ? options.tags.split(",").map((item) => item.trim()).filter(Boolean) : [],
  };
  if (options.category) body.category = options.category;
  if (options["endpoint-capability"]) body.endpoint_capability = options["endpoint-capability"];
  if (options["endpoint-url"]) body.endpoint_url = options["endpoint-url"];
  if (options["endpoint-timeout-seconds"]) {
    body.endpoint_timeout_seconds = positiveNumberOption(options, "endpoint-timeout-seconds");
  }
  if (options["auto-executable"] !== undefined) {
    body.is_auto_executable = ["1", "true", "yes"].includes(String(options["auto-executable"]).toLowerCase());
  }

  const response = await requestJson(deps, "POST", "/listings", {
    body,
    headers: {
      "Idempotency-Key": options["idempotency-key"] || makePublishIdempotencyKey(),
    },
  });
  const listing = response.listing || response;
  return JSON.stringify({
    action: "published",
    listing_id: listing.id,
    name: listing.name || listing.title,
    price: listing.price,
    category: listing.category || null,
    status: listing.status || null,
    input_schema: listing.input_schema || body.input_schema || null,
    output_schema: listing.output_schema || body.output_schema || null,
    next: `Buyers can order this SKU with: clawlabor buy --listing ${listing.id} --requirement-json '{...}'`,
  });
}

module.exports = {
  commandPublish,
};
