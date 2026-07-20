# Quality Bar

## Test Level Requirements (Unbeatable Tests)

Tests are classified into 4 levels. **L1/L2 alone are insufficient** — the regression
gate MUST include L3 to catch the "38 passing unit tests, broken service" failure mode.

| Level | Required? | What It Proves |
|-------|-----------|----------------|
| L1 Unit | Yes | Logic correctness (pure functions, isolated modules) |
| L2 API/Adapter | Yes | Contracts hold (method signatures, API schemas) |
| **L3 Integration** | **Yes — critical** | **Real app starts, real requests succeed, real state changes** |
| L4 E2E Scenario | Via UAT gate | Complete user journeys work end-to-end |

**New features touching integration points MUST include an L3 test** (or extend an
existing one). An L3 test starts the real application, sends a real request, and verifies
a real state delta — no mocks at the system boundary.

See `.kitchenloop/unbeatable-tests.md` for project-specific L3/L4 guidance.

## Live Verification — the Live Test & Fix rule (per SDD cycle)

Every PR that changes product behavior MUST carry a **Live Test Evidence**
section: the change was verified against the built compose image (fresh
`docker compose up --build`), the changed flow was driven in a real browser
(screenshots archived under `.kitchenloop/evidence/<iteration>/<ticket>/`),
and the compose log was scanned clean of non-allowlisted ERROR lines.
Defects found live are fixed in the same cycle — fix → rebuild → re-test.

- A green unit/L2 suite without live evidence **fails review**.
- Explicit `N/A (no product behavior change)` or `SKIPPED (pre-skeleton)` is
  acceptable only when true — a silent skip is a review-blocking honesty
  violation.
- Log allowlist additions require justification in the PR body; allowlisting
  a real error to get green is an assertion-weakening violation.

## Code Quality

- Follows the clean-code policy: `.claude/skills/typescript-clean-architecture/SKILL.md`
  (layer boundaries, Pre-Write Discipline, extraction thresholds, money rules)
- All existing tests pass (no regressions)
- New code has test coverage for happy path + primary error case
- Linting passes with zero errors
- No TODO/FIXME/HACK comments in shipped code (use tickets instead)
- No secrets, API keys, or credentials committed

## PR Standards

- PR title is descriptive (under 70 characters)
- PR body includes summary and test plan
- Changes are focused (one concern per PR)
- No unrelated formatting changes mixed with functional changes

## Safety

- No destructive operations without confirmation
- Error handling at system boundaries (user input, external APIs)
- No silent failures — errors are logged or surfaced

## Documentation

- Public API changes are reflected in docs
- Complex logic has inline comments explaining "why" (not "what")

## The Bar — Domain Red-Lines (example)

Derived from the project constitution (`.specify/memory/constitution.md`).
Every PR is evaluated against these before merge. Replace the examples below
with your project's own red-lines — short, testable, and anchored to the
constitution:

1. **Schema-Sacred** — The core domain schema is the platform's central
   entity. No layer may fork or privately extend it. Schema changes require a
   versioned migration note in the feature's plan.

2. **Adapter-Clean** — No third-party API shapes leak outside their adapter
   boundary. Swapping a provider must not require changes outside the adapter.

3. **Money-Safe** — Money paths use precise arithmetic, handle every external
   call failure, and assert state conservation on failure (no orphan money
   rows, no silently lost funds). Money paths require L3 integration tests
   against sandbox providers — unit-test-only coverage fails review.
