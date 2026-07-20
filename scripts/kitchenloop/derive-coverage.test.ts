import { describe, expect, it } from "vitest";
import { dedupe, extractCoverageFromText, validateCoverage } from "./derive-coverage.mjs";

// derive-coverage.mjs walks both scenarios/incubating/*/scenario.mjs
// (mandatory block) and tests/e2e/*.spec.ts (optional block) through the SAME
// extraction + validation guard, so a future e2e spec with a malformed or
// out-of-vocab block fails loudly instead of being silently invisible to the
// matrix (the exact drift class the scenario guard exists to prevent). These
// tests exercise the pure, dependency-free guard directly — no
// filesystem/network, matching the CI-testable bar of tests/live's
// dependency-free scripts.

const DIMS = {
  features: ["notes-editor", "sharing", "search"],
  platforms: ["web", "api"],
  user_types: ["author", "reader"],
};

describe("extractCoverageFromText", () => {
  it("returns null when no COVERAGE block is present", () => {
    expect(extractCoverageFromText("// just a comment\nconst x = 1;", "fixture.ts")).toBeNull();
  });

  it("parses a valid block", () => {
    const text = [
      "// KITCHENLOOP-COVERAGE-BEGIN",
      '// [{ "feature": "sharing", "platform": "web", "user_type": "reader", "result": "pass", "iteration": 3 }]',
      "// KITCHENLOOP-COVERAGE-END",
    ].join("\n");
    const parsed = extractCoverageFromText(text, "fixture.ts");
    expect(parsed).toEqual([
      { feature: "sharing", platform: "web", user_type: "reader", result: "pass", iteration: 3 },
    ]);
  });

  it("throws on malformed JSON (the typo guard)", () => {
    const text = ["// KITCHENLOOP-COVERAGE-BEGIN", "// [ this is not json", "// KITCHENLOOP-COVERAGE-END"].join("\n");
    expect(() => extractCoverageFromText(text, "fixture.ts")).toThrow(/not valid JSON/);
  });

  it("throws when the block is valid JSON but not an array", () => {
    const text = ["// KITCHENLOOP-COVERAGE-BEGIN", '// { "feature": "sharing" }', "// KITCHENLOOP-COVERAGE-END"].join(
      "\n",
    );
    expect(() => extractCoverageFromText(text, "fixture.ts")).toThrow(/must be a JSON array/);
  });
});

describe("validateCoverage", () => {
  it("normalizes a valid entry and tags it with its witness", () => {
    const entries = validateCoverage(
      "fixture.ts",
      [{ feature: "sharing", platform: "web", user_type: "reader", result: "pass", iteration: 3, tier: "T2" }],
      DIMS,
      "fixture.spec.ts",
    );
    expect(entries).toEqual([
      {
        feature: "sharing",
        platform: "web",
        user_type: "reader",
        result: "pass",
        iteration: 3,
        tier: "T2",
        note: "",
        scenario: "fixture.spec.ts",
      },
    ]);
  });

  it("throws on a feature outside kitchenloop.yaml's spec.dimensions vocabulary", () => {
    expect(() =>
      validateCoverage(
        "fixture.ts",
        [{ feature: "calendar", platform: "web", user_type: "reader", result: "pass", iteration: 3 }],
        DIMS,
        "fixture.spec.ts",
      ),
    ).toThrow(/feature="calendar"/);
  });

  it("throws on a result that isn't pass/fail", () => {
    expect(() =>
      validateCoverage(
        "fixture.ts",
        [{ feature: "sharing", platform: "web", user_type: "reader", result: "flaky", iteration: 3 }],
        DIMS,
        "fixture.spec.ts",
      ),
    ).toThrow(/result must be "pass" or "fail"/);
  });

  it("throws when iteration is missing or non-numeric", () => {
    expect(() =>
      validateCoverage(
        "fixture.ts",
        [{ feature: "sharing", platform: "web", user_type: "reader", result: "pass" }],
        DIMS,
        "fixture.spec.ts",
      ),
    ).toThrow(/missing numeric "iteration"/);
  });
});

describe("dedupe", () => {
  it("keeps the higher-iteration entry for the same feature/platform/user_type combo", () => {
    const older = { feature: "sharing", platform: "web", user_type: "reader", result: "pass", iteration: 3, tier: "", note: "", scenario: "a" };
    const newer = { ...older, iteration: 5, scenario: "b" };
    expect(dedupe([older, newer])).toEqual([newer]);
    expect(dedupe([newer, older])).toEqual([newer]);
  });

  it("keeps the earlier-declared entry on an iteration tie (first source wins)", () => {
    const first = { feature: "sharing", platform: "web", user_type: "reader", result: "pass", iteration: 3, tier: "", note: "", scenario: "scenario-witness" };
    const second = { ...first, scenario: "e2e-spec-witness" };
    expect(dedupe([first, second])).toEqual([first]);
  });
});
