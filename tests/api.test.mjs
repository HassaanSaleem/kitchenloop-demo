// L3 integration tests: boot the real HTTP server on an ephemeral port and
// drive it over real HTTP, asserting on status codes and response bodies (real
// state deltas) — no mocks at the system boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildApp } from "../src/server.mjs";

// Boot buildApp on an ephemeral port. Pass a pre-seeded storePath to exercise
// notes that already exist on disk (e.g. a malformed record).
async function start(storePath) {
  const path = storePath ?? join(mkdtempSync(join(tmpdir(), "relay-api-")), "notes.json");
  const app = buildApp({ storePath: path });
  await new Promise((resolve) => app.listen(0, resolve));
  return {
    base: `http://127.0.0.1:${app.address().port}`,
    close: () => app.close(),
  };
}

// Write a raw notes.json (bypassing the API) so we can seed records the API
// would now reject — used to prove search tolerates pre-existing bad data.
function seedStore(notes) {
  const path = join(mkdtempSync(join(tmpdir(), "relay-api-seed-")), "notes.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(notes, null, 2));
  return path;
}

test("POST /notes with a valid title returns 201 and the created note", async () => {
  const srv = await start();
  try {
    const res = await fetch(`${srv.base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Groceries", body: "milk, eggs" }),
    });
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.ok(note.id, "created note should have an id");
    assert.equal(note.title, "Groceries");
  } finally {
    srv.close();
  }
});

test("POST /notes with no title key returns 400", async () => {
  const srv = await start();
  try {
    const res = await fetch(`${srv.base}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: "no title" }),
    });
    assert.equal(res.status, 400, "missing title must be rejected with 400");
    const err = await res.json();
    assert.match(err.error, /title/i, "error body should mention the title");
  } finally {
    srv.close();
  }
});

test("POST /notes with a blank title returns 400", async () => {
  const srv = await start();
  try {
    const res = await fetch(`${srv.base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "   ", body: "blank title" }),
    });
    assert.equal(res.status, 400, "empty/whitespace title must be rejected with 400");
  } finally {
    srv.close();
  }
});

test("GET /search does not 500 when a note in the store lacks a title", async () => {
  const seeded = seedStore([
    { id: "good-1", title: "Groceries", body: "milk, eggs", tags: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "bad-1", body: "orphaned body, no title", tags: [], createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
  ]);
  const srv = await start(seeded);
  try {
    const res = await fetch(`${srv.base}/search?q=milk`);
    assert.equal(res.status, 200, "one malformed note must not 500 search for the whole collection");
    const results = await res.json();
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "good-1");
  } finally {
    srv.close();
  }
});

test("GET /search matches a note by one of its tags", async () => {
  const srv = await start();
  try {
    await fetch(`${srv.base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Standup notes", body: "ship the demo", tags: ["work"] }),
    });
    const res = await fetch(`${srv.base}/search?q=work`);
    assert.equal(res.status, 200);
    const results = await res.json();
    assert.equal(results.length, 1, "a query equal to a tag should match the note");
    assert.equal(results[0].title, "Standup notes");
  } finally {
    srv.close();
  }
});

test("GET /search matches regardless of case", async () => {
  const srv = await start();
  try {
    await fetch(`${srv.base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Relay Launch", body: "ship the demo" }),
    });
    const res = await fetch(`${srv.base}/search?q=relay`);
    assert.equal(res.status, 200);
    const results = await res.json();
    assert.equal(results.length, 1, "lowercase query should match the title-cased note");
    assert.equal(results[0].title, "Relay Launch");
  } finally {
    srv.close();
  }
});

test("POST /notes/:id/share on an unknown id returns 404", async () => {
  const srv = await start();
  try {
    const res = await fetch(`${srv.base}/notes/00000000-0000-0000-0000-000000000000/share`, {
      method: "POST",
    });
    assert.equal(res.status, 404, "sharing a nonexistent note id must 404, not mint a token");
  } finally {
    srv.close();
  }
});

test("POST /notes/:id/share on a real id returns 201 with a resolvable token", async () => {
  const srv = await start();
  try {
    const note = await (await fetch(`${srv.base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Shareable", body: "read-only please" }),
    })).json();

    const shareRes = await fetch(`${srv.base}/notes/${note.id}/share`, { method: "POST" });
    assert.equal(shareRes.status, 201, "sharing a real note should still succeed");
    const { token } = await shareRes.json();
    assert.ok(token, "share should return a token");

    const shared = await fetch(`${srv.base}/shared/${token}`);
    assert.equal(shared.status, 200, "the minted token should resolve to the note");
    assert.equal((await shared.json()).id, note.id);
  } finally {
    srv.close();
  }
});
