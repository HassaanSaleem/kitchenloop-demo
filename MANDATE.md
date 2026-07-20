---
title: MANDATE — the owner's standing mandate
owner: Syed Hassaan Saleem
---

Hand-written, human-owned. The standing mandate the loop steers by; read at the
start of every loop phase. Only the owner edits it. Under ten lines — a mandate,
not a backlog. (State lives in docs/internal/loop-state.md; the queue in
.kitchenloop/backlog.json; pending asks in ESCALATIONS.md.)

1. The loop may run autonomously: ideate scenarios, triage findings, execute
   backlog tickets, and merge PRs that pass every gate (lint + tests + the
   quality bar + regression oracle).
2. ALWAYS STOP for: changes to the stored-note JSON schema on disk; changes to
   the loop's own gates (quality bar, oracle commands, this file,
   ESCALATIONS.md, scripts/); pushes to `main` outside the gated merge
   pipeline; pushes to new remotes; force-pushes; deploys (there are none).
3. Spec gaps file tickets; the spec never gets silently defined by code.
4. When blocked, add a row to ESCALATIONS.md and continue other work. A gate
   that is not escalated was not asked.
