// L3 smoke: boot the real server on an ephemeral port, exercise one full
// user journey over HTTP (create -> list -> search -> share -> shared read),
// and exit non-zero on any failure.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.mjs";

const app = buildApp({ storePath: join(mkdtempSync(join(tmpdir(), "relay-smoke-")), "notes.json") });

await new Promise((resolve) => app.listen(0, resolve));
const base = `http://127.0.0.1:${app.address().port}`;

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};

const created = await (await fetch(`${base}/notes`, {
  method: "POST",
  body: JSON.stringify({ title: "smoke note", body: "hello relay" }),
})).json();
if (!created.id) fail("create returned no id");

const listed = await (await fetch(`${base}/notes`)).json();
if (listed.length !== 1) fail(`expected 1 note, got ${listed.length}`);

const found = await (await fetch(`${base}/search?q=relay`)).json();
if (found.length !== 1) fail("search did not find the note body");

const { token } = await (await fetch(`${base}/notes/${created.id}/share`, { method: "POST" })).json();
if (!token) fail("share returned no token");

const shared = await (await fetch(`${base}/shared/${token}`)).json();
if (shared.id !== created.id) fail("shared read returned wrong note");

console.log("SMOKE PASS: create -> list -> search -> share -> shared read");
app.close();
