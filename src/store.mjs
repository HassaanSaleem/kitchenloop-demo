// Note store: in-memory map with JSON-file persistence.
// Notes are { id, title, body, tags, createdAt, updatedAt }.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class NoteStore {
  constructor(filePath = "data/notes.json") {
    this.filePath = filePath;
    this.notes = new Map();
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    for (const note of raw) this.notes.set(note.id, note);
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...this.notes.values()], null, 2));
  }

  create({ title, body = "", tags = [] }) {
    const now = new Date().toISOString();
    const note = { id: randomUUID(), title, body, tags, createdAt: now, updatedAt: now };
    this.notes.set(note.id, note);
    this.persist();
    return note;
  }

  get(id) {
    return this.notes.get(id) ?? null;
  }

  list() {
    return [...this.notes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  remove(id) {
    const existed = this.notes.delete(id);
    if (existed) this.persist();
    return existed;
  }
}
