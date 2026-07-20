# Kitchen Loop - Phase 4: Regress (Autonomous)

You are running **autonomously** as part of the Kitchen Loop. No interactive owner is available — never use `AskUserQuestion`; any ask goes to `ESCALATIONS.md` as an entry. You make all in-scope decisions yourself; anything on MANDATE.md's ALWAYS-STOP list becomes an `ESCALATIONS.md` entry instead of an action.

## Harness Rules — READ FIRST (before any other action)

1. **STOP sentinel.** Check whether `{{REPO_ROOT}}/.kitchenloop/STOP` exists. If it does, print its contents, output the stopped sentinel below, and STOP immediately — do no other work this phase:
   ```
   [regress] STOPPED -- .kitchenloop/STOP present, iteration {{ITERATION_NUM}}
   ```
   Regress is also the phase that MAY create `{{REPO_ROOT}}/.kitchenloop/STOP` (with a reason inside) when a stop condition trips in Step 3 — see that step.
2. **Read `MANDATE.md`** (the owner's standing mandate) before doing anything else. It lists what ALWAYS stops: any work item matching the ALWAYS-STOP list in MANDATE.md (e.g. core schema migrations, changes to money-path semantics, changes to the loop's own gates, pushes outside the gated merge pipeline, deploys). For ANY work item that matches the ALWAYS-STOP list: do NOT do it — append an entry to `ESCALATIONS.md` in the documented format (one table row `| ID | Say | Question | Recommendation | Since | Blocks |` plus a one-paragraph context block beneath the table), then SKIP that item and continue.
3. **No interactive owner.** The owner is asynchronous; the ONLY channel to them is an `ESCALATIONS.md` entry. A gate that is not in ESCALATIONS.md was not asked.

## Autonomous Mode Rules

1. **Do NOT use `EnterPlanMode` or `ExitPlanMode`**. Proceed directly.
2. **Do NOT use `AskUserQuestion`**. Make reasonable decisions.
3. **Do NOT use the Write tool to output status messages.** Only use Write/Edit for actual code and documentation files.

## Loop Context
- **Repo root**: {{REPO_ROOT}}
- **Iteration worktree**: {{ITER_WORKTREE}}
- **Iteration number**: {{ITERATION_NUM}}
- **Mode**: {{MODE}}
- **Base branch**: {{BASE_BRANCH}}
- **Regress quick**: {{REGRESS_QUICK}}
- **Important**: You are running inside a git worktree, NOT the main repo directory.
  All file writes go to this worktree. Do NOT `cd` to the repo root.

## Your Task

Run the **regress** phase. **Print a progress line before each step** so the owner knows where you are.

**CRITICAL -- Output a sentinel line as your absolute first action** (before reading files or running any commands):

```
[regress] STARTED -- iteration {{ITERATION_NUM}}, mode={{MODE}}
```

This ensures the loop monitor sees activity immediately, before any long-running test commands.

### Step 1: Pre-flight Checks

Print `[regress] Step 1/6: Running pre-flight checks...`

Verify the working directory is clean and the project builds:
```bash
{{LINT_COMMAND}}
```

### Step 1.5: Security Scan (if configured)

If `{{SECURITY_COMMAND}}` is not empty:
- Print `[regress] Step 1.5/6: Running security scan...`
- Run: `{{SECURITY_COMMAND}}`
- If the scan finds critical/high severity issues, flag them in the summary.
- Security scan failures are **warnings** (do not block the regression gate), but must be reported.

### Step 2: Run Tests

If `{{REGRESS_QUICK}}` is `true` (quick mode):
- Print `[regress] Step 2/6: Running quick tests...`
- Run: `{{QUICK_TEST_COMMAND}}`

If `{{REGRESS_QUICK}}` is `false` (full mode):
- Print `[regress] Step 2/6: Running full test suite...`
- Run: `{{FULL_TEST_COMMAND}}`

Capture:
- Total tests run
- Tests passed / failed / skipped
- Any new test failures (compare against previous iteration)

### Step 2.5: L3 Smoke Test (Integration Gate)

If `{{SMOKE_COMMAND}}` is not empty:
- Print `[regress] Step 2.5/6: Running L3 smoke test (integration gate)...`
- Run: `{{SMOKE_COMMAND}}`
- This is the **unbeatable test** — it verifies the real application works end-to-end.
- A smoke test failure is **more critical** than L1/L2 failures — it means the product is broken even if unit tests pass.
- If it fails: flag as `SMOKE_FAIL` in the summary and recommend pausing for investigation.

If `{{SMOKE_COMMAND}}` is empty:
- Print `[regress] Step 2.5/6: WARNING — No L3 smoke test configured.`
- Print `  The regression gate only covers L1/L2 (unit/adapter tests).`
- Print `  This means the loop cannot detect "all tests pass but the app is broken".`
- Print `  The ideate phase should prioritize bootstrapping an L3 test.`
- Include this warning in the iteration summary.

### Step 3: Evaluate Stop Conditions

Print `[regress] Step 3/6: Evaluating stop conditions...`

1. **Pass rate**: Calculate pass_rate = passed / total. If below the configured floor, flag it.
2. **Test count trend**: If total test count has declined for 3+ consecutive iterations, flag it.
3. **Consecutive failures**: If this is the 3rd consecutive regress failure, the orchestrator will pause automatically.

**Trip the STOP sentinel when a hard stop condition fires.** If the smoke gate failed (`SMOKE_FAIL`),
or the pass rate is below floor, or this is the 3rd consecutive regress failure, create
`{{REPO_ROOT}}/.kitchenloop/STOP` with a short reason inside (which condition tripped, iteration
number, and the failing numbers). This makes every subsequent loop phase refuse to run until the
owner deletes the file. Do NOT create STOP for a warning-only condition (e.g. a security-scan
warning or a missing L3 smoke test) — those are reported, not stopping.

### Step 3.5: Regenerate And Report Coverage Stats

Run `node scripts/kitchenloop/derive-coverage.mjs` to regenerate
`{{COVERAGE_MATRIX_PATH}}` from every `scenarios/incubating/*/scenario.mjs`
file's own `KITCHENLOOP-COVERAGE` declaration (the derive script is the ONLY
writer of the matrix's `tested`/`tested_combos`/`coverage_pct` fields; never
hand-edit them, in this step or when writing loop-state.md's Coverage section
below). If it exits non-zero (a scenario file has a missing/malformed block or
an out-of-vocabulary combo), treat that as a WARNING in the regress output —
fix the offending scenario file if you can identify it, otherwise leave the
existing matrix file as-is and note the failure; do not paper over it.

Then read the regenerated file and include a coverage summary in the iteration
output (and in loop-state.md's Coverage section, Step 4 below — pull the
numbers from this file, don't re-derive or restate them by hand):
- Total combos in spec surface
- Combos tested so far
- Coverage percentage
- Any new combos exercised this iteration (from the ideate phase)

### Step 4: Update Loop State

Print `[regress] Step 4/6: Updating loop state...`

**IMPORTANT — Re-read before writing**: `docs/internal/loop-state.md` is shared mutable state that other phases may have modified during this iteration. You MUST re-read it immediately before making any edits. Do NOT rely on any earlier copy you may have in memory — it may be stale.

Update docs/internal/loop-state.md with:
- Current iteration number
- Test results summary (passed/failed/total)
- Pass rate
- Any new blocked combos discovered

#### History Verification

After updating, verify the iteration history table has no gaps:
- Check that all iteration numbers from the first entry to the current one are present
- If any iteration numbers are missing, add a row with `[missing — backfilled by regress]` as the status
- This prevents silent gaps that make trend analysis unreliable

### Step 5: Pattern Consolidation

Print `[regress] Step 5/6: Consolidating patterns...`

Review the experience reports from recent iterations and update memory/codebase-patterns.md:

- Read `memory/codebase-patterns.md` (create if it doesn't exist)
- Review this iteration's changes (PRs merged, bugs found, scenarios implemented)
- Ask: "What patterns did this iteration CONFIRM or DISCOVER about how this codebase works?"
- Categories to consider:
  - **Architecture patterns**: How components should be structured
  - **Testing patterns**: What makes tests robust vs brittle
  - **Error patterns**: Common failure modes and how to handle them
  - **Integration patterns**: How external dependencies behave
  - **Performance patterns**: What's slow, what's fast
- ONLY write patterns confirmed by 2+ iterations. Do NOT write speculative patterns.
- If an existing pattern is contradicted by this iteration's evidence, UPDATE or REMOVE it.
- Keep it concise — patterns file should be < 200 lines

### Step 5b: Quality Sweep (every 3rd iteration)

Run this step ONLY when **`{{ITERATION_NUM}}` is a multiple of 3** (`{{ITERATION_NUM}} % 3 == 0`,
same cadence as `runtime.review_interval` in `kitchenloop.yaml`) **and the oracle passed this
iteration** (tests green and, if configured, `{{SMOKE_COMMAND}}` green). Otherwise print
`[regress] Step 5b: quality sweep skipped (not a 3rd iteration / oracle not green)` and move on.

When it applies:
- Print `[regress] Step 5b: Running quality sweep...`
- Invoke the **`kitchenloop-quality-sweep`** skill and run its procedure end to end (dead code,
  duplication/compactness, completeness, and architecture-boundary conformance). The skill:
  - skips with a one-line report if the app skeleton doesn't exist yet (no `package.json`) — expected pre-skeleton;
  - produces `docs/internal/reports/quality-sweep-iter-{{ITERATION_NUM}}.md`;
  - files each finding as an `improvement` ticket via the active ticketing provider (when
    `ticketing.provider` is `none`, that means appending tickets to `.kitchenloop/backlog.json`),
    deduped against open tickets — it NEVER deletes code directly (removals go through the normal
    Execute → review → UAT pipeline).
- The sweep is a report-and-ticket meta-phase; it is NOT part of the pass/fail regression gate. If
  the sweep tooling itself fails, note it in the summary and continue — do not fail the iteration on it.
- This is the loop's own quality debt control (a standing MANDATE item). Do not modify any protected
  gate file while running it; findings that touch protected files become `ESCALATIONS.md` entries, not edits.

### Step 6: Iteration Summary

Print `[regress] Step 6/6: Writing iteration summary...`

Output a concise summary:
```
Iteration {{ITERATION_NUM}} Summary:
  Mode: {{MODE}}
  Tests (L1/L2): X passed, Y failed, Z total (pass rate: N%)
  Smoke (L3): [PASS / FAIL / NOT CONFIGURED]
  New failures: [list or "none"]
  Patterns updated: [yes/no]
  Quality sweep: [ran (N tickets filed) / skipped (not 3rd iter or oracle not green) / N/A (pre-skeleton)]
  Stop conditions: [all clear / WARNING: pass rate below floor / WARNING: no L3 smoke test / STOP created: <reason>]
```

## Rules

- Do NOT skip the test suite — this is the safety net for the entire loop
- If tests fail, investigate root cause briefly but do NOT attempt to fix in regress phase
- Always update loop state, even if tests fail
