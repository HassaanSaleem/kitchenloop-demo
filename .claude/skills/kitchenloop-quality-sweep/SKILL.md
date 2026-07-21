---
name: kitchenloop-quality-sweep
description: Periodic codebase quality audit for the loop — dead code, duplication, completeness, compactness, and architecture-boundary conformance. Run every 3rd loop iteration (aligned with review_interval) or on demand. Produces a report and files improvement tickets; never deletes code directly.
---

# KitchenLoop: Quality Sweep

> Meta-phase — audit the codebase the loop is growing, so N autonomous SDD cycles
> don't accumulate random files, orphan functions, duplicates, or dead code.

## Triggers

- `kitchenloop quality sweep`
- Every 3rd loop iteration (same cadence as `review_interval` in kitchenloop.yaml) —
  the Regress phase invokes this after the oracle when `iteration % 3 == 0`
- After any large feature merge (3+ PRs in one iteration)

## Ground Rules

- **Report + tickets, never direct deletion.** Findings become `improvement`
  tickets in the backlog; removals happen through the normal Execute → review →
  UAT pipeline with tests green.
- **Dedupe against open tickets** before filing (match on file path + finding type).
- **No silent caps**: if a scan is skipped (tool missing, dir absent), say so in
  the report — a skipped scan must not read as a clean scan.
- The clean-code policy being enforced is `.claude/skills/typescript-clean-architecture/SKILL.md`;
  cite the specific rule for every finding.

## Procedure

### Step 0: Preconditions

1. Skip with a one-line report if the app skeleton doesn't exist yet (no `package.json`).
2. Read `.kitchenloop/quality-bar.md` and the clean-code policy.
3. Note the last sweep report in `docs/internal/reports/` to compute trends.

### Step 1: Dead Code (unused files, exports, dependencies)

```bash
npx knip --reporter markdown          # unused files, exports, types, deps
```
Fallback if knip isn't configured yet: `npx ts-prune` + `npx depcheck`.
Classify each hit: **dead** (no references — ticket for deletion), **orphan**
(file imported by nothing — wiring bug or dead), **premature** (exported for a
future consumer that never arrived — inline or delete).

### Step 2: Duplication & Compactness

```bash
npx jscpd --min-tokens 50 --reporters consoleFull apps packages
```
Plus outlier scan: files > 400 lines, functions > 60 lines, packages whose
`index.ts` exports > 20 symbols. Each duplication cluster = one `generalize`
ticket naming the concept to hoist (per the extraction thresholds in the
clean-code policy). Long-file findings propose a concrete split along layer
boundaries, not arbitrary line counts.

### Step 3: Completeness

1. `grep -rn "TODO\|FIXME\|HACK\|XXX" apps packages --include="*.ts" --include="*.tsx"`
   — each is a quality-bar violation; ticket it.
2. Stub scan: `throw new Error("not implemented")`, empty catch blocks,
   `@ts-expect-error` / `eslint-disable` without a comment justifying it.
3. **Spec↔code completeness** (alignment with SDD): for each feature merged since
   the last sweep, open its `specs/<NNN>/spec.md` and verify every functional
   requirement maps to code + a test. Unimplemented-and-undeferred requirements
   are MISSING-IMPL tickets; implemented-but-unspecified behavior is a
   SPEC-GAP ticket (spec amendment, not code change).
4. Test-coverage shape: every handler/domain function has its happy-path +
   error-branch tests (policy rule) — list gaps, don't chase percentages.

### Step 4: Architecture Boundary Conformance

```bash
npx depcruise --config .dependency-cruiser.cjs apps packages
```
Boundary rules (from the clean-code policy): domain imports no adapters;
domain types only from their canonical package; third-party API shapes only
inside their adapter package; no deep imports across package boundaries;
money math only in the domain package. Each violation is a DRIFT ticket
(blocking priority: high).

### Step 5: Report & Tickets

1. Write `docs/internal/reports/quality-sweep-iter-<N>.md`:
   summary table (finding counts by category vs previous sweep — trend arrows),
   findings with file:line evidence and the policy rule violated, tickets filed.
2. File tickets (type `improvement`; priority: DRIFT/boundary = high,
   dead code / duplication = medium, TODO/compactness = low).
3. Append a one-line entry to the loop state iteration history.
4. If any category **grew** two sweeps in a row, flag it in the report header as
   a drift warning for the owner (same spirit as the loop's drift metrics —
   quality debt must trend down, not up).
