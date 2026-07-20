# Unbeatable Tests

> An "unbeatable" test verifies **ground truth that the code author cannot fake**.
> It catches the failure mode where 38 unit tests pass but the service is completely broken.

## The 4-Level Testing Pyramid

| Level | What | Trust | Gate Role |
|-------|------|-------|-----------|
| **L1 Unit** | Isolated logic, pure functions | Low — proves logic, not integration | Fast CI feedback |
| **L2 API/Adapter** | Methods with real dependencies | Medium — proves contracts | Pre-merge gate |
| **L3 Integration** | Full execution pipeline | High — proves real-world behavior | **Regression oracle** |
| **L4 E2E Scenario** | Complete user journeys | Highest — proves the product works | **UAT gate** |

**L1 and L2 are necessary but not sufficient.** A test that only checks layers 1-2 is
dangerously incomplete — it can silently succeed while doing the wrong thing. L3 and L4
are the "unbeatable" tests because they verify against ground truth.

## What Makes a Test "Unbeatable"

The 4-layer verification pattern for each test:

1. **Compilation** — does it build/compile?
2. **Execution** — does it run without errors?
3. **Output Parsing** — does the output contain what we expect?
4. **State Deltas** — did the actual state match expectations?

A test that only checks layers 1-2 can silently succeed while doing the wrong thing.
**Layer 4 (state deltas) is what makes it unbeatable.**

---

## What "Unbeatable" Means for This Project

For a web application, ground truth = a real browser can load pages, interact with UI elements, and see correct results. The server must start, routes must resolve, and rendering must produce the expected DOM.

### Current Test Level Audit

- L1/L2 (unit/adapter): Covered by `npm test`
- **L3 (integration): NOT YET CONFIGURED** — first loop iteration should bootstrap this
- L4 (E2E): Covered by UAT gate (once L3 exists)

### What L3 Looks Like Here

Start the real application server, send HTTP requests to real routes, and verify responses contain expected data. This proves the server boots, routes resolve, middleware runs, and the database is reachable.

Example: `npm start && curl -sf http://localhost:3000/ && curl -sf http://localhost:3000/api/health | grep ok`

**Smoke test command**: `(not yet configured — bootstrap in first loop iteration)`

### What L4 Looks Like Here

Browser automation against the **built compose image** (the Live Test & Fix
rule, `.kitchenloop/quality-bar.md`) — never a dev server.
`docker compose up --build --wait` boots the artifact you
would ship; Playwright loads pages, clicks buttons, fills forms, and asserts
on visible content, capturing screenshot-on-failure, per-step traces, and
video automatically. This proves the product works as a user would experience
it — in the form it actually ships.

Example: `docker compose up --build --wait && npx playwright test tests/e2e/smoke.spec.ts`
exercising a core user journey, followed by a compose-log scan for
non-allowlisted ERROR lines.

### Live Test & Fix — every SDD cycle

L3/L4 are not just the regression oracle's job. **Every ticket that changes
product behavior ends with a live pass inside its own Execute cycle**, before
the PR is done (protocol: `.claude/skills/kitchenloop-execute/SKILL.md` step 4e):

1. Build + boot the compose stack from a fresh image (clean state, `down -v` first)
2. Live smoke + the Playwright specs relevant to the change
3. QA-style browser journey of the changed flow via Playwright MCP — per-step
   screenshots into `.kitchenloop/evidence/<iteration>/<ticket>/`
4. Compose-log review — non-allowlisted ERROR lines fail the stage even when
   the UI looks fine
5. Defects found live are fixed in the SAME cycle: fix → rebuild → re-test
   (max 3 cycles, then the ticket returns to todo with a blocker comment)

The UAT gate then re-verifies independently: a zero-context evaluator drives
the same live stack through the protected test card (browser steps + screenshots
+ log review). Evidence — screenshots, traces, compose logs — is the witness;
a green suite without live evidence does not count as verified.

---

## Bootstrap Priority

If L3 tests do not yet exist, **the first loop iteration MUST create one** before doing
any feature work. A loop without an L3 smoke test is running blind — the regression gate
is disconnected from whether the product actually works.

### Minimum Viable L3 Test Checklist

- [ ] Starts the real application (not a mock)
- [ ] Sends a real request (HTTP, CLI command, API call)
- [ ] Asserts on the response (status code, output content)
- [ ] Verifies a state delta (database row, file created, side effect)
- [ ] Cleans up after itself (teardown, temp files)

### L3 Bootstrap Patterns by Project Type

**Web App / API**:
```bash
# Start server, hit health endpoint, verify response
npm start &
sleep 3
curl -sf http://localhost:3000/health | grep -q '"ok"'
# Hit a real route, verify it returns data
curl -sf http://localhost:3000/api/items | jq '.length > 0'
kill %1
```

**CLI Tool**:
```bash
# Run the actual CLI with real input, verify output
echo '{"input": "test"}' | my-cli process --format json | jq '.status == "ok"'
# Verify side effects (file created, exit code)
my-cli generate --output /tmp/test-output
test -f /tmp/test-output/result.json
```

**Library / SDK**:
```bash
# Run an integration script that exercises the public API end-to-end
python -c "
from mylib import Client
c = Client()
result = c.process('test-input')
assert result.status == 'ok', f'Expected ok, got {result.status}'
assert len(result.data) > 0, 'No data returned'
"
```

**Web App (Browser)**:
```bash
# Start app, use headless browser to verify rendering
npm start &
sleep 3
npx playwright test tests/smoke.spec.ts
kill %1
```
