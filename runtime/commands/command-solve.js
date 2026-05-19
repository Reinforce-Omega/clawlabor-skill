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
const { commandWait } = require("./command-wait");

async function commandSolve(options, deps, flags) {
  const goal = requiredOption(options, "goal");
  const trace = [];
  const requirement = (options["requirement-json"] || options["requirement-file"])
    ? parseRequirement(options)
    : {};

  // Parse --input flags: plain entries merged into requirement immediately
  const inputEntries = parseInputFlags(options["input"] ? [].concat(options["input"]) : []);
  const fileEntries = parseFileFlags(options["file"] ? [].concat(options["file"]) : []);
  for (const e of inputEntries) {
    requirement[e.field] = e.value;
  }
  // Pattern-only fast-fail before any API call
  for (const e of fileEntries) {
    if (!isUrlField(e.field)) {
      throw new Error(
        `Field "${e.field}" does not look like a URL field (*_url, *_uri, or schema format:"uri"). ` +
        `Use --file ${e.field}=path for local files, or --input ${e.field}="value" for plain strings.`,
      );
    }
  }

  // 1. match
  const body = matchBody(options, flags, deps.env);
  const matchResult = await requestJson(deps, "POST", "/listings/match", { body });
  const matches = Array.isArray(matchResult.matches) ? matchResult.matches : [];
  const allowed = matches.filter((item) => item.policy?.allowed !== false);
  trace.push({ step: "match", total: matches.length, allowed: allowed.length });

  if (allowed.length === 0) {
    if (!flags.has("allow-bounty")) {
      const err = new Error("No policy-compatible listing matched and --allow-bounty not set");
      err.errorCode = "no_match";
      throw err;
    }
    const reward = numberOption(options, "bounty-reward");
    if (reward === undefined) {
      throw new Error("Missing required --bounty-reward when falling back to bounty");
    }
    const { title, description } = deriveBountyFromGoal(goal, options);
    const taskBody = {
      title,
      description,
      reward,
      task_mode: options["task-mode"] || "bounty",
    };
    if (Object.keys(requirement).length > 0) taskBody.requirement = requirement;
    if (options.category) taskBody.category = options.category;
    const task = await requestJson(deps, "POST", "/tasks", { body: taskBody });
    trace.push({ step: "post_bounty", task_id: task?.id });
    return JSON.stringify({
      action: "posted_bounty",
      task_id: task?.id,
      task,
      trace,
    });
  }

  const selected = pickCompatibleListing(matches, requirement);

  // Stage files after match so we can validate against the listing's input_schema
  const stagedResults = [];
  for (const e of fileEntries) {
    if (!isUrlField(e.field, selected.input_schema)) {
      throw new Error(
        `Field "${e.field}" is not declared as a URI type in the selected listing's schema. ` +
        `Use --file ${e.field}=path only for URL fields, or --input ${e.field}="value" for plain strings.`,
      );
    }
    const staged = await stageAndUploadFile(deps, e);
    stagedResults.push(staged);
    requirement[staged.field] = staged.signedUrl;
    trace.push({ step: "stage_file", field: staged.field, staged_id: staged.stagedId });
  }

  // 2. local schema validation (skip required-field check for file-input fields already injected above)
  const schemaCheck = validateRequirementAgainstSchema(requirement, selected.input_schema);
  if (!schemaCheck.valid) {
    const err = new Error(
      `Requirement missing required fields for selected listing: ${schemaCheck.missing.join(", ")}`,
    );
    err.errorCode = "requirement_invalid";
    err.missing = schemaCheck.missing;
    throw err;
  }

  // 3. buy
  const idempotencyKey = options["idempotency-key"] || deps.makeIdempotencyKey();
  const purchase = await requestJson(deps, "POST", `/listings/${selected.id}/purchase`, {
    body: {
      requirement,
      staged_attachment_ids: stagedResults.map((s) => s.stagedId),
    },
    headers: { "X-Idempotency-Key": idempotencyKey },
  });
  const orderId = purchase?.id || purchase?.order?.id;
  if (!orderId) {
    throw new Error("Purchase response did not include order id");
  }
  trace.push({ step: "buy", order_id: orderId, listing_id: selected.id });

  if (options["attachment-file"]) {
    const attachmentText = await uploadAttachment(deps, "order", orderId, {
      ...readAttachmentOptions(
        {
          ...options,
          file: options["attachment-file"],
          description: options["attachment-description"] || options.description,
        },
        "file",
      ),
    });
    const attachment = attachmentText ? JSON.parse(attachmentText) : null;
    trace.push({
      step: "upload_attachment",
      order_id: orderId,
      file_id: attachment?.file_id,
      filename: attachment?.filename,
    });
  }

  // 4. wait until pending_confirmation
  const waitOutput = await commandWait(
    { ...options, order: orderId, until: "pending_confirmation" },
    deps,
  );
  const waitResult = JSON.parse(waitOutput);
  trace.push({ step: "wait", ...waitResult });
  if (!waitResult.reached) {
    return JSON.stringify({
      action: "waiting",
      order_id: orderId,
      reason: waitResult.reason,
      trace,
    });
  }

  // 5. validate
  const validation = await requestJson(deps, "POST", `/orders/${orderId}/validate-delivery`, {
    body: {},
  });
  trace.push({
    step: "validate",
    verdict: validation?.verdict,
    can_auto_confirm: validation?.can_auto_confirm,
  });

  // 6. optionally confirm
  const autoConfirmRequested = flags.has("auto-confirm");
  let confirmed = null;
  if (autoConfirmRequested && validation?.can_auto_confirm) {
    confirmed = await requestJson(deps, "POST", `/orders/${orderId}/confirm`, { body: {} });
    trace.push({ step: "confirm", order_id: orderId });
  }

  // 7. fetch result
  const orderDetail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = orderDetail.order || orderDetail;
  const delivery = parseDeliveryNote(order?.delivery_note);
  const attachments = await fetchOrderAttachments(deps, orderId);

  const autoConfirm = {
    requested: autoConfirmRequested,
    fired: Boolean(confirmed),
    policy: validation?.auto_confirm_policy || null,
    skip_reason:
      autoConfirmRequested && !confirmed
        ? validation?.auto_confirm_skip_reason || "validation response did not permit auto-confirm"
        : null,
    next_action:
      autoConfirmRequested && !confirmed
        ? `Review delivery, then run: clawlabor confirm --order ${orderId}`
        : null,
  };

  return JSON.stringify({
    action: confirmed ? "completed" : "delivered",
    order_id: orderId,
    listing_id: selected.id,
    validation,
    delivery_format: delivery.format,
    delivery: delivery.value,
    delivery_attestation: order?.delivery_attestation || null,
    attachments,
    auto_confirmed: Boolean(confirmed),
    auto_confirm: autoConfirm,
    trace,
  });
}

module.exports = {
  commandSolve,
};
