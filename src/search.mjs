// Full-text search over a note store.

export function searchNotes(store, query) {
  if (!query) return [];
  // Tolerate malformed records: a single note with an undefined title/body must
  // never 500 search for the whole collection, regardless of how it got stored.
  const matches = (field) => typeof field === "string" && field.includes(query);
  return store.list().filter((note) => matches(note.title) || matches(note.body));
}
