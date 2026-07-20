---
name: kitchenloop-regress
description: KitchenLoop regress phase — run lint + the full test suite (and the L3 smoke gate) against the iteration worktree, evaluate stop conditions, consolidate patterns, run the quality sweep every 3rd iteration, and write loop state. Regress is the SOLE writer of loop-state.md. Use when running the loop's regress phase or asked to run the regression gate.
---

# KitchenLoop: Regress

> Phase 4 -- Run full regression, evaluate stop conditions, update loop state.

## Triggers

- `kitchenloop regress`
- `loop regress`
- `regression test`

---

## Overview

The Regress phase is the loop's quality gate. It runs the full test suite,
evaluates whether the codebase is healthy enough to continue looping, and
consolidates patterns learned during the iteration. If stop conditions are
triggered, the loop pauses until a human intervenes.

---

## Harness Preamble (run before anything else)

This skill runs inside the autonomous loop. Before the procedure below:

1. **STOP sentinel** — if `.kitchenloop/STOP` exists, print its contents, output
   the phase sentinel `[regress] STOPPED -- iteration {N}`, and stop immediately.
   Run no further step. (Regress is also the phase that MAY *create*
   `.kitchenloop/STOP` — with a reason inside — when a hard stop condition trips
   in Step 4; see that step.)
2. **Read `MANDATE.md`.** Any work item matching the ALWAYS-STOP list in
   MANDATE.md (e.g. core schema migrations, changes to money-path semantics,
   changes to the loop's own gates, pushes outside the gated merge pipeline,
   deploys) must NOT be done. Instead write one row to `ESCALATIONS.md`
   (`| ID | Say | Question | Recommendation | Since | Blocks |` plus a context
   paragraph below it) and skip that item, continuing with other work.
3. **No interactive owner** — never use `AskUserQuestion`. Make reasonable
   decisions; asks go to `ESCALATIONS.md` as rows, never buried in prose.

---

## Procedure

### Step 1: Pre-Flight Checks

1. Load `kitchenloop.yaml` -- read `verification`, `paths`, and `repo`.
2. Verify all `verification.preflight_env_vars` are set. If any are missing,
   record them and STOP -- regression results would be misleading.
3. **Run in the iteration worktree.** This phase runs inside the loop's iteration
   git worktree (matching `prompts/regress.md`), where `{repo.base_branch}` is
   already checked out at the repo root. Do NOT `git checkout {repo.base_branch}`
   or `git pull` inside the worktree — that fails with "already checked out" and
   would violate worktree isolation. Run the regression against the worktree's
   current tree as-is; the iteration branch already carries the merged work.
4. Read loop state at `paths.loop_state` for:
   - Current iteration number
   - Previous pass rate and test count
   - Consecutive failure count

### Step 2: Run Lint

Run the lint command from `verification.oracle.lint_command`:

```bash
{lint_command}
```

Record: PASS or FAIL with details.

If lint fails, attempt auto-fix (if the lint command supports it). Record
whether auto-fix succeeded.

### Step 3: Run Full Regression

Run the full test command from `verification.oracle.full_command`:

```bash
{full_command} 2>&1 | tee {paths.logs}/regress-iter-{N}.log
```

Parse the output to extract:
- **Total tests**: number of tests executed
- **Passed**: number passing
- **Failed**: number failing (with names and error summaries)
- **Skipped**: number skipped
- **Duration**: wall-clock time

Calculate:
- **Pass rate** = passed / (passed + failed)
- **Skip rate** = skipped / total

<!-- CUSTOMIZE: Add parsing logic for your test framework's output format.
     For example, pytest uses "X passed, Y failed, Z skipped" format.
     Jest uses "Tests: X passed, Y failed, Z total" format. -->

### Step 4: Evaluate Stop Conditions

Read `verification.stop_conditions` from config and evaluate each:

#### 4a. Pass Rate Floor

```
current_pass_rate >= stop_conditions.pass_rate_floor
```

If **violated**: The loop has introduced regressions. Log the failing tests,
set status to PAUSED, and report the delta from the previous iteration.

#### 4b. Consecutive Failures

Track how many iterations in a row the regression has failed. If:

```
consecutive_failures >= stop_conditions.max_consecutive_failures
```

Then **PAUSE** the loop. Something systemic is wrong -- a human needs to
investigate.

#### 4c. Test Count Decline

Compare the current test count against the previous N iterations (where N is
`stop_conditions.test_count_decline_iters`):

```
If test count has declined for N consecutive iterations: FLAG
```

This catches accidental test deletion or skip-creep. It's a warning, not a
stop condition -- log it prominently but don't pause.

### Step 5: Pattern Consolidation

If the regression **passed**, consolidate patterns:

1. Read `paths.patterns` if it exists.
2. Review the PRs merged since the last regression:
   ```bash
   git log --oneline {last_regress_commit}..HEAD
   ```
3. Extract any new patterns worth documenting:
   - Recurring fix patterns (same type of bug fixed multiple times)
   - New conventions established
   - Pitfalls discovered
4. Append new patterns to `paths.patterns`.

If the regression **failed**, skip pattern consolidation -- focus on the
failure report.

### Step 5b: Quality Sweep (every 3rd iteration)

If `iteration % 3 == 0` and the regression passed, run the quality sweep per
`.claude/skills/kitchenloop-quality-sweep/SKILL.md`: dead code (knip),
duplication/compactness (jscpd + outliers), completeness (TODO/stub scan +
spec↔code mapping for features merged since the last sweep), and architecture
boundary conformance (dependency-cruiser) — these are the default Node/TS
toolchain; adapt the tools to the project's stack via config. File `improvement`
tickets for findings **through the active ticketing provider** — when
`ticketing.provider` is `none` (the default) that means appending tickets to
`.kitchenloop/backlog.json` via `lib/tickets.sh`, not `gh issue create`; write
the report to `docs/internal/reports/quality-sweep-iter-{N}.md`. A skipped scan
must be reported as skipped, never as clean. Findings that touch a protected
gate file become `ESCALATIONS.md` rows, not tickets or edits. If any finding
category grew two sweeps in a row, add a drift warning to the iteration report
header.

### Step 6: Write Regression Report

Append to or update the loop state at `paths.loop_state`:

```markdown
## Regression -- Iteration {N}

- **Date**: {timestamp}
- **Branch**: {branch}
- **Lint**: PASS | FAIL
- **Pass rate**: {pass_rate}% ({passed}/{total})
- **Previous pass rate**: {prev_rate}%
- **Delta**: {+/-N}%
- **Skip rate**: {skip_rate}%
- **Test count**: {total} (previous: {prev_total})
- **Duration**: {duration}
- **Consecutive failures**: {count}
- **Status**: CONTINUE | PAUSED | FLAGGED

### Failing Tests
{list of failing test names and error summaries, if any}

### New Patterns
{list of patterns consolidated, if any}

### Warnings
{test count decline, high skip rate, or other concerns}
```

Also write a detailed log to `{paths.logs}/regress-iter-{N}.log`.

### Step 7: Determine Next Action

Based on the evaluation:

| Status | Action |
|--------|--------|
| **CONTINUE** | Pass rate above floor, no stop conditions triggered. Loop proceeds. |
| **FLAGGED** | Test count declining or skip rate high. Loop proceeds with warning. |
| **PAUSED** | Stop condition triggered. Loop stops. Report the reason clearly. |

If PAUSED, follow `verification.skip_policy.regress_fail`:
- `pause` -- stop the loop entirely, require human intervention
- `continue` -- log the failure but proceed (not recommended)
- `retry` -- re-run regression once before pausing

---

## Output Contract

1. **Regression log** at `{paths.logs}/regress-iter-{N}.log`
2. **Loop state updated** with regression results at `paths.loop_state`
3. **Patterns file updated** (if regression passed) at `paths.patterns`
4. **Clear status determination**: CONTINUE, FLAGGED, or PAUSED

---

## Metrics Tracked

The following metrics are recorded in loop state for trend analysis:

| Metric | Source |
|--------|--------|
| Pass rate | Test output parsing |
| Test count | Test output parsing |
| Skip count | Test output parsing |
| Duration | Wall-clock timing |
| Consecutive failures | Loop state history |
| Lint status | Lint command exit code |

---

## Configuration Reference

| Config Key | Used For |
|-----------|----------|
| `verification.oracle.full_command` | Full regression command |
| `verification.oracle.lint_command` | Lint command |
| `verification.preflight_env_vars` | Required env vars |
| `verification.stop_conditions.pass_rate_floor` | Minimum pass rate |
| `verification.stop_conditions.max_consecutive_failures` | Failure limit |
| `verification.stop_conditions.test_count_decline_iters` | Decline detection window |
| `verification.skip_policy.regress_fail` | What to do on failure |
| `paths.loop_state` | Loop state file |
| `paths.logs` | Log output directory |
| `paths.patterns` | Codebase patterns file |
| `repo.base_branch` | Branch to test on |
