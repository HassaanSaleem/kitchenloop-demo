// Relay Notes HTTP API — a thin JSON layer over the store, search, and share modules.
//
//   POST   /notes            {title, body?, tags?}  -> 201 note
//   GET    /notes            -> 200 [notes]
//   GET    /notes/:id        -> 200 note | 404
//   DELETE /notes/:id        -> 204 | 404
//   GET    /search?q=term    -> 200 [notes]
//   POST   /notes/:id/share  -> 201 {token}
//   GET    /shared/:token    -> 200 note | 404

import { createServer } from "node:http";
import { NoteStore } from "./store.mjs";
import { ShareRegistry } from "./share.mjs";
import { searchNotes } from "./search.mjs";

export function buildApp({ storePath } = {}) {
  const store = new NoteStore(storePath);
  const shares = new ShareRegistry();

  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };

    try {
      if (req.method === "POST" && url.pathname === "/notes") {
        const body = await readJson(req);
        const invalid = validateCreate(body);
        if (invalid) return send(400, { error: invalid });
        return send(201, store.create(body));
      }
      if (req.method === "GET" && url.pathname === "/notes") {
        return send(200, store.list());
      }
      const noteMatch = url.pathname.match(/^\/notes\/([^/]+)$/);
      if (noteMatch) {
        const note = store.get(noteMatch[1]);
        if (req.method === "GET") {
          return note ? send(200, note) : send(404, { error: "not found" });
        }
        if (req.method === "DELETE") {
          return store.remove(noteMatch[1]) ? send(204) : send(404, { error: "not found" });
        }
      }
      if (req.method === "GET" && url.pathname === "/search") {
        return send(200, searchNotes(store, url.searchParams.get("q")));
      }
      const shareMatch = url.pathname.match(/^\/notes\/([^/]+)\/share$/);
      if (req.method === "POST" && shareMatch) {
        if (!store.get(shareMatch[1])) return send(404, { error: "not found" });
        return send(201, { token: shares.share(shareMatch[1]) });
      }
      const sharedMatch = url.pathname.match(/^\/shared\/([^/]+)$/);
      if (req.method === "GET" && sharedMatch) {
        const noteId = shares.resolve(sharedMatch[1]);
        const note = noteId ? store.get(noteId) : null;
        return note ? send(200, note) : send(404, { error: "not found" });
      }
      return send(404, { error: "no such route" });
    } catch (err) {
      // Bad input carries a 4xx statusCode (constitution III — "bad input gets a
      // 4xx"); anything else is an unexpected failure and gets a 500.
      return send(err.statusCode ?? 500, { error: err.message });
    }
  });
}

// Validate a POST /notes payload against the documented {title, body?, tags?}
// schema. Returns an error string for a 400, or null when the payload is OK.
// `title` is required and must be a non-empty string; missing/blank titles are
// rejected here rather than stored verbatim.
function validateCreate(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "request body must be a JSON object";
  }
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return "title is required";
  }
  return null;
}

// Tag an Error with a 4xx status so the top-level handler answers with that code
// (constitution III — bad input is a 4xx, not a 500) instead of defaulting to 500.
function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(badRequest("request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  buildApp().listen(port, () => {
    console.log(`relay-notes listening on :${port}`);
  });
}
