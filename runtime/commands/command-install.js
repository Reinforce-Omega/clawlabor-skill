const { runInstaller } = require("../../bin/install");

function flagsToInstallerArgs(flags) {
  const args = [];
  for (const flag of flags) {
    args.push(`--${flag}`);
  }
  return args;
}

async function commandInstall(_options, _deps, flags) {
  const result = runInstaller(flagsToInstallerArgs(flags));
  return JSON.stringify({
    action: result.action,
    installed: result.installed || [],
    failed: result.failed || [],
    removed: result.removed || [],
    hints: result.hints || [],
  });
}

module.exports = { commandInstall };
