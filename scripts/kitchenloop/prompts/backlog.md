# Kitchen Loop - Backlog Grooming (Autonomous)

You are running **autonomously** as part of the Kitchen Loop. No interactive owner is available — never use `AskUserQuestion`; any ask goes to `ESCALATIONS.md` as an entry. You make all in-scope decisions yourself; anything on MANDATE.md's ALWAYS-STOP list becomes an `ESCALATIONS.md` entry instead of an action.

## Harness Rules — READ FIRST (before any other action)

1. **STOP sentinel.** Check whether `{{REPO_ROOT}}/.kitchenloop/STOP` exists. If it does, print its contents, output the stopped sentinel below, and STOP immediately — do no other work this phase:
   ```
   [backlog] STOPPED -- .kitchenloop/STOP present, iteration {{ITERATION_NUM}}
   ```
2. **Read `MANDATE.md`** (the owner's standing mandate) before doing anything else. It lists what ALWAYS stops: any work item matching the ALWAYS-STOP list in MANDATE.md (e.g. core schema migrations, changes to money-path semantics, changes to the loop's own gates, pushes outside the gated merge pipeline, deploys). For ANY work item that matches the ALWAYS-STOP list: do NOT do it — append an entry to `ESCALATIONS.md` in the documented format (one table row `| ID | Say | Question | Recommendation | Since | Blocks |` plus a one-paragraph context block beneath the table), then SKIP that item and continue.
3. **No interactive owner.** The owner is asynchronous; the ONLY channel to them is an `ESCALATIONS.md` entry. A gate that is not in ESCALATIONS.md was not asked.

## Autonomous Mode Rules

1. **Do NOT use `EnterPlanMode` or `ExitPlanMode`**. Proceed directly.
2. **Do NOT use `AskUserQuestion`**. Make reasonable decisions.
3. In autonomous mode, you ARE the approver. Evaluate and promote without waiting for confirmation.
4. **Do NOT use the Write tool to output status messages.** Never create files with names like "=== Done ===", "Exit code:", etc. Only use Write/Edit for actual code and documentation files.

## Ticketing Provider Dispatch

Read `ticketing.provider` from `kitchenloop.yaml` first:
- `provider: "none"` (this repo): ALL ticket operations read/write `.kitchenloop/backlog.json`
  (states `todo` / `backlog` / `in_progress` / `in_review` / `done`; fields `id`, `title`, `body`,
  `type`, `priority`, `state`, `created`, `pr_url`). Ticket ids are local (e.g. `tkt-0001`) — there
  is no `#N` issue form. Do NOT run `gh issue`/`gh pr` for ticket state.
- `provider: "github"`: use `gh issue`/`gh pr` with the labels under `ticketing.github`. The `#N`
  and `gh` steps below are the github path ONLY.

## Context
- Iteration: {{ITERATION_NUM}}
- Working directory: {{ITER_WORKTREE}}
- Base branch: {{BASE_BRANCH}}

## Your Task

**CRITICAL -- Output a sentinel line as your absolute first action** (before reading files or running any commands):

```
[backlog] STARTED -- iteration {{ITERATION_NUM}}
```

Run the **backlog grooming** phase:

### Step 1: Category-Aware Backpressure Check

Count tickets currently in "todo" state **by category**:

- If todo has **8+ total AND balanced categories**: skip grooming (report count and stop)
- If todo has **8+ total but missing categories**: continue, but ONLY add tickets for deficient categories
- If todo has **<8 total**: full grooming pass (all categories)

### Step 1.5: Abandoned Fix PR Scan

Scan for tickets whose fix PRs were closed without merging — these bugs are still live.

**When `ticketing.provider` is `github`:**
```bash
gh pr list --state closed --limit 50 \
  --json number,title,body,state,mergedAt \
  --jq '.[] | select(.mergedAt == null)'
```
Extract the ticket ID from the PR title/body (look for `#N` references).

**When `ticketing.provider` is `none` (this repo):** there is no `#N` linkage — key the scan to the
local branch/ticket convention instead:
```bash
# Closed-not-merged fix branches follow kitchen/fix-<ticket_id>-<desc>.
git fetch origin --prune
git branch -r --merged origin/{{BASE_BRANCH}} | sed 's#origin/##'   # already-merged (ignore)
```
For each `kitchen/fix-<ticket_id>-*` branch that is NOT merged into `origin/{{BASE_BRANCH}}` and has
no open PR, treat `<ticket_id>` (a `tkt-NNNN`/local id) as an abandoned fix. Cross-check the
ticket's `pr_url` field in `.kitchenloop/backlog.json`.

For each abandoned fix, regardless of provider:
1. Resolve the ticket ID (`#N` for github, `tkt-NNNN`/local id for `none`).
2. Check if the ticket is still open (`todo`/`in_progress`/`in_review`, or `backlog`).
3. If yes: promote back to `todo` with a note: "Fix for `<ticket_id>` was closed/abandoned without merging. Bug is still live on `{{BASE_BRANCH}}`. Re-promoting for execution."
4. If the ticket was already closed/`done`: reopen it (set state back to `todo`).

This prevents bugs from going unfixed when AI-generated fix PRs are silently abandoned.

### Step 2: Scan and Evaluate

Scan all tickets in "backlog" state. For each ticket, evaluate:

1. **Urgency** (1-5): Is this blocking other work? Is it a regression? Time-sensitive?
2. **Accessibility** (1-5): Can it be implemented with existing code? Dependencies available?
3. **Impact** (1-5): How many users/features does this affect? Does it improve the testing pipeline?

Score = Urgency + Accessibility + Impact (max 15)

### Step 3: Category Balance

Ensure the todo queue has a healthy mix using this composition:

| Category | Target | Purpose |
|----------|--------|---------|
| **Bug** | 2-3 | Fix what's broken — highest reliability impact |
| **Feature** | 1-2 | Expand capabilities, exercises new spec surface |
| **Improvement** | 1-2 | Polish and momentum |
| **Exploration** | 0-1 | Creative stress-testing, coverage discovery |

### Step 4: Execute Promotions

Move the top-scoring tickets to `todo` state until the queue reaches 5-8 tickets:
1. **Do NOT promote a blocked ticket.** Skip any ticket that declares a `blockedBy` dependency (or
   whose body names a prerequisite ticket) whose PR is not yet merged into `{{BASE_BRANCH}}`.
   Promoting a dependent ticket sends Execute to branch it from a base that lacks the prerequisite
   (e.g. bootstrap tickets that all depend on the app-skeleton ticket). Leave it in `backlog` and
   note it as "deferred (blocked by `<prereq>`)" in the summary.
2. Transition state from `backlog` to `todo`.
3. Add a note: "Promoted to todo by Kitchen Loop backlog grooming (iteration {{ITERATION_NUM}})".

### Step 5: Summary

Output:
```
Backlog grooming complete:
  Scanned: N backlog tickets
  Promoted: M tickets to todo
  Todo queue: X tickets (target: 5-8)
  Promoted:
    - tkt-0006: Fix login timeout (bug, score: 13)
    - tkt-0007: Add retry logic (improvement, score: 11)
  Deferred (blocked): [ticket id + prerequisite, or "none"]
```
(Use `#N` ids under the github provider, `tkt-NNNN`/local ids under provider `none`.)

## Rules

- Do NOT create new tickets — only promote existing ones from backlog
- Do NOT modify ticket content — only change state
- If the backlog is empty, output: "Backlog empty — ideate phase will create new scenarios"
