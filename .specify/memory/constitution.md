# relay-notes Constitution

## Core Principles

### I. Zero Runtime Dependencies
The service runs on Node.js built-ins only (`node:http`, `node:test`,
`node:crypto`, `node:fs`). Adding a runtime dependency is an owner gate.

### II. The API Is the Product
Every capability is expressed through the documented JSON API in README.md.
No hidden admin paths, no undocumented routes. A route that isn't in the
README doesn't exist; extending the API amends the README in the same PR.

### III. Honest Errors
Bad input gets a 4xx with a JSON error body; unexpected failures get a 500
with the message — never a silent 200, never an empty body on error.

### IV. Durable Notes
Notes survive a process restart via the JSON file store. The on-disk schema
is versioned in effect: changing the shape of persisted notes requires a
migration note in the feature plan and an owner gate (see MANDATE.md).

### V. Test-Backed Behavior
Every route and module behavior has a `node:test` case; the L3 smoke
(`tests/smoke.mjs`) walks the full user journey against a really-booted
server. A behavior without a test is a proposal, not a feature.

## Governance

This constitution bounds every spec and plan; the Constitution Check in
`/speckit-plan` verifies compliance. Amendments are owner-gated via
ESCALATIONS.md and take effect only after the owner merges them.

**Version**: 1.0.0 | **Ratified**: 2026-07-20 | **Last Amended**: 2026-07-20
