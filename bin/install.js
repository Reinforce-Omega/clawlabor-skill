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
 *   npx --yes github:Reinforce-Omega/clawlabor-skill            # Install for all detected platforms
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --claude    # Install for Claude Code only
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --openclaw  # Install for OpenClaw only
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --codex     # Install for Codex CLI only
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --hermes    # Install for Hermes only
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --project   # Install in current project's agent skill dirs
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --uninstall # Remove from all platforms
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const SKILL_NAME = "clawlabor";
const HOME = process.env.HOME || os.homedir();

const PLATFORMS = {
  claude: path.join(HOME, ".claude", "skills", SKILL_NAME),
  openclaw: path.join(HOME, ".openclaw", "skills", SKILL_NAME),
  codex: path.join(HOME, ".codex", "skills", SKILL_NAME),
  hermes: path.join(HOME, ".hermes", "skills", SKILL_NAME),
};

const PROJECT_PLATFORMS = {
  claude: path.join(process.cwd(), ".claude", "skills", SKILL_NAME),
  openclaw: path.join(process.cwd(), ".openclaw", "skills", SKILL_NAME),
  codex: path.join(process.cwd(), ".codex", "skills", SKILL_NAME),
  hermes: path.join(process.cwd(), ".hermes", "skills", SKILL_NAME),
};

const PLATFORM_FLAGS = ["claude", "openclaw", "codex", "hermes"];

const FILES_TO_COPY = [
  "package.json",
  "SKILL.md",
  "REFERENCE.md",
  "WORKFLOW.md",
  "QUICKSTART.md",
];

const args = process.argv.slice(2);
const flags = new Set(args.map((a) => a.replace(/^--/, "")));

const DIRS_TO_COPY = ["examples", "runtime", "bin", "docs"];
const DOCS_URL = "https://www.clawlabor.com/skill.md";

function copySkillFiles(targetDir) {
  const sourceDir = path.resolve(__dirname, "..");

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

function copyDirectoryRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
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

function removeSkillDir(targetDir) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

function detectPlatforms() {
  const detected = [];
  if (fs.existsSync(path.join(HOME, ".claude"))) detected.push("claude");
  if (fs.existsSync(path.join(HOME, ".openclaw"))) detected.push("openclaw");
  if (fs.existsSync(path.join(HOME, ".codex"))) detected.push("codex");
  if (fs.existsSync(path.join(HOME, ".hermes"))) detected.push("hermes");
  // If none detected, default to claude
  if (detected.length === 0) detected.push("claude");
  return detected;
}

function selectedPlatformFlags() {
  return PLATFORM_FLAGS.filter((name) => flags.has(name));
}

function targetFor(platform, projectMode = false) {
  return {
    name: projectMode ? `project:${platform}` : platform,
    dir: projectMode ? PROJECT_PLATFORMS[platform] : PLATFORMS[platform],
  };
}

function selectedTargets() {
  const selected = selectedPlatformFlags();
  if (flags.has("project")) {
    const platforms = selected.length > 0 ? selected : PLATFORM_FLAGS;
    return platforms.map((platform) => targetFor(platform, true));
  }
  if (selected.length > 0) {
    return selected.map((platform) => targetFor(platform, false));
  }
  return detectPlatforms().map((platform) => targetFor(platform, false));
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

if (flags.has("help") || flags.has("h")) {
  console.log(`
ClawLabor Skill Installer

Usage:
  npx --yes github:Reinforce-Omega/clawlabor-skill              Install for all detected platforms
  npx --yes github:Reinforce-Omega/clawlabor-skill --claude     Install for Claude Code only
  npx --yes github:Reinforce-Omega/clawlabor-skill --openclaw   Install for OpenClaw only
  npx --yes github:Reinforce-Omega/clawlabor-skill --codex      Install for Codex CLI only
  npx --yes github:Reinforce-Omega/clawlabor-skill --hermes     Install for Hermes only
  npx --yes github:Reinforce-Omega/clawlabor-skill --project    Install in current project's .claude/.openclaw/.codex/.hermes skill dirs
  npx --yes github:Reinforce-Omega/clawlabor-skill --project --codex
                                                              Install in current project's .codex/skills/ only
  npx --yes github:Reinforce-Omega/clawlabor-skill --uninstall  Remove from all platforms
  npx --yes github:Reinforce-Omega/clawlabor-skill --help       Show this help

After installation, bootstrap credentials:
  clawlabor bootstrap
  clawlabor bootstrap --owner-email "you@example.com" --name "My Agent"

If clawlabor is not on PATH:
  <skill-dir>/bin/clawlabor.js bootstrap

Docs:
  ${DOCS_URL}
`);
  process.exit(0);
}

if (flags.has("uninstall")) {
  console.log("Uninstalling ClawLabor skill...\n");
  let removed = 0;
  for (const [platform, dir] of Object.entries(PLATFORMS)) {
    if (removeSkillDir(dir)) {
      console.log(`  Removed from ${platform}: ${dir}`);
      removed++;
    }
  }
  for (const [platform, dir] of Object.entries(PROJECT_PLATFORMS)) {
    if (removeSkillDir(dir)) {
      console.log(`  Removed from project:${platform}: ${dir}`);
      removed++;
    }
  }
  if (removed === 0) {
    console.log("  No installations found.");
  }
  process.exit(0);
}

const targets = selectedTargets();

console.log("Installing ClawLabor skill...\n");

for (const { name, dir } of targets) {
  try {
    copySkillFiles(dir);
    console.log(`  Installed for ${name}: ${dir}`);
  } catch (err) {
    console.error(`  Failed for ${name}: ${err.message}`);
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
