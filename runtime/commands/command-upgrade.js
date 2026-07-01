function installerArgsFromFlags(flags) {
  const args = [];
  for (const flag of flags) {
    args.push(`--${flag}`);
  }
  return args;
}

async function commandUpgrade(_options, deps, flags) {
  const spawnSync = deps.spawnSync;
  const install = spawnSync("npm", ["install", "-g", "clawlabor@latest"], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error("Failed to upgrade ClawLabor with `npm install -g clawlabor@latest`");
  }

  const reinstallArgs = ["install", ...installerArgsFromFlags(flags)];
  const reinstall = spawnSync("clawlabor", reinstallArgs, {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (reinstall.status !== 0) {
    return JSON.stringify({
      action: "upgraded",
      package: "clawlabor@latest",
      skill_reinstall: "failed",
      next: `Package upgrade succeeded. Refresh skill files manually with: clawlabor ${reinstallArgs.join(" ")}`,
    });
  }

  return JSON.stringify({
    action: "upgraded",
    package: "clawlabor@latest",
    skill_reinstall: "ok",
  });
}

module.exports = { commandUpgrade };
