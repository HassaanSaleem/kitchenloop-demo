// Regenerates .kitchenloop/coverage-matrix.yaml from the machine-parseable
// KITCHENLOOP-COVERAGE block declared near the top of source files that
// witness a feature x platform x user_type combo. Without a derivation link,
// coverage-matrix.yaml and loop-state.md would be two independently
// hand-authored summaries of "what have we tested" that can silently
// disagree with each other and with the scenario files themselves.
//
// Two sources are scanned:
//   - scenarios/incubating/*/scenario.mjs — a block is MANDATORY; a scenario
//     dir with a scenario.mjs but no block is a hard error (every incubating
//     scenario must declare its coverage claim).
//   - tests/e2e/*.spec.ts — a block is OPTIONAL (not every e2e spec claims a
//     matrix combo); when present, it is validated by the exact same guard
//     (malformed JSON / out-of-vocab dimension / bad result / missing
//     iteration all throw) so a future e2e spec's typo'd block fails loudly
//     instead of being silently dropped (the same drift class the scenario
//     guard exists to prevent).
//
// Single source of truth going forward: each file's own KITCHENLOOP-COVERAGE
// block. This script is the ONLY writer of coverage-matrix.yaml's
// tested/tested_combos/coverage_pct fields — never hand-edit them.
//
// Usage: node scripts/kitchenloop/derive-coverage.mjs
// Exit 0 = matrix regenerated; non-zero = a source file has a missing
// (scenario only) or malformed COVERAGE block, or declares a
// feature/platform/user_type outside kitchenloop.yaml's spec.dimensions
// vocabulary (typo guard).
//
// NOTE: lives directly under scripts/kitchenloop/, not a coverage/
// subdirectory — .gitignore has a repo-wide `coverage/` rule (test-coverage
// output dirs) that would otherwise swallow this file.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCENARIOS_DIR = path.join(REPO_ROOT, "scenarios/incubating");
const E2E_DIR = path.join(REPO_ROOT, "tests/e2e");
const MATRIX_PATH = path.join(REPO_ROOT, ".kitchenloop/coverage-matrix.yaml");
const CONFIG_PATH = path.join(REPO_ROOT, "kitchenloop.yaml");

export function extractDimension(yamlText, key) {
  const lines = yamlText.split("\n");
  const headerRe = new RegExp(`^\\s{4}${key}:\\s*$`);
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) throw new Error(`kitchenloop.yaml: spec.dimensions.${key} not found`);
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s{4}-\s*"([^"]+)"/);
    if (m) {
      items.push(m[1]);
      continue;
    }
    if (/^\s{4}#/.test(line)) continue; // inline comment at list-item indent
    break; // anything else ends the list
  }
  return items;
}

export function loadDimensions() {
  const text = readFileSync(CONFIG_PATH, "utf8");
  return {
    features: extractDimension(text, "features"),
    platforms: extractDimension(text, "platforms"),
    user_types: extractDimension(text, "user_types"),
  };
}

/** Parse a KITCHENLOOP-COVERAGE block out of already-read source text.
 * Returns null when no block is present; throws on a present-but-malformed
 * block. `sourcePath` is used only for error messages. */
export function extractCoverageFromText(text, sourcePath) {
  const m = text.match(/\/\/ KITCHENLOOP-COVERAGE-BEGIN([\s\S]*?)\/\/ KITCHENLOOP-COVERAGE-END/);
  if (!m) return null;
  const jsonText = m[1]
    .split("\n")
    .map((line) => line.replace(/^\/\/ ?/, ""))
    .join("\n");
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`${sourcePath}: KITCHENLOOP-COVERAGE block is not valid JSON — ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${sourcePath}: KITCHENLOOP-COVERAGE block must be a JSON array`);
  }
  return parsed;
}

function extractCoverage(sourcePath) {
  return extractCoverageFromText(readFileSync(sourcePath, "utf8"), sourcePath);
}

/** Validate each raw COVERAGE entry against the dimension vocabulary and
 * shape, returning normalized entries tagged with their witness. Shared by
 * both the scenario and e2e collectors so the same typo/malformed-block
 * guard applies to both sources. */
export function validateCoverage(sourcePath, coverage, dims, witness) {
  const entries = [];
  for (const raw of coverage) {
    const { feature, platform, user_type, result, iteration, tier, note } = raw;
    for (const [field, value, vocab] of [
      ["feature", feature, dims.features],
      ["platform", platform, dims.platforms],
      ["user_type", user_type, dims.user_types],
    ]) {
      if (!vocab.includes(value)) {
        throw new Error(
          `${sourcePath}: COVERAGE entry has ${field}="${value}", not in kitchenloop.yaml spec.dimensions.${field === "user_type" ? "user_types" : `${field}s`} (${vocab.join(", ")})`,
        );
      }
    }
    if (result !== "pass" && result !== "fail") {
      throw new Error(`${sourcePath}: COVERAGE entry result must be "pass" or "fail", got "${result}"`);
    }
    if (typeof iteration !== "number") {
      throw new Error(`${sourcePath}: COVERAGE entry missing numeric "iteration"`);
    }
    entries.push({ feature, platform, user_type, result, iteration, tier: tier ?? "", note: note ?? "", scenario: witness });
  }
  return entries;
}

export function collectScenarioEntries(dims) {
  const scenarioDirs = readdirSync(SCENARIOS_DIR).filter((name) =>
    statSync(path.join(SCENARIOS_DIR, name)).isDirectory(),
  );
  const entries = [];
  for (const dir of scenarioDirs) {
    const scenarioPath = path.join(SCENARIOS_DIR, dir, "scenario.mjs");
    let coverage;
    try {
      coverage = extractCoverage(scenarioPath);
    } catch (err) {
      if (err.code === "ENOENT") continue; // no scenario.mjs in this dir (e.g. a README-only stub)
      throw err;
    }
    if (coverage === null) {
      throw new Error(
        `${scenarioPath}: missing KITCHENLOOP-COVERAGE-BEGIN/END block — every incubating scenario must declare its coverage claim`,
      );
    }
    entries.push(...validateCoverage(scenarioPath, coverage, dims, dir));
  }
  return entries;
}

/** Walk tests/e2e/*.spec.ts. A block is OPTIONAL here — not every e2e spec
 * claims a matrix combo — but a PRESENT block is validated exactly like a
 * scenario's (a future e2e spec with a malformed/out-of-vocab block fails
 * loudly instead of being silently invisible to the matrix). */
export function collectE2eEntries(dims) {
  let files;
  try {
    files = readdirSync(E2E_DIR).filter((name) => name.endsWith(".spec.ts"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const entries = [];
  for (const file of files) {
    const specPath = path.join(E2E_DIR, file);
    const coverage = extractCoverage(specPath);
    if (coverage === null) continue; // this spec doesn't claim a matrix combo
    entries.push(...validateCoverage(specPath, coverage, dims, file));
  }
  return entries;
}

export function dedupe(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const key = `${e.feature}|${e.platform}|${e.user_type}`;
    const existing = byKey.get(key);
    if (!existing || e.iteration > existing.iteration) byKey.set(key, e);
  }
  return [...byKey.values()];
}

function yamlEscape(str) {
  return str.replace(/"/g, '\\"');
}

function renderMatrix(dims, tested) {
  const totalCombos = dims.features.length * dims.platforms.length * dims.user_types.length;
  const testedCombos = tested.length;
  const coveragePct = Math.round((testedCombos / totalCombos) * 1000) / 10;
  const today = new Date().toISOString().slice(0, 10);

  const sorted = [...tested].sort((a, b) =>
    a.iteration - b.iteration ||
    a.feature.localeCompare(b.feature) ||
    a.platform.localeCompare(b.platform) ||
    a.user_type.localeCompare(b.user_type),
  );

  const lines = [];
  lines.push("# Coverage Matrix");
  lines.push("#");
  lines.push("# GENERATED FILE — do not hand-edit tested/tested_combos/coverage_pct below.");
  lines.push("# Source of truth: the KITCHENLOOP-COVERAGE block each scenarios/incubating/*/");
  lines.push("# scenario.mjs or tests/e2e/*.spec.ts file declares near its top. Regenerate with:");
  lines.push("#   node scripts/kitchenloop/derive-coverage.mjs");
  lines.push("# (Replaces a hand-appended-by-two-phases convention, which can silently drift");
  lines.push("# from both loop-state.md and the scenario files. The walk also covers");
  lines.push("# tests/e2e/*.spec.ts, the other place coverage is durably");
  lines.push("# witnessed.)");
  lines.push("");
  lines.push(`last_updated: "${today}"`);
  lines.push(`total_combos: ${totalCombos}   # ${dims.features.length} features x ${dims.platforms.length} platforms x ${dims.user_types.length} user_types (kitchenloop.yaml spec.dimensions)`);
  lines.push(`tested_combos: ${testedCombos}`);
  lines.push(`coverage_pct: ${coveragePct}`);
  lines.push("");
  lines.push("tested:");
  let lastIteration = null;
  for (const e of sorted) {
    if (e.iteration !== lastIteration) {
      lines.push(`  # ── iteration ${e.iteration} ──`);
      lastIteration = e.iteration;
    }
    lines.push(`  - combo: { feature: "${e.feature}", platform: "${e.platform}", user_type: "${e.user_type}" }`);
    lines.push(`    iteration: ${e.iteration}`);
    const comment = [e.note, `witness: ${e.scenario}`].filter(Boolean).join(" — ");
    lines.push(`    result: "${e.result}"${comment ? `   # ${yamlEscape(comment)}` : ""}`);
    if (e.tier) lines.push(`    tier: "${e.tier}"`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const dims = loadDimensions();
  const entries = [...collectScenarioEntries(dims), ...collectE2eEntries(dims)];
  const tested = dedupe(entries);
  const yaml = renderMatrix(dims, tested);
  writeFileSync(MATRIX_PATH, yaml, "utf8");
  console.log(`derive-coverage: wrote ${MATRIX_PATH} — ${tested.length} unique combos from ${entries.length} declared entries across ${new Set(entries.map((e) => e.scenario)).size} sources.`);
}

// Only run when executed directly (`node derive-coverage.mjs`) — importing
// this module (e.g. from a test) must not have the side effect of
// overwriting the real coverage-matrix.yaml.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
