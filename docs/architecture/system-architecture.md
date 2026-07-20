# relay-notes — system architecture

## System map

```
src/server.mjs   HTTP layer: routing + JSON I/O only — no business logic
src/store.mjs    NoteStore: note lifecycle + JSON-file persistence
src/share.mjs    ShareRegistry: opaque read-only share tokens (in-memory)
src/search.mjs   searchNotes: pure function over a store
```

The HTTP layer depends on the three modules; the modules never depend on the
HTTP layer or on each other (search takes a store as an argument).

## Invariants

- **ARCH-1** — routing stays in `server.mjs`; store/share/search stay
  transport-free (no `req`/`res` types outside the HTTP layer).
- **ARCH-2** — the persisted note shape (`id`, `title`, `body`, `tags`,
  `createdAt`, `updatedAt`) is the durable contract; changes require a
  migration note in the feature plan (owner gate, see MANDATE.md).
- **ARCH-3** — share tokens are opaque and unguessable (crypto-random,
  ≥128 bits); resolving an unknown token is a 404, never an error.
- **ARCH-4** — zero runtime dependencies (Constitution I).
