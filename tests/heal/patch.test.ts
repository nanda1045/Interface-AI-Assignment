import { describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { applyStepRepair } from "../../src/heal/patch.js";
import type { LocatorStrategy } from "../../src/surface/types.js";

// A ladder helper: one role_name strategy is enough for these pure tests.
const ladder = (name: string): LocatorStrategy[] => [{ kind: "role_name", role: "button", name, frame: "main", unique: true, confidence: 0.9 }];

const target = (name: string) => ({ frame: "main", strategies: ladder(name) });

// A minimal but schema-valid read-only capability with two locator steps.
const base: CapabilityArtifact = {
  schema_version: "1.0",
  capability: {
    id: "find_member", version: "1.0.0", title: "Find member", description: "Look a member up.",
    app: { id: "meridian-core", vendor: "Cornerstone", ui_version_range: ">=4 <5" }, risk: "read_only", status: "approved",
    provenance: { discovered_by: "gpt", discovery_run: "disc_1", recorded_at: "2026-08-20T00:00:00.000Z", approved_by: "alice", approved_at: "2026-08-20T00:01:00.000Z", input_fingerprint: { member_number: "abc123" }, validation: { run: "val_1", validated_at: "2026-08-20T00:01:00.000Z", outcome: "success", reused_params: [], matched_tiers: { "1": 2 } } }
  },
  inputs: { type: "object", required: ["member_number"], properties: { member_number: { type: "string" } } },
  outputs: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  entry: { url: "https://target.test/members", preconditions: [] },
  steps: [
    { id: "s1", intent: "Type member number", action: { kind: "type", value_from: { param: "member_number" } }, target: target("Member No."), wait: { readyWhen: "target_resolvable", timeout_ms: 1000 }, postconditions: [{ kind: "value_equals_param", param: "member_number" }] },
    { id: "s2", intent: "Click Search", action: { kind: "click" }, target: target("Search"), wait: { readyWhen: "target_resolvable", timeout_ms: 1000 }, postconditions: [] }
  ],
  checkpoint: { assert: [{ kind: "element_present", target: target("Member Name") }] },
  extract: [{ output: "name", from: target("Member Name"), parse: "text" }],
  outcomes: [], recovery: [],
  policy: { allowed_origins: ["https://target.test"], allowed_actions: ["navigate", "type", "click"], max_duration_ms: 60_000 }
};

describe("applyStepRepair - the pure heal patch", () => {
  it("replaces only the named step's ladder and produces an unapproved draft", () => {
    const draft = applyStepRepair(base, { stepId: "s2", newStrategies: ladder("Search Members"), newVersion: "1.1.0", fromRun: "replay_bad", model: "gpt-heal", now: new Date("2026-08-21T00:00:00.000Z") });

    // The one healed step changed; every other step is byte-identical.
    expect(draft.steps[1]!.target!.strategies).toEqual(ladder("Search Members"));
    expect(draft.steps[0]).toEqual(base.steps[0]);
    expect(draft.steps[1]!.action).toEqual(base.steps[1]!.action);
    expect(draft.steps[1]!.postconditions).toEqual(base.steps[1]!.postconditions);

    // It is a draft with no approval - a proposal, not something runnable.
    expect(draft.capability.status).toBe("draft");
    expect(draft.capability.version).toBe("1.1.0");
    expect(draft.capability.provenance.approved_by).toBeNull();
    expect(draft.capability.provenance.validation).toBeNull();
  });

  it("records repair provenance and preserves the original input fingerprint", () => {
    const draft = applyStepRepair(base, { stepId: "s2", newStrategies: ladder("Search Members"), newVersion: "1.1.0", fromRun: "replay_bad", model: "gpt-heal" });
    expect(draft.capability.provenance.repair).toMatchObject({ from_version: "1.0.0", from_run: "replay_bad", step: "s2", strategies_before: 1, strategies_after: 1 });
    // The fingerprint is carried over so approval still demands a different invocation.
    expect(draft.capability.provenance.input_fingerprint).toEqual(base.capability.provenance.input_fingerprint);
    // The re-discovery is credited to the healer, distinct from any approver.
    expect(draft.capability.provenance.discovered_by).toBe("gpt-heal");
    expect(draft.capability.provenance.discovery_run).toBe("replay_bad");
  });

  it("rejects an unknown step, a targetless step, and an empty ladder", () => {
    expect(() => applyStepRepair(base, { stepId: "s9", newStrategies: ladder("x"), newVersion: "1.1.0", fromRun: "r", model: "m" })).toThrow(/not part of/);
    expect(() => applyStepRepair(base, { stepId: "s2", newStrategies: [], newVersion: "1.1.0", fromRun: "r", model: "m" })).toThrow(/at least one/);

    const withScroll: CapabilityArtifact = { ...base, steps: [...base.steps, { id: "s3", intent: "Scroll", action: { kind: "scroll", direction: "down" }, wait: { readyWhen: "page_loaded", timeout_ms: 500 }, postconditions: [] }] };
    expect(() => applyStepRepair(withScroll, { stepId: "s3", newStrategies: ladder("x"), newVersion: "1.1.0", fromRun: "r", model: "m" })).toThrow(/no locator target/);
  });

  it("keeps an irreversible capability's human boundary intact through a repair", () => {
    // Healing the verify locator of the human_required boundary must not strip
    // its execution or move it - the strict schema re-check guarantees this.
    const irreversible: CapabilityArtifact = {
      ...base,
      capability: { ...base.capability, id: "transfer", risk: "irreversible" },
      inputs: { type: "object", required: [], properties: {} },
      steps: [{ id: "s1", intent: "Post the transfer", action: { kind: "click" }, target: target("Post Transfer"), wait: { readyWhen: "target_resolvable", timeout_ms: 1000 }, execution: "human_required", postconditions: [] }]
    };
    const draft = applyStepRepair(irreversible, { stepId: "s1", newStrategies: ladder("Post Transfer Now"), newVersion: "1.1.0", fromRun: "r", model: "m" });
    expect(draft.steps[0]!.execution).toBe("human_required");
    expect(draft.steps[draft.steps.length - 1]!.execution).toBe("human_required");
    expect(draft.capability.risk).toBe("irreversible");
  });
});
