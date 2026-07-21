// Usage: node scenarios/incubating/notes-search-share-seams/scenario.mjs
//
// T2 composition scenario: an author builds a small note collection through
// the public HTTP API the way a real client would -- including one note
// saved without a title, which is easy to produce from any form/client that
// briefly submits a partial payload -- then searches across the collection
// and exercises the share/read lifecycle a reader would follow.
//
// KITCHENLOOP-COVERAGE-BEGIN
// [
//   { "feature": "notes-editor", "platform": "api", "user_type": "author", "result": "fail", "iteration": 1, "tier": "T2", "note": "POST /notes with no title returns 201 with no validation, despite README documenting {title, body?, tags?} (title required)" },
//   { "feature": "search", "platform": "api", "user_type": "author", "result": "fail", "iteration": 1, "tier": "T2", "note": "one title-less note crashes GET /search with 500 for the WHOLE collection, not just that note" },
//   { "feature": "sharing", "platform": "api", "user_type": "author", "result": "fail", "iteration": 1, "tier": "T2", "note": "POST /notes/:id/share on a nonexistent note id returns 201 with a token instead of 404" },
//   { "feature": "sharing", "platform": "api", "user_type": "reader", "result": "pass", "iteration": 1, "tier": "T2", "note": "a reader's GET /shared/:token correctly serves the note when valid and correctly 404s once the underlying note is deleted" }
// ]
// KITCHENLOOP-COVERAGE-END

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../../src/server.mjs";

let app;
let base;

before(async () => {
  app = buildApp({ storePath: join(mkdtempSync(join(tmpdir(), "relay-scenario-")), "notes.json") });
  await new Promise((resolve) => app.listen(0, resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => {
  app.close();
});

test("author builds a realistic note collection, including one bad payload", async () => {
  const groceries = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Groceries", body: "milk, eggs, coffee", tags: ["home"] }),
  })).json();
  assert.ok(groceries.id, "well-formed note should be created");

  const standup = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Standup notes", body: "ship the relay demo" }),
  })).json();
  assert.ok(standup.id, "second well-formed note should be created");

  // A real client can easily submit a payload missing `title` (a blank form
  // field, a partial autosave, a client bug). README documents {title, body?,
  // tags?} -- title has no `?`, i.e. it is meant to be required.
  const malformedResp = await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ body: "oops, forgot the title" }),
  });
  const malformed = await malformedResp.json();

  // EXPECTED per the documented schema: the API should reject this with 400.
  // ACTUAL (bug): it silently accepts it and returns 201.
  assert.equal(
    malformedResp.status,
    400,
    `BUG: expected 400 for a note with no title, got ${malformedResp.status} -- ` +
      `the note was created as ${JSON.stringify(malformed)}`,
  );
});

test("search must not 500 for the whole collection because of one bad note", async () => {
  // Reuses the collection seeded above, which includes the title-less note.
  const searchResp = await fetch(`${base}/search?q=milk`);
  const body = await searchResp.text();

  // EXPECTED: searching should still find "Groceries" even though another
  // note in the store is malformed.
  // ACTUAL (bug): GET /search throws on note.title.includes(...) for the
  // title-less note and returns 500, breaking search for EVERY note, not
  // just the bad one.
  assert.equal(
    searchResp.status,
    200,
    `BUG: GET /search returned ${searchResp.status} instead of 200 once a title-less note existed -- body: ${body}`,
  );
});

test("sharing a note id that was never created should 404, not 201", async () => {
  const shareResp = await fetch(`${base}/notes/00000000-0000-0000-0000-000000000000/share`, {
    method: "POST",
  });
  const shareBody = await shareResp.json();

  // EXPECTED: sharing a note that doesn't exist should 404, matching the
  // 404 semantics used everywhere else for an unknown note id.
  // ACTUAL (bug): the share endpoint never checks the note exists, so it
  // happily mints a token for a note that will never resolve to real data.
  assert.equal(
    shareResp.status,
    404,
    `BUG: POST /notes/:id/share on an unknown id returned ${shareResp.status} ` +
      `with body ${JSON.stringify(shareBody)} instead of 404`,
  );
});

test("a reader's share link works while the note exists, and 404s once it's deleted", async () => {
  const note = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Lifecycle note", body: "shared then deleted" }),
  })).json();

  const { token } = await (await fetch(`${base}/notes/${note.id}/share`, { method: "POST" })).json();
  assert.ok(token, "sharing an existing note should return a token");

  const readerBefore = await fetch(`${base}/shared/${token}`);
  assert.equal(readerBefore.status, 200, "reader should see the note via the share link");
  const sharedNote = await readerBefore.json();
  assert.equal(sharedNote.id, note.id, "shared read should return the same note the author shared");

  const del = await fetch(`${base}/notes/${note.id}`, { method: "DELETE" });
  assert.equal(del.status, 204, "author should be able to delete their own note");

  const readerAfter = await fetch(`${base}/shared/${token}`);
  assert.equal(readerAfter.status, 404, "share link should stop working once the note is deleted");
});

test("informational: sharing the same note twice mints two independently valid tokens", async () => {
  // Not asserted as a bug -- README doesn't document link revocation or a
  // single-active-link constraint -- but noted as a gap in Missing Features.
  const note = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Multi-share note", body: "two links, no way to revoke either" }),
  })).json();

  const tokenA = (await (await fetch(`${base}/notes/${note.id}/share`, { method: "POST" })).json()).token;
  const tokenB = (await (await fetch(`${base}/notes/${note.id}/share`, { method: "POST" })).json()).token;
  assert.notEqual(tokenA, tokenB, "each share call mints a fresh token");

  const readA = await fetch(`${base}/shared/${tokenA}`);
  const readB = await fetch(`${base}/shared/${tokenB}`);
  assert.equal(readA.status, 200);
  assert.equal(readB.status, 200);
});
