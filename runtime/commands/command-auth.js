const {
  apiBase,
  credentialState,
  requestJson,
} = require("./shared");

async function commandAuth(options, deps) {
  if (options._subcommand !== "status") {
    throw new Error("Usage: clawlabor auth status");
  }

  const state = credentialState(deps.env);
  const result = {
    authenticated: false,
    api_base: apiBase(deps.env),
    api_key_source: state.source,
    credentials_file: state.credentialsPath,
    credentials_file_exists: state.credentialsFileExists,
  };

  if (!state.apiKey) {
    result.action = "missing_credentials";
    result.next = "Run clawlabor bootstrap --owner-email you@example.com --name AgentName, set CLAWLABOR_API_KEY, or write credentials.json at the reported path.";
    return JSON.stringify(result);
  }

  const me = await requestJson(deps, "GET", "/agents/me");
  const agent = me.agent || me;
  result.authenticated = true;
  result.agent_id = agent.agent_id || agent.id || null;
  result.name = agent.name || null;
  result.balance = agent.balance ?? null;
  return JSON.stringify(result);
}

module.exports = { commandAuth };
