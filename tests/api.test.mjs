// L3 integration tests: boot the real HTTP server on an ephemeral port, send
// real requests, and assert on real responses (and, for the search-robustness
// case, real on-disk state). These cover the iteration-1 hardening bundle:
//   17846222216546606501 — POST /notes requires a title (400 on missing/empty)
//   17846222216546600150 — GET /search tolerates a malformed stored record
//   17846222216546655427 — POST /notes/:id/share 404s for an unknown note id
//   17846222216546647429 — GET /search is case-insensitive
//   17846222216546654897 — GET /search matches tags

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.mjs";

function tempStorePath() {
  return join(mkdtempSync(join(tmpdir(), "relay-api-")), "notes.json");
}

async function startApp(storePath = tempStorePath()) {
  const app = buildApp({ storePath });
  await new Promise((resolve) => app.listen(0, resolve));
  return {
    base: `http://127.0.0.1:${app.address().port}`,
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

const postNote = (base, payload) =>
  fetch(`${base}/notes`, { method: "POST", body: JSON.stringify(payload) });

// ── Ticket 17846222216546606501 — title is required ──────────────────────────
test("POST /notes with no title key returns 400 with an error body", async () => {
  const { base, close } = await startApp();
  try {
    const resp = await postNote(base, { body: "oops, forgot the title" });
    assert.equal(resp.status, 400);
    const json = await resp.json();
    assert.ok(json.error, "400 response carries a JSON error body");
  } finally {
    await close();
  }
});

test("POST /notes with an empty title returns 400", async () => {
  const { base, close } = await startApp();
  try {
    const resp = await postNote(base, { title: "", body: "still empty" });
    assert.equal(resp.status, 400);
  } finally {
    await close();
  }
});

test("POST /notes with a non-object JSON body returns 400", async () => {
  const { base, close } = await startApp();
  try {
    const resp = await fetch(`${base}/notes`, {
      method: "POST",
      body: JSON.stringify(["not", "an", "object"]),
    });
    assert.equal(resp.status, 400);
    const json = await resp.json();
    assert.ok(json.error, "400 response carries a JSON error body");
  } finally {
    await close();
  }
});

test("POST /notes with a malformed JSON body returns 400, not 500", async () => {
  const { base, close } = await startApp();
  try {
    const resp = await fetch(`${base}/notes`, {
      method: "POST",
      body: "{ this is not valid json",
    });
    assert.equal(resp.status, 400, "malformed JSON is bad input -> 4xx, never 500");
    const json = await resp.json();
    assert.ok(json.error, "400 response carries a JSON error body");
  } finally {
    await close();
  }
});

test("POST /notes with a valid title still returns 201", async () => {
  const { base, close } = await startApp();
  try {
    const resp = await postNote(base, { title: "Groceries", body: "milk" });
    assert.equal(resp.status, 201);
    const note = await resp.json();
    assert.equal(note.title, "Groceries");
    assert.ok(note.id, "created note has an id");
  } finally {
    await close();
  }
});

// ── Ticket 17846222216546600150 — search tolerates a malformed record ─────────
test("GET /search does not 500 when the store holds a title-less record", async () => {
  const storePath = tempStorePath();
  const now = new Date().toISOString();
  // Seed the on-disk store directly with a good note and a legacy record that
  // has no `title` field — the exact shape that used to crash search for the
  // whole collection.
  writeFileSync(
    storePath,
    JSON.stringify([
      { id: "good", title: "Groceries", body: "milk, eggs", tags: [], createdAt: now, updatedAt: now },
      { id: "legacy", body: "no title on this one", tags: [], createdAt: now, updatedAt: now },
    ]),
  );
  const { base, close } = await startApp(storePath);
  try {
    const resp = await fetch(`${base}/search?q=milk`);
    assert.equal(resp.status, 200, "search returns 200 despite the malformed record");
    const results = await resp.json();
    assert.equal(results.length, 1);
    assert.equal(results[0].id, "good", "the well-formed note is still found");
  } finally {
    await close();
  }
});

// ── Ticket 17846222216546655427 — share unknown id 404s ───────────────────────
test("POST /notes/:id/share 404s for a note id that was never created", async () => {
  const { base, close } = await startApp();
  try {
    const resp = await fetch(`${base}/notes/00000000-0000-0000-0000-000000000000/share`, {
      method: "POST",
    });
    assert.equal(resp.status, 404);
    const json = await resp.json();
    assert.equal(json.error, "not found");
  } finally {
    await close();
  }
});

test("POST /notes/:id/share still 201s with a token for a real note", async () => {
  const { base, close } = await startApp();
  try {
    const note = await (await postNote(base, { title: "Shareable" })).json();
    const resp = await fetch(`${base}/notes/${note.id}/share`, { method: "POST" });
    assert.equal(resp.status, 201);
    const { token } = await resp.json();
    assert.ok(token, "a real note yields a share token");
  } finally {
    await close();
  }
});

// ── Ticket 17846222216546647429 — case-insensitive search ─────────────────────
test("GET /search matches a note regardless of case", async () => {
  const { base, close } = await startApp();
  try {
    await postNote(base, { title: "Relay Launch", body: "kickoff" });
    const results = await (await fetch(`${base}/search?q=relay`)).json();
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Relay Launch");
  } finally {
    await close();
  }
});

// ── Ticket 17846222216546654897 — search matches tags ─────────────────────────
test("GET /search matches a note by one of its tags", async () => {
  const { base, close } = await startApp();
  try {
    await postNote(base, { title: "Standup notes", body: "ship it", tags: ["work"] });
    const results = await (await fetch(`${base}/search?q=work`)).json();
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Standup notes");
  } finally {
    await close();
  }
});
