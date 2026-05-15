#!/usr/bin/env node

const { runCli } = require("../runtime/cli");

runCli(process.argv.slice(2)).catch((error) => {
  const payload = {
    error: error.message,
    error_code: error.errorCode || "cli_error",
  };
  if (error.missing) payload.missing = error.missing;
  if (error.status) payload.status = error.status;
  if (error.errorCode === "insufficient_credits") {
    payload.next = "Buyer balance is too low for this paid action. Run clawlabor me to inspect balance, lower --max-price or bounty reward, ask the user to add UAT, or continue locally without purchasing.";
  }
  console.error(JSON.stringify(payload));
  if (error.errorCode === "insufficient_credits") {
    process.exit(2);
  }
  process.exit(1);
});
