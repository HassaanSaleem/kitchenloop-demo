# Kitchen Loop - Phase 2: Triage (Autonomous)

You are running **autonomously** as part of the Kitchen Loop. No interactive owner is available — never use `AskUserQuestion`; any ask goes to `ESCALATIONS.md` as an entry. You make all in-scope decisions yourself; anything on MANDATE.md's ALWAYS-STOP list becomes an `ESCALATIONS.md` entry instead of an action.

## Harness Rules — READ FIRST (before any other action)

1. **STOP sentinel.** Check whether `{{REPO_ROOT}}/.kitchenloop/STOP` exists. If it does, print its contents, output the stopped sentinel below, and STOP immediately — do no other work this phase:
   ```
   [triage] STOPPED -- .kitchenloop/STOP present, iteration {{ITERATION_NUM}}
   ```
2. **Read `MANDATE.md`** (the owner's standing mandate) before doing anything else. It lists what ALWAYS stops: any work item matching the ALWAYS-STOP list in MANDATE.md (e.g. core schema migrations, changes to money-path semantics, changes to the loop's own gates, pushes outside the gated merge pipeline, deploys). For ANY work item that matches the ALWAYS-STOP list: do NOT do it — append an entry to `ESCALATIONS.md` in the documented format (one table row `| ID | Say | Question | Recommendation | Since | Blocks |` plus a one-paragraph context block beneath the table), then SKIP that item and continue.
3. **No interactive owner.** The owner is asynchronous; the ONLY channel to them is an `ESCALATIONS.md` entry. If it is not recorded in ESCALATIONS.md, the loop has not actually asked.

## Autonomous Mode Rules

1. **Do NOT use `EnterPlanMode` or `ExitPlanMode`**. Plan inline and proceed.
2. **Do NOT use `AskUserQuestion`**. Make reasonable decisions and document them.
3. Create all tickets without asking for confirmation. Use your best judgment for priority and labeling.
4. **Do NOT use the Write tool to output status messages.** Only use Write/Edit for actual code and documentation files.

## Ticketing Provider Dispatch

Read `ticketing.provider` from `kitchenloop.yaml` first:
- `provider: "none"` (this repo): ALL ticket operations read/write `.kitchenloop/backlog.json`
  (states `todo` / `backlog` / `in_progress` / `in_review` / `done`; fields `id`, `title`, `body`,
  `type`, `priority`, `state`, `created`, `pr_url`). New tickets get local id-style ids (e.g.
  `tkt-0006`) — there is no `#N` issue form. Do NOT run `gh issue`/`gh pr` for ticket operations.
- `provider: "github"`: use `gh issue`/`gh pr` with the labels under `ticketing.github`. The `gh`
  and `#N` steps below are the github path ONLY.

## Loop Context
- **Repo root**: {{REPO_ROOT}}
- **Iteration worktree**: {{ITER_WORKTREE}}
- **Iteration number**: {{ITERATION_NUM}}
- **Mode**: {{MODE}}
- **Base branch**: {{BASE_BRANCH}}
- **Important**: You are running inside a git worktree, NOT the main repo directory.
  All file writes go to this worktree. Do NOT `cd` to the repo root.

## Your Task

Run the **triage** phase.

**CRITICAL -- Output a sentinel line as your absolute first action** (before reading files or running any commands):

```
[triage] STARTED -- iteration {{ITERATION_NUM}}, mode={{MODE}}
```

### Step 1: Find the Latest Report

Look in docs/internal/reports/ for the most recent iteration report file.

### Step 2: Extract Findings

For each bug, missing feature, improvement, or friction point in the report:
1. Write a clear title (under 80 characters)
2. Write a description with reproduction steps or context
3. Identify the **root cause hypothesis** — which component or file is responsible, and why
4. Include **file pointers** — specific files and line ranges from the experience report or codebase
5. Define **acceptance criteria** — exact conditions for considering the fix verified
6. Write **reproduction steps** — concrete commands or sequence to reproduce the issue
7. Assign a type: `bug`, `feature`, `improvement`, or `exploration`
8. Assign a priority: `critical`, `high`, `medium`, or `low`

**HARD ROADMAP SCOPE — do NOT create out-of-scope tickets.** Consult `spec.blocked` in
`kitchenloop.yaml` — items listed there are out of scope until the owner unlocks their phase;
triage must reject findings that target them, citing the blocked id. A finding that targets a
blocked item is **rejected at triage** — do NOT create a ticket. Record it once in an
`out-of-scope` note in the summary so its existence is logged; it only becomes actionable after
the owner unlocks that item. In-scope findings proceed to Step 3.

### Step 3: Deduplicate (with abandoned-PR override)

Before creating tickets, check existing tickets to avoid duplicates:
- Search for similar titles and descriptions in the existing backlog
- If a duplicate exists, add a comment to the existing ticket instead of creating a new one

**CRITICAL — Abandoned fix PR override**: When you find a duplicate ticket, check if its fix was
**closed/abandoned without merging** — if so the bug is still live and dedup must be overridden.

- **`provider: "github"`:** check the linked PR:
  ```bash
  gh pr view <pr_number> --json state,mergedAt --jq '{state, mergedAt}'
  ```
  Abandoned when `state == "CLOSED"` and `mergedAt == null`.
- **`provider: "none"` (this repo):** there is no `#N` linkage. The fix branch follows
  `kitchen/fix-<ticket_id>-<desc>`; the fix is abandoned when that branch is NOT merged into
  `origin/{{BASE_BRANCH}}` and has no open PR (cross-check the ticket's `pr_url` field in
  `.kitchenloop/backlog.json`):
  ```bash
  git fetch origin --prune
  git branch -r --merged origin/{{BASE_BRANCH}} | grep "kitchen/fix-<ticket_id>-" || echo "NOT MERGED — abandoned"
  ```

If abandoned, **override the dedup decision**:
- Create a new ticket OR reopen the existing one (set state back to `todo` under `none`)
- Reference the closed fix in the description: "Previous fix (`kitchen/fix-<ticket_id>-…` / PR #N) was closed without merging"
- Set priority to at least the original ticket's priority
- This prevents bugs from going unfixed when fixes are silently abandoned

### Step 4: Create Tickets

Create each ticket using the active ticketing provider (append to `.kitchenloop/backlog.json` when
`provider` is `none`; `gh issue create` when `github`). Include:
- Clear, descriptive title
- Reproduction steps or context in the body
- Appropriate labels/fields (type + priority)
- Reference to the iteration report
- Set `blocks`/`blockedBy` dependencies between related tickets (a dependent ticket must name the
  prerequisite ticket id so backlog grooming and execute can defer it until the prerequisite merges)

### Step 5: Summary

Output all tickets created (or existing ones updated) — use `#N` ids under github, `tkt-NNNN`/local
ids under provider `none`:
```
Created: tkt-0006 — "Fix login timeout error" (bug, high)
Updated: tkt-0002 — "Add retry logic for API calls" (added iteration {{ITERATION_NUM}} findings)
Out-of-scope (not ticketed): [finding + blocked id, or "none"]
```

## Rules

- **Do NOT update docs/internal/loop-state.md** — the regress phase handles all loop-state commits
- Use consistent labeling: bug, feature, improvement, exploration
- Priority: Critical = today, High = this week, Medium = this sprint, Low = backlog
