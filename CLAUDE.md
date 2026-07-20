# relay-notes — repo guidance

A deliberately tiny zero-dependency Node.js note-taking API (see README.md for
the surface). This repo is the demo target of the
[KitchenLoop](https://github.com/HassaanSaleem/kitchenloop) autonomous build
loop, which is vendored under `scripts/` and `.claude/`.

## Development model

Changes flow through the loop: ideate (synthetic user) → triage (tickets in
`.kitchenloop/backlog.json`) → execute (branch + PR per ticket, feature-sized
work through the `/speckit-*` SDD flow) → polish (gated merge via
`scripts/pr-manager/`) → regress (oracle + drift control).

- The owner's standing rules are in `MANDATE.md` — read them before acting.
  Anything on its ALWAYS-STOP list gets escalated in `ESCALATIONS.md`, never
  done unilaterally.
- Oracle commands: `npm test` (node:test), `npm run lint`, `npm run smoke`.
  All three must be green before any commit.
- Zero runtime dependencies is a deliberate constraint — do not add packages
  without an escalation.
- Notes persist to `data/notes.json` (gitignored); the on-disk schema is
  MANDATE-protected.
