import { describe, expect, it } from "vitest";
import { distillDiscovery } from "../../src/artifact/distill.js";
import type { DiscoveryResult } from "../../src/agent/loop.js";

const locator = { capturedAt: "2026-08-13T00:00:00.000Z", strategies: [{ kind: "attr_css" as const, value: "input[name='f_mno']", frame: "workarea", unique: true as const, confidence: 0.7 }] };
const result: DiscoveryResult = {
  status: "success", runId: "disc_test", outputs: { savings_balance: locator },
  steps: [{ step: 1, reasoning: "Enter member", action: { kind: "type", ref: "e1", text: "4521", sensitive: true }, locators: locator, beforeUrl: "http://localhost:4478/desk", afterUrl: "http://localhost:4478/desk" }]
};
const options = {
  id: "lookup_member_savings_balance", title: "Look up member savings balance", description: "Reads regular savings.", entryUrl: "http://localhost:4478/desk", model: "test", runId: "disc_test", params: { member_id: "4521" },
  inputs: { type: "object" as const, required: ["member_id"], properties: { member_id: { type: "string" as const, sensitive: true } } },
  outputs: { type: "object" as const, required: ["savings_balance"], properties: { savings_balance: { type: "string" as const, "x-format": "usd-currency" } } }
};

const roleName = (name: string) => ({ kind: "role_name" as const, role: "button", name, frame: "workarea", unique: true as const, confidence: 0.9 });
const bundle = (...strategies: { kind: string }[]) => ({ capturedAt: "2026-08-13T00:00:00.000Z", strategies }) as typeof locator;
const runWith = (overrides: { reasoning?: string; locators?: typeof locator; outputs?: DiscoveryResult["outputs"] }): DiscoveryResult => ({
  ...result,
  outputs: overrides.outputs ?? result.outputs,
  steps: [{
    step: 1,
    reasoning: overrides.reasoning ?? "Enter member",
    action: { kind: "type", ref: "e1", text: "4521", sensitive: true },
    locators: overrides.locators ?? locator,
    beforeUrl: "http://localhost:4478/desk",
    afterUrl: "http://localhost:4478/desk"
  }]
});

const step = (action: DiscoveryResult["steps"][number]["action"], locators = locator): DiscoveryResult["steps"][number] =>
  ({ step: 1, reasoning: "Work the form", action, locators, beforeUrl: "http://localhost:4478/desk", afterUrl: "http://localhost:4478/desk" });
const runSteps = (...steps: DiscoveryResult["steps"]): DiscoveryResult => ({ ...result, steps });

describe("distillDiscovery", () => {
  it("binds concrete recorded values into typed parameters", () => {
    const artifact = distillDiscovery(result, options);
    expect(artifact.steps[0]?.action).toEqual({ kind: "type", value_from: { param: "member_id" }, sensitive: true });
    expect(JSON.stringify(artifact)).not.toContain("4521");
  });

  it("fails loudly when a supplied parameter never binds", () => {
    expect(() => distillDiscovery(result, { ...options, params: { member_id: "9999" } })).toThrow(/Could not uniquely bind/);
    expect(() => distillDiscovery(result, { ...options, params: { ...options.params, unused: "x" } })).toThrow(/never bound: unused/);
  });

  it("permits only the actions the capability performs", () => {
    const artifact = distillDiscovery(
      runSteps(step({ kind: "type", ref: "e1", text: "4521", sensitive: true }), step({ kind: "click", ref: "e1" })),
      options
    );
    // navigate for the entry, click for the recovery rule, type and click for the steps.
    expect([...artifact.policy.allowed_actions].sort()).toEqual(["click", "navigate", "type"]);
    expect(artifact.policy.allowed_actions).not.toContain("press");
    expect(artifact.policy.allowed_actions).not.toContain("scroll");
  });

  it("scrubs values the run marked sensitive out of the model's intent text", () => {
    const artifact = distillDiscovery(
      runWith({ reasoning: 'I can see member 4521 "Alex Testman" in the results.' }),
      { ...options, sensitiveValues: ["Alex Testman"] }
    );
    expect(artifact.steps[0]?.intent).toBe('I can see member {{member_id}} "«redacted»" in the results.');
    expect(JSON.stringify(artifact)).not.toContain("Alex Testman");
  });

  it("drops locator strategies built from run-specific data but keeps the rest of the ladder", () => {
    const artifact = distillDiscovery(
      runWith({ locators: bundle(roleName("View account 4521-01"), locator.strategies[0]!) }),
      options
    );
    expect(artifact.steps[0]?.target?.strategies).toHaveLength(1);
    expect(artifact.steps[0]?.target?.strategies[0]?.kind).toBe("attr_css");
    expect(JSON.stringify(artifact)).not.toContain("4521-01");
  });

  it("collapses a value the model re-entered into the same control", () => {
    const artifact = distillDiscovery(
      runSteps(step({ kind: "type", ref: "e1", text: "4521", sensitive: true }), step({ kind: "type", ref: "e1", text: "4521", sensitive: true })),
      options
    );
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0]?.id).toBe("s1");
  });

  it("never collapses a repeated click, which may be doing work each time", () => {
    const artifact = distillDiscovery(
      runSteps(step({ kind: "type", ref: "e1", text: "4521", sensitive: true }), step({ kind: "click", ref: "e1" }), step({ kind: "click", ref: "e1" })),
      options
    );
    expect(artifact.steps).toHaveLength(3);
  });

  it("refuses the artifact when run data emptied a ladder", () => {
    expect(() => distillDiscovery(runWith({ locators: bundle(roleName("View account 4521-01")) }), options))
      .toThrow(/step 1 was built from run-specific data/);
    expect(() => distillDiscovery(runWith({ outputs: { savings_balance: bundle(roleName("Balance for Alex Testman")) } }), { ...options, sensitiveValues: ["Alex Testman"] }))
      .toThrow(/extraction of savings_balance was built from run-specific data/);
  });
});
