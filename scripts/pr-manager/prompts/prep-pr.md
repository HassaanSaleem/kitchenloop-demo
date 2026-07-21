# PR Preparation Pipeline

You are preparing PR #{{PR_NUMBER}} for merge. Follow this pipeline strictly.
Every result you emit MUST be a single line beginning with `RESULT: ` — the
orchestrator only parses lines matching `^RESULT: `. Emit exactly one such line
as your final action.

## Harness Rules — read and obey before anything else

1. **STOP check (FIRST ACTION).** If `{{REPO_ROOT}}/.kitchenloop/STOP` exists,
   print its contents, output `RESULT: STUCK: STOP sentinel present`, and STOP
   immediately. Do no other work.
2. **MANDATE.** Read `{{REPO_ROOT}}/MANDATE.md` — it is the owner's standing
   mandate. If any action this pipeline would take is a work item matching the
   ALWAYS-STOP list in MANDATE.md (e.g. core schema migrations, changes to
   money-path semantics, changes to the loop's own gates, pushes outside the
   gated merge pipeline, deploys), do NOT do it: add a row to
   `{{REPO_ROOT}}/ESCALATIONS.md` in the exact format that file documents (one
   table row plus one context paragraph below it), output
   `RESULT: STUCK: [reason]`, and stop. If it is not recorded in
   ESCALATIONS.md, the loop has not actually asked.
3. **No interactive owner.** Never use AskUserQuestion and never wait for
   human input. Every ask goes to `ESCALATIONS.md` as an entry — never buried in
   a PR comment, prose, or chat.
4. **Push scope.** You MAY push fix commits to *this PR's own feature branch*
   (`{{HEAD_BRANCH}}`) — that is the authorized pr-manager path. You land the PR
   only via `gh pr merge` after every gate passes. You may NEVER `git push` to
   `{{BASE_BRANCH}}` directly, push to a new remote, force-push, or deploy;
   those ALWAYS stop and escalate to ESCALATIONS.md.

## Stage 1: Safety Checks

Verify:
- [ ] PR targets the correct base branch (`{{BASE_BRANCH}}`)
- [ ] PR is open and not in draft
- [ ] PR has no merge conflicts
- [ ] PR author is in the allowlist (if configured; empty = trust all)

If any check fails, output `RESULT: NOT_MERGEABLE: [reason]` and stop.

## Stage 1.5: Protected-Path Guard (Hard Gate)

The loop may not merge changes to its own gates. List the PR's changed files:

```bash
gh pr diff {{PR_NUMBER}} --name-only
```

If ANY changed file is at or under one of these protected paths, the loop may
not merge the PR:

- `.kitchenloop/quality-bar.md`
- `.kitchenloop/unbeatable-tests.md`
- `scripts/pr-manager/`
- `scripts/kitchenloop/prompts/`
- `kitchenloop.yaml`
- `MANDATE.md`
- `ESCALATIONS.md`
- `.specify/memory/constitution.md`
- `docs/architecture/system-architecture.md`
- `.claude/agents/uat-evaluator.md`
- `.claude/skills/kitchenloop-quality-sweep/`

If there is any hit: a loop-authored change to a protected gate is an owner
decision, not a loop merge. Add an ESCALATIONS.md entry, output
`RESULT: NOT_MERGEABLE: touches protected gate <file>`, and STOP.
(The orchestrator also enforces this mechanically before spawning you, so a hit
here means that guard was bypassed — treat it as blocking.)

## Stage 2: Worktree Setup

```bash
git fetch origin {{HEAD_BRANCH}}
git worktree add .claude/worktrees/pr-{{PR_NUMBER}} {{HEAD_BRANCH}}
cd .claude/worktrees/pr-{{PR_NUMBER}}
```

## Stage 3: Code Review (Hard Gate)

Run the `pr-auditor` agent (`.claude/agents/pr-auditor.md`) for a deep,
read-only review covering:

- Security vulnerabilities
- Logic errors
- Performance issues
- Test coverage gaps
- **Spec/architecture alignment** (see Stage 4a taxonomy): the reviewer MUST read
  this PR's feature `spec.md` and `plan.md` from this branch — resolve the real
  directory with `git -C {{WORKTREE}} diff --name-only {{BASE_BRANCH}}...HEAD | grep -oE '^specs/[0-9A-Za-z._-]+' | sort -u | head -1` (do not assume a placeholder path) — and
  check the implementation against them, not just review the code in isolation.
- **Required PR-body sections present** (the Live Test & Fix rule,
  `.kitchenloop/quality-bar.md`; honesty gate). The PR body must
  contain:
  - a **Live Test Evidence** section with a verdict — PASS (with journey,
    evidence path, and log excerpts), or an explicit `N/A (no product behavior
    change)` / `SKIPPED (pre-skeleton)`;
  - a **Pre-Write Decision** section (reuse/extend/generalize/new) per the
    clean-architecture policy;
  - a **Spec Alignment** section citing the feature spec/plan (or `N/A` with
    reason).
  A missing section, or an `N/A` on a PR that visibly changes product behavior,
  is a **critical** finding (honesty violation, same class as a weakened
  assertion).

If **critical** issues found: fix them, commit, push to `{{HEAD_BRANCH}}`.
Re-run review.
If issues persist after 2 fix attempts: output `RESULT: STUCK: critical review issues` and stop.

## Stage 4: External Review — Multi-Model Tribunal

Collect independent reviews from all available external reviewers. Each reviewer
outputs `APPROVE` or `REQUEST_CHANGES` with specific feedback.

### 4a. Codex Review (only if `reviewers.codex.enabled: true` in kitchenloop.yaml)

Codex is an **optional** second, cross-vendor reviewer, independent of the Claude
`pr-auditor` in Stage 3. **If `reviewers.codex.enabled: false`, skip this stage
entirely** — do not count it; the Stage 3 pr-auditor is the review gate, and a
single-subscription (Claude-only) setup merges on that alone. Run the rest of
this stage only when codex is enabled, from inside the PR worktree so the diff is
against the PR branch.

**First resolve THIS PR's real feature spec directory — never pass codex the
literal `specs/<NNN-feature>` placeholder, or it reviews blind to the spec (the
weakest link in the alignment gate):**
```bash
SPEC_DIR=$(git -C {{WORKTREE}} diff --name-only {{BASE_BRANCH}}...HEAD \
  | grep -oE '^specs/[0-9A-Za-z._-]+' | sort -u | head -1)
```
If `SPEC_DIR` is empty (a bug-fix PR that touches no `specs/` path), state that
there is no feature spec and have codex review against the invariants +
constitution only.

Then run codex with the RESOLVED `$SPEC_DIR` interpolated by the shell, so codex
receives CONCRETE file paths (not a placeholder).

**Invocation (codex-cli ≥ 0.142):** `codex review --base <branch>` and a custom
PROMPT are MUTUALLY EXCLUSIVE on modern codex-cli — `codex review --base main
"<prompt>"` errors out (`the argument '--base' cannot be used with '[PROMPT]'`).
So drive the alignment review through `codex exec` (full-prompt mode) and have it
diff against the base itself. Run from inside the PR worktree ({{WORKTREE}}) so
the diff resolves against the PR branch. The verdict lands in the
`--output-last-message` file (also echoed to stdout). Redirect stdin from
`/dev/null` (as shown) — `codex exec` otherwise blocks on a stdin read in the
loop's non-interactive shell and the gate hangs indefinitely.
```bash
codex exec --output-last-message /tmp/codex-4a-{{PR_NUMBER}}.txt "You are the external cross-model reviewer (Stage 4a) for PR #{{PR_NUMBER}}. Review ONLY the changes this branch introduces over {{BASE_BRANCH}}: first run  git diff --stat {{BASE_BRANCH}}...HEAD  then read the changed files that matter.

Three-way ALIGNMENT review — verify code, spec, and architecture agree. Read before judging the diff:
1. The feature spec: ${SPEC_DIR}/spec.md (requirements + acceptance criteria)
2. The feature plan: ${SPEC_DIR}/plan.md (module boundaries, data model, contracts)
3. The system architecture: docs/architecture/system-architecture.md (the numbered system invariants)
4. The constitution gates: .specify/memory/constitution.md and .kitchenloop/quality-bar.md ('The Bar')

Classify EVERY finding into exactly one state:
- VIOLATION    — code contradicts the spec or plan (blocking)
- MISSING-IMPL — a spec requirement has no implementation and no recorded deferral (blocking)
- DRIFT        — implementation violates a system invariant (cite the invariant id) or diverges from the plan's architecture: wrong module boundary, a core schema forked outside its canonical package, external API shapes leaking past the adapter boundary, money path without state-conservation handling, procedure without role authorization (blocking)
- EXTRA-BEHAVIOR   — implemented behavior with no basis in the spec/plan (scope creep; blocking unless trivially cosmetic)
- SPEC-GAP  — significant implemented behavior the spec does not address (NOT blocking: report it so a spec-amendment ticket is filed; the spec evolves through SDD, code does not silently define it)

Then review correctness, security, and style as usual.
End your output with a line containing exactly APPROVE or REQUEST_CHANGES, then the findings list with each finding's state label, file, and evidence." < /dev/null
```
Read the verdict from `/tmp/codex-4a-{{PR_NUMBER}}.txt` (the last APPROVE/REQUEST_CHANGES line).
Timeout: 300s (or `reviewers.codex.timeout` in kitchenloop.yaml).

**When enabled, codex is a MANDATE-named merge gate.** If it is enabled but
times out or is unavailable, you MUST NOT silently proceed on the other
reviewers: add an ESCALATIONS.md entry recording the codex outage for
PR #{{PR_NUMBER}}, output `RESULT: STUCK: codex review unavailable (merge gate)`,
and stop. This applies only when codex is enabled — with
`reviewers.codex.enabled: false` there is nothing to wait on and the Stage 3
pr-auditor stands as the gate. Never record an outage only in a PR comment.

**Routing rule (two-loop routing):** VIOLATION / MISSING-IMPL / DRIFT / EXTRA-BEHAVIOR
mean the *code* is wrong → fix autonomously in this pipeline. SPEC-GAP means the
*spec* is wrong or incomplete → file a spec-amendment ticket (`improvement` type,
titled `spec-gap: ...`) and do NOT block the merge on it. Code fixes are autonomous;
spec changes go back through the SDD flow.

**Deferral cross-check (before blocking on MISSING-IMPL).** codex reviews only the
diff + branch files — it does NOT see the PR description, so it cannot know a
requirement was deliberately deferred. Before treating any codex `MISSING-IMPL` as
blocking, confirm the requirement was not recorded as out-of-scope/deferred in
`$SPEC_DIR/plan.md` OR the PR body (`gh pr view {{PR_NUMBER}} --json body -q .body`).
If a deferral is recorded there, it is NOT MISSING-IMPL — reclassify it as
SPEC-GAP (non-blocking) so codex's blindness to the PR description cannot
false-block a PR on already-agreed scope.

### 4b. Gemini Review (only if `reviewers.gemini.enabled: true` in kitchenloop.yaml)
```bash
gemini --approval-mode plan -p "Review this PR diff for: correctness, security, performance. Output APPROVE or REQUEST_CHANGES with specific feedback."
```
Timeout: 60s. If disabled in config, skip entirely (do not count it). If enabled
but it times out/errors, record as `UNAVAILABLE` and exclude it (gemini is not a
MANDATE-named gate).

### 4c. Consensus Classification

Combine the Stage 3 pr-auditor verdict (always) with whichever external
reviewers are enabled — Stage 4a (codex) and/or Stage 4b (gemini) — into a
tribunal:

| All counted reviewers | Classification | Action |
|---|---|---|
| All APPROVE | **CONFIRMED** | Proceed |
| Majority APPROVE | **LIKELY** | Proceed, log dissenting review in PR comment |
| Majority REQUEST_CHANGES | **FLAG** | Add `needs-attention` label, output `RESULT: STUCK: majority reviewer rejection` |
| All REQUEST_CHANGES | **BLOCKED** | Output `RESULT: STUCK: unanimous reviewer rejection` |

- The Stage 3 pr-auditor always counts. A **single-subscription (Claude-only)**
  setup with both external reviewers disabled merges on the pr-auditor's APPROVE
  alone — that is a valid one-reviewer gate, not a weakened one.
- An **enabled**-but-UNAVAILABLE codex never collapses the tribunal — it stops
  (see Stage 4a). A disabled codex is simply not counted.
- When exactly two reviewers count: majority = both must agree.
- `UNAVAILABLE` reviewers (an enabled reviewer that errored) are excluded from the count.
- If REQUEST_CHANGES from any reviewer: attempt to fix the feedback first, then re-evaluate.
  After 2 fix attempts, use the latest verdicts for final classification.

## Stage 5: Branch Update

Update the PR branch with the latest base branch:
```bash
git fetch origin {{BASE_BRANCH}}
git merge origin/{{BASE_BRANCH}} --no-edit
```

If conflicts: resolve them following `scripts/pr-manager/prompts/resolve-conflicts.md`
(prefer PR branch intent), commit, and push to `{{HEAD_BRANCH}}`.
If unresolvable: output `RESULT: STUCK: unresolvable conflicts` and stop.

## Stage 6: CI Wait & Fix (4 rounds max)

Wait for CI checks to complete. If checks fail:
1. Analyze the failure
2. Fix the issue
3. Push to `{{HEAD_BRANCH}}` and wait again
4. Repeat up to 4 times

If CI still fails after 4 rounds: label PR `needs-attention` and output `RESULT: STUCK: CI failures`.

## Stage 7: Review Bot Threads (4 rounds max)

**Skip this stage entirely if `pr_manager.review_bot` is empty in kitchenloop.yaml**
(no review bot is installed on this repo — Codex in Stage 4a is the external reviewer).

Check for unresolved review bot threads (e.g., CodeRabbit). For each:
1. Read the feedback
2. Either fix the issue or reply explaining why it's not applicable
3. Push changes to `{{HEAD_BRANCH}}`
4. **Poll for re-review** instead of sleeping a fixed duration. Review threads are
   only available via the GraphQL API (the REST `--json` field does not exist):

```bash
# Poll every 2 minutes, max 4 polls (8 minutes total)
read -r OWNER REPO < <(gh repo view --json owner,name \
  --jq '"\(.owner.login) \(.name)"')
for i in 1 2 3 4; do
  sleep 120
  unresolved=$(gh api graphql -f query='
    query($owner:String!,$repo:String!,$pr:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$pr){
          reviewThreads(first:100){ nodes{ isResolved } }
        }
      }
    }' -F owner="$OWNER" -F repo="$REPO" -F pr={{PR_NUMBER}} \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false)] | length')
  [ "$unresolved" -eq 0 ] && break
done
```

Do NOT use a hard `sleep 600` or similar — poll for review status completion.

If threads still unresolved after 4 rounds: continue (non-blocking).

## Stage 8: Final Check

**Only if `reviewers.codex.enabled: true`** (skip this stage entirely when codex
is disabled — Stage 3's pr-auditor already gated the merge). Run one final Codex
review (hard gate for critical issues). Same codex-cli ≥ 0.142
constraint as Stage 4a — use `codex exec` (a custom prompt cannot be combined with
`codex review --base`), run from inside the PR worktree ({{WORKTREE}}), with
stdin closed (`< /dev/null`, as in Stage 4a — otherwise codex exec hangs on a
stdin read in the non-interactive shell):
```bash
codex exec --output-last-message /tmp/codex-8-{{PR_NUMBER}}.txt "Final merge-safety review of PR #{{PR_NUMBER}}. Review ONLY the changes this branch introduces over {{BASE_BRANCH}}: first run  git diff {{BASE_BRANCH}}...HEAD . Is this PR safe to merge? Check ONLY for critical issues: data loss, money-path bugs (double-charge/double-record, non-conserving failure paths), schema breakage, security, and in-process cross-request state on the serverless surface. End your output with a line containing exactly APPROVE or REJECT, with reason." < /dev/null
```
Read the verdict from `/tmp/codex-8-{{PR_NUMBER}}.txt` (the last APPROVE/REJECT line).
Timeout: 300s. When codex is enabled it is a MANDATE-named merge gate: if it is
unavailable here, you MUST NOT treat the PR as approved. Add an ESCALATIONS.md
entry recording the codex outage for PR #{{PR_NUMBER}}, output
`RESULT: STUCK: codex final review unavailable (merge gate)`, and stop.

If REJECT with critical reason: output `RESULT: STUCK: final review rejection`.

## Gate Decision (end of preparation)

- If any stage above failed: output the appropriate `RESULT: STUCK: [reason]` or
  `RESULT: NOT_MERGEABLE: [reason]` line and STOP.
- If all stages passed AND `{{DRY_RUN}}` is `true`: output `RESULT: PREPPED` and
  STOP. This is a dry run — do NOT continue to any merge stage, and do NOT merge.
- If all stages passed AND `{{DRY_RUN}}` is `false`: continue to the merge stages
  below (Stage 8.5 onward).

## Worktree Cleanup

If you STOP at this stage (PREPPED / STUCK / NOT_MERGEABLE), clean up the worktree first:
```bash
git worktree remove .claude/worktrees/pr-{{PR_NUMBER}}
```

## Output

Emit exactly one line, as your final action:

- `RESULT: PREPPED` — all prep gates passed (dry run: not merged)
- `RESULT: STUCK: [reason]` — needs human attention (review/CI/codex-outage/UAT)
- `RESULT: NOT_MERGEABLE: [reason]` — cannot be merged (protected path, wrong state, conflicts)
