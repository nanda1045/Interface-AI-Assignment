import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplayResult } from "../../src/replay/result.js";
import { RunService } from "../../src/run/service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const succeeded: ReplayResult = {
  status: "success", outputs: { balance: "$1.00" }, evidence: "runs/x",
  stability: { resolutions: 1, matched_tiers: {}, matched_strategies: {}, rescued_steps: [] }
};

function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

async function settled(): Promise<void> {
  // Two macrotask turns are enough for the chained job promises to advance.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("run service", () => {
  it("returns a queued record immediately and finishes it asynchronously", async () => {
    const service = new RunService("/nonexistent-run-root");
    const { gate, release } = deferred();
    const record = service.submit({
      runId: "replay_a", capability: "lookup",
      execute: async () => { await gate; return { result: succeeded, reference: "lookup@1.0.0" }; }
    });
    expect(record.state).toBe("queued");
    release();
    await settled();
    expect(service.get("replay_a")).toMatchObject({ state: "success", capability: "lookup@1.0.0" });
  });

  it("runs strictly one job at a time, in arrival order", async () => {
    // One operator browser is the honest model of this deployment; the queue is
    // what stops two Chromiums fighting over the same live target.
    const service = new RunService("/nonexistent-run-root");
    const first = deferred();
    const order: string[] = [];
    service.submit({ runId: "replay_1", capability: "a", execute: async () => { order.push("start-1"); await first.gate; order.push("end-1"); return { result: succeeded, reference: "a@1" }; } });
    service.submit({ runId: "replay_2", capability: "b", execute: async () => { order.push("start-2"); return { result: succeeded, reference: "b@1" }; } });
    await settled();
    expect(order).toEqual(["start-1"]);
    expect(service.get("replay_2")?.state).toBe("queued");
    first.release();
    await settled();
    expect(order).toEqual(["start-1", "end-1", "start-2"]);
  });

  it("keeps a setup error distinct from a replay that ran and failed", async () => {
    const service = new RunService("/nonexistent-run-root");
    service.submit({ runId: "replay_boom", capability: "x", execute: async () => { throw new Error("No capability named x"); } });
    await settled();
    expect(service.get("replay_boom")).toMatchObject({ state: "failed", error: "No capability named x" });
    expect(service.get("replay_boom")?.result).toBeUndefined();
  });

  it("marks and clears the waiting-for-human state only from the matching state", () => {
    const service = new RunService("/nonexistent-run-root");
    const { gate, release } = deferred();
    void gate;
    service.submit({ runId: "replay_h", capability: "hold", execute: async () => { await gate; return { result: succeeded, reference: "hold@1" }; } });
    // queued → the mark is ignored; only a running run can wait on a person.
    service.markWaitingForHuman("replay_h", true);
    expect(service.get("replay_h")?.state).toBe("queued");
    release();
  });

  it("rebuilds history from evidence directories, classifying by run-id prefix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-service-"));
    roots.push(root);
    const write = async (runId: string, startedLine: object, result?: object) => {
      await mkdir(path.join(root, runId), { recursive: true });
      await writeFile(path.join(root, runId, "log.jsonl"), `${JSON.stringify(startedLine)}\n`);
      if (result) await writeFile(path.join(root, runId, "result.json"), JSON.stringify(result));
    };
    await write("disc_20260820T1", { type: "run_started", goal: "Look up member" }, { status: "escalated" });
    await write("approval_20260820T2", { type: "run_started", capability: "lookup@1.1.0" }, { status: "success", outputs: {} });
    await write("replay_20260820T3", { type: "run_started", capability: "lookup@1.1.0" }, { status: "business_outcome", code: "MEMBER_NOT_FOUND" });
    await write("replay_20260820T4", { type: "run_started", capability: "lookup@1.1.0" });

    const service = new RunService(root);
    const listed = await service.list();
    const byId = Object.fromEntries(listed.map((record) => [record.runId, record]));
    expect(byId["disc_20260820T1"]).toMatchObject({ type: "discovery", state: "escalated", capability: "Look up member" });
    expect(byId["approval_20260820T2"]).toMatchObject({ type: "approval_validation", state: "success" });
    expect(byId["replay_20260820T3"]).toMatchObject({ type: "replay", state: "business_outcome" });
    // A run directory with no terminal result is visible, not hidden - that is
    // exactly the kind of run someone needs to find.
    expect(byId["replay_20260820T4"]).toMatchObject({ state: "failed", error: "No terminal result was recorded." });
  });
});
