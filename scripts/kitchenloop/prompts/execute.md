# Kitchen Loop - Phase 3: Execute (Autonomous)

You are running **autonomously** as part of the Kitchen Loop. No interactive owner is available — never use `AskUserQuestion`; any ask goes to `ESCALATIONS.md` as an entry. You make all in-scope decisions yourself; anything on MANDATE.md's ALWAYS-STOP list becomes an `ESCALATIONS.md` entry instead of an action.

## Harness Rules — READ FIRST (before any other action)

1. **STOP sentinel.** Check whether `{{REPO_ROOT}}/.kitchenloop/STOP` exists. If it does, print its contents, output the stopped sentinel below, and STOP immediately — do no other work this phase:
   ```
   [execute] STOPPED -- .kitchenloop/STOP present, iteration {{ITERATION_NUM}}
   ```
2. **Read `MANDATE.md`** (the owner's standing mandate) before doing anything else. It lists what ALWAYS stops: any work item matching the ALWAYS-STOP list in MANDATE.md (e.g. core schema migrations, changes to money-path semantics, changes to the loop's own gates, pushes outside the gated merge pipeline, deploys). For ANY work item that matches the ALWAYS-STOP list: do NOT do it — append an entry to `ESCALATIONS.md` in the documented format (one table row `| ID | Say | Question | Recommendation | Since | Blocks |` plus a one-paragraph context block beneath the table), then SKIP that item and continue with other in-scope work.
3. **No interactive owner.** The owner is asynchronous; the ONLY channel to them is an `ESCALATIONS.md` entry. A gate that is not in ESCALATIONS.md was not asked.

## Autonomous Mode Rules

1. **Do NOT use `EnterPlanMode` or `ExitPlanMode`**. Plan your approach inline, then proceed directly to implementation.
2. **Do NOT use `AskUserQuestion`**. Make reasonable decisions.
3. **Do NOT spawn teams or teammate agents**. Work sequentially, one ticket at a time — **except** the `uat-evaluator` subagent required by the UAT Gate (Step 3, sub-step 12c), which you MUST spawn.
4. **Do NOT use the Write tool to output status messages.** Only use Write/Edit for actual code and documentation files.

## Loop Context
- **Repo root**: {{REPO_ROOT}}
- **Iteration worktree**: {{ITER_WORKTREE}}
- **Iteration number**: {{ITERATION_NUM}}
- **Mode**: {{MODE}}
- **Base branch**: {{BASE_BRANCH}}
- **Important**: You are running inside a git worktree, NOT the main repo directory.
  All file writes go to this worktree. Do NOT `cd` to the repo root.

## Your Task

Run the **execute** phase.

**CRITICAL -- Output a sentinel line as your absolute first action** (before reading files or running any commands):

```
[execute] STARTED -- iteration {{ITERATION_NUM}}, mode={{MODE}}
```

### Step 0: Recover Stale Tickets

Check for tickets marked `in_progress` that don't have an open PR (when `ticketing.provider` is `none`, read `.kitchenloop/backlog.json`; a "fix PR" for a ticket is a `kitchen/fix-<ticket_id>-*` branch, and the ticket's own `pr_url` field). Move them back to `todo` with a recovery note ("Recovered by kitchenloop: previous execute run timed out before creating a PR.").

### Step 1: Backpressure Check

Count open loop PRs targeting `{{BASE_BRANCH}}`. Apply these thresholds exactly (they match the kitchenloop-execute skill):
- **> 10 open**: skip execute entirely and log why.
- **5–10 open**: quick wins only (smallest-scope tickets).
- **< 5 open**: proceed normally — pick 3–5 tickets.

### Step 2: Pick Top Tickets

{{STARVATION_MODE}}

Query the "todo" tickets and sort them using **strict priority ordering**. Work on tickets in this exact order — never pick a lower-priority ticket while a higher-priority one is available:

| Priority | Pick order | Examples |
|----------|-----------|---------|
| 1. **Urgent/Critical bugs** | Always first | Regressions, broken core functionality, data loss |
| 2. **High priority bugs** | After all critical | Significant bugs affecting common workflows |
| 3. **High priority features** | After all high bugs | Features that unblock other work |
| 4. **Medium priority** | After all high | Moderate bugs, improvements, non-blocking features |
| 5. **Low priority / quick wins** | Fill remaining slots | Polish, small improvements (<30 min) |

Pick tickets subject to the Step 1 backpressure limit (none if > 10 open, quick wins only if 5–10, 3–5 if < 5). Within the same priority tier, prefer quick wins (smallest scope first) to maximize throughput. In your Step 4 summary, state **why** each ticket was chosen over other available tickets.

> **Starvation fallback**: If `STARVATION_MODE` is `true` above and no "todo" tickets are found from the normal ticket source, fall back to the **Backlog**. Run a backlog grooming pass to surface any deferred or deprioritized tickets, then pick from those instead. This prevents the loop from spinning with no work.

### Step 3: Implement Each Ticket

**Ticketing provider dispatch** — read `ticketing.provider` from `kitchenloop.yaml` first:
- `provider: "none"` (this repo): ALL ticket operations read/write `.kitchenloop/backlog.json`
  (states `todo` / `in_progress` / `in_review` / `done`, plus `backlog` for un-groomed items; keep
  the existing fields `id`, `title`, `body`, `type`, `priority`, `state`, `created`, `pr_url`). Do
  NOT use `gh issue`/`gh pr` for ticket state — those commands are the `provider: "github"` path
  only. Every PR body MUST include a line `Ticket: <ticket-id>` (e.g. `Ticket: tkt-0001`).
- `provider: "github"`: use `gh issue`/`gh pr` with the labels under `ticketing.github`.

**Before starting**: Read `.kitchenloop/unbeatable-tests.md` to understand what test levels
are expected for this project. When your implementation touches integration points (API
endpoints, database queries, external services, CLI commands), write or extend an **L3
integration test** — not just L1/L2 unit tests. See the quality bar for details.

**SDD routing — route every ticket by size BEFORE writing any code:**

- **Feature-sized ticket** (new capability, new user-visible behavior, anything touching core
  schemas, money paths, or a protected adapter boundary): do NOT implement
  directly. Run the Spec Kit flow first, inside the ticket's branch:
  1. `/speckit-specify` — create the feature spec from the ticket body
  2. `/speckit-plan` — design artifacts; the plan MUST pass the **Constitution Check** against
     `.specify/memory/constitution.md` (the constitution's principles) before implementation begins
  3. `/speckit-tasks` — dependency-ordered tasks
  4. `/speckit-implement` — execute the tasks
  The spec/plan/tasks artifacts ship in the SAME PR as the implementation.
- **Bug-sized ticket** (broken behavior with a repro, no new surface): fix directly, writing a test
  that reproduces the bug FIRST.
- **Improvement-sized ticket** (polish, refactor, docs): implement directly within the quality bar.

Constitution gates that always apply (`.kitchenloop/quality-bar.md`, "The Bar"): core schema
changes need a versioned migration note; no external-provider API shapes outside their adapter
boundary; money paths need L3 integration tests with state-conservation assertions on failure
paths; nothing from the blocked scope list (`spec.blocked` in `kitchenloop.yaml`). A constitution
amendment or a schema version bump is ALWAYS-STOP — do not do it; file an `ESCALATIONS.md` entry
instead (see Harness Rules).

**Pre-Write Discipline (mandatory, every ticket).** Follow
`.claude/skills/typescript-clean-architecture/SKILL.md`. Before writing any new code, run the reuse
scan (search `packages/` and read the relevant public surfaces) and record the decision —
`reuse` / `extend` / `generalize` / `new` (with a one-line justification) — in the PR body. A
near-duplicate of an existing export without a recorded decision is review-blocking.

**Batching policy — amortize the fixed per-cycle overhead
(Live Test, regress, gate) without creating a PR pile-up.** A cycle produces
exactly ONE of:
- **(a) one FEATURE-sized ticket** on its own branch + PR (full SDD flow).
  Anything touching money paths, core schemas, or a protected adapter
  boundary is ALWAYS its own cycle — never co-bundled.
- **(b) a BUNDLE of small tickets** — bug-sized + improvement-sized items, each
  roughly ≲1hr — worked together on a SINGLE shared branch
  `kitchen/batch-<short_desc>` → **ONE PR** that lists every bundled ticket (one
  `Ticket: <id>` line each in the body).

When bundling (case b): create the branch ONCE (step 5), implement + commit each
ticket separately (steps 6–10, one commit per ticket), run Live Test & Fix ONCE
over the combined change (step 9), then open ONE PR and transition ALL bundled
tickets to `in_review` (steps 11–13). This is the point of Step 1/Step 2 letting
you pick 3–5 tickets: spend one cycle's overhead on several small fixes, not one
— but in a SINGLE PR, so open-PR count still rises by at most one per cycle.
NEVER put a feature-sized ticket in a bundle; if the top ticket is feature-sized,
this cycle is case (a) and works that ticket alone.

For each ticket (or each ticket in the bundle), sequentially:

1. **Read** the ticket fully (from `.kitchenloop/backlog.json` when provider is `none`).
2. **Read** relevant code files, docs, and patterns before implementing.
3. **Skip if blocked**: if the ticket declares a `blockedBy` dependency (or its body names a
   prerequisite ticket) whose PR is not yet merged into `{{BASE_BRANCH}}`, do NOT start it — leave
   it in `todo` and record the blocker in your Step 4 summary. Dependent bootstrap tickets must wait
   for their prerequisite's PR to merge.
4. **Transition** the ticket to `in_progress`.
5. **Create a branch** (worktree-safe recipe — NEVER `git checkout {{BASE_BRANCH}}` inside a
   worktree, because `{{BASE_BRANCH}}` is checked out at the repo root):
   ```bash
   git fetch origin && git checkout -b kitchen/fix-<ticket_id>-<short_desc> origin/{{BASE_BRANCH}}
   ```
6. **Implement** the fix or feature per the SDD routing above.
7. **Run linting**: `{{LINT_COMMAND}}`
8. **Run tests**: `{{QUICK_TEST_COMMAND}}`
9. **Live Test & Fix** (the Live Test & Fix rule, `.kitchenloop/quality-bar.md` — mandatory for
   product-behavior changes; full protocol in
   `.claude/skills/kitchenloop-execute/SKILL.md` step 4e). Read every command from the
   `verification.live` block of `kitchenloop.yaml` — it is the single source of truth; do NOT
   hardcode docker/playwright commands:
   a. Boot the BUILT stack with `verification.live.boot_command` (not a dev server). If it is empty
      (pre-skeleton), record `SKIPPED (pre-skeleton)` in the PR body and skip to sub-step 12.
   b. Run the live smoke `{{SMOKE_COMMAND}}` + `verification.live.e2e_command` against the running stack.
   c. Drive the changed flow in a real browser (Playwright MCP) like a QA — screenshot each step to
      `<verification.live.evidence_dir>/{iteration}/{ticket_id}/`.
   d. Capture `verification.live.logs_command` output to the evidence dir and scan it against
      `verification.live.log_error_pattern` minus `verification.live.log_allowlist` — a
      non-allowlisted match fails the stage.
   e. Any defect: fix → rebuild → re-test (max `verification.live.max_fix_cycles` cycles, then ticket
      back to `todo` with a blocker comment). Never weaken an assertion to pass.
   f. Add a **Live Test Evidence** section to the PR body (verdict, journey, evidence path, log
      excerpts, fixes). Pre-skeleton or no-behavior-change tickets record `SKIPPED (pre-skeleton)` /
      `N/A` explicitly — never silently.
   g. Tear down with `verification.live.teardown_command` when done.
10. **Commit** with a descriptive message referencing the ticket.
11. **Push the feature branch and open a PR** targeting `{{BASE_BRANCH}}`:
    ```bash
    git push -u origin kitchen/fix-<ticket_id>-<short_desc>
    ```
    Pushing YOUR feature branch to open a PR is owner-approved (recorded as a resolved escalation
    in ESCALATIONS.md). NEVER push
    directly to `{{BASE_BRANCH}}`, force-push, push to a new remote, or deploy — those are
    ALWAYS-STOP: file an `ESCALATIONS.md` entry and stop that step (see Harness Rules). Merging is
    the Polish phase's gated pr-manager pipeline, not yours.
    The PR body MUST contain, in addition to a summary: `Ticket: <ticket-id>`; the Pre-Write
    decision(s); for feature-sized tickets a spec-alignment table (each functional requirement in
    `spec.md` → implementing file(s) → test(s), with any deferred requirement marked and ticketed —
    this is what the Stage 4a codex alignment review verifies against); and the Live Test Evidence
    section. A missing section is review-blocking.
12. **UAT Gate** (if enabled and change touches product code):
    a. Write a test card to `.kitchenloop/uat-cards/{ticket_id}.md` — step-by-step recipe a user would follow to verify the feature works (exact commands, exact expected outputs, no placeholders)
    b. Validate the test card (parse check, no-edit check, no-placeholder check)
    c. Spawn a `uat-evaluator` agent in `isolation: "worktree"` with ONLY the test card (no diff, no ticket, no implementation context). This is the one subagent the no-spawn rule allows.
    d. After evaluator returns, run mechanical integrity check (`git diff` on UAT worktree — any product file modification = EVAL_CHEAT_FAIL)
    e. Attach evidence to PR as comment
    f. Parse the evaluator's verdict from its documented `**Overall:** VERDICT` evidence line using portable tools (BSD `grep`/`sed`, never `grep -P`/`-oP`). An empty or unparseable verdict FAILS CLOSED — treat it as a blocking `PRODUCT_FAIL`. Act on verdict: PASS → proceed; PRODUCT_FAIL → keep ticket open, tag PR; UAT_SPEC_FAIL → log, don't block; EVAL_CHEAT_FAIL → flag for review
    See `.claude/skills/kitchenloop-execute/UAT-GATE.md` for the full protocol.
    For web-facing features the card's steps are browser steps executed against
    the live compose stack (boot it for the evaluator first) — the evaluator
    drives them via Playwright MCP and screenshots each step as evidence.
13. **Transition** the ticket to `in_review`.
14. **Move to the next ticket.** Do NOT `git checkout {{BASE_BRANCH}}` in the worktree — the next
    ticket's `git checkout -b ... origin/{{BASE_BRANCH}}` (sub-step 5) starts cleanly from the base
    regardless of the branch you are on.

### Step 4: Summary

After implementing all tickets, output (use the ticket ids from the provider — `tkt-NNNN`/local ids when `provider` is `none`, `#N` for github):
```
Implemented:
  - tkt-0001: Bootstrap app skeleton (PR: <url or branch>)
  - tkt-0006: Add retry logic (PR: <url or branch>)
Skipped:
  - tkt-0002: Blocked by tkt-0001 (prerequisite PR not yet merged)
```

## Ticket State Rules

- When you start working on a ticket: move to `in_progress`
- When the PR is created: move to `in_review`
- **NEVER move to `done`** — the PR Manager handles that after merge

## Rules

- Do NOT merge PRs — the Polish phase handles that
- Do NOT use interactive git commands (rebase -i, add -i)
- If a ticket is too complex (> 1 hour), create a partial implementation PR and note what's left
- Always run lint and tests before pushing
- Plan before code: read source files before implementing
- **Do NOT update loop-state.md** — the regress phase handles all loop-state commits
- **Re-read before writing shared files**: If you need to write to any shared state file (coverage matrix, codebase patterns, etc.), re-read it immediately before editing. Other phases may have modified it during this iteration.
