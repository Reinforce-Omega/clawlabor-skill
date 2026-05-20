const { requestJson, positiveNumberOption } = require("./shared");

const ALLOWED_ROLES = new Set(["buyer", "seller", "all"]);

function parseSince(value) {
  if (!value) return null;
  const match = /^(\d+)\s*([smhd])$/i.exec(String(value).trim());
  if (!match) {
    throw new Error(
      `Invalid --since value "${value}". Use forms like 30m, 2h, 7d, 90s.`,
    );
  }
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const seconds = unit === "s" ? n : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
  return new Date(Date.now() - seconds * 1000);
}

function compactOrder(order) {
  if (!order || typeof order !== "object") return order;
  const counterparty = order.role === "seller"
    ? order.buyer || order.buyer_agent || null
    : order.seller || order.seller_agent || null;
  return {
    id: order.id || order.order_id || null,
    status: order.status || null,
    role: order.role || null,
    sku_id: order.sku_id || order.listing_id || null,
    sku_title: order.sku_title || order.listing_title || order.title || null,
    price: order.price ?? order.total_price ?? null,
    counterparty: counterparty
      ? {
          id: counterparty.id || counterparty.agent_id || null,
          name: counterparty.name || null,
        }
      : null,
    created_at: order.created_at || null,
    updated_at: order.updated_at || null,
    deadline_at:
      order.deadline_at || order.accept_deadline_at || order.complete_deadline_at || null,
  };
}

async function commandOrders(options, deps) {
  const role = (options.as || options.role || "all").toLowerCase();
  if (!ALLOWED_ROLES.has(role)) {
    throw new Error(
      `Unknown --as value "${role}". Use one of: buyer, seller, all.`,
    );
  }

  const statusFilter = options.status || null;
  const limit = positiveNumberOption(options, "limit") || 20;
  const page = positiveNumberOption(options, "page") || 1;
  const sinceCutoff = parseSince(options.since);
  const compact = !options.raw;

  const params = new URLSearchParams();
  if (role !== "all") params.set("role", role);
  if (statusFilter) params.set("status", statusFilter);
  params.set("limit", String(limit));
  params.set("page", String(page));

  const data = await requestJson(deps, "GET", `/orders?${params.toString()}`);
  const orders = Array.isArray(data?.orders) ? data.orders : [];

  let filtered = orders;
  if (sinceCutoff) {
    filtered = orders.filter((o) => {
      const ts = o.updated_at || o.created_at;
      if (!ts) return true;
      const d = new Date(ts);
      return !Number.isNaN(d.getTime()) && d >= sinceCutoff;
    });
  }

  return JSON.stringify({
    action: "orders",
    filter: {
      as: role,
      status: statusFilter,
      since: options.since || null,
      page,
      limit,
    },
    pagination: data?.pagination || null,
    count: filtered.length,
    orders: compact ? filtered.map(compactOrder) : filtered,
  });
}

module.exports = {
  commandOrders,
};
