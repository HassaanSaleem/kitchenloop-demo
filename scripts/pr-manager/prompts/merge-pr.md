# PR Merge Pipeline

You are merging PR #{{PR_NUMBER}}. These stages continue the preparation
pipeline above — Stages 1-8 (the harness preamble, safety, protected-path
guard, code review, tribunal, branch update, CI, and final codex check) have
already run and passed. Do NOT re-run them. Every result line MUST begin with
`RESULT: ` (the orchestrator only parses `^RESULT: `).

You are reading these merge stages only because `{{DRY_RUN}}` is `false`. If it
were a dry run you would already have stopped at the Gate Decision above with
`RESULT: PREPPED`.

## Stage 8.5: Deletion Guard (Defense-in-Depth)

Before merging, verify no files are silently deleted:

```bash
git diff --name-only --diff-filter=D origin/{{BASE_BRANCH}}...HEAD
```

If any files are listed:
1. Check the PR description for explicit documentation of each deletion (e.g., "Removes X because Y").
2. If **any** deletion is undocumented, output `RESULT: NOT_MERGEABLE: undocumented file deletions` and **stop immediately**. Do NOT merge.
3. Only proceed if every deletion is justified in the PR body.

## Stage 8.6: Merge-Gate Evidence (Hard Gate)

MANDATE.md grants merge autonomy only to PRs that pass EVERY gate:
lint + tests + codex alignment review + **UAT card** + **regression oracle**.
Codex is covered by Stages 4a/8. Verify the remaining two here:

1. **UAT card verdict.** The PR must NOT carry the `uat-failed` label, and it
   must have a UAT evidence comment from the execute phase:
   ```bash
   gh pr view {{PR_NUMBER}} --json labels --jq '.labels[].name'      # must NOT include uat-failed
   gh pr view {{PR_NUMBER}} --json comments --jq '.comments[].body' | grep -F 'UAT Gate Results'
   ```
   Read the UAT comment's verdict line (`**Verdict:** ...`). It must read `PASS`.
   Parse portably — BSD grep/sed only, never `grep -P`/`grep -oP`. **Fail closed:**
   a missing, empty, or unparseable verdict counts as a FAIL, not a pass.
2. **Regression oracle / tests.** Confirm the oracle ran green for this change:
   Stage 6 CI when `pr_manager.require_ci` is true; otherwise the PR body's Live
   Test Evidence section (verified in Stage 3) plus the recorded `npm test` /
   oracle result for the PR's ticket.

If the UAT verdict is not `PASS` (or is absent), or the oracle evidence is
missing, and there is no explicit owner waiver entry for this PR in
ESCALATIONS.md: add an ESCALATIONS.md entry, output
`RESULT: STUCK: UAT/oracle evidence missing`, and STOP. Do NOT merge.

## Stage 9: Merge

Only if every preparation stage AND Stages 8.5-8.6 passed:
```bash
gh pr merge {{PR_NUMBER}} --squash --delete-branch --match-head-commit {{VERIFIED_HEAD_SHA}}
```

The `--match-head-commit` flag ensures GitHub only merges the exact commit that
was reviewed. If a force-push changed the PR head after the deletion guard ran,
the merge will fail safely — in that case output
`RESULT: NOT_MERGEABLE: head moved after review` and stop.

Note: `gh pr merge` lands the PR through GitHub's gated merge; it is NOT a direct
`git push` to `{{BASE_BRANCH}}` and is the only authorized way to land code.

After merge:
- Transition any referenced tickets to "done" state
- Add a comment to each ticket: "Fixed in PR #{{PR_NUMBER}}"

## Stage 10: Cleanup

Remove the worktree:
```bash
git worktree remove .claude/worktrees/pr-{{PR_NUMBER}}
```

## Output

Emit exactly one line, as your final action:

- `RESULT: MERGED` — PR was successfully squash-merged
- `RESULT: NOT_MERGEABLE: [reason]` — PR cannot be merged (protected path, wrong state, conflicts, undocumented deletion, head moved)
- `RESULT: STUCK: [reason]` — PR needs human attention (CI failures, review issues, codex outage, UAT/oracle evidence missing)
