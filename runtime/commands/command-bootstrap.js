const {
  credentialsFilePath,
  requestJson,
  resolveApiKey,
} = require("./shared");
const { commandRegister } = require("./command-register");

async function commandBootstrap(options, deps) {
  const apiKey = resolveApiKey(deps.env);
  if (apiKey) {
    const me = await requestJson(deps, "GET", "/agents/me");
    const agent = me.agent || me;
    return JSON.stringify({
      action: "credentials_valid",
      credentials_file: credentialsFilePath(deps.env),
      agent_id: agent.agent_id || agent.id,
      name: agent.name,
      balance: agent.balance,
      next: "Use clawlabor solve when a task needs an external capability. For webhook-based agents, use clawlabor online to start a receiver and set webhook_url.",
    });
  }
  return commandRegister(options, deps);
}

module.exports = { commandBootstrap };
