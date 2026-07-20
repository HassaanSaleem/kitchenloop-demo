// Zero-dependency lint gate: every source and test module must pass a syntax
// check and must not contain merge-conflict markers or debug-breakpoint statements.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function mjsFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

const files = ["src", "tests", "scripts"].flatMap(mjsFilesUnder);

let failed = false;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    console.error(`LINT: ${file} failed syntax check\n${err.stderr}`);
    failed = true;
  }
  const text = readFileSync(file, "utf8");
  if (/^(<{7}|={7}|>{7})/m.test(text)) {
    console.error(`LINT: ${file} contains merge-conflict markers`);
    failed = true;
  }
  // Pattern is split so this file's own source never matches it.
  if (new RegExp("\\bdebug" + "ger\\b").test(text)) {
    console.error(`LINT: ${file} contains a forbidden debug statement`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`LINT PASS: ${files.length} files clean`);
