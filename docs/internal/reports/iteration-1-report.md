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

---

## Round 2: A second ideate pass on iteration 1

The harness invoked the ideate phase for iteration 1 a second time against this
same worktree. The bugs from Round 1 above are still live on `main` — both
follow-up PRs (`#1` and `#2`) that attempted fixes were closed without
merging, and `ESC-1`'s tooling fix has since landed (`derive-coverage.mjs` now
parses `kitchenloop.yaml` correctly — confirmed by running it below). Rather
than re-run the identical `notes-search-share-seams` scenario (an anti-pattern
per the ideate skill: "don't re-test the same dimension combo unless a related
fix was merged"), this pass picked a genuinely uncovered angle.

### Scenario: Share tokens do not survive a service restart
**Tier**: T2 Composition
**Features Exercised**: notes-editor (persistence), sharing
**Codex feasibility check**: PROCEED — "achievable with the current codebase
... exercises something new because existing coverage checks same-process
share lifecycle and delete invalidation, but not token durability across
restart/redeploy."

### What I Did (as a user)

Reading `src/store.mjs` and `src/share.mjs` side by side surfaced an
asymmetry: `NoteStore` persists every note to `data/notes.json` and reloads
it on construction, but `ShareRegistry` keeps its token -> noteId map in a
plain in-memory `Map` with no file I/O at all. `buildApp()` constructs a
fresh `NoteStore` and a fresh `ShareRegistry` every time it's called — which
is exactly what happens on a real process restart or redeploy.

I role-played an author who shares a note (e.g. an internal runbook) and a
reader who bookmarks the link, then simulated the service restarting under
them:

1. Wrote `scenarios/incubating/share-tokens-restart-durability/scenario.mjs`
   against a live `buildApp()` instance over real HTTP (no mocks), with a
   `restartService()` helper that closes the current listener and stands up
   a brand new `buildApp({ storePath })` against the *same* on-disk store —
   the same simulation technique `tests/store.test.mjs` already uses
   ("a second store instance sees persisted notes"), just carried through
   the full HTTP server instead of the store in isolation.
2. Confirmed the happy path first: create a note, share it, `GET
   /shared/:token` resolves — 200, before touching the restart logic at all.
3. Confirmed notes-editor's persistence promise holds at the HTTP layer, not
   just the unit-test layer: create a note, restart, `GET /notes/:id` — 200,
   same title and body. This is exactly what the README/CLAUDE.md's "notes
   persist to data/notes.json" claim promises, and it's kept.
4. Confirmed the hypothesis: create a note, share it, restart, `GET
   /shared/:token` with the *same* token from step 3 — expected 200 (a
   reader's bookmarked link should not care about the server's process
   lifecycle), got **404**. Also confirmed the underlying note itself is
   untouched (`GET /notes/:id` still 200) immediately after, isolating the
   bug to token durability specifically, not general data loss.
5. Checked whether the author has any workaround: after a restart, sharing
   the same (still-intact) note again does mint a fresh, working token —
   so the note is never truly unrecoverable, but the *original* link the
   author already handed out is now silently dead with no error anywhere.
6. Ran the new scenario directly: `node
   scenarios/incubating/share-tokens-restart-durability/scenario.mjs` — 3
   pass, 1 fail (the restart-durability bug), exactly as designed.
7. Ran the full oracle: `node scripts/lint.mjs` (10 files clean), `node
   --test tests/*.test.mjs` (8/8 pass, unchanged), `node tests/smoke.mjs`
   (PASS) — the new scenario lives outside `tests/*.test.mjs` so the
   regression gate is untouched.
8. Ran `node scripts/kitchenloop/derive-coverage.mjs` — it now runs cleanly
   (confirms `ESC-1`'s fix landed), producing `4/6` combos (`66.7%`). Note:
   the matrix dedupes by `(feature, platform, user_type)` and keeps
   whichever declaring scenario has the higher `iteration` number, first-file
   wins on a tie — since both this scenario's `sharing/api/reader` entry and
   Round 1's collide on `iteration: 1`, the matrix currently shows Round 1's
   witness (the delete-invalidation "pass") rather than this scenario's
   restart-durability "fail" for that same combo. The real finding is fully
   documented here, in the scenario file, and will reach triage via this
   report's Friction Log regardless — flagging as tooling friction below,
   not fixing it (scripts/ is MANDATE ALWAYS-STOP territory).

### What Worked

- `buildApp({ storePath })` made simulating a real restart trivial — no test
  server framework, no process spawning, just close-and-reconstruct against
  the same file path. Same ergonomics win noted in Round 1.
- Notes-editor's persistence guarantee genuinely holds end-to-end over real
  HTTP, not just at the `NoteStore` unit-test layer. Good sign for the core
  data path.
- The `ESC-1` tooling fix is confirmed resolved: `derive-coverage.mjs` parsed
  `kitchenloop.yaml`'s dimensions correctly on the first try this round.

### Friction Points (Round 2)

6. **[BUG]** Share tokens are silently invalidated by any service restart,
   even though the note they point to is completely unaffected — see BUG-4.
7. **[UX]** There is no error, log line, or response header anywhere that
   tells a reader (or the author) *why* a previously-working share link
   started 404ing. From the outside it's indistinguishable from the note
   having been deleted.
8. **[TOOLING, not relay-notes]** `.kitchenloop/coverage-matrix.yaml`'s
   dedupe key is `(feature, platform, user_type)` only — it cannot represent
   two different scenarios reaching different pass/fail conclusions about the
   same combo (as happened here: sharing/api/reader is "pass" per Round 1's
   delete-invalidation test and "fail" per this round's restart-durability
   test). Not escalating — informational only, doesn't block anything since
   triage reads this report's Friction Log directly, not the matrix.

### Bugs Found (Round 2)

**BUG-4**: `POST /notes/:id/share` mints a token that is only ever stored in
`ShareRegistry`'s in-memory `Map` (`src/share.mjs:6-14`) — it is never
written to disk. Any service restart (deploy, crash recovery, `npm start`
re-run) resets `ShareRegistry` to empty, so `GET /shared/:token` starts
returning `404` for every share link issued before that restart, even though
`NoteStore` correctly persisted the underlying notes across the exact same
restart. A reader with a bookmarked/emailed share link has no way to know
whether the link died because the author deleted the note (working as
intended) or because the service merely restarted (a bug) — both look
identical: a bare `404 {"error": "not found"}`.
Repro: `POST /notes` -> `POST /notes/:id/share` -> confirm `GET
/shared/:token` is 200 -> restart the process (or, in-process, construct a
new `buildApp({ storePath })` against the same store path) -> `GET
/shared/:token` with the same token -> 404, despite `GET /notes/:id` still
returning 200 for the same note.

### Missing Features (Round 2)

None beyond FEAT-3 (already filed in Round 1: no way to list/revoke a note's
active share tokens) — BUG-4 makes that gap worse in one direction (tokens
can vanish involuntarily) while FEAT-3 is about the opposite direction
(tokens can't be revoked voluntarily). Both point at the same root cause:
share tokens have no durable, inspectable home.

### Improvements (Round 2)

**IMP-3**: Persist `ShareRegistry`'s token -> noteId map the same way
`NoteStore` persists notes (e.g. a sibling JSON file, or folding tokens into
the existing note record) so share links survive a restart. At minimum,
until that's built, this should be called out explicitly in the README as a
known limitation ("share links do not survive a service restart") so it's a
documented trade-off rather than a silent surprise.

### Tests Added (Round 2)

- `scenarios/incubating/share-tokens-restart-durability/scenario.mjs` — 4
  `node:test` cases against a live in-process server, using a
  `restartService()` helper that reconstructs `buildApp()` against the same
  `storePath`:
  1. `a note and its share link both work before any restart` — **passes**
     (baseline).
  2. `the note survives a service restart -- notes-editor persistence works
     as documented` — **passes** (confirms `NoteStore`'s durability promise
     holds over real HTTP).
  3. `a share token does NOT survive a service restart, even though the note
     does` — **fails today** (documents BUG-4: expects 200, gets 404).
  4. `informational: the author can re-share the still-intact note after a
     restart` — **passes** (confirms the note data is fine; only the
     previously-issued token is lost).
  - Run directly: `node
    scenarios/incubating/share-tokens-restart-durability/scenario.mjs` (3
    pass, 1 fail — the 1 failure is the point, a characterization test
    pinned to the expected behavior so it goes green once BUG-4 is fixed).
  - Lives outside `tests/*.test.mjs`, so it does **not** affect
    `verification.oracle.full_command`/`quick_command` — the regression gate
    stays green (`node --test tests/*.test.mjs`: 8/8 pass; `node
    scripts/lint.mjs`: clean; `node tests/smoke.mjs`: pass, all unchanged
    from Round 1).

### Outcome (Round 2)

**PARTIAL** — found one new, real, reproducible bug (BUG-4: share tokens
don't survive a restart) at a seam Round 1 didn't touch (persistence x
sharing, rather than validation x search x sharing), backed by a
regression-ready characterization test, with the regression oracle
unaffected. Also confirmed `ESC-1`'s tooling fix is live and working, and
surfaced one new (non-blocking, non-escalated) observation about the
coverage matrix's dedupe granularity.
