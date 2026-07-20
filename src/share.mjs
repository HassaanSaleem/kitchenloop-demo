// Share links: a note can be shared read-only via an opaque token.

import { randomBytes } from "node:crypto";

export class ShareRegistry {
  constructor() {
    this.tokens = new Map(); // token -> noteId
  }

  share(noteId) {
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, noteId);
    return token;
  }

  resolve(token) {
    return this.tokens.get(token) ?? null;
  }
}
