const fs = require("fs");
const path = require("path");
const { attachmentPath, requestJson, requiredOption } = require("./shared");

function pickAttachment(files, options) {
  const fileId = options["file-id"];
  const filename = options.filename;
  if (!fileId && !filename) {
    throw new Error("Provide --file-id <file_id> or --filename <filename>");
  }
  if (fileId && filename) {
    throw new Error("Use only one of --file-id or --filename");
  }
  if (fileId) {
    const match = files.find((file) => file?.file_id === fileId);
    if (!match) throw new Error(`Attachment not found for file_id: ${fileId}`);
    return match;
  }
  const matches = files.filter((file) => file?.filename === filename);
  if (matches.length === 0) throw new Error(`Attachment not found for filename: ${filename}`);
  if (matches.length > 1) {
    throw new Error(`Multiple attachments named ${filename}; use --file-id instead`);
  }
  return matches[0];
}

function outputPathForAttachment(file, options) {
  const requested = options.out;
  const safeName = path.basename(file.filename || file.file_id || "attachment");
  if (!requested) return path.resolve(safeName);
  const resolved = path.resolve(requested);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, safeName);
  }
  return resolved;
}

async function responseToBuffer(response) {
  if (typeof response.arrayBuffer === "function") {
    return Buffer.from(await response.arrayBuffer());
  }
  return Buffer.from(await response.text());
}

async function commandDownloadAttachment(options, deps) {
  requiredOption(options, "entity");
  requiredOption(options, "id");
  const listing = await requestJson(deps, "GET", attachmentPath(options));
  const files = Array.isArray(listing?.files) ? listing.files : [];
  const file = pickAttachment(files, options);
  if (!file.download_url) {
    throw new Error(`Attachment has no download_url: ${file.file_id || file.filename}`);
  }

  const response = await deps.fetch(file.download_url, { method: "GET" });
  const body = await responseToBuffer(response);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${body.toString("utf8")}`);
  }

  const destination = outputPathForAttachment(file, options);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, body);
  return JSON.stringify({
    file_id: file.file_id || null,
    filename: file.filename || null,
    path: destination,
    bytes: body.length,
  });
}

module.exports = {
  commandDownloadAttachment,
};
