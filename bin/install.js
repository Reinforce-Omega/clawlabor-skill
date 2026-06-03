#!/usr/bin/env node

/**
 * ClawLabor Skill Installer
 *
 * Installs the ClawLabor skill into the appropriate directory for:
 * - Claude Code: ~/.claude/skills/clawlabor/
 * - OpenClaw:    ~/.openclaw/skills/clawlabor/
 * - Codex CLI:   ~/.codex/skills/clawlabor/
 * - Hermes:      ~/.hermes/skills/clawlabor/
 *
 * Usage:
 *   npx --yes clawlabor install            # Install for all detected platforms
 *   npx --yes clawlabor install --claude    # Install for Claude Code only
 *   npx --yes clawlabor install --openclaw  # Install for OpenClaw only
 *   npx --yes clawlabor install --codex     # Install for Codex CLI only
 *   npx --yes clawlabor install --hermes    # Install for Hermes only
 *   npx --yes clawlabor install --project   # Install in current project's agent skill dirs
 *   npx --yes clawlabor install --uninstall # Remove from all platforms
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const SKILL_NAME = "clawlabor";
const PLATFORM_FLAGS = ["claude", "openclaw", "codex", "hermes"];

// HOME and target paths are computed *lazily* (per runInstaller call) so tests
// can mock process.env.HOME after this module is required without leaking real
// installations into the test side-effects.
function resolveHome() {
  return process.env.HOME || os.homedir();
}

function platformsFor(home) {
  return {
    claude: path.join(home, ".claude", "skills", SKILL_NAME),
    openclaw: path.join(home, ".openclaw", "skills", SKILL_NAME),
    codex: path.join(home, ".codex", "skills", SKILL_NAME),
    hermes: path.join(home, ".hermes", "skills", SKILL_NAME),
  };
}

function projectPlatformsFor(cwd) {
  return {
    claude: path.join(cwd, ".claude", "skills", SKILL_NAME),
    openclaw: path.join(cwd, ".openclaw", "skills", SKILL_NAME),
    codex: path.join(cwd, ".codex", "skills", SKILL_NAME),
    hermes: path.join(cwd, ".hermes", "skills", SKILL_NAME),
  };
}

const FILES_TO_COPY = [
  "package.json",
  "SKILL.md",
  "REFERENCE.md",
  "WORKFLOW.md",
  "QUICKSTART.md",
  "LICENSE",
  "COPYRIGHT",
];

const DIRS_TO_COPY = ["examples", "runtime", "bin", "docs"];
const DOCS_URL = "https://www.clawlabor.com/skill.md";

function copySkillFiles(targetDir) {
  const sourceDir = path.resolve(__dirname, "..");

  // A previous symlink-mode install may have left `targetDir` as a symlink
  // (often dangling, once the global package it pointed at was removed).
  // `mkdirSync` throws ENOENT on a dangling symlink, so clear it first.
  clearExistingPath(targetDir);

  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of FILES_TO_COPY) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  for (const dir of DIRS_TO_COPY) {
    const srcDir = path.join(sourceDir, dir);
    const destDir = path.join(targetDir, dir);
    if (fs.existsSync(srcDir)) {
      copyDirectoryRecursive(srcDir, destDir);
    }
  }
}

const COPY_SKIP_NAMES = new Set([".DS_Store", "Thumbs.db"]);

function copyDirectoryRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (COPY_SKIP_NAMES.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function resolveNpmRoot() {
  // Test escape hatch so unit tests can avoid running real npm and avoid touching
  // the user's machine.
  if (process.env.CLAWLABOR_NPM_ROOT_OVERRIDE) {
    return process.env.CLAWLABOR_NPM_ROOT_OVERRIDE;
  }
  const result = spawnSync("npm", ["root", "-g"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout.trim() || null;
}

function canonicalSkillDir() {
  const npmRoot = resolveNpmRoot();
  if (!npmRoot) return null;
  const candidate = path.join(npmRoot, SKILL_NAME);
  return fs.existsSync(candidate) ? candidate : null;
}

function safeLstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Remove whatever currently occupies `p`, if anything. Symlinks (including
// dangling ones) MUST be unlinked: `fs.rmSync(p, { recursive, force })`
// follows the link, hits ENOENT on a dangling target, and — because of
// `force` — silently no-ops, leaving the dead link in place.
function clearExistingPath(p) {
  const stat = safeLstat(p);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(p);
    return;
  }
  fs.rmSync(p, { recursive: true, force: true });
}

function symlinkTarget(target, sourceDir) {
  // Replace whatever's at `target` (file / dir / existing symlink) with a fresh
  // symlink → sourceDir. Returns { ok, error? }. Windows or hardened sandboxes
  // may refuse symlink creation; caller falls back to copy mode.
  clearExistingPath(target);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(sourceDir, target, "dir");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function removeSkillDir(targetDir) {
  if (fs.existsSync(targetDir) || safeLstat(targetDir)) {
    clearExistingPath(targetDir);
    return true;
  }
  return false;
}

function detectPlatforms(home) {
  const detected = [];
  if (fs.existsSync(path.join(home, ".claude"))) detected.push("claude");
  if (fs.existsSync(path.join(home, ".openclaw"))) detected.push("openclaw");
  if (fs.existsSync(path.join(home, ".codex"))) detected.push("codex");
  if (fs.existsSync(path.join(home, ".hermes"))) detected.push("hermes");
  // If none detected, default to claude
  if (detected.length === 0) detected.push("claude");
  return detected;
}

function selectedPlatformFlags(flags) {
  return PLATFORM_FLAGS.filter((name) => flags.has(name));
}

function targetFor(platform, projectMode, platforms, projectPlatforms) {
  return {
    name: projectMode ? `project:${platform}` : platform,
    dir: projectMode ? projectPlatforms[platform] : platforms[platform],
  };
}

function selectedTargets(flags, platforms, projectPlatforms, home) {
  const selected = selectedPlatformFlags(flags);
  if (flags.has("project")) {
    const list = selected.length > 0 ? selected : PLATFORM_FLAGS;
    return list.map((platform) => targetFor(platform, true, platforms, projectPlatforms));
  }
  if (selected.length > 0) {
    return selected.map((platform) => targetFor(platform, false, platforms, projectPlatforms));
  }
  return detectPlatforms(home).map((platform) => targetFor(platform, false, platforms, projectPlatforms));
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function dependencyHints() {
  const hints = [];
  if (!commandAvailable("cloudflared")) {
    hints.push([
      "  - cloudflared is not on PATH. Default `clawlabor online` uses Cloudflare Tunnel.",
      "    macOS: brew install cloudflared",
      "    Other platforms: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
      "    You can also bypass tunneling with: clawlabor online --webhook-url <https-url>",
    ].join("\n"));
  }
  return hints;
}

// --- Main ---

function runInstaller(rawArgs = process.argv.slice(2)) {
  const flags = new Set(rawArgs.map((a) => a.replace(/^--/, "")));
  const home = resolveHome();
  const platforms = platformsFor(home);
  const projectPlatforms = projectPlatformsFor(process.cwd());

  if (flags.has("help") || flags.has("h")) {
    console.log(`
ClawLabor Skill Installer

Usage:
  npx --yes clawlabor install                     Install for all detected platforms
  npx --yes clawlabor install --claude            Install for Claude Code only
  npx --yes clawlabor install --openclaw          Install for OpenClaw only
  npx --yes clawlabor install --codex             Install for Codex CLI only
  npx --yes clawlabor install --hermes            Install for Hermes only
  npx --yes clawlabor install --project           Install in current project's .claude/.openclaw/.codex/.hermes skill dirs
  npx --yes clawlabor install --project --codex   Install in current project's .codex/skills/ only
  npx --yes clawlabor install --uninstall         Remove from all platforms
  npx --yes clawlabor install --help              Show this help

(Legacy GitHub installer remains supported via:
  npx --yes github:Reinforce-Omega/clawlabor-skill [...flags])

After installation, bootstrap credentials:
  clawlabor bootstrap
  clawlabor bootstrap --owner-email "you@example.com" --name "My Agent"

If clawlabor is not on PATH:
  <skill-dir>/bin/clawlabor.js bootstrap

Docs:
  ${DOCS_URL}
`);
    return { action: "help", code: 0 };
  }

  if (flags.has("uninstall")) {
    console.log("Uninstalling ClawLabor skill...\n");
    const removed = [];
    for (const [platform, dir] of Object.entries(platforms)) {
      if (removeSkillDir(dir)) {
        console.log(`  Removed from ${platform}: ${dir}`);
        removed.push({ name: platform, dir });
      }
    }
    for (const [platform, dir] of Object.entries(projectPlatforms)) {
      if (removeSkillDir(dir)) {
        console.log(`  Removed from project:${platform}: ${dir}`);
        removed.push({ name: `project:${platform}`, dir });
      }
    }
    if (removed.length === 0) {
      console.log("  No installations found.");
    }
    return { action: "uninstall", removed, code: 0 };
  }

  const targets = selectedTargets(flags, platforms, projectPlatforms, home);
  const installed = [];
  const failed = [];

  // Symlink mode: when `npm i -g clawlabor` has installed the package globally,
  // point every agent's skill dir at that one canonical location so
  // `npm i -g clawlabor@latest` propagates to all agents automatically.
  // `--copy` forces classic per-target file copies (useful on Windows without
  // dev mode, or when an agent runtime can't follow symlinks).
  const canonical = flags.has("copy") ? null : canonicalSkillDir();
  const symlinkPreferred = canonical !== null;

  if (symlinkPreferred) {
    console.log(`Linking ClawLabor skill from ${canonical} ...\n`);
  } else {
    console.log("Installing ClawLabor skill...\n");
  }

  for (const { name, dir } of targets) {
    if (symlinkPreferred) {
      const link = symlinkTarget(dir, canonical);
      if (link.ok) {
        console.log(`  Linked ${name} -> ${canonical}`);
        installed.push({ name, dir, mode: "link", target: canonical });
        continue;
      }
      console.log(`  Symlink failed for ${name} (${link.error}); falling back to copy`);
    }
    try {
      copySkillFiles(dir);
      console.log(`  Installed (copy) for ${name}: ${dir}`);
      installed.push({ name, dir, mode: "copy" });
    } catch (err) {
      console.error(`  Failed for ${name}: ${err.message}`);
      failed.push({ name, dir, error: err.message });
    }
  }

  const hints = dependencyHints();

  console.log(`

  ClawLabor skill installed!

  Next steps:

  1. Bootstrap credentials:
     clawlabor bootstrap

     If this agent is not registered yet:
     clawlabor bootstrap --owner-email "you@example.com" --name "My Agent"

     If clawlabor is not on PATH:
     <skill-dir>/bin/clawlabor.js bootstrap

  2. Use the runtime CLI when work needs outside capabilities:
     clawlabor solve --goal "Analyze competitor" --requirement-json '{"url":"https://example.com"}'

  3. Choose a listening strategy before going live:
     clawlabor online

  4. Start using it in your agent:
     "Use ClawLabor when this task needs capabilities beyond local tools."

  Docs: ${DOCS_URL}

`);

  if (hints.length > 0) {
    console.log("Optional dependency checks:\n");
    console.log(hints.join("\n\n"));
    console.log("");
  }

  return { action: "install", installed, failed, hints, code: failed.length > 0 ? 1 : 0 };
}

if (require.main === module) {
  const result = runInstaller();
  process.exit(result.code || 0);
}

module.exports = { runInstaller };
