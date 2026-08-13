import { describe, expect, it } from "vitest";
import { capabilityArtifactSchema } from "../../src/artifact/schema.js";

export const validArtifact = {
  schema_version: "1.0",
  capability: { id: "lookup_balance", version: "1.0.0", title: "Lookup balance", description: "Reads a balance.", app: { id: "corepoint", vendor: "CorePoint", ui_version_range: ">=3.1" }, risk: "read_only", status: "draft", provenance: { discovered_by: "test", discovery_run: "disc_test", recorded_at: "2026-08-13T00:00:00.000Z", approved_by: null, approved_at: null } },
  inputs: { type: "object", required: ["member_id"], properties: { member_id: { type: "string", pattern: "^[0-9]{4}$", sensitive: true } } },
  outputs: { type: "object", required: ["balance"], properties: { balance: { type: "string", "x-format": "usd-currency" } } },
  entry: { url: "http://localhost:4478/desk", preconditions: [{ kind: "authenticated", via: "test" }] },
  steps: [{ id: "s1", intent: "Enter member ID", action: { kind: "type", value_from: { param: "member_id" }, sensitive: true }, target: { frame: "workarea", strategies: [{ kind: "attr_css", value: "input[name='f_mno']", frame: "workarea", unique: true, confidence: 0.7 }] }, wait: { readyWhen: "target_resolvable", timeout_ms: 10000 }, postconditions: [{ kind: "value_equals_param", param: "member_id" }] }],
  checkpoint: { assert: [{ kind: "text_visible", pattern: "Member Profile", frame: "workarea" }] },
  extract: [{ output: "balance", from: { frame: "workarea", strategies: [{ kind: "text", value: "$2,481.13", frame: "workarea", unique: true, confidence: 0.8 }] }, parse: "currency" }],
  outcomes: [], recovery: [], policy: { allowed_origins: ["http://localhost:4478"], allowed_actions: ["navigate", "click", "type"], max_duration_ms: 120000 }
};

describe("capabilityArtifactSchema", () => {
  it("round-trips a strict typed artifact", () => {
    const parsed = capabilityArtifactSchema.parse(validArtifact);
    expect(capabilityArtifactSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects unknown transcript-shaped fields", () => {
    expect(() => capabilityArtifactSchema.parse({ ...validArtifact, transcript: [{ role: "user", content: "secret" }] })).toThrow();
  });

  it("rejects undeclared input bindings and output extractions", () => {
    const invalid = structuredClone(validArtifact);
    invalid.steps[0]!.action.value_from.param = "other";
    expect(() => capabilityArtifactSchema.parse(invalid)).toThrow(/Parameter is not declared/);
  });
});
