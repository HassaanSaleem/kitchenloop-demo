# ESCALATIONS — what the loop is waiting on YOU for

One row per pending human gate. The loop adds a row whenever it stops for the
owner, then continues other work; the owner answers asynchronously by saying
the exact word(s) in **Say**. Cleared rows are removed (history lives in the
loop state and git log). Empty table = nothing is asked of you.

Rules for the loop:
- Every stop-for-the-owner MUST be a row here — never buried in prose or a PR
  comment. A gate that is not in ESCALATIONS.md was not asked.
- Each row includes one short context paragraph directly below the table row it
  belongs to: what happened, the recommendation, and what stays blocked.
- Never edit or reinterpret an existing row's **Say** word; add a new row instead.

| ID | Say | Question | Recommendation | Since | Blocks |
|----|-----|----------|----------------|-------|--------|
