// L3 integration tests: boot the real HTTP app on an ephemeral port and drive
// it over the wire (no mocks at the system boundary). Covers input validation,
// search robustness/semantics, and share existence checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.mjs";

// Boot an app on an ephemeral port, optionally seeding the on-disk store with
// pre-existing records (used to simulate data written before a validation fix).
async function boot(seed) {
  const storePath = join(mkdtempSync(join(tmpdir(), "relay-server-")), "notes.json");
  if (seed) writeFileSync(storePath, JSON.stringify(seed, null, 2));
  const app = buildApp({ storePath });
  await new Promise((resolve) => app.listen(0, resolve));
  return { app, base: `http://127.0.0.1:${app.address().port}` };
}

test("POST /notes rejects a payload with no title (400)", async () => {
  const { app, base } = await boot();
  try {
    const res = await fetch(`${base}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: "oops, forgot the title" }),
    });
    assert.equal(res.status, 400, "missing title must be rejected, not stored");
    const err = await res.json();
    assert.ok(err.error, "400 carries a JSON error body (honest errors)");
  } finally {
    app.close();
  }
});

test("POST /notes rejects an empty-string title (400)", async () => {
  const { app, base } = await boot();
  try {
    const res = await fetch(`${base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "", body: "still no real title" }),
    });
    assert.equal(res.status, 400, "empty title is not a valid title");
  } finally {
    app.close();
  }
});

test("POST /notes still creates a well-formed note (201)", async () => {
  const { app, base } = await boot();
  try {
    const res = await fetch(`${base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Real note", body: "hello relay" }),
    });
    assert.equal(res.status, 201, "a valid title is accepted as before");
    const note = await res.json();
    assert.ok(note.id, "created note has an id");
    assert.equal(note.title, "Real note");
  } finally {
    app.close();
  }
});

test("GET /search matches a note by its tag", async () => {
  const { app, base } = await boot();
  try {
    await fetch(`${base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Standup", body: "sync", tags: ["work"] }),
    });
    const res = await fetch(`${base}/search?q=work`);
    assert.equal(res.status, 200);
    const results = await res.json();
    assert.equal(results.length, 1, "q=work matches the note's \"work\" tag");
  } finally {
    app.close();
  }
});

test("GET /search matches case-insensitively", async () => {
  const { app, base } = await boot();
  try {
    await fetch(`${base}/notes`, {
      method: "POST",
      body: JSON.stringify({ title: "Relay Launch", body: "kickoff" }),
    });
    const res = await fetch(`${base}/search?q=relay`);
    assert.equal(res.status, 200);
    const results = await res.json();
    assert.equal(results.length, 1, "q=relay finds \"Relay Launch\"");
  } finally {
    app.close();
  }
});

test("GET /search tolerates a pre-existing title-less note (200, not 500)", async () => {
  // A record missing `title` may already exist on disk from before validation
  // was added. Search must degrade gracefully, not 500 the whole collection.
  const now = "2026-07-21T08:00:00.000Z";
  const { app, base } = await boot([
    { id: "good-1", title: "Groceries", body: "milk, eggs", tags: [], createdAt: now, updatedAt: now },
    { id: "bad-1", body: "no title here", tags: [], createdAt: now, updatedAt: now },
  ]);
  try {
    const res = await fetch(`${base}/search?q=milk`);
    assert.equal(res.status, 200, "one malformed note must not 500 search for everyone");
    const results = await res.json();
    assert.equal(results.length, 1, "the well-formed note is still found");
    assert.equal(results[0].id, "good-1");
  } finally {
    app.close();
  }
});
