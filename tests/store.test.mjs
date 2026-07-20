import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../src/store.mjs";

const tempStore = () => new NoteStore(join(mkdtempSync(join(tmpdir(), "relay-notes-")), "notes.json"));

test("create returns a persisted note with id and timestamps", () => {
  const store = tempStore();
  const note = store.create({ title: "Standup", body: "ship the demo", tags: ["work"] });
  assert.ok(note.id);
  assert.equal(note.title, "Standup");
  assert.equal(store.get(note.id).body, "ship the demo");
});

test("list returns newest first", async () => {
  const store = tempStore();
  store.create({ title: "first" });
  await new Promise((resolve) => setTimeout(resolve, 5)); // distinct createdAt
  const second = store.create({ title: "second" });
  assert.equal(store.list()[0].id, second.id);
});

test("remove deletes and reports absence", () => {
  const store = tempStore();
  const note = store.create({ title: "gone soon" });
  assert.equal(store.remove(note.id), true);
  assert.equal(store.get(note.id), null);
  assert.equal(store.remove(note.id), false);
});

test("a second store instance sees persisted notes", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-notes-"));
  const path = join(dir, "notes.json");
  const first = new NoteStore(path);
  const note = first.create({ title: "durable" });
  const second = new NoteStore(path);
  assert.equal(second.get(note.id).title, "durable");
});
