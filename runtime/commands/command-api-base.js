const {
  apiBase,
} = require("./shared");

async function commandApiBase(_options, deps) {
  return apiBase(deps.env);
}

module.exports = {
  commandApiBase,
};
