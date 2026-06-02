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
  if (error.errorCode === "requirement_invalid") {
    if (error.listingId) payload.listing_id = error.listingId;
    if (error.listingTitle) payload.listing_title = error.listingTitle;
    if (error.missingFieldHints) payload.missing_field_hints = error.missingFieldHints;
    if (error.sampleRequirement) payload.sample_requirement = error.sampleRequirement;
    if (error.planCommand) payload.plan_command = error.planCommand;
    if (error.rerunCommand) payload.rerun_command = error.rerunCommand;
    payload.next = "Run plan_command to preview the listing's required_fields and sample_requirement, replace any <TODO:...> placeholders, then re-run rerun_command.";
  }
  console.error(JSON.stringify(payload));
  if (error.errorCode === "insufficient_credits") {
    process.exit(2);
  }
  process.exit(1);
});
