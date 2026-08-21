import { describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { describeShapeDrift, detectShapeDrift } from "../../src/eval/shape.js";

// A read-only capability whose one output is a table with three declared columns.
const target = { frame: "main", strategies: [{ kind: "role_name" as const, role: "table", name: "results", frame: "main", unique: true as const, confidence: 0.9 }] };
const artifact = {
  extract: [{
    output: "matches", from: target, parse: "table",
    columns: [{ header: "Member No.", property: "member_no" }, { header: "Name", property: "name" }, { header: "Shares", property: "shares" }]
  }]
} as unknown as CapabilityArtifact;

describe("detectShapeDrift", () => {
  it("reports no drift when the live headers match the declared columns (case-insensitive)", () => {
    expect(detectShapeDrift(artifact, { matches: ["member no.", "Name", "Shares"] })).toEqual([]);
  });

  it("flags a newly-added live column the recording does not map", () => {
    const drift = detectShapeDrift(artifact, { matches: ["Member No.", "Name", "Shares", "Branch"] });
    expect(drift).toEqual([{ output: "matches", added: ["Branch"], missing: [] }]);
  });

  it("flags a declared column that is no longer present live", () => {
    const drift = detectShapeDrift(artifact, { matches: ["Member No.", "Name"] });
    expect(drift).toEqual([{ output: "matches", added: [], missing: ["Shares"] }]);
  });

  it("ignores outputs the run did not observe", () => {
    expect(detectShapeDrift(artifact, {})).toEqual([]);
  });

  it("summarizes drift compactly, or returns undefined when clean", () => {
    expect(describeShapeDrift([])).toBeUndefined();
    expect(describeShapeDrift([{ output: "matches", added: ["Branch"], missing: ["Shares"] }])).toBe("shape drift: matches (+Branch -Shares)");
  });
});
