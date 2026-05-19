const {
  fetchOrderCancellationContext,
  numberOption,
  requestJson,
  requiredOption,
  TERMINAL_ORDER_STATES,
} = require("./shared");

async function commandWait(options, deps) {
  const orderId = requiredOption(options, "order");
  const until = options.until || "pending_confirmation";
  const timeoutMs = (numberOption(options, "timeout") ?? 300) * 1000;
  const intervalMs = (numberOption(options, "interval") ?? 5) * 1000;
  const start = deps.now();
  let last = null;
  while (deps.now() - start < timeoutMs) {
    const detail = await requestJson(deps, "GET", `/orders/${orderId}`);
    last = detail.order || detail;
    const status = last?.status;
    if (status === until) {
      const cancellationContext =
        status === "cancelled" && !last?.cancel_reason
          ? await fetchOrderCancellationContext(deps, orderId)
          : null;
      return JSON.stringify({
        id: last.id,
        status,
        cancel_reason: last?.cancel_reason || null,
        reached: true,
        waited_ms: deps.now() - start,
        cancellation_context: cancellationContext,
      });
    }
    if (TERMINAL_ORDER_STATES.has(status) && status !== until) {
      const cancellationContext =
        status === "cancelled" && !last?.cancel_reason
          ? await fetchOrderCancellationContext(deps, orderId)
          : null;
      return JSON.stringify({
        id: last.id,
        status,
        cancel_reason: last?.cancel_reason || null,
        reached: false,
        reason: "terminal_state_before_target",
        waited_ms: deps.now() - start,
        cancellation_context: cancellationContext,
      });
    }
    await deps.sleep(intervalMs);
  }
  return JSON.stringify({
    id: last?.id || orderId,
    status: last?.status || null,
    reached: false,
    reason: "timeout",
    waited_ms: deps.now() - start,
  });
}

module.exports = {
  commandWait,
};
