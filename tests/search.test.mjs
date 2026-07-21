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

// Ticket 17846222216546647429 — search is case-insensitive.
test("matches regardless of case in query or note", () => {
  const store = tempStore();
  store.create({ title: "Relay Launch", body: "Kickoff Plan" });
  assert.equal(searchNotes(store, "relay").length, 1, "lowercase query matches TitleCase title");
  assert.equal(searchNotes(store, "RELAY").length, 1, "uppercase query matches TitleCase title");
  assert.equal(searchNotes(store, "kickoff").length, 1, "lowercase query matches TitleCase body");
});

// Ticket 17846222216546654897 — search also looks at tags.
test("matches a note by one of its tags", () => {
  const store = tempStore();
  store.create({ title: "Standup notes", body: "ship it", tags: ["work", "urgent"] });
  assert.equal(searchNotes(store, "work").length, 1, "tag value is searchable");
  assert.equal(searchNotes(store, "URGENT").length, 1, "tag match is case-insensitive too");
  assert.equal(searchNotes(store, "missing").length, 0, "non-matching term still returns nothing");
});

// Ticket 17846222216546600150 — one malformed record must not break search.
test("tolerates records with a missing title or body", () => {
  const store = tempStore();
  store.create({ title: "Groceries", body: "milk, eggs" });
  // Records that reached the store without a title/body (a title-less note from
  // the pre-validation bug, or a hand-edited notes.json) must be skipped
  // field-by-field, never thrown on. They still carry createdAt/updatedAt like
  // any record that passed through NoteStore.create.
  const ts = new Date().toISOString();
  store.notes.set("no-title", { id: "no-title", body: "quinoa", tags: [], createdAt: ts, updatedAt: ts });
  store.notes.set("no-body", { id: "no-body", title: "Eggplant", tags: [], createdAt: ts, updatedAt: ts });
  assert.doesNotThrow(() => searchNotes(store, "milk"));
  assert.equal(searchNotes(store, "milk").length, 1, "well-formed note still matches");
  assert.equal(searchNotes(store, "quinoa").length, 1, "title-less record's body still matches");
  assert.equal(searchNotes(store, "eggplant").length, 1, "body-less record's title still matches");
});
