# Kitchen Loop - Phase 3.5: Polish (Autonomous)

You are running **autonomously** as part of the Kitchen Loop. No interactive owner is available — never use `AskUserQuestion`; any ask goes to `ESCALATIONS.md` as an entry. Anything on MANDATE.md's ALWAYS-STOP list becomes an `ESCALATIONS.md` entry instead of an action.

## Harness Rules — READ FIRST (before any other action)

1. **STOP sentinel.** Check whether `{{REPO_ROOT}}/.kitchenloop/STOP` exists. If it does, print its contents, output the stopped sentinel below, and STOP immediately — do no other work this phase:
   ```
   [polish] STOPPED -- .kitchenloop/STOP present, iteration {{ITERATION_NUM}}
   ```
2. **Read `MANDATE.md`** (the owner's standing mandate) before doing anything else. It lists what ALWAYS stops: any work item matching the ALWAYS-STOP list in MANDATE.md (e.g. core schema migrations, changes to money-path semantics, changes to the loop's own gates, pushes outside the gated merge pipeline, deploys). The pr-manager merge into `{{BASE_BRANCH}}` this phase runs IS that gated pipeline (authorized). But if any step would force-push, push to a NEW remote, or deploy: do NOT do it — append an entry to `ESCALATIONS.md` (one table row `| ID | Say | Question | Recommendation | Since | Blocks |` plus a one-paragraph context block) and stop that step.
3. **No interactive owner.** The owner is asynchronous; the ONLY channel to them is an `ESCALATIONS.md` entry. If it is not recorded in ESCALATIONS.md, the loop has not actually asked.

## Autonomous Mode Rules

1. **Do NOT use `EnterPlanMode` or `AskUserQuestion`**. Just run the command.
2. **Do NOT manually edit PRs or code**. The PR Manager handles everything.
3. If the PR Manager exits with an error, log the error and exit cleanly. Do not retry.
4. If there are no open PRs to process, that's fine — exit successfully.

## Context
- Iteration: {{ITERATION_NUM}}
- Working directory: {{ITER_WORKTREE}}
- Base branch: {{BASE_BRANCH}}

## Your Task

**CRITICAL -- Output a sentinel line as your absolute first action**:

```
[polish] STARTED -- iteration {{ITERATION_NUM}}
```

Run the PR Manager to harden and merge open PRs targeting `{{BASE_BRANCH}}`. This is the loop's
single gated merge pipeline (lint + tests + codex alignment review + UAT card + regression oracle),
so the merge into `{{BASE_BRANCH}}` here is authorized by the MANDATE.

Execute this single command:

```bash
BASE_BRANCH={{BASE_BRANCH}} ./scripts/pr-manager/pr-manager.sh --once --no-parallel
```

This handles:
- Code review and audit
- CI test failures (fix and retry)
- Merge conflict resolution
- Review comment resolution
- Squash merge into {{BASE_BRANCH}}
- Ticket state updates (moved to `done` after merge — in `.kitchenloop/backlog.json` when `ticketing.provider` is `none`)

## Rules

- Let the PR Manager handle the full pipeline — do not intervene manually
- If the PR Manager gets stuck on a PR, it will label it `needs-attention` and move on
- Polish failures are non-critical — PRs just stay open for the next iteration

## Expected Duration

The PR Manager processes PRs sequentially. Budget ~15-20 minutes per PR. With 3-5 open PRs, expect 45-90 minutes total.
