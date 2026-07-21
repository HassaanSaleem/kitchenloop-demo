// Full-text search over a note store.

export function searchNotes(store, query) {
  if (!query) return [];
  return store.list().filter((note) => {
    // A record loaded from disk may predate title validation and be missing
    // `title`/`body`; guard so one malformed note can't 500 the whole search.
    const title = typeof note.title === "string" ? note.title : "";
    const body = typeof note.body === "string" ? note.body : "";
    return title.includes(query) || body.includes(query);
  });
}
