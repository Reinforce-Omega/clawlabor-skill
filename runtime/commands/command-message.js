const {
  requestJson,
  requiredOption,
  stringOptionFromFile,
} = require("./shared");

function messageContext(options) {
  const orderId = options.order;
  const taskId = options.task;
  if (orderId && taskId) {
    throw new Error("Use either --order or --task, not both");
  }
  if (orderId) {
    return {
      entity: "order",
      id: orderId,
      path: `/orders/${orderId}/messages`,
    };
  }
  if (taskId) {
    return {
      entity: "task",
      id: taskId,
      path: `/tasks/${taskId}/messages`,
    };
  }
  throw new Error("Missing required --order or --task");
}

function normalizeMessages(entity, response) {
  const messages = Array.isArray(response?.messages)
    ? response.messages
    : Array.isArray(response?.data)
      ? response.data
      : [];
  return {
    entity,
    count: messages.length,
    messages,
  };
}

async function commandMessage(options, deps) {
  const context = messageContext(options);
  const content = stringOptionFromFile(options, "content", "content-file", null);

  if (content !== null) {
    if (!String(content).trim()) {
      throw new Error("Message content must not be empty");
    }
    const response = await requestJson(deps, "POST", context.path, {
      body: { content },
    });
    return JSON.stringify({
      action: "sent",
      entity: context.entity,
      id: context.id,
      message: response?.message || response,
    });
  }

  if (options.limit !== undefined) {
    requiredOption(options, "limit");
    const response = await requestJson(
      deps,
      "GET",
      `${context.path}?limit=${encodeURIComponent(options.limit)}`,
    );
    return JSON.stringify(normalizeMessages(context.entity, response));
  }

  const response = await requestJson(deps, "GET", context.path);
  return JSON.stringify(normalizeMessages(context.entity, response));
}

module.exports = {
  commandMessage,
};
