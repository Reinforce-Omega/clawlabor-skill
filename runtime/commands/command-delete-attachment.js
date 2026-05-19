const { attachmentPath, request } = require("./shared");

async function commandDeleteAttachment(options, deps) {
  return request(deps, "DELETE", attachmentPath(options, true));
}

module.exports = {
  commandDeleteAttachment,
};
