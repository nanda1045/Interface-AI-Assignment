import { mkdtemp, mkdir, readdir, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepScreenshots } from "../../src/evidence/retention.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "retention-"));
  roots.push(root);
  return root;
}

describe("screenshot retention sweep", () => {
  it("deletes screenshots older than the window and keeps recent ones and non-images", async () => {
    const root = await makeRoot();
    const stepsDir = path.join(root, "replay_x", "steps");
    await mkdir(stepsDir, { recursive: true });
    await writeFile(path.join(stepsDir, "old.png"), "old");
    await writeFile(path.join(stepsDir, "new.png"), "new");
    await writeFile(path.join(root, "replay_x", "log.jsonl"), "{}"); // must never be touched
    // Age the old screenshot two hours back.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(stepsDir, "old.png"), old, old);

    const removed = await sweepScreenshots(root, 60 * 60 * 1000); // 1h window
    expect(removed).toBe(1);
    expect((await readdir(stepsDir)).sort()).toEqual(["new.png"]);
    // The redacted log survives - retention touches images only.
    expect(await readdir(path.join(root, "replay_x"))).toContain("log.jsonl");
  });

  it("sweeps the failure directory too and ignores a missing run root", async () => {
    const root = await makeRoot();
    const failDir = path.join(root, "replay_y", "failure");
    await mkdir(failDir, { recursive: true });
    await writeFile(path.join(failDir, "final.png"), "x");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(failDir, "final.png"), old, old);
    expect(await sweepScreenshots(root, 60 * 60 * 1000)).toBe(1);
    // No throw on a directory that does not exist.
    expect(await sweepScreenshots(path.join(root, "nope"), 1000)).toBe(0);
  });
});
