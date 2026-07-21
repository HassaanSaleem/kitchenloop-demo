# Kitchen Loop Report - Iteration 1

## Scenario: A malformed note poisons search, and share links can be issued for notes that don't exist
**Date**: 2026-07-21
**Mode**: strategy
**Tier**: T2 Composition
**Features Exercised**: notes-editor, search, sharing

## What I Did (as a user)

I role-played the documented user journey from `kitchenloop.yaml`'s `project.context`
(author creates notes -> lists -> searches -> shares -> reader opens the share
link), but the way a real client actually behaves rather than the idealized
happy path: I let one note go out the door with a missing `title` (the kind
of thing that happens from a blank form field, a partial autosave, or a buggy
client), and I probed what happens at the seams between notes-editor, search,
and sharing rather than testing each feature in isolation.

Confirmed the L3 smoke test (`tests/smoke.mjs`, wired to `verification.oracle.smoke_command`)
already exists from a prior commit and passes, so Priority Zero bootstrap was
not needed this iteration.

Concretely, against a live `buildApp()` instance over real HTTP (no mocks):

1. Created two well-formed notes ("Groceries", "Standup notes").
2. Created a third note with `POST /notes` and no `title` field at all —
   this is accepted with `201`, even though the README documents the schema
   as `{title, body?, tags?}` (title has no `?`, i.e. is meant to be required).
3. Called `GET /search?q=milk` — expected to still find "Groceries". Instead
   the whole endpoint 500'd, because `search.mjs` does
   `note.title.includes(query)` and the title-less note's `title` is
   `undefined`. **One bad note breaks search for the entire collection**, not
   just for itself.
4. Called `POST /notes/:id/share` with an id that was never created —
   expected `404` (matching every other "unknown id" path in this API).
   Instead it returned `201` with a token, because `ShareRegistry.share()`
   never checks the note exists.
5. Ran the correct-path lifecycle: create -> share -> reader reads via
   `GET /shared/:token` (200, correct note) -> author deletes the note ->
   reader re-reads the same token (404, correctly revoked). This direction
   works exactly as expected.
6. Sanity-checked that sharing the same note twice mints two independently
   valid tokens (not a bug — just undocumented; noted below).
7. Poked at `search` a bit further: it's case-sensitive (`q=relay` does not
   match a note titled "Relay Launch") and it only looks at `title`/`body`,
   never `tags`, even when the query text is itself one of the note's tags.
8. Wrote all of the above as `scenarios/incubating/notes-search-share-seams/scenario.mjs`,
   using `node:test` so each finding is an individually reported pass/fail
   rather than one script that aborts on the first surprise. Ran it directly
   with `node scenarios/incubating/notes-search-share-seams/scenario.mjs`.
9. Ran the oracle: `node scripts/lint.mjs`, `node --test tests/*.test.mjs`,
   `node tests/smoke.mjs` — all green, confirming my new scenario file (which
   lives outside `tests/*.test.mjs`) doesn't touch the regression gate.
10. Tried to regenerate the coverage matrix per Step 6 and hit a real bug in
    the loop's own tooling (`scripts/kitchenloop/derive-coverage.mjs`) — see
    Friction Point 1 and `ESCALATIONS.md` (ESC-1). Left `scripts/` untouched
    since it's on MANDATE's ALWAYS-STOP list, and did not hand-edit
    `.kitchenloop/coverage-matrix.yaml` (it's generated).

## What Worked

- The share -> read -> delete -> read-again lifecycle is correct: a deleted
  note's share links stop resolving immediately, with no extra cleanup step
  needed. This is exactly the behavior a reader would expect.
- Minting a fresh token per `share` call is simple and predictable — no
  hidden token reuse or collisions across two shares of the same note.
- The server itself is trivial to stand up in-process via `buildApp()` for
  testing — no fixtures, no test server boilerplate needed. Good ergonomics
  for writing this kind of scenario test.
- `node:test` run as a plain script (no `--test` flag) reports each
  assertion's pass/fail individually and still exits non-zero overall, which
  made it easy to write one scenario file that documents three bugs and two
  correct behaviors in a single, readable run.

## Friction Points

1. **[BUG - tooling, not relay-notes]** `scripts/kitchenloop/derive-coverage.mjs`
   cannot currently parse `kitchenloop.yaml` at all. `extractDimension()`
   matches the `features:`/`platforms:`/`user_types:` header at 4-space
   indent correctly, but then looks for list items at that *same* 4-space
   indent, while the actual file nests items 2 spaces deeper (standard
   YAML). Every dimension resolves to an empty vocabulary, so
   `node scripts/kitchenloop/derive-coverage.mjs` throws on any scenario's
   `KITCHENLOOP-COVERAGE` block, no matter how correctly formatted. Filed as
   `ESC-1` in `ESCALATIONS.md` (scripts/ is MANDATE ALWAYS-STOP territory) —
   `.kitchenloop/coverage-matrix.yaml` was not regenerated this iteration as
   a result. The block is already correctly declared in
   `scenarios/incubating/notes-search-share-seams/scenario.mjs` and ready to
   be picked up as soon as the script is fixed.
2. **[BUG]** `POST /notes` performs no input validation. A payload missing
   `title` is silently accepted and stored — see Bugs Found for the
   downstream blast radius.
3. **[BUG]** `POST /notes/:id/share` never checks that the note id exists,
   so callers get a false-positive `201` for notes that were never created
   (or were already deleted).
4. **[UX]** `GET /search` is case-sensitive substring matching only, and
   never looks at `tags` — searching for a word that is literally one of a
   note's tags returns nothing unless that word also happens to appear in
   the title or body.
5. **[UX]** There's no way to see or revoke a note's outstanding share
   tokens — `POST /notes/:id/share` can be called any number of times and
   every token it has ever issued stays valid until the note itself is
   deleted. Not a bug (nothing documents otherwise) but a real gap for a
   "read-only share link" feature.

## Bugs Found

**BUG-1**: A note created without a `title` breaks `/search` for the entire
collection, not just itself — `src/search.mjs:6` calls
`note.title.includes(query)` unconditionally, which throws
`TypeError: Cannot read properties of undefined (reading 'includes')` on any
note whose `title` is `undefined`, turning `GET /search` into a 500 for every
caller until that one note is deleted.
Repro: `POST /notes` with `{"body": "no title"}` (no validation stops this),
then `GET /search?q=<anything>`.
Root cause is really the *lack* of input validation on `POST /notes`
(BUG-2) — the search crash is the downstream symptom.

**BUG-2**: `POST /notes` accepts a payload with no `title` and returns `201`.
The README documents the create schema as `{title, body?, tags?}` — `title`
has no `?`, implying it's required — but `src/server.mjs`/`src/store.mjs`
never enforce that. This is the root cause behind BUG-1.

**BUG-3**: `POST /notes/:id/share` returns `201 {token}` for a note id that
was never created (or has since been deleted), instead of `404` like every
other "operate on an unknown note id" path in this API (`GET /notes/:id`,
`DELETE /notes/:id` both correctly 404). The token it mints will never
resolve to real data — `GET /shared/:token` correctly 404s when the underlying
note doesn't exist — so the failure mode is a confusing "successful" share
that silently does nothing, rather than an honest error at the point of
the mistake.

## Missing Features

**FEAT-1**: Case-insensitive search. `GET /search?q=relay` does not match a
note titled "Relay Launch" — every real note-search UI a user would expect
(and the ones this project is presumably competing with) treats search as
case-insensitive by default.

**FEAT-2**: Search over `tags`, not just `title`/`body`. Notes can be tagged
at creation time (`POST /notes {tags: [...]}`), but there is no way — via
`/search` or any other endpoint — to find notes by tag. Tags are write-only
today.

**FEAT-3**: A way to list or revoke a note's active share tokens. Right now
the only way to invalidate a share link is to delete the note itself (which
also deletes the note's content for the author, not just the reader's
access).

## Improvements

**IMP-1**: `POST /notes` should validate the payload (at minimum, require a
non-empty `title`) and return `400` with a clear error body on a bad
payload, the same way the server already does for `err.message` on parse
errors. This single change would prevent both BUG-1 and BUG-2.

**IMP-2**: `POST /notes/:id/share` (and, for symmetry, any future endpoint
keyed by note id) should check `store.get(id)` first and return `404` when
the note doesn't exist, matching the convention already used by
`GET /notes/:id` and `DELETE /notes/:id`.

## Tests Added

- `scenarios/incubating/notes-search-share-seams/scenario.mjs` — 5
  `node:test` cases against a live in-process server (no mocks):
  1. `author builds a realistic note collection, including one bad payload`
     — **fails today** (documents BUG-2: expects 400, gets 201).
  2. `search must not 500 for the whole collection because of one bad note`
     — **fails today** (documents BUG-1: expects 200, gets 500).
  3. `sharing a note id that was never created should 404, not 201` —
     **fails today** (documents BUG-3: expects 404, gets 201).
  4. `a reader's share link works while the note exists, and 404s once it's
     deleted` — **passes** (confirms correct lifecycle behavior).
  5. `informational: sharing the same note twice mints two independently
     valid tokens` — **passes** (documents current behavior around FEAT-3,
     not asserted as a bug).
  - Run directly: `node scenarios/incubating/notes-search-share-seams/scenario.mjs`
    (2 pass, 3 fail — the 3 failures are the point; they're characterization
    tests pinned to the *expected* behavior so they go green the moment
    BUG-1/2/3 are fixed).
  - Lives outside `tests/*.test.mjs`, so it does **not** affect
    `verification.oracle.full_command`/`quick_command` — the regression gate
    stays green (`node --test tests/*.test.mjs`: 8/8 pass;
    `node scripts/lint.mjs`: clean; `node tests/smoke.mjs`: pass).

## Outcome

**PARTIAL** — the scenario itself succeeded exactly as intended: it found
three real, reproducible bugs at the seams between notes-editor, search, and
sharing (exactly the kind of thing T2 composition testing is for), backed by
a regression-ready test file, without touching the regression oracle. It also
surfaced two non-blocking feature gaps in search and one in sharing.

Separately, it hit a real bug in the loop's own coverage-derivation tooling
(`scripts/kitchenloop/derive-coverage.mjs`) while trying to complete Step 6,
which is now escalated as `ESC-1` rather than fixed unilaterally (scripts/ is
MANDATE ALWAYS-STOP territory). `.kitchenloop/coverage-matrix.yaml` could not
be regenerated this iteration as a direct consequence — the `KITCHENLOOP-COVERAGE`
block is already correctly declared and will resolve automatically once
`ESC-1` is answered and the script is fixed.
