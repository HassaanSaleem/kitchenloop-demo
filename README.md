# relay-notes

A deliberately tiny note-taking service for **Relay** (a fictional company):
notes with tags, full-text search, and read-only share links over a
zero-dependency Node.js JSON API.

This repo exists to be **evolved by
[KitchenLoop](https://github.com/HassaanSaleem/kitchenloop)** — the autonomous
build loop is vendored under `scripts/` and `.claude/`, and every change beyond
the initial seed commit is loop-made: scenario-driven tickets, spec-driven
implementation, gated merges.

## The API

```
POST   /notes            {title, body?, tags?}   -> 201 note | 400
GET    /notes                                    -> 200 [notes], newest first
GET    /notes/:id                                -> 200 note | 404
DELETE /notes/:id                                -> 204 | 404
GET    /search?q=term                            -> 200 [notes]
POST   /notes/:id/share                          -> 201 {token} | 404
GET    /shared/:token                            -> 200 note | 404
```

Behavior notes:

- `POST /notes` requires a non-empty `title`; a missing or empty title is
  rejected with `400 {error}` (the note is not stored).
- `GET /search?q=term` matches a note's `title`, `body`, and `tags`, and is
  case-insensitive.
- `POST /notes/:id/share` returns `404` when the note id does not exist,
  matching `GET`/`DELETE /notes/:id`.

```bash
npm start          # serve on :3000 (PORT to override)
npm test           # node:test suite
npm run lint       # syntax + hygiene gate
npm run smoke      # boot the real server, walk the full user journey
```

## Running the loop

```bash
./scripts/kitchenloop/kitchenloop.sh 1        # one full iteration
./scripts/kitchenloop/kitchenloop.sh 5        # five, unattended
```

The loop's configuration is `kitchenloop.yaml`; the owner's standing rules are
`MANDATE.md`; asks the loop could not decide for itself land in
`ESCALATIONS.md`.
