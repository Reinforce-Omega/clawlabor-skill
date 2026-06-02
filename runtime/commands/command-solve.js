const {
  apiBase,
  attachmentPath,
  buildSampleRequirement,
  compactListingForPlan,
  describeRequiredFields,
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
  shellQuote,
  stageAndUploadFile,
  stringOptionFromFile,
  summarizeOrderMessages,
  TERMINAL_ORDER_STATES,
  uploadAttachment,
  validateRequirementAgainstSchema,
  writeCredentialsFile,
} = require("./shared");
const { commandWait } = require("./command-wait");

function waitSecondsForStatus(status, options, avgCompletionSeconds) {
  const explicit = positiveNumberOption(options, "wait-seconds");
  if (explicit) return explicit;
  if (status === "pending_accept" || status === "pending_acceptance" || status === "created") return 60;
  if (status === "in_progress") return avgCompletionSeconds || 300;
  return avgCompletionSeconds || 120;
}

function checkAfterIso(deps, waitSeconds) {
  return new Date(deps.now() + (waitSeconds * 1000)).toISOString();
}

function resumeCommand(orderId) {
  return `clawlabor solve --resume-order ${orderId}`;
}

function terminalNextAction(action) {
  return {
    type: "terminal",
    terminal: true,
    action,
    command: null,
  };
}

function waitNextAction(orderId, waitSeconds, checkAfter, reason) {
  return {
    type: "wait",
    terminal: false,
    reason,
    check_after_seconds: waitSeconds,
    check_after_iso: checkAfter,
    command: resumeCommand(orderId),
    non_blocking: true,
    scheduling_note: "Do not sleep or block. Schedule next_action.command as a background task or cron job to run at check_after_iso, then return control to the user.",
  };
}

function replyNextAction(orderId) {
  return {
    type: "reply",
    terminal: false,
    decision_required: true,
    command: `clawlabor message --order ${orderId} --content <reply>`,
    after_command: resumeCommand(orderId),
  };
}

function reviewDeliveryNextAction(orderId) {
  return {
    type: "review_delivery",
    terminal: false,
    decision_required: true,
    command: `clawlabor confirm --order ${orderId}`,
    when: "delivery_acceptable",
    otherwise: `Do not confirm; keep the order pending while you decide the correct buyer action for order ${orderId}.`,
  };
}

function openOrderRetryPolicy(orderId) {
  return {
    initial_solve_repeat_safe: false,
    duplicate_purchase_risk: true,
    resume_command: resumeCommand(orderId),
    rule: "Once solve returns an order_id, do not run the original solve --goal command again for this purchase; use resume_command or next_action.command.",
  };
}

async function fetchOrderMessages(deps, orderId) {
  const detail = await requestJson(deps, "GET", `/orders/${orderId}/messages?limit=20`);
  return Array.isArray(detail?.messages)
    ? detail.messages
    : Array.isArray(detail?.data)
      ? detail.data
      : [];
}

async function currentAgentId(deps) {
  const me = await requestJson(deps, "GET", "/agents/me");
  return me?.id || me?.agent?.id || me?.agent_id || me?.agent?.agent_id || null;
}

async function latestCounterpartyMessage(deps, orderId) {
  const [messages, selfId] = await Promise.all([
    fetchOrderMessages(deps, orderId),
    currentAgentId(deps),
  ]);
  const latest = [...messages].reverse().find((message) => {
    const senderId = message?.sender_id || message?.sender?.id || null;
    return senderId && senderId !== selfId;
  });
  return latest || null;
}

async function deliveredResult(orderId, listingId, options, deps, flags, trace) {
  const validation = await requestJson(deps, "POST", `/orders/${orderId}/validate-delivery`, {
    body: {},
  });
  trace.push({
    step: "validate",
    verdict: validation?.verdict,
    can_auto_confirm: validation?.can_auto_confirm,
  });

  const autoConfirmRequested = flags.has("auto-confirm");
  let confirmed = null;
  if (autoConfirmRequested && validation?.can_auto_confirm) {
    confirmed = await requestJson(deps, "POST", `/orders/${orderId}/confirm`, { body: {} });
    trace.push({ step: "confirm", order_id: orderId });
  }

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

  return {
    action: confirmed ? "completed" : "delivered",
    order_id: orderId,
    listing_id: listingId || order?.service_sku_id || null,
    validation,
    delivery_format: delivery.format,
    delivery: delivery.value,
    delivery_attestation: order?.delivery_attestation || null,
    attachments,
    auto_confirmed: Boolean(confirmed),
    auto_confirm: autoConfirm,
    decision_required: !confirmed,
    next_command: confirmed ? null : `clawlabor confirm --order ${orderId}`,
    next_action: confirmed ? terminalNextAction("completed") : reviewDeliveryNextAction(orderId),
    retry_policy: confirmed ? null : openOrderRetryPolicy(orderId),
    resume_command: resumeCommand(orderId),
    trace,
  };
}

async function observeOrder(orderId, options, deps, flags, trace = [], listingId = null) {
  const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
  const order = detail.order || detail;
  const status = order?.status || null;
  trace.push({ step: "observe", order_id: orderId, status });

  if (status === "cancelled") {
    const cancellationContext = !order?.cancel_reason
      ? await fetchOrderCancellationContext(deps, orderId)
      : null;
    return {
      action: "cancelled",
      order_id: orderId,
      status,
      cancel_reason: order?.cancel_reason || null,
      cancellation_context: cancellationContext,
      terminal: true,
      next_action: terminalNextAction("cancelled"),
      trace,
    };
  }

  if (status === "completed" || order?.confirmed_at) {
    return {
      action: "confirmed",
      order_id: orderId,
      status: "completed",
      terminal: true,
      next_action: terminalNextAction("confirmed"),
      trace,
    };
  }

  if (status === "pending_confirmation") {
    return deliveredResult(orderId, listingId, options, deps, flags, trace);
  }

  const latestMessage = await latestCounterpartyMessage(deps, orderId);
  if (latestMessage) {
    return {
      action: "needs_buyer_response",
      order_id: orderId,
      status,
      latest_message: latestMessage,
      next_command: `clawlabor message --order ${orderId} --content <reply>`,
      next_action: replyNextAction(orderId),
      retry_policy: openOrderRetryPolicy(orderId),
      resume_command: resumeCommand(orderId),
      decision_required: true,
      trace,
    };
  }

  const waitSeconds = waitSecondsForStatus(status, options);
  const reason = status === "in_progress"
    ? "seller_is_working"
    : "waiting_for_seller_state_change";
  const checkAfter = checkAfterIso(deps, waitSeconds);
  return {
    action: "wait",
    order_id: orderId,
    status,
    reason,
    check_after_seconds: waitSeconds,
    check_after_iso: checkAfter,
    resume_command: resumeCommand(orderId),
    non_blocking: true,
    scheduling_note: "Do not sleep or block. Schedule resume_command as a background task or cron job to run at check_after_iso, then return control to the user.",
    next_action: waitNextAction(orderId, waitSeconds, checkAfter, reason),
    retry_policy: openOrderRetryPolicy(orderId),
    deadline: {
      accept_deadline: order?.accept_deadline || null,
      confirm_deadline: order?.confirm_deadline || null,
    },
    trace,
  };
}

async function commandSolve(options, deps, flags) {
  if (options["resume-order"]) {
    return JSON.stringify(await observeOrder(options["resume-order"], options, deps, flags));
  }

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
    const listingLabel = selected.title || selected.name || selected.id;
    const fieldHints = describeRequiredFields(selected.input_schema)
      .filter((field) => schemaCheck.missing.includes(field.name));
    const sample = buildSampleRequirement(selected.input_schema, requirement);
    const planCmd = `clawlabor plan --goal ${shellQuote(goal)}`;
    const rerunCmd = `clawlabor solve --goal ${shellQuote(goal)} --requirement-json ${shellQuote(JSON.stringify(sample))}`;
    const err = new Error(
      `Requirement missing required fields for listing "${listingLabel}": ${schemaCheck.missing.join(", ")}. ` +
      `Run \`${planCmd}\` to preview the schema and a pre-filled sample requirement, ` +
      `or rerun solve after replacing the <TODO:...> placeholders in sample_requirement.`,
    );
    err.errorCode = "requirement_invalid";
    err.missing = schemaCheck.missing;
    err.listingId = selected.id;
    err.listingTitle = listingLabel;
    err.missingFieldHints = fieldHints;
    err.sampleRequirement = sample;
    err.planCommand = planCmd;
    err.rerunCommand = rerunCmd;
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

  // 4. wait briefly until pending_confirmation; return action=wait when seller is still working
  const waitOutput = await commandWait(
    {
      ...options,
      order: orderId,
      until: "pending_confirmation",
      timeout: options.timeout ?? "30",
    },
    deps,
  );
  const waitResult = JSON.parse(waitOutput);
  trace.push({ step: "wait", ...waitResult });
  if (!waitResult.reached) {
    if (waitResult.status === "cancelled") {
      return JSON.stringify({
        action: "cancelled",
        order_id: orderId,
        status: waitResult.status,
        cancel_reason: waitResult.cancel_reason || null,
        cancellation_context: waitResult.cancellation_context || null,
        terminal: true,
        next_action: terminalNextAction("cancelled"),
        trace,
      });
    }
    const waitSeconds = waitSecondsForStatus(waitResult.status, options, selected.avg_completion_seconds);
    const reason = waitResult.status === "in_progress"
      ? "seller_is_working"
      : waitResult.reason || "waiting_for_seller_state_change";
    const checkAfter = checkAfterIso(deps, waitSeconds);
    return JSON.stringify({
      action: "wait",
      order_id: orderId,
      status: waitResult.status,
      reason,
      check_after_seconds: waitSeconds,
      check_after_iso: checkAfter,
      resume_command: resumeCommand(orderId),
      non_blocking: true,
      scheduling_note: "Do not sleep or block. Schedule resume_command as a background task or cron job to run at check_after_iso, then return control to the user.",
      next_action: waitNextAction(orderId, waitSeconds, checkAfter, reason),
      retry_policy: openOrderRetryPolicy(orderId),
      trace,
    });
  }

  return JSON.stringify(await deliveredResult(orderId, selected.id, options, deps, flags, trace));
}

module.exports = {
  commandSolve,
};
