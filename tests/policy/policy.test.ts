import { describe, expect, it } from "vitest";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";

const config: PolicyConfig = {
  allowed_origins: ["http://localhost:4478"],
  allowed_path_patterns: ["^/(desk|workspace)(/.*)?$"],
  allowed_actions: ["navigate", "click", "type"],
  max_steps: 25,
  max_duration_ms: 120_000,
  risk: { discovery_mutations: "block", irreversible: "escalate" }
};

describe("PolicyEngine", () => {
  const policy = new PolicyEngine(config);

  it("allows configured safe actions and routes", () => {
    expect(policy.check({ kind: "navigate", url: "http://localhost:4478/workspace/search" }, { risk: "read_only" })).toEqual({ allowed: true, rule: "allowed" });
  });

  it("denies off-origin and off-route navigation", () => {
    expect(policy.check({ kind: "navigate", url: "https://example.com/workspace" }, { risk: "read_only" })).toMatchObject({ allowed: false, rule: "origin_not_allowed" });
    expect(policy.check({ kind: "navigate", url: "http://localhost:4478/__chaos" }, { risk: "read_only" })).toMatchObject({ allowed: false, rule: "route_not_allowed" });
  });

  it("blocks mutations without explicit permission and always transfers irreversible work", () => {
    expect(policy.check({ kind: "click", ref: "e1" }, { risk: "mutating" })).toMatchObject({ allowed: false, rule: "mutation_requires_confirmation" });
    expect(policy.check({ kind: "click", ref: "e1" }, { risk: "mutating", allowMutations: true })).toEqual({ allowed: true, rule: "allowed" });
    expect(policy.check({ kind: "click", ref: "e1" }, { risk: "irreversible", allowMutations: true })).toMatchObject({ allowed: false, rule: "irreversible_requires_human" });
  });
});
