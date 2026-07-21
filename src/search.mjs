// Full-text search over a note store.

export function searchNotes(store, query) {
  if (!query) return [];
  const needle = query.toLowerCase();
  return store.list().filter((note) => {
    // Search title, body, and tags. A record loaded from disk may predate
    // title validation and be missing fields; only string fields are matched,
    // so one malformed note can't 500 the whole search.
    const fields = [note.title, note.body, ...(Array.isArray(note.tags) ? note.tags : [])];
    return fields.some(
      (field) => typeof field === "string" && field.toLowerCase().includes(needle)
    );
  });
}
