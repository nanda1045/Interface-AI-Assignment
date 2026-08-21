import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evalManifestSchema, loadEvalManifest } from "../../src/eval/manifest.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function write(contents: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-manifest-"));
  roots.push(root);
  const file = path.join(root, "eval.yaml");
  await writeFile(file, contents, "utf8");
  return file;
}

describe("eval manifest", () => {
  it("loads auth and per-capability safe invocations", async () => {
    const file = await write("auth: teller\ncases:\n  find_member_by_number:\n    member_number: \"100987\"\n");
    const manifest = await loadEvalManifest(file);
    expect(manifest.auth).toBe("teller");
    expect(manifest.cases.find_member_by_number).toEqual({ member_number: "100987" });
  });

  it("rejects unknown top-level keys and non-string parameters", () => {
    expect(evalManifestSchema.safeParse({ cases: {}, extra: 1 }).success).toBe(false);
    expect(evalManifestSchema.safeParse({ cases: { x: { n: 5 } } }).success).toBe(false);
  });
});
