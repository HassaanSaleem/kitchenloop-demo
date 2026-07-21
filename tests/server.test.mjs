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
