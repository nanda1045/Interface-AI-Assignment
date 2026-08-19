import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintParams } from "../../src/artifact/distill.js";
import { applyOverlay } from "../../src/artifact/overlay.js";
import { ArtifactStore } from "../../src/artifact/store.js";
import { validArtifact } from "./schema.test.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("artifact governance and tenant overlays", () => {
  it("persists, loads, and approves an artifact with reviewer provenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-artifacts-"));
    temporaryDirectories.push(root);
    const store = new ArtifactStore(root);
    await store.save(validArtifact as never);
    const evidence = { run: "replay_validation", params: { member_id: "8832" }, matchedTiers: { "1": 3 } };
    const approved = await store.approve("lookup_balance@1.0.0", "reviewer@example.test", evidence, new Date("2026-08-13T12:00:00.000Z"));
    expect(approved.capability).toMatchObject({ status: "approved", provenance: { approved_by: "reviewer@example.test", approved_at: "2026-08-13T12:00:00.000Z" } });
    expect(approved.capability.provenance.validation).toMatchObject({ run: "replay_validation", outcome: "success", matched_tiers: { "1": 3 } });
    expect((await store.list())).toEqual(["lookup_balance@1.0.0.json"]);
  });

  it("refuses approval that replayed the discovery invocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-artifacts-"));
    temporaryDirectories.push(root);
    const store = new ArtifactStore(root);
    const recorded = structuredClone(validArtifact) as { capability: { provenance: Record<string, unknown> } };
    recorded.capability.provenance.input_fingerprint = fingerprintParams({ member_id: "4521" });
    await store.save(recorded as never);
    await expect(store.approve("lookup_balance@1.0.0", "reviewer@example.test", { run: "r", params: { member_id: "4521" }, matchedTiers: {} }))
      .rejects.toThrow(/different invocation/);
    await expect(store.approve("lookup_balance@1.0.0", "reviewer@example.test", { run: "r", params: { member_id: "8832" }, matchedTiers: {} }))
      .resolves.toMatchObject({ capability: { status: "approved" } });
  });

  it("refuses approval by the identity that recorded the capability", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-artifacts-"));
    temporaryDirectories.push(root);
    const store = new ArtifactStore(root);
    await store.save(validArtifact as never);
    const discoverer = (validArtifact as { capability: { provenance: { discovered_by: string } } }).capability.provenance.discovered_by;
    await expect(store.approve("lookup_balance@1.0.0", discoverer, { run: "r", params: { member_id: "8832" }, matchedTiers: {} }))
      .rejects.toThrow(/cannot be the identity that recorded/);
  });

  it("specializes only declared tenant seams and revalidates the result", () => {
    const parsed = structuredClone(validArtifact) as never;
    const overlaid = applyOverlay(parsed, {
      schema_version: "1.0",
      capability: "lookup_balance",
      tenant: "b",
      entry_url: "http://localhost:4479/operations",
      step_targets: { s1: { frame: "workarea", strategies: [{ kind: "attr_css", value: "input[name='f_ahid']", frame: "workarea", unique: true, confidence: 0.7 }] } }
    });
    expect(overlaid.entry.url).toBe("http://localhost:4479/operations");
    expect(overlaid.policy.allowed_origins).toEqual(["http://localhost:4479"]);
    expect(overlaid.steps[0]?.target?.strategies[0]).toMatchObject({ kind: "attr_css", value: "input[name='f_ahid']" });
    expect(overlaid.capability.id).toBe("lookup_balance");
  });
});
