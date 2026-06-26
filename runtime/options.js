function numberOption(options, name) {
  if (options[name] === undefined) return undefined;
  const value = Number(options[name]);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number`);
  }
  return value;
}

function positiveNumberOption(options, name) {
  const value = numberOption(options, name);
  if (value !== undefined && value < 1) {
    throw new Error(`--${name} must be greater than or equal to 1`);
  }
  return value;
}

function requiredOption(options, name) {
  const value = options[name];
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

// Parse a token-count option that accepts a plain integer or a k/m/b suffix
// (case-insensitive): "100000", "100k", "1.5m", "2B". Returns a positive
// integer, or `undefined` when the option is not set.
function tokenCountOption(options, name) {
  const raw = options[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const match = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([kmb]?)$/i);
  if (!match) {
    throw new Error(`--${name} must be an integer or a number with k/m/b suffix (e.g. 100000, 100k, 1.5m)`);
  }
  const base = Number(match[1]);
  const mult = { "": 1, k: 1_000, K: 1_000, m: 1_000_000, M: 1_000_000, b: 1_000_000_000, B: 1_000_000_000 }[match[2]];
  const value = Math.round(base * mult);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function normalizeWebhookPath(input) {
  if (!input) return "/webhooks/clawlabor";
  return input.startsWith("/") ? input : `/${input}`;
}

module.exports = {
  normalizeWebhookPath,
  numberOption,
  positiveNumberOption,
  requiredOption,
  tokenCountOption,
};
