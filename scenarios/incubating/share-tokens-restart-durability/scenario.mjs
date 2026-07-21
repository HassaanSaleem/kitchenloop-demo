// Usage: node scenarios/incubating/share-tokens-restart-durability/scenario.mjs
//
// T2 composition scenario: notes-editor's on-disk persistence combined with
// sharing's link lifecycle, across a simulated service restart. A real
// deploy/crash-recovery restarts the Node process; this scenario mirrors that
// by closing one buildApp() instance and constructing a fresh one against the
// SAME storePath (exactly what a restart does -- buildApp() constructs a new
// NoteStore and a new ShareRegistry from scratch every time it's called).
//
// KITCHENLOOP-COVERAGE-BEGIN
// [
//   { "feature": "notes-editor", "platform": "api", "user_type": "author", "result": "pass", "iteration": 1, "tier": "T2", "note": "notes correctly survive a service restart -- NoteStore reloads from notes.json on construction" },
//   { "feature": "sharing", "platform": "api", "user_type": "reader", "result": "fail", "iteration": 1, "tier": "T2", "note": "a previously-valid share token 404s after any service restart, even though the underlying note is untouched -- ShareRegistry is in-memory only with no persistence, unlike NoteStore" },
//   { "feature": "sharing", "platform": "api", "user_type": "author", "result": "pass", "iteration": 1, "tier": "T2", "note": "the author can mint a fresh working share token for the still-intact note after a restart -- confirms the note data itself is not the problem, only the previously-issued token" }
// ]
// KITCHENLOOP-COVERAGE-END

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../../src/server.mjs";

let storePath;
let app;
let base;

before(async () => {
  storePath = join(mkdtempSync(join(tmpdir(), "relay-restart-")), "notes.json");
  app = buildApp({ storePath });
  await new Promise((resolve) => app.listen(0, resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => {
  app.close();
});

// Restart the "service": close the current listener and stand up a brand new
// buildApp() instance against the same storePath, exactly like a real
// process restart or redeploy would. Reassigns the module-level `app`/`base`
// so every fetch() after calling this hits the new instance.
async function restartService() {
  await new Promise((resolve) => app.close(resolve));
  app = buildApp({ storePath });
  await new Promise((resolve) => app.listen(0, resolve));
  base = `http://127.0.0.1:${app.address().port}`;
}

test("a note and its share link both work before any restart", async () => {
  const note = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Runbook", body: "restart procedure", tags: ["ops"] }),
  })).json();
  assert.ok(note.id, "note should be created");

  const { token } = await (await fetch(`${base}/notes/${note.id}/share`, { method: "POST" })).json();
  assert.ok(token, "share should return a token");

  const shared = await fetch(`${base}/shared/${token}`);
  assert.equal(shared.status, 200, "share link should resolve before any restart");
});

test("the note survives a service restart -- notes-editor persistence works as documented", async () => {
  const note = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Durable note", body: "should still be here after restart" }),
  })).json();

  await restartService();

  const afterRestart = await fetch(`${base}/notes/${note.id}`);
  assert.equal(afterRestart.status, 200, "note should still be readable after a restart");
  const body = await afterRestart.json();
  assert.equal(body.title, "Durable note", "note content should be unchanged after a restart");
});

test("a share token does NOT survive a service restart, even though the note does", async () => {
  const note = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Shared runbook", body: "reader relies on this link staying up" }),
  })).json();

  const { token } = await (await fetch(`${base}/notes/${note.id}/share`, { method: "POST" })).json();
  const beforeRestart = await fetch(`${base}/shared/${token}`);
  assert.equal(beforeRestart.status, 200, "share link should work before the restart");

  await restartService();

  // EXPECTED (a reader's perspective on a "read-only share link" feature):
  // a link that worked yesterday should still work today, independent of
  // whatever the service's process lifecycle happens to be -- the note
  // itself is untouched, so the reader has no way to know why their
  // bookmarked link suddenly broke.
  // ACTUAL (bug): ShareRegistry (src/share.mjs) keeps tokens in a plain
  // in-memory Map with no persistence -- every restart silently invalidates
  // every previously issued share link, with no error, warning, or way for
  // the author to know it happened.
  const afterRestart = await fetch(`${base}/shared/${token}`);
  assert.equal(
    afterRestart.status,
    200,
    `BUG: share token 404'd after a service restart even though the note itself ` +
      `(id ${note.id}) still exists -- ShareRegistry does not persist tokens to disk`,
  );

  // Confirm the note itself really is fine -- isolates the bug to the share
  // token's durability, not general data loss on restart.
  const noteStillThere = await fetch(`${base}/notes/${note.id}`);
  assert.equal(noteStillThere.status, 200, "the underlying note should be unaffected by the restart");
});

test("informational: the author can re-share the still-intact note after a restart", async () => {
  const note = await (await fetch(`${base}/notes`, {
    method: "POST",
    body: JSON.stringify({ title: "Re-shareable", body: "author can work around the restart bug manually" }),
  })).json();
  const { token: oldToken } = await (await fetch(`${base}/notes/${note.id}/share`, { method: "POST" })).json();

  await restartService();

  const { token: newToken } = await (await fetch(`${base}/notes/${note.id}/share`, { method: "POST" })).json();
  assert.ok(newToken, "author should be able to mint a fresh token after a restart");
  assert.notEqual(newToken, oldToken, "the fresh token should differ from the pre-restart token");

  const readNew = await fetch(`${base}/shared/${newToken}`);
  assert.equal(readNew.status, 200, "the freshly minted post-restart token should resolve correctly");
});
