import { describe, expect, it } from "vitest";
import { mutationById, uiMutations } from "../../src/eval/mutations.js";
import { formatStressReport, scoreStress } from "../../src/eval/stress.js";
import type { ReplayResult } from "../../src/replay/result.js";

const mutation = mutationById("rename_labels");
const expected = { savings_balance: "$3,109.08" };
const stability = { resolutions: 1, matched_tiers: { "1": 1 }, matched_strategies: { role_name: 1 }, rescued_steps: [] };
const succeeded = (outputs: Record<string, unknown>): ReplayResult => ({ status: "success", outputs, evidence: "runs/x", stability });

describe("stress scoring", () => {
  it("counts a run as survived only when it returns the value it should", () => {
    expect(scoreStress(mutation, succeeded(expected), expected)).toMatchObject({ survived: true, verdict: "correct" });
  });

  it("does not count a successful run that returned the wrong value", () => {
    // The failure this system is least able to notice on its own: the ladder
    // resolved something, the checkpoint passed, and it read the wrong cell.
    const row = scoreStress(mutation, succeeded({ savings_balance: "$441.90" }), expected);
    expect(row.survived).toBe(false);
    expect(row.verdict).toBe("wrong savings_balance");
  });

  it("treats a missing output as wrong rather than absent", () => {
    expect(scoreStress(mutation, succeeded({}), expected).survived).toBe(false);
  });

  it("reports a business outcome or failure as not survived, keeping the class", () => {
    const outcome = scoreStress(mutation, { status: "business_outcome", code: "MEMBER_NOT_FOUND", evidence: "runs/x" }, expected);
    expect(outcome).toMatchObject({ survived: false, verdict: "business_outcome" });
    const failure = scoreStress(mutation, {
      status: "failure", evidence: "runs/x",
      failure: { class: "target_not_found", disposition: "fix_capability", step: "s2", intent: "", expected: "", observed: "", domSnapshot: "failure/dom.html" }
    }, expected);
    expect(failure).toMatchObject({ survived: false, detail: "target_not_found" });
  });

  it("renders a report that names the surviving count", () => {
    const report = formatStressReport([scoreStress(mutation, succeeded(expected), expected)]);
    expect(report).toContain("rename_labels");
    expect(report).toContain("1/1 mutations survived.");
  });
});

describe("the mutation catalogue", () => {
  it("keeps an unmutated control so a green row means something", () => {
    expect(mutationById("none").script).toBe("");
  });

  it("leaves form control names alone, since changing them breaks the app rather than the locator", () => {
    // A mutation may change how an element is found and must not change what
    // the application does; stripping `name` would break the POST and every
    // capability would fail for a reason that is not about locators at all.
    for (const candidate of uiMutations) {
      expect(candidate.script).not.toMatch(/removeAttribute\(\s*["']name["']\s*\)/);
      expect(candidate.script).not.toMatch(/setAttribute\(\s*["']name["']/);
    }
  });
});
