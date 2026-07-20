// Full-text search over a note store.

export function searchNotes(store, query) {
  if (!query) return [];
  return store.list().filter(
    (note) => note.title.includes(query) || note.body.includes(query)
  );
}
