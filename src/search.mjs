// Full-text search over a note store.
//
// Matching is case-insensitive and spans a note's title, body, and tags.
// A note whose title/body is missing (e.g. a legacy or hand-edited record on
// disk) is tolerated field-by-field rather than crashing the whole request.

export function searchNotes(store, query) {
  if (!query) return [];
  const needle = query.toLowerCase();
  return store.list().filter((note) => noteMatches(note, needle));
}

function noteMatches(note, needle) {
  const fields = [note.title, note.body, ...(Array.isArray(note.tags) ? note.tags : [])];
  return fields.some(
    (field) => typeof field === "string" && field.toLowerCase().includes(needle)
  );
}
