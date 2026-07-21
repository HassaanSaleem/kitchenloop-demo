---
title: MANDATE — the owner's standing mandate
owner: Syed Hassaan Saleem
---

The owner writes this file; the loop only reads it — at the start of every
phase — and never edits it. Keep it to a handful of lines: it says what the
loop may do on its own and what it must stop for, nothing more. It is policy,
not a task list. (Running state lives in docs/internal/loop-state.md; the work
queue in .kitchenloop/backlog.json; open questions in ESCALATIONS.md.)

1. The loop may run autonomously: ideate scenarios, triage findings, execute
   backlog tickets, and merge PRs that pass every gate (lint + tests + the
   quality bar + regression oracle).
2. ALWAYS STOP for: changes to the stored-note JSON schema on disk; changes to
   the loop's own gates (quality bar, oracle commands, this file,
   ESCALATIONS.md, scripts/); pushes to `main` outside the gated merge
   pipeline; pushes to new remotes; force-pushes; deploys (there are none).
3. Spec gaps file tickets; the spec never gets silently defined by code.
4. When blocked, record the question as a row in ESCALATIONS.md and move on to
   other work. If it isn't recorded there, the loop has not really asked — so
   it must not act as though the owner already answered.
