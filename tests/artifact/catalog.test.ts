import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog, toCapabilityTool } from "../../src/artifact/catalog.js";
import { ArtifactStore } from "../../src/artifact/store.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { validArtifact } from "./schema.test.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function shaped(changes: (artifact: CapabilityArtifact) => void): CapabilityArtifact {
  const artifact = structuredClone(validArtifact) as CapabilityArtifact;
  changes(artifact);
  return artifact;
}

describe("projecting a capability into a tool definition", () => {
  it("uses the typed input contract as the tool's schema", () => {
    const tool = toCapabilityTool(validArtifact as CapabilityArtifact);
    expect(tool.name).toBe("lookup_balance");
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.required).toContain("member_id");
    expect(tool.input_schema.properties.member_id).toMatchObject({ type: "string" });
  });

  it("keeps our own fields out of the schema handed to a model", () => {
    // Built by an allow-list rather than by deleting known extras, so a field
    // added to the artifact schema later cannot leak into a tool definition.
    const tool = toCapabilityTool(shaped((artifact) => {
      artifact.inputs.properties.member_id = { type: "string", sensitive: true, "x-format": "member-id", description: "The member to look up." };
    }));
    expect(tool.input_schema.properties.member_id).toEqual({ type: "string", description: "The member to look up." });
  });

  it("describes what comes back, since a tool definition has nowhere to declare it", () => {
    const tool = toCapabilityTool(validArtifact as CapabilityArtifact);
    // The declared format is more useful to a caller than the raw JSON type.
    expect(tool.description).toContain("Returns: balance (usd-currency)");
  });

  it("never advertises an irreversible capability", () => {
    // Replay refuses these unattended, so listing one would offer an agent a
    // call that is guaranteed to fail.
    const catalog = buildCatalog([shaped((artifact) => { artifact.capability.risk = "irreversible"; })]);
    expect(catalog).toHaveLength(0);
  });

  it("marks risk so a caller can refuse to run a mutating capability unattended", () => {
    const catalog = buildCatalog([shaped((artifact) => { artifact.capability.risk = "mutating"; })]);
    expect(catalog[0]).toMatchObject({ risk: "mutating", reference: "lookup_balance@1.0.0" });
  });
});

describe("what reaches the catalog from disk", () => {
  it("offers only approved capabilities, and only their newest approved version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-catalog-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    await store.save(shaped((artifact) => { artifact.capability.version = "1.0.0"; artifact.capability.status = "approved"; }) as never);
    await store.save(shaped((artifact) => { artifact.capability.version = "1.1.0"; artifact.capability.status = "approved"; }) as never);
    // Newer, but nobody reviewed it: an agent must not be offered this.
    await store.save(shaped((artifact) => { artifact.capability.version = "2.0.0"; artifact.capability.status = "draft"; }) as never);

    const catalog = buildCatalog(await store.approved());
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.reference).toBe("lookup_balance@1.1.0");
  });

  it("offers nothing when a capability has never been approved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-catalog-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    await store.save(shaped((artifact) => { artifact.capability.status = "draft"; }) as never);
    expect(buildCatalog(await store.approved())).toHaveLength(0);
  });
});
