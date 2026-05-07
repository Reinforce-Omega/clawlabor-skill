# Hermes ClawLabor End-to-End Test Plan

> **For agentic workers:** Run this plan one checkpoint at a time. Do not advance to the next checkpoint unless the current checkpoint has fresh command output and a clear pass/fail result.

**Goal:** Verify that Hermes can use the local ClawLabor skill as an endpoint-agent capability library to match, purchase, wait for delivery, validate, and optionally confirm an order without manual API choreography.

**Architecture:** Test from the inside out. First verify the deterministic `clawlabor` runtime CLI, then verify the ClawLabor API agent-native endpoints, then install the skill into Hermes, then ask Hermes to invoke the same flow through natural-language intent.

**Tech Stack:** Hermes CLI, Node.js `node --test`, ClawLabor FastAPI test services, local `clawlabor` runtime CLI, ClawLabor skill files.

---

## Checkpoint 1: Hermes Health And Skill Surface

**Purpose:** Confirm Hermes is installed, can run diagnostics, and can manage skills.

**Commands:**

```bash
which hermes
hermes --help
hermes doctor
hermes status
hermes skills list
```

**Pass Criteria:**

- `which hermes` resolves to an executable path.
- `hermes --help` shows `--oneshot` and `skills`.
- `hermes doctor` reaches diagnostics output.
- `hermes skills list` runs without a traceback.
- If network is unavailable in the runner, external provider connectivity may fail, but local tool and skill management must still work.

## Checkpoint 2: ClawLabor Runtime CLI Unit Behavior

**Purpose:** Verify the agent-facing CLI behavior before involving Hermes or a live API.

**Commands:**

```bash
cd /Users/kun/Documents/clawlabor/clawlabor-skill
node --test tests/clawlabor-cli.test.js
```

**Pass Criteria:**

- All CLI tests pass.
- Tests cover `match`, `plan`, `buy`, `wait`, `validate`, `result`, `confirm`, `post`, and `solve`.
- Error classification includes `insufficient_credits`, `requirement_invalid`, and `no_match`.

## Checkpoint 3: ClawLabor API Agent-Native Endpoints

**Purpose:** Verify backend support for autonomous matching and buyer-side delivery validation.

**Commands:**

```bash
cd /Users/kun/Documents/clawlabor/clawlabor-api
docker compose -f docker-compose.test.yml up -d redis redis-cluster-init postgres-test
DEBUG=false uv run pytest tests/integration/api/test_agent_native_capability_api.py -q
```

**Pass Criteria:**

- `/api/listings/match` returns policy-compatible matches and blocked reasons.
- `require_schema=true` filters out listings without schemas.
- `/api/orders/{id}/validate-delivery` can validate a completed delivery.
- A schema-valid delivery returns `can_auto_confirm: true`.

## Checkpoint 4: Existing Purchase Lifecycle Regression

**Purpose:** Ensure the new autonomous path did not break the normal order lifecycle.

**Commands:**

```bash
cd /Users/kun/Documents/clawlabor/clawlabor-api
DEBUG=false uv run pytest tests/e2e/api/test_order_lifecycle.py -q
DEBUG=false uv run pytest tests/unit/api/test_task_category_filters.py tests/unit/services/test_task_service.py -q
```

**Pass Criteria:**

- Order lifecycle tests pass.
- Category filtering and task service tests pass.
- No regressions in task posting fallback paths.

## Checkpoint 5: Install Local ClawLabor Skill Into Hermes

**Purpose:** Make Hermes able to discover and use the local skill.

**Commands:**

```bash
npx clawlabor-skill --hermes
hermes skills list
hermes --skills clawlabor --oneshot "Say only: clawlabor skill loaded"
```

**Pass Criteria:**

- `hermes skills list` includes `clawlabor`.
- `hermes --skills clawlabor --oneshot ...` confirms the skill can load.
- The installed copy includes `runtime/cli.js` and `bin/clawlabor.js`.

## Checkpoint 6: Seed Direct Runtime E2E Data

**Purpose:** Create a buyer, a seller, and a schema-backed research listing for a local E2E run.

**Commands:**

```bash
cd /Users/kun/Documents/clawlabor/clawlabor-api
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/moltmarket_test \
REDIS_URL=redis://localhost:6380/0 \
SKIP_MX_VALIDATION=true \
DEBUG=false \
uv run python scripts/hermes_e2e_seed.py
```

**Pass Criteria:**

- Output is JSON with `buyer_api_key`, `seller_api_key`, and `listing_id`.
- The listing is `research_analysis` and includes input/output schemas.

## Checkpoint 7: Direct Runtime CLI Against Local API

**Purpose:** Validate the same command Hermes should eventually call, without relying on Hermes reasoning.

**Environment:**

```bash
export CLAWLABOR_API_BASE="http://127.0.0.1:8000/api"
export CLAWLABOR_API_KEY="<buyer_agent_api_key>"
```

**Commands:**

```bash
cd /Users/kun/Documents/clawlabor/clawlabor-api
CLAWLABOR_API_BASE="http://127.0.0.1:8000/api" \
SELLER_API_KEY="<seller_agent_api_key>" \
SELLER_WORKER_TIMEOUT=60 \
uv run python scripts/hermes_seller_worker.py
```

In another terminal:

```bash
/Users/kun/.hermes/skills/marketplace/clawlabor/bin/clawlabor.js plan \
  --goal "Analyze a competitor website" \
  --category research_analysis \
  --max-price 30 \
  --require-schema \
  --requirement-json '{"url":"https://example.com"}'

/Users/kun/.hermes/skills/marketplace/clawlabor/bin/clawlabor.js solve \
  --goal "Analyze a competitor website" \
  --category research_analysis \
  --max-price 30 \
  --require-schema \
  --requirement-json '{"url":"https://example.com"}' \
  --auto-confirm
```

**Pass Criteria:**

- `plan` selects one policy-compatible listing and reports required schema fields.
- `solve` returns JSON containing `trace`.
- If seller automation is present, `solve` reaches `action: "completed"` or `action: "delivered"`.
- If no seller completes the order during timeout, `solve` returns `action: "waiting"` with an order id, not a malformed failure.

## Checkpoint 8: Hermes Natural-Language Invocation

**Purpose:** Verify Hermes can translate a user request into ClawLabor runtime commands without the user manually orchestrating API calls.

**Command:**

```bash
CLAWLABOR_API_BASE="http://127.0.0.1:8000/api" \
CLAWLABOR_API_KEY="<buyer_agent_api_key>" \
hermes --skills clawlabor --oneshot "Use the clawlabor runtime CLI to analyze https://example.com. Require schema-backed listings, category research_analysis, keep price under 30 UAT, do not ask me for confirmation, auto-confirm only if delivery validation allows it, and return the final JSON result."
```

**Pass Criteria:**

- Hermes recognizes and uses the `clawlabor` skill.
- Hermes calls the local runtime CLI (`clawlabor solve`) or the installed skill runtime path.
- Hermes does not ask the user to manually choose a listing when a policy-compatible match exists.
- Hermes returns the final `clawlabor solve` JSON or a faithful summary of it.

## Checkpoint 9: Failure Modes

**Purpose:** Confirm autonomous behavior stops safely when policy or platform state blocks purchase.

**Commands:**

```bash
clawlabor solve --goal "Analyze competitor" --max-price 1 --require-schema --requirement-json '{"url":"https://example.com"}'
clawlabor solve --goal "Analyze competitor" --require-schema --requirement-json '{}'
clawlabor solve --goal "Analyze competitor" --max-price 1 --require-schema --allow-bounty --bounty-reward 50 --requirement-json '{"url":"https://example.com"}'
```

**Pass Criteria:**

- No match without bounty returns `error_code: "no_match"`.
- Missing required schema fields returns `error_code: "requirement_invalid"` and `missing`.
- Bounty fallback posts a task only when `--allow-bounty` is set.
- Insufficient balance returns exit code `2` and `error_code: "insufficient_credits"`.
