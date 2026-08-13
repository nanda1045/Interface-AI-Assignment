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
});
