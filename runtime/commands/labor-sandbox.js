const { spawnSync } = require("node:child_process");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function dockerName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function runtimeStateMounts(runtime, hireId) {
  const source = `clawlabor-hire-${dockerName(hireId)}-state`;
  const targets = {
    claude: ["/home/sandbox/.claude"],
    codex: ["/home/sandbox/.codex"],
    opencode: ["/home/sandbox/.local/share/opencode"],
  }[runtime] || [];
  return targets.map((target) => ({ source, target, type: "volume" }));
}

function runtimeStateInitCommand(mounts, { excludePaths = [] } = {}) {
  const targets = [
    "/home/sandbox/.local",
    "/home/sandbox/.cache",
    "/home/sandbox/.config",
    ...mounts.map((m) => m.target),
  ];
  if (targets.length === 0) return "true";
  const quoted = targets.map(shellQuote).join(" ");
  const excludes = excludePaths.map((p) => `! -path ${shellQuote(p)}`).join(" ");
  const recursiveChowns = targets
    .map((target) => `find ${shellQuote(target)} -mindepth 1 ${excludes} -exec chown sandbox:sandbox {} +`)
    .join(" && ");
  // Docker creates named volumes as root-owned directories. The runtime agents
  // run as the sandbox user, so normalize ownership before agent startup. Some
  // credentials are mounted read-only under these dirs and must be skipped.
  return `mkdir -p ${quoted} && chown sandbox:sandbox ${quoted} && ${recursiveChowns}`;
}

function sandboxUserCommand(command) {
  return `setpriv --reuid=sandbox --regid=sandbox --init-groups env HOME=/home/sandbox ${command}`;
}

function dockerContainerRunning(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && String(result.stdout || "").trim() === "true";
}

function hireStateVolumeName(hireId) {
  return `clawlabor-hire-${dockerName(hireId)}-state`;
}

function dockerVolumeExists(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["volume", "inspect", name], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function dockerRemoveVolume(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["volume", "rm", name], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function stopContainerByName(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  run("docker", ["rm", "-f", name], { stdio: "ignore" });
}

function restartContainerByName(name, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  return run("docker", ["restart", name], { stdio: "ignore" }).status === 0;
}

function terminateChild(child, signal = "SIGTERM") {
  if (!child || typeof child.kill !== "function") return;
  try {
    child.kill(signal);
  } catch (_err) { /* noop */ }
}

function terminateProcessGroup(child, signal = "SIGTERM", deps = {}) {
  if (!child) return;
  if (child.pid) {
    try {
      const killProcessGroup = deps.killProcessGroup || process.kill;
      killProcessGroup(-child.pid, signal);
      return;
    } catch (_err) { /* fall back to child kill */ }
  }
  terminateChild(child, signal);
}

function forceKillProcess(child, timeoutMs = 5000, deps = {}) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  if (typeof child.once !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      terminateProcessGroup(child, "SIGKILL", deps);
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function dockerImagePresent(image, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["image", "inspect", image], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function dockerPullImage(image, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("docker", ["pull", image], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return result.status === 0;
}

function ensureDockerImage(image, deps = {}, stdout = () => {}, { logPrefix = "[6/7]" } = {}) {
  if (dockerImagePresent(image, deps)) return;
  stdout(`${logPrefix} Pulling sandbox image ${image}...`);
  if (!dockerPullImage(image, deps)) {
    throw new Error(`Docker image ${image} is not available locally and docker pull failed`);
  }
}

async function removeContainerByNameAsync({ spawn, containerName, timeoutMs = 1500 }) {
  try {
    await new Promise((resolve) => {
      const dockerRm = spawn("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      if (dockerRm && typeof dockerRm.once === "function") {
        dockerRm.once("exit", () => resolve());
        setTimeout(resolve, timeoutMs);
      } else {
        resolve();
      }
    });
  } catch (_err) {
    /* noop */
  }
}

function clearPortOccupant({ port, containerName, stdout }) {
  try {
    const { execSync } = require("child_process");
    const occupied = execSync(
      `docker ps --filter "publish=${port}" --format '{{.Names}}'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (occupied && occupied !== containerName) {
      execSync(`docker rm -f ${occupied}`, { stdio: "ignore" });
      stdout(`Stopped existing container ${occupied} occupying port ${port}`);
    }
  } catch (_err) {
    /* best effort - if the command fails, let docker run surface the real error */
  }
}

function startSandboxContainer({
  spawn,
  stdout,
  image,
  port,
  runtime,
  hireId,
  containerName,
  sandboxToken,
  sandboxCreds,
  runtimeEnv,
  logPrefix = "[6/7]",
}) {
  clearPortOccupant({ port, containerName, stdout });
  stdout(`${logPrefix} Starting sandbox container (${image})...`);
  const credEnvFlags = Object.keys(sandboxCreds.env).flatMap((envName) => ["-e", envName]);
  const stateMounts = runtimeStateMounts(runtime, hireId);
  const readOnlyCredPaths = sandboxCreds.mounts.filter((m) => m.ro).map((m) => m.container);
  const stateMountFlags = stateMounts.flatMap((m) => [
    "--mount", `type=${m.type},source=${m.source},target=${m.target}`,
  ]);
  const credMountFlags = sandboxCreds.mounts.flatMap((m) => ["-v", `${m.host}:${m.container}${m.ro ? ":ro" : ""}`]);
  return spawn(
    "docker",
    [
      "run", "-d", "--rm", "--name", containerName, "-p", `127.0.0.1:${port}:2468`,
      // Start as root only long enough to repair fresh volume ownership;
      // agent install and the long-running server run as sandbox below.
      "-u", "root",
      "-e", "CLAWLABOR_AGENT_RUNTIME",
      ...credEnvFlags,
      ...stateMountFlags,
      ...credMountFlags,
      "--entrypoint", "sh",
      image,
      "-lc",
      [
        runtimeStateInitCommand(stateMounts, { excludePaths: readOnlyCredPaths }),
        sandboxUserCommand(`sandbox-clawlabor install-agent ${shellQuote(runtime)}`),
        runtimeStateInitCommand(stateMounts, { excludePaths: readOnlyCredPaths }),
        `exec ${sandboxUserCommand(`sandbox-clawlabor server --token=${shellQuote(sandboxToken)} --host 0.0.0.0 --port 2468`)}`,
      ].join(" && "),
    ],
    { stdio: "ignore", env: runtimeEnv },
  );
}

function dockerListHireStateVolumes(deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run(
    "docker",
    ["volume", "ls", "--filter", "name=clawlabor-hire-", "--format", "{{.Name}}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("clawlabor-hire-") && line.endsWith("-state"));
}

function hireIdFromVolumeName(volumeName) {
  const m = /^clawlabor-hire-(.+)-state$/.exec(volumeName);
  return m ? m[1] : null;
}

module.exports = {
  dockerName,
  shellQuote,
  runtimeStateMounts,
  runtimeStateInitCommand,
  sandboxUserCommand,
  dockerContainerRunning,
  hireStateVolumeName,
  dockerVolumeExists,
  dockerRemoveVolume,
  stopContainerByName,
  restartContainerByName,
  terminateChild,
  terminateProcessGroup,
  forceKillProcess,
  dockerImagePresent,
  dockerPullImage,
  ensureDockerImage,
  removeContainerByNameAsync,
  startSandboxContainer,
  dockerListHireStateVolumes,
  hireIdFromVolumeName,
};
