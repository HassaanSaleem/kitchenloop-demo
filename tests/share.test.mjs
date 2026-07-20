import { test } from "node:test";
import assert from "node:assert/strict";
import { ShareRegistry } from "../src/share.mjs";

test("share issues a resolvable token", () => {
  const shares = new ShareRegistry();
  const token = shares.share("note-1");
  assert.equal(shares.resolve(token), "note-1");
});

test("unknown tokens resolve to null", () => {
  const shares = new ShareRegistry();
  assert.equal(shares.resolve("nope"), null);
});
