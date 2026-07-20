# UAT Gate Protocol

## Overview

After each ticket implementation (post-PR creation), the execute phase runs a **User Acceptance Test gate** using a fresh agent that has zero implementation context. This catches integration failures, UX friction, and documentation lies that unit tests miss.

## Flow

```
implement -> unit tests -> lint -> live test & fix (built compose
             image, QA journey, log scan — see SKILL.md step 4e) -> PR created
         -> generate test card (implementer)
         -> freeze test card (deterministic validation)
         -> boot live stack for the evaluator (docker compose up --build --wait)
         -> spawn UAT evaluator (fresh agent, clean worktree, browser via Playwright MCP)
         -> integrity check (git diff on worktree)
         -> attach evidence to PR
         -> verdict determines next action
```

The UAT gate is the *independent* live check: the implementer already live-tested
in step 4e, but the evaluator re-verifies with zero implementation context
against the same built stack. Two different humans-in-spirit, one artifact.

## Step 1: Generate Test Card (Implementer)

After creating the PR, the implementer writes a test card to:
`.kitchenloop/uat-cards/<ticket-id>.md`

### Test Card Format (STRICT)

```markdown
# User Test Card: <ticket-id>

## Feature (one sentence)
<What the user should be able to do after this change>

## Prerequisites
- [ ] <exact prerequisite, e.g., "API_KEY is set">
- [ ] <each prerequisite is checkable with a command>

## Prerequisite Verification Commands
```bash
# Each prerequisite must have a verification command
echo $API_KEY | head -c 5      # should print first 5 chars
which myapp                     # should return a path
```

## Steps

### Step 1: <action description>
```bash
<exact command — no placeholders, no "edit this file">
```
**Expected exit code:** 0
**Expected output contains:** "<exact string or regex>"
**Expected output does NOT contain:** "<error pattern>"

### Step 2: ...
(each step has exact command, exact expected exit code, exact output assertions)

### Browser steps (web-facing features — REQUIRED form for UI changes)

For features a user experiences in the browser, steps are browser actions
executed against the live compose stack (the implementer boots it before
spawning the evaluator; the card's prerequisites verify it's up):

```markdown
### Step N: <user action description>
**Browser action:** navigate to http://localhost:3000/<route>, then <exact
interaction: click "<visible label>", fill "<field label>" with "<value>", submit>
**Expected visible result:** "<exact text/element the user must see>"
**Expected NOT visible:** "<error text/broken state>"
**Screenshot:** save as step-N.png in the evidence directory
```

Browser steps are executed with Playwright MCP browser tools. Every browser
step MUST capture a screenshot — a browser step without a screenshot does not
count as executed.

## Artifacts
<list any files that should exist after the test, with expected content patterns>

## Constraints
- MAX_DURATION: <seconds, e.g., 120>
```

### Test Card Rules

1. **No manual code edits** — if the feature requires testing a code change (e.g., "set config to X"), the implementer must provide a pre-built test fixture or config file as part of the PR
2. **No vague assertions** — "should work" is not an assertion. Use exact strings, exit codes, file existence checks
3. **No implementation details** — the card should describe user-visible behavior only. No internal file paths, variable names, or class references
4. **Every command must be copy-pasteable** — no `<placeholders>` that require judgment
5. **Include negative tests** — at least one step should verify that bad input is rejected gracefully

### What Makes a GOOD Test Card

- Tests the feature from the CLI or user entry points
- For web features: browser steps against the live compose stack, with
  screenshots — testing the built product, not its source
- Verifies both happy path and one failure mode
- Has tight output assertions (exact strings, not "should contain something about X")
- Includes a final log-review step: check the captured compose log for
  ERROR-level lines (the implementer provides the log path in prerequisites)
- Runs in under 120 seconds
- Doesn't require any files that aren't in the repo

### What Makes a BAD Test Card

- "Run the unit tests" (that's not user testing, that's developer testing)
- "Open config.py and change line 42" (requires code editing)
- "Observe that it works" (no assertion)
- Steps that only work on the implementer's machine

## Step 2: Freeze Test Card (Validation)

Before handing off to the UAT evaluator, validate the test card:

1. **Parse check**: Every step has `command`, `expected exit code`, and at least one output assertion
2. **No-edit check**: Reject steps that instruct manual file editing or ad-hoc repo mutations
   (e.g., `vim`, `nano`, `sed -i`, `cat > file`, `touch`, `mkdir`, `cp`, `mv`, `rm`, `echo ... > file`).
   Allow generic product actions like "create account", "start server", "submit request".
3. **No-placeholder check**: No step contains `<angle-bracket-placeholders>`
4. **Duration check**: Total MAX_DURATION across steps is reasonable (< 300s)

If validation fails, the test card is defective. Log it but don't block the PR — the UAT gate reports UAT_SPEC_FAIL instead.

## Step 3: Build Environment, then Spawn UAT Evaluator

The evaluator runs in a fresh `isolation: "worktree"` — clean git state, which is
required for the Step 4 integrity check. A clean worktree has **no `node_modules`**
(it is git-ignored, so it is never copied into a new worktree), so any card step
that touches the toolchain — a CLI run, `pnpm test`, a booted app — would
otherwise fail as `ENVIRONMENT_BLOCKED` before it can produce a real verdict.

So the evaluator's FIRST action MUST be to **build its environment**, prepended to
its prompt as a mandatory setup preamble (below). Installing dependencies is NOT a
product change — `node_modules` and the pnpm store are git-ignored, and
`--frozen-lockfile` leaves the lockfile untouched, so this does **not** trip the
Step 4 integrity check (which only flags tracked/untracked *product* files).
(Default toolchain: pnpm workspace — adapt to the project.)

```python
# Pseudo-code for the execute phase
Agent(
    subagent_type="uat-evaluator",
    isolation="worktree",           # clean git state, separate copy
    model="haiku",                  # deliberately weakest model = "dumb user" proxy
    prompt=f"""Execute the following User Test Card. You have NO other context.

## Step 0 — Environment setup (run this FIRST, before any test-card step)
From the worktree root, install dependencies so the card's steps can run:

    pnpm install --frozen-lockfile || pnpm install

Then, if the card has browser steps, confirm the live stack the implementer
booted is reachable (the card's prerequisites say how). If BOTH install commands
fail, STOP and report `ENVIRONMENT_BLOCKED` with the install error — that is a
real, fixable environment fault to surface, not a silent PR block. Otherwise
proceed to the test card below and return a real PASS/PRODUCT_FAIL verdict.

{test_card_contents}

## Hidden Checks (evaluator-only, not visible to implementer)

1. Run `git status` after all steps — working tree must be clean (no modified files)
2. Run `ls .kitchenloop/uat-runs/{ticket_id}/` — evidence.md must exist
3. Verify no files were created outside .kitchenloop/uat-runs/
4. Check that all commands from the test card were actually executed (evidence.md must contain raw output for each step)

Save all evidence to: .kitchenloop/uat-runs/{ticket_id}/evidence.md
""",
)
```

## Step 4: Integrity Check (Post-UAT)

After the UAT evaluator returns, the execute phase performs a **mechanical integrity check**:

```bash
cd <uat-worktree-path>

# 1. Check for product file modifications (staged + unstaged)
CHANGED=$(git diff --name-only --cached; git diff --name-only)
UNTRACKED=$(git ls-files --others --exclude-standard | grep -v ".kitchenloop/uat-runs/")

if [ -n "$CHANGED" ] || [ -n "$UNTRACKED" ]; then
    echo "EVAL_CHEAT_FAIL: UAT evaluator modified product files"
    echo "Changed: $CHANGED"
    echo "Untracked: $UNTRACKED"
    # Override verdict to EVAL_CHEAT_FAIL regardless of what evaluator reported
fi

# 2. Check evidence exists
if [ ! -f ".kitchenloop/uat-runs/<ticket-id>/evidence.md" ]; then
    echo "EVAL_CHEAT_FAIL: No evidence file produced"
fi

# 3. Check evidence has content for each step
STEP_COUNT=$(grep -c "^### Step" .kitchenloop/uat-cards/<ticket-id>.md)
EVIDENCE_STEPS=$(grep -c "^### Step" .kitchenloop/uat-runs/<ticket-id>/evidence.md)
if [ "$EVIDENCE_STEPS" -lt "$STEP_COUNT" ]; then
    echo "EVAL_CHEAT_FAIL: Evidence missing steps ($EVIDENCE_STEPS/$STEP_COUNT)"
fi
```

## Step 5: Verdict Actions

| Verdict | Action |
|---------|--------|
| **PASS** | Proceed normally. Copy evidence to PR comment. |
| **PRODUCT_FAIL** | Keep ticket in current state. Add PR comment with failure details. Tag as `uat-failed`. |
| **UAT_SPEC_FAIL** | Implementer's test card was bad. Log for process improvement. Don't block PR. |
| **EVAL_CHEAT_FAIL** | Serious process issue. Log prominently. Re-run with stricter model or flag for human review. |

## Step 6: Attach Evidence to PR

```bash
# Add UAT results as PR comment
gh pr comment <pr-number> --body "$(cat <<'EOF'
## UAT Gate Results

**Verdict:** <PASS|PRODUCT_FAIL|UAT_SPEC_FAIL|EVAL_CHEAT_FAIL>
**Evaluator:** <model used>
**Duration:** <seconds>

<paste evidence summary — not full output, just step verdicts and any failures>

<details>
<summary>Full evidence</summary>

<paste full evidence.md contents>

</details>
EOF
)"
```

## When to Skip UAT Gate

The UAT gate MAY be skipped for:
- **Pure refactors** with no user-visible behavior change (but still need unit tests)
- **Documentation-only changes**
- **CI/CD pipeline changes**

The gate MUST NOT be skipped for:
- Any change to core product source code
- Any change to CLI or user-facing interfaces
- Any new or modified user-visible feature

## Anti-Gaming Design Decisions

1. **Why `isolation: "worktree"`**: Clean git state means any file modification is detectable via `git diff`
2. **Why Haiku (weakest model)**: A strong model compensates for bad test cards by "figuring out" the intent. A weak model fails if the card is incomplete — which is the signal you want. The test card must be good enough for the dumbest user, and Haiku is your dumb user proxy. If Haiku can follow the card and get the expected results, a real user can too.
3. **Why hidden checks**: Evaluator can't optimize for checks it doesn't know about
4. **Why mechanical integrity check**: The implementer (not the evaluator) runs the integrity check, so the evaluator can't suppress it
5. **Why exact commands**: Removes evaluator judgment about "what to test", preventing reinterpretation
6. **Why evidence format**: Structured output is mechanically parseable — narrative is not
