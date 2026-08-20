import { describe, expect, it } from "vitest";
import { capabilityArtifactSchema, type CapabilityArtifact } from "../../src/artifact/schema.js";
import { validArtifact } from "./schema.test.js";

function shaped(changes: (artifact: CapabilityArtifact) => void): unknown {
  const artifact = structuredClone(validArtifact) as CapabilityArtifact;
  changes(artifact);
  return artifact;
}

const tableTarget = { frame: "main", strategies: [{ kind: "structural" as const, value: "/html/body/table", frame: "main", unique: true as const, confidence: 0.5 }] };

// A well-formed table artifact the negative cases below each break one way.
function tableArtifact(changes: (artifact: CapabilityArtifact) => void = () => undefined): unknown {
  return shaped((artifact) => {
    artifact.outputs = { type: "object", required: ["matches"], properties: { matches: { type: "array", items: { type: "object", properties: { member_no: { type: "string" }, name: { type: "string" } } } } } };
    artifact.extract = [{ output: "matches", from: tableTarget, parse: "table", columns: [{ header: "Member No.", property: "member_no" }, { header: "Name", property: "name" }] }];
    changes(artifact);
  });
}

describe("table contract cross-validation", () => {
  it("accepts the well-formed table artifact", () => {
    expect(() => capabilityArtifactSchema.parse(tableArtifact())).not.toThrow();
  });

  it("requires a column mapping for table extraction", () => {
    expect(() => capabilityArtifactSchema.parse(tableArtifact((artifact) => { delete (artifact.extract[0] as { columns?: unknown }).columns; })))
      .toThrow(/requires a column mapping/);
  });

  it("requires the filled output to be an array", () => {
    expect(() => capabilityArtifactSchema.parse(tableArtifact((artifact) => {
      artifact.outputs.properties.matches = { type: "string" };
    }))).toThrow(/must fill an array-typed output/);
  });

  it("rejects a column property the items do not declare", () => {
    expect(() => capabilityArtifactSchema.parse(tableArtifact((artifact) => {
      artifact.extract[0]!.columns![1] = { header: "Name", property: "surprise" };
    }))).toThrow(/not declared in the output's items/);
  });

  it("rejects duplicate column properties and duplicate or blank headers", () => {
    expect(() => capabilityArtifactSchema.parse(tableArtifact((artifact) => {
      artifact.extract[0]!.columns![1] = { header: "Name", property: "member_no" };
    }))).toThrow(/mapped twice/);
    expect(() => capabilityArtifactSchema.parse(tableArtifact((artifact) => {
      artifact.extract[0]!.columns![1] = { header: "member no.", property: "name" };
    }))).toThrow(/appears twice/);
    expect(() => capabilityArtifactSchema.parse(tableArtifact((artifact) => {
      artifact.extract[0]!.columns![1] = { header: "  ", property: "name" };
    }))).toThrow(/header is blank/);
  });

  it("rejects a column mapping on scalar extraction, and scalar parse on an array output", () => {
    expect(() => capabilityArtifactSchema.parse(shaped((artifact) => {
      (artifact.extract[0] as { columns?: unknown }).columns = [{ header: "X", property: "x" }];
    }))).toThrow(/Only table extraction takes a column mapping/);
    expect(() => capabilityArtifactSchema.parse(tableArtifact((artifact) => {
      artifact.extract[0]!.parse = "text";
      delete (artifact.extract[0] as { columns?: unknown }).columns;
    }))).toThrow(/needs table extraction/);
  });

  it("requires exactly one extraction per required output", () => {
    expect(() => capabilityArtifactSchema.parse(shaped((artifact) => { artifact.extract = []; })))
      .toThrow(/has 0 extraction rules/);
    expect(() => capabilityArtifactSchema.parse(shaped((artifact) => { artifact.extract = [artifact.extract[0]!, artifact.extract[0]!]; })))
      .toThrow(/has 2 extraction rules/);
  });
});

describe("irreversible human-boundary validation", () => {
  const humanStep = (target = true): CapabilityArtifact["steps"][number] => ({
    id: "s2", intent: "Post the transfer", action: { kind: "click" },
    ...(target ? { target: tableTarget } : {}),
    wait: { readyWhen: "target_resolvable" as const, timeout_ms: 1_000 },
    execution: "human_required" as const,
    postconditions: []
  });

  it("accepts an irreversible artifact whose final step is the verified human boundary", () => {
    expect(() => capabilityArtifactSchema.parse(shaped((artifact) => {
      artifact.capability.risk = "irreversible";
      artifact.steps = [artifact.steps[0]!, humanStep()];
    }))).not.toThrow();
  });

  it("rejects an irreversible artifact with no human_required step", () => {
    expect(() => capabilityArtifactSchema.parse(shaped((artifact) => { artifact.capability.risk = "irreversible"; })))
      .toThrow(/must record a human_required step/);
  });

  it("rejects agent-executed steps after the human boundary", () => {
    // An unrelated human step followed by an agent-executed final action would
    // perform the irreversible work unattended - the exact hole this closes.
    expect(() => capabilityArtifactSchema.parse(shaped((artifact) => {
      artifact.capability.risk = "irreversible";
      artifact.steps = [humanStep(), artifact.steps[0]!];
    }))).toThrow(/final step of an irreversible capability/);
  });

  it("rejects a human boundary with no target to verify the screen against", () => {
    expect(() => capabilityArtifactSchema.parse(shaped((artifact) => {
      artifact.capability.risk = "irreversible";
      const step = humanStep(false);
      step.action = { kind: "press", key: "Enter" };
      artifact.steps = [artifact.steps[0]!, step];
    }))).toThrow(/needs a target locator/);
  });
});
