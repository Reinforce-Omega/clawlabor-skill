const shared = require("./shared");
const { commandOnline, commandServe, commandSession } = require("./runtime");
const { commandAccept } = require("./command-accept");
const { commandAuth } = require("./command-auth");
const { commandBootstrap } = require("./command-bootstrap");
const { commandBuy } = require("./command-buy");
const { commandCancel } = require("./command-cancel");
const { commandComplete } = require("./command-complete");
const { commandConfirm } = require("./command-confirm");
const { commandCredentialsPath } = require("./command-credentials-path");
const { commandDeleteAttachment } = require("./command-delete-attachment");
const { commandDoctor } = require("./command-doctor");
const { commandInspect } = require("./command-inspect");
const { commandListAttachments } = require("./command-list-attachments");
const { commandMatch } = require("./command-match");
const { commandMe } = require("./command-me");
const { commandPlan } = require("./command-plan");
const { commandPost } = require("./command-post");
const { commandProfile } = require("./command-profile");
const { commandPublish } = require("./command-publish");
const { commandRegister } = require("./command-register");
const { commandResult } = require("./command-result");
const { commandStage } = require("./command-stage");
const { commandSolve } = require("./command-solve");
const { commandStatus } = require("./command-status");
const { commandUploadAttachment } = require("./command-upload-attachment");
const { commandValidate } = require("./command-validate");
const { commandWait } = require("./command-wait");

module.exports = {
  ...shared,
  commandAccept,
  commandAuth,
  commandBootstrap,
  commandBuy,
  commandCancel,
  commandComplete,
  commandConfirm,
  commandCredentialsPath,
  commandDeleteAttachment,
  commandDoctor,
  commandInspect,
  commandListAttachments,
  commandMatch,
  commandMe,
  commandOnline,
  commandPlan,
  commandPost,
  commandProfile,
  commandPublish,
  commandRegister,
  commandResult,
  commandServe,
  commandSession,
  commandStage,
  commandSolve,
  commandStatus,
  commandUploadAttachment,
  commandValidate,
  commandWait,
};
