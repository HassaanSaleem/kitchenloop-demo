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
