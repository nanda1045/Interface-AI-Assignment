import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/store.js";
import { validArtifact } from "./schema.test.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type Artifact = typeof validArtifact & { capability: { version: string; status: string } };

async function storeWith(...versions: { version: string; status: "draft" | "approved" }[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-resolve-"));
  roots.push(root);
  const store = new ArtifactStore(root);
  for (const { version, status } of versions) {
    const artifact = structuredClone(validArtifact) as Artifact;
    artifact.capability.version = version;
    artifact.capability.status = status;
    await store.save(artifact as never);
  }
  return store;
}

describe("resolving a capability reference", () => {
  it("gives a bare name the newest approved version", async () => {
    const store = await storeWith(
      { version: "1.0.0", status: "approved" },
      { version: "1.1.0", status: "approved" },
      { version: "2.0.0", status: "approved" }
    );
    expect(await store.resolve("lookup_balance")).toMatchObject({ version: "2.0.0", reference: "lookup_balance@2.0.0" });
  });

  it("skips a newer draft rather than handing back something unreviewed", async () => {
    // The point of resolution: an agent asking by name cannot be given a
    // capability nobody signed off, however recent it is.
    const store = await storeWith(
      { version: "1.1.0", status: "approved" },
      { version: "1.2.0", status: "draft" }
    );
    expect(await store.resolve("lookup_balance")).toMatchObject({ version: "1.1.0" });
  });

  it("honours a major or minor range", async () => {
    const store = await storeWith(
      { version: "1.1.0", status: "approved" },
      { version: "1.2.0", status: "approved" },
      { version: "2.0.0", status: "approved" }
    );
    expect(await store.resolve("lookup_balance@1")).toMatchObject({ version: "1.2.0" });
    expect(await store.resolve("lookup_balance@1.x")).toMatchObject({ version: "1.2.0" });
    expect(await store.resolve("lookup_balance@1.1")).toMatchObject({ version: "1.1.0" });
  });

  it("lets an exact pin reach a draft, because you must be able to replay what you just recorded", async () => {
    const store = await storeWith({ version: "1.0.0", status: "draft" });
    expect(await store.resolve("lookup_balance@1.0.0")).toMatchObject({ version: "1.0.0" });
    await expect(store.load("lookup_balance@1.0.0")).resolves.toMatchObject({ capability: { status: "draft" } });
  });

  it("refuses a bare name when nothing is approved, and says how to proceed", async () => {
    const store = await storeWith({ version: "1.0.0", status: "draft" });
    await expect(store.resolve("lookup_balance")).rejects.toThrow(/No approved version.*pin an exact version/s);
  });

  it("lets approval alone resolve a draft by name", async () => {
    // Otherwise a capability could never reach its first approval.
    const store = await storeWith({ version: "1.0.0", status: "draft" });
    expect(await store.resolve("lookup_balance", { includeDrafts: true })).toMatchObject({ version: "1.0.0" });
  });

  it("names what exists when a reference misses", async () => {
    const store = await storeWith({ version: "1.0.0", status: "approved" });
    await expect(store.resolve("lookup_balance@9.9.9")).rejects.toThrow(/Versions of lookup_balance: 1\.0\.0/);
    await expect(store.resolve("lookup_balance@3")).rejects.toThrow(/No version of lookup_balance matching 3/);
    await expect(store.resolve("no_such_capability")).rejects.toThrow(/No capability named no_such_capability/);
  });

  it("orders versions numerically rather than as text", async () => {
    // "10.0.0" sorts before "9.0.0" as a string; the newest is 10.
    const store = await storeWith(
      { version: "9.0.0", status: "approved" },
      { version: "10.0.0", status: "approved" }
    );
    expect(await store.resolve("lookup_balance")).toMatchObject({ version: "10.0.0" });
    expect(await store.latestVersion("lookup_balance")).toBe("10.0.0");
  });
});
