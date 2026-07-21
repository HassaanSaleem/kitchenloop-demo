import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../src/store.mjs";
import { searchNotes } from "../src/search.mjs";

const tempStore = () => new NoteStore(join(mkdtempSync(join(tmpdir(), "relay-notes-")), "notes.json"));

test("finds notes by title and body", () => {
  const store = tempStore();
  store.create({ title: "Groceries", body: "milk, eggs" });
  store.create({ title: "Reading list", body: "distributed systems" });
  assert.equal(searchNotes(store, "Groceries").length, 1);
  assert.equal(searchNotes(store, "distributed").length, 1);
});

test("empty query returns nothing", () => {
  const store = tempStore();
  store.create({ title: "anything" });
  assert.equal(searchNotes(store, "").length, 0);
  assert.equal(searchNotes(store, null).length, 0);
});

test("search is case-insensitive across query and note casing", () => {
  const store = tempStore();
  store.create({ title: "Relay Launch", body: "Ship It" });
  assert.equal(searchNotes(store, "relay").length, 1, "lowercase query matches title-cased note");
  assert.equal(searchNotes(store, "RELAY").length, 1, "uppercase query matches too");
  assert.equal(searchNotes(store, "ship").length, 1, "case-insensitive on the body as well");
});

test("tolerates malformed notes (missing title or body) without throwing", () => {
  const store = tempStore();
  store.create({ title: "Groceries", body: "milk, eggs" });
  store.create({ body: "orphaned body, no title" }); // title === undefined
  store.notes.set("hand-crafted", {
    id: "hand-crafted",
    title: "Loose",
    body: undefined, // undefined body
    tags: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  assert.doesNotThrow(() => searchNotes(store, "milk"));
  const hits = searchNotes(store, "milk");
  assert.equal(hits.length, 1, "well-formed note is still found alongside malformed ones");
  assert.equal(hits[0].title, "Groceries");
});
