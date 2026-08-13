import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const approved = await store.approve("lookup_balance@1.0.0", "reviewer@example.test", new Date("2026-08-13T12:00:00.000Z"));
    expect(approved.capability).toMatchObject({ status: "approved", provenance: { approved_by: "reviewer@example.test", approved_at: "2026-08-13T12:00:00.000Z" } });
    expect((await store.list())).toEqual(["lookup_balance@1.0.0.json"]);
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
