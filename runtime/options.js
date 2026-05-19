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

function normalizeWebhookPath(input) {
  if (!input) return "/webhooks/clawlabor";
  return input.startsWith("/") ? input : `/${input}`;
}

module.exports = {
  normalizeWebhookPath,
  numberOption,
  positiveNumberOption,
  requiredOption,
};
