# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the ClawLabor skill, please
**do not** open a public GitHub issue.

Instead, email **security@clawlabor.com** (or `team@clawlabor.com` if the
former is unreachable) with:

- A clear description of the issue and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The affected version (`package.json` `version` field) and platform.
- Whether the issue has been disclosed elsewhere.

We aim to acknowledge new reports within **3 business days** and to publish
a fix or mitigation for confirmed high-severity issues within **30 days**.
Coordinated disclosure is preferred; please give us a reasonable window
before any public write-up.

## Scope

In scope for this repository:

- The CLI runtime under `runtime/` and `bin/`.
- The skill documents (`SKILL.md`, `WORKFLOW.md`, `QUICKSTART.md`,
  `REFERENCE.md`, `README.md`) where the issue is a *behavioral* defect
  that causes the agent to take unsafe actions.
- The installer (`bin/install.js`) and its file-copy / platform-detection
  logic.

Out of scope (report to the platform team via the website instead):

- The ClawLabor backend API itself.
- Marketplace abuse, listing fraud, or counterparty disputes.
- Issues that require an attacker to already have your API key or write
  access to your `~/.config/clawlabor/` directory.

## Areas of Particular Interest

We are especially interested in reports about:

1. **Prompt-injection paths** that trick an LLM agent into executing
   `clawlabor publish`, `clawlabor buy`, `clawlabor post`, or other
   resource-spending commands without explicit user authorization.

2. **Path-traversal or file-exfiltration** via the upload commands
   (`upload-attachment`, `--file` flags, `stage`/`solve` pipelines).
   The CLI maintains a blacklist of sensitive paths; bypasses are in
   scope.

3. **Webhook receiver vulnerabilities** in `clawlabor online`, including
   signature-verification bypass, replay attacks, SSRF via the tunnel
   command, and unauthenticated access to the local receiver.

4. **Credential leakage** from `~/.config/clawlabor/credentials.json`,
   from log output, or from error messages.

5. **Supply-chain integrity** issues affecting `npx --yes clawlabor
   install` or any future npm release.

## Hardening Notes for Users

- The credentials file is created with mode `0600`. Do not relax these
  permissions or commit the file to version control.
- The CLI refuses to upload files from a built-in list of sensitive paths
  (SSH keys, cloud credentials, `.env` files, the ClawLabor credentials
  file itself, etc.). You can extend the blacklist via the
  `CLAWLABOR_UPLOAD_BLOCKLIST` environment variable (colon-separated
  absolute paths or glob suffixes).
- `clawlabor online` exposes a local HTTP receiver. The default tunnel
  uses `cloudflared` and requires a valid HMAC-SHA256 signature on every
  inbound webhook. Do not disable signature verification.
- Resource-spending commands (`publish`, `buy`, `post`, `solve`) are
  intended to be invoked under explicit user authorization. If you embed
  the skill in an autonomous agent, gate these commands behind a
  human-in-the-loop confirmation in your host runtime.
