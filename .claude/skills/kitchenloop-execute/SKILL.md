---
name: kitchenloop-execute
description: KitchenLoop execute phase — query the top unblocked tickets, implement each through the SDD routing (feature-sized via Spec Kit, bug-sized via direct fix + repro test), live-test against the built stack, ship a PR, and run the UAT gate. Use when running the loop's execute phase or working tickets.
---

# KitchenLoop: Execute

> Phase 3 -- Query top unblocked tickets, implement them sequentially, ship PRs.

## Triggers

- `kitchenloop execute`
- `loop execute`
- `work on tickets`

---

## Overview

The Execute phase takes tickets from the todo queue and turns them into merged
code. Each ticket follows a strict workflow: branch, implement, lint, test,
commit, PR, transition state. The goal is steady throughput -- 3 to 5 tickets
per iteration.

The autonomous **execute prompt** (`scripts/kitchenloop/prompts/execute.md`) is
the authoritative driver of this phase; this skill is its detailed companion and
MUST state identical rules (backpressure, branch recipe, ticket-state ownership,
UAT gate). Where they ever diverge, the prompt wins.

---

## Harness Preamble (run before anything else)

This skill runs inside the autonomous loop. Before the procedure below:

1. **STOP sentinel** — if `.kitchenloop/STOP` exists, print its contents, output
   the phase sentinel `[execute] STOPPED -- iteration {N}`, and stop immediately.
   Run no further step.
2. **Read `MANDATE.md`.** Any work item matching the ALWAYS-STOP list in
   MANDATE.md (e.g. core schema migrations, changes to money-path semantics,
   changes to the loop's own gates, pushes outside the gated merge pipeline,
   deploys) must NOT be done. Instead write one row to `ESCALATIONS.md`
   (`| ID | Say | Question | Recommendation | Since | Blocks |` plus a context
   paragraph below it) and skip that ticket, continuing with other work.
3. **No interactive owner** — never use `AskUserQuestion`. Make reasonable
   decisions; asks go to `ESCALATIONS.md` as rows, never buried in prose or a
   PR comment.

---

## Ticketing Provider Dispatch

All ticket operations MUST honor `ticketing.provider` from `kitchenloop.yaml`.
**With `provider: "none"`**, the loop's queue lives in
`.kitchenloop/backlog.json`, NOT in a GitHub issue tracker.

- **`none` / `local`** (the default): tickets are a JSON array in
  `.kitchenloop/backlog.json`; each object has `id, title, body, type, priority,
  state, created, pr_url` and moves through states
  `backlog → todo → in_progress → in_review → done`. Query/transition/recover via
  the `scripts/kitchenloop/lib/tickets.sh` helpers — `ticket_list_by_state`,
  `ticket_transition`, `ticket_recover_stale`, `ticket_set_pr_url`,
  `ticket_add_comment` — never with `gh issue` commands. Every PR body MUST carry
  a `Ticket: <ticket-id>` line so `ticket_extract_ids_from_pr` links the PR to
  its ticket.
- **`github`**: the `gh issue ...` snippets below are the GitHub path.

Creating and reading PRs via `gh pr create` / `gh pr list` is correct under either
provider — the loop's PRs are real GitHub PRs; only the ticket queue is local.

---

## Procedure

### Step 0: Pre-Flight

1. Load `kitchenloop.yaml` -- read `paths`, `verification`, `ticketing`, and `repo`.
2. Read loop state at `paths.loop_state` for current iteration context.
3. Check environment variables listed in `verification.preflight_env_vars`.
   If any are missing, STOP and report which are absent.

### Step 1: Check PR Backpressure

Before starting new work, check for open PRs from previous iterations:

```bash
gh pr list --author "@me" --state open --json number,title,mergeable,reviewDecision,statusCheckRollup
```

**Backpressure rules** (identical to `prompts/execute.md` — the authoritative source):
- If there are **more than 10 open PRs**, skip execute entirely and log why.
  Focus the loop's attention on getting existing PRs merged.
- If there are **5-10 open PRs**, work only smaller, quick-win tickets this iteration.
- If there are **fewer than 5 open PRs**, proceed normally (3-5 tickets).

### Step 2: Recover Stale Tickets

Check for tickets marked as in-progress that have no active branch or PR.
These are artifacts of interrupted previous iterations.

- **Local provider (`none`, the default)**: `ticket_recover_stale` (from
  `lib/tickets.sh`) finds `in_progress` tickets with no open PR and moves them
  back to `todo`. Or list them with `ticket_list_by_state in_progress` and
  transition each with `ticket_transition {id} todo`.
- **GitHub provider**:
  ```bash
  gh issue list --label "{ticketing.github.state_labels.in_progress}" --json number,title
  ```

For each stale ticket:
- If a branch exists with changes, pick up where it left off.
- If no branch exists, transition back to todo state (with a recovery comment:
  "Recovered by kitchenloop: previous execute run timed out before creating a PR.").

### Step 3: Select Tickets

1. Query the todo queue, ordered by priority:
   - **Local provider (`none`, the default)**: `ticket_list_by_state todo` (from
     `lib/tickets.sh`) returns the todo tickets from `.kitchenloop/backlog.json`.
   - **GitHub provider**:
     ```bash
     gh issue list --label "{ticketing.github.state_labels.todo}" --json number,title,labels,body --limit 10
     ```
2. Filter out tickets that are blocked (check for "blocked" label or dependencies
   mentioned in the ticket body).
3. Select the top 3-5 unblocked tickets (adjusted by backpressure from Step 1)
   using strict priority ordering (critical bugs first, then high bugs, high
   features, medium, quick wins). Within a tier prefer the smallest scope.
4. Prefer a mix of categories (bugs, features, improvements) over all-of-one-type.

### Step 4: Implement Each Ticket

For each selected ticket, execute the following sub-steps sequentially:

#### 4a. Create Branch (worktree-safe)

This phase runs inside the iteration's git worktree, where `{repo.base_branch}`
is already checked out at the repo root. NEVER `git checkout {repo.base_branch}`
here — it fails with "'{repo.base_branch}' is already checked out". Branch
straight off the remote base (identical recipe to `prompts/execute.md` step 5):

```bash
git fetch origin && git checkout -b kitchen/fix-{ticket_id}-{short_desc} origin/{repo.base_branch}
```

When you move to the next ticket, do NOT `git checkout {repo.base_branch}` — the
next ticket's `git checkout -b ... origin/{repo.base_branch}` starts cleanly from
the base regardless of the branch you are currently on.

#### 4b. Transition Ticket to In-Progress

- **Local provider (`none`, the default)**: `ticket_transition {ticket_id} in_progress`
  (from `lib/tickets.sh`), which updates the ticket's `state` in
  `.kitchenloop/backlog.json`.
- **GitHub provider**:
  ```bash
  gh issue edit {ticket_number} --remove-label "{ticketing.github.state_labels.todo}" --add-label "{ticketing.github.state_labels.in_progress}"
  ```

#### 4c. Implement the Fix/Feature

1. Read the ticket body carefully for requirements and acceptance criteria.
2. Identify the relevant files -- use search tools, not guesswork.
3. Make the minimal change that satisfies the ticket.
4. Follow the project's coding conventions and patterns.

**Spec-Driven Development routing.** This project implements features through a
loop over SDD. Route each ticket by size before coding:

- **Feature-sized ticket** (new capability, new user-visible behavior, anything
  touching the core domain schema, money paths, or an adapter boundary declared
  protected in the MANDATE): do NOT implement directly. Run the Spec Kit flow
  first, inside the ticket's branch:
  1. `/speckit-specify` — create the feature spec from the ticket body
  2. `/speckit-plan` — design artifacts; MUST pass the Constitution Check
     against `.specify/memory/constitution.md`
  3. `/speckit-tasks` — dependency-ordered tasks
  4. `/speckit-implement` — execute the tasks
  The spec/plan/tasks artifacts ship in the same PR as the implementation.
- **Bug-sized ticket** (broken behavior with a repro, no new surface): fix
  directly with a test that reproduces the bug first.
- **Improvement-sized ticket** (polish, refactor, docs): implement directly
  within the quality bar.

**Autonomous-mode override for the Spec Kit chain.** The `/speckit-*` skills were
written for interactive use and contain "STOP and ask the user" / "wait for user
response" gates (e.g. `/speckit-specify` clarifications end with "wait for user
response"; `/speckit-implement` has an incomplete-checklist gate that asks
"proceed anyway? (yes/no)"). This phase runs with no interactive owner, so in
loop context you MUST NOT stall on them: resolve clarifications yourself with
documented assumptions (record each assumption in the spec's Clarifications
section and in the PR body), and treat incomplete checklist items as
**proceed-with-note** — list them in the PR body rather than stopping. Never call
`AskUserQuestion`; a genuine blocker that needs the owner becomes an
`ESCALATIONS.md` row, not an interactive wait.

Constitution gates that always apply (see `.kitchenloop/quality-bar.md`,
"The Bar"): changes to the core domain schema need a migration note; no
third-party API shapes outside the adapter boundary; money paths need L3 sandbox
integration tests; nothing from the constitution's deferred list.

**Clean-code policy + Pre-Write Discipline (mandatory for every ticket).**
Follow `.claude/skills/typescript-clean-architecture/SKILL.md`. Before writing
any new code: run the reuse scan (search `packages/` and read the relevant
public surfaces) and record the decision — `reuse` / `extend` / `generalize` /
`new` (with one-line justification) — in the PR body. A near-duplicate of an
existing export without a recorded decision is review-blocking.

**PR body contract.** Every PR must include:
1. The Pre-Write decision(s) as above.
2. For feature-sized tickets: a spec-alignment table — each functional
   requirement from `spec.md` → implementing file(s) → test(s), with any
   deferred requirement explicitly marked and ticketed. This table is what the
   Stage 4a codex alignment review verifies against.
3. A **Live Test Evidence** section (the Live Test & Fix rule,
   `.kitchenloop/quality-bar.md`): the live-verification verdict
   from step 4e — PASS with journey + evidence path + key log excerpts, or an
   explicit `N/A (no product behavior change)` / `SKIPPED (pre-skeleton)`.
   A missing section is review-blocking.

**Implementation guardrails:**
- Do NOT refactor unrelated code in the same commit.
- Do NOT add dependencies unless the ticket specifically requires it.
- Do NOT modify test infrastructure unless the ticket is about test infrastructure.
- Keep each PR focused on exactly one ticket.

#### 4d. Lint and Test

1. Run lint: the command from `verification.oracle.lint_command`
2. Run quick tests: the command from `verification.oracle.quick_command`
3. If `verification.oracle.smoke_command` is configured, run it too — this is the L3
   integration gate that verifies the real app still works.
4. If any check fails, fix the issue before proceeding.
5. If the fix requires more than 3 attempts, skip the ticket and add a comment
   explaining the blocker.

#### 4e. Live Test & Fix (mandatory for product-behavior changes — see `.kitchenloop/quality-bar.md`)

Unit/integration green is necessary, not sufficient. Before committing,
verify the change against the **built artifact**, like a QA would:

1. **Build + boot the real stack**: `docker compose down -v && docker compose up --build --wait`
   (fresh image, real Postgres + mailpit, clean state).
2. **Live smoke**: run `verification.oracle.smoke_command` against the running
   stack; for UI-facing changes also run the relevant Playwright specs
   (`npx playwright test`) — screenshots/traces are captured automatically.
3. **QA journey**: drive the changed flow end-to-end in a real browser
   (Playwright MCP) exactly as a user would — click, type, submit — and
   screenshot each step into the evidence directory.
4. **Log review**: `docker compose logs --no-color > .kitchenloop/evidence/<iteration>/<ticket>/compose.log`,
   then scan it — any ERROR-level line or unhandled exception not on a
   documented allowlist is a failure, even if the UI looked fine.
5. **Fix loop**: any defect found → fix the code → rebuild → re-run steps 2–4.
   Max 3 fix cycles; after that, move the ticket back to todo with a blocker
   comment. NEVER weaken an assertion, allowlist a real error, or skip a step
   to get green.
6. **Archive evidence** under `.kitchenloop/evidence/<iteration>/<ticket>/`
   (git-ignored) and add a **Live Test Evidence** section to the PR body:
   verdict, journey tested, key log excerpts, defects found and fixed.
7. **Teardown**: `docker compose down -v`.

Carve-outs: docs/CI/pure-refactor tickets with zero user-visible change may
record `N/A (no product behavior change)`. Until the project has a runnable
service to boot, record `SKIPPED (pre-skeleton)`. Both go in the PR body —
explicit, never silent. If the Docker daemon is unavailable, this stage FAILS
(report it; do not proceed to PR as if verified).

#### 4f. Commit and Push

```bash
git add {specific_files}
git commit -m "{type}: {description} (#{ticket_id})"
git push -u origin {branch_name}
```

Commit message types: `fix:`, `feat:`, `refactor:`, `test:`, `docs:`, `chore:`

#### 4g. Create PR

```bash
gh pr create \
  --title "{type}: {short description}" \
  --body "$(cat <<'EOF'
## Summary
{1-3 bullet points describing the change}

## Ticket
Ticket: {ticket_id}
{GitHub provider only — also add: Closes #{ticket_number}}

## Pre-Write Decision
{reuse | extend | generalize | new} — {one-line justification from the reuse scan
(search of `packages/` + the relevant public surfaces) for the code written; see
the Pre-Write Discipline above. A near-duplicate of an existing export without a
recorded decision is review-blocking.}

## Spec Alignment
{Feature-sized tickets: one row per functional requirement. This table is what the
Stage 4a codex alignment review verifies against.}

| Functional requirement (spec.md) | Implementing file(s) | Test(s) |
|----------------------------------|----------------------|---------|
| {FR-1} | {path} | {test} |

{Mark any deferred requirement explicitly and link its follow-up ticket. For
bug/improvement tickets with no `spec.md`, write `N/A (no spec)` instead of the table.}

## Test Plan
- [ ] Lint passes
- [ ] Quick tests pass
- [ ] {specific test for this change}

## Live Test Evidence
{verdict: PASS | N/A (no product behavior change) | SKIPPED (pre-skeleton)}
{journey tested, evidence path, key log excerpts, defects found and fixed}

Generated by KitchenLoop iteration {N}
EOF
)" \
  --base {repo.pr_target}
```

#### 4h. UAT Gate (independent live acceptance test)

After the PR exists and BEFORE transitioning the ticket, run the User Acceptance
Test gate — the full protocol is in
`.claude/skills/kitchenloop-execute/UAT-GATE.md`. It is the independent live
check: step 4e was the implementer's own live test; the UAT evaluator re-verifies
with zero implementation context against the same built stack. Skip ONLY for pure
refactors / docs / CI changes with no user-visible behavior (record the skip
reason in the PR); NEVER skip it for product source, CLI, or user-facing changes.

1. **Generate the test card** → `.kitchenloop/uat-cards/{ticket_id}.md`: a
   step-by-step recipe a user follows (exact commands, exact expected exit codes
   and output assertions, no `<placeholders>`; browser steps for web features).
2. **Freeze the card** (deterministic validation): every step has a command, an
   expected exit code, and ≥1 output assertion; reject manual-edit steps and
   `<angle-bracket-placeholders>`. A defective card → report `UAT_SPEC_FAIL`,
   don't block.
3. **Boot the live stack** for the evaluator (`verification.live.boot_command`)
   so browser steps run against the built image.
4. **Spawn the `uat-evaluator` subagent** in `isolation: "worktree"` with ONLY
   the test card contents — no diff, no ticket, no implementation context. This
   is the one subagent the no-spawn rule permits.
5. **Integrity check** (the implementer runs it, not the evaluator): `git diff`
   / `git ls-files --others` on the UAT worktree — any product-file modification
   outside `.kitchenloop/uat-runs/` = `EVAL_CHEAT_FAIL`; a missing evidence file
   = `EVAL_CHEAT_FAIL` (override whatever the evaluator reported).
6. **Parse the verdict** from the evaluator's documented `**Overall:** VERDICT`
   line using portable tools only (BSD `grep`/`sed` — NEVER `grep -P`/`-oP`).
   **Fail closed**: an empty or unparseable verdict is blocking and is treated as
   a `PRODUCT_FAIL`-equivalent.
7. **Act on the verdict**: `PASS` → proceed to 4i; `PRODUCT_FAIL` → keep the
   ticket in its current state, comment the failure on the PR, tag `uat-failed`,
   do NOT transition to in-review; `UAT_SPEC_FAIL` → log (bad card), don't block;
   `EVAL_CHEAT_FAIL` → flag prominently for review.
8. **Attach evidence** to the PR as a comment (`gh pr comment` — valid under both
   providers) and keep the card at `.kitchenloop/uat-cards/{ticket_id}.md` plus
   evidence at `.kitchenloop/uat-runs/{ticket_id}/`.

#### 4i. Transition Ticket to In-Review

Only after a `PASS` (or a legitimately skipped) UAT gate:

- **Local provider (`none`, the default)**: `ticket_transition {ticket_id} in_review`
  then `ticket_set_pr_url {ticket_id} {pr_url}` (from `lib/tickets.sh`).
- **GitHub provider**:
  ```bash
  gh issue edit {ticket_number} --remove-label "{ticketing.github.state_labels.in_progress}" --add-label "{ticketing.github.state_labels.in_review}"
  ```

Never move a ticket to `done` — the pr-manager does that after merge.

### Step 5: Emit Execute Summary (do NOT write loop-state)

**Do NOT write `loop-state.md`** — the regress phase is the sole writer of loop
state (this avoids concurrent-write corruption of the shared file, matching
`prompts/execute.md`). Emit the run summary to stdout instead:
- Tickets attempted and their outcomes (completed, skipped, blocked), stating WHY
  each was chosen over other available tickets
- PRs created (numbers/URLs or branch names) with their `Ticket:` ids
- UAT verdict per ticket
- Any tickets that were stale-recovered

Regress records this iteration into loop state when it runs.

---

## Output Contract

At the end of the Execute phase:

1. **3-5 PRs created** (or fewer if backpressure limited throughput), each PR body
   carrying `Ticket: <id>`, the Pre-Write decision, the spec-alignment table
   (feature tickets), and the Live Test Evidence section
2. **A UAT test card** at `.kitchenloop/uat-cards/{ticket_id}.md` and **evidence**
   at `.kitchenloop/uat-runs/{ticket_id}/` for each product-behavior ticket, with
   the verdict attached to its PR
3. **Tickets transitioned** to in-review state (only after a PASS/skipped UAT gate)
4. **Stale tickets recovered** or transitioned back to todo
5. **Execute summary** emitted to stdout (loop state is written by regress, not here)

---

## Error Handling

| Situation | Action |
|-----------|--------|
| Lint fails after 3 fix attempts | Skip ticket, add comment, move back to todo |
| Tests fail on unrelated code | Note in PR body, proceed if ticket-specific tests pass |
| Branch conflict with base | Rebase, resolve conflicts, retry |
| Ticket is ambiguous | Add clarifying comment, implement best interpretation, note in PR |
| CI fails on PR | Check logs, fix if possible, label needs-attention if not |

---

## Configuration Reference

| Config Key | Used For |
|-----------|----------|
| `repo.base_branch` | Base for new branches |
| `repo.pr_target` | PR target branch |
| `repo.iteration_branch_prefix` | Branch naming |
| `ticketing.provider` | Ticketing system |
| `ticketing.github.state_labels` | Issue label transitions |
| `verification.oracle.lint_command` | Lint check |
| `verification.oracle.quick_command` | Quick test |
| `verification.preflight_env_vars` | Required env vars |
| `paths.loop_state` | Loop state file |
