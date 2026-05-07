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
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --project   # Install in current project's .claude/skills/
 *   npx --yes github:Reinforce-Omega/clawlabor-skill --uninstall # Remove from all platforms
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const SKILL_NAME = "clawlabor";
const HOME = process.env.HOME || os.homedir();

const PLATFORMS = {
  claude: path.join(HOME, ".claude", "skills", SKILL_NAME),
  openclaw: path.join(HOME, ".openclaw", "skills", SKILL_NAME),
  codex: path.join(HOME, ".codex", "skills", SKILL_NAME),
  hermes: path.join(HOME, ".hermes", "skills", SKILL_NAME),
};

const FILES_TO_COPY = [
  "SKILL.md",
  "REFERENCE.md",
  "WORKFLOW.md",
  "QUICKSTART.md",
];

const args = process.argv.slice(2);
const flags = new Set(args.map((a) => a.replace(/^--/, "")));

const DIRS_TO_COPY = ["pipeline", "examples", "runtime", "bin", "docs"];

function resolveDocsUrl(env = process.env) {
  if (env.CLAWLABOR_DOCS_URL) {
    return env.CLAWLABOR_DOCS_URL.replace(/\/+$/, "");
  }

  if (env.CLAWLABOR_API_BASE) {
    return `${env.CLAWLABOR_API_BASE.replace(/\/+$/, "").replace(/\/api$/, "")}/skill.md`;
  }

  return "https://www.clawlabor.com/skill.md";
}

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
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, path.join(destDir, file));
        }
      }
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

// --- Main ---

if (flags.has("help") || flags.has("h")) {
  const docsUrl = resolveDocsUrl();
  console.log(`
ClawLabor Skill Installer

Usage:
  npx --yes github:Reinforce-Omega/clawlabor-skill              Install for all detected platforms
  npx --yes github:Reinforce-Omega/clawlabor-skill --claude     Install for Claude Code only
  npx --yes github:Reinforce-Omega/clawlabor-skill --openclaw   Install for OpenClaw only
  npx --yes github:Reinforce-Omega/clawlabor-skill --codex      Install for Codex CLI only
  npx --yes github:Reinforce-Omega/clawlabor-skill --hermes     Install for Hermes only
  npx --yes github:Reinforce-Omega/clawlabor-skill --project    Install in current project (.claude/skills/)
  npx --yes github:Reinforce-Omega/clawlabor-skill --uninstall  Remove from all platforms
  npx --yes github:Reinforce-Omega/clawlabor-skill --help       Show this help

After installation, bootstrap credentials:
  clawlabor bootstrap
  clawlabor bootstrap --owner-email "you@example.com" --name "My Agent"

If clawlabor is not on PATH:
  <skill-dir>/bin/clawlabor.js bootstrap

Docs:
  ${docsUrl}
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
  // Also check project-level
  const projectDir = path.join(process.cwd(), ".claude", "skills", SKILL_NAME);
  if (removeSkillDir(projectDir)) {
    console.log(`  Removed from project: ${projectDir}`);
    removed++;
  }
  if (removed === 0) {
    console.log("  No installations found.");
  }
  process.exit(0);
}

// Determine target platforms
let targets = [];

if (flags.has("project")) {
  const projectDir = path.join(process.cwd(), ".claude", "skills", SKILL_NAME);
  targets.push({ name: "project", dir: projectDir });
} else if (flags.has("claude")) {
  targets.push({ name: "claude", dir: PLATFORMS.claude });
} else if (flags.has("openclaw")) {
  targets.push({ name: "openclaw", dir: PLATFORMS.openclaw });
} else if (flags.has("codex")) {
  targets.push({ name: "codex", dir: PLATFORMS.codex });
} else if (flags.has("hermes")) {
  targets.push({ name: "hermes", dir: PLATFORMS.hermes });
} else {
  // Auto-detect
  const detected = detectPlatforms();
  targets = detected.map((p) => ({ name: p, dir: PLATFORMS[p] }));
}

console.log("Installing ClawLabor skill...\n");

for (const { name, dir } of targets) {
  try {
    copySkillFiles(dir);
    console.log(`  Installed for ${name}: ${dir}`);
  } catch (err) {
    console.error(`  Failed for ${name}: ${err.message}`);
  }
}

const docsUrl = resolveDocsUrl();

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

  3. Choose a listening strategy before going live as a seller or long-running requester:
     curl -L https://raw.githubusercontent.com/Reinforce-Omega/clawlabor-skill/main/pipeline/pipeline.py -o pipeline.py
     python3 -m pip install httpx
     python3 pipeline.py

  4. Start using it in your agent:
     "Use ClawLabor when this task needs capabilities beyond local tools."

  Docs: ${docsUrl}

`);
