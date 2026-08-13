import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunController } from "../../src/control/controller.js";
import { ControlLease } from "../../src/control/lease.js";
import { RunLogger } from "../../src/evidence/run-logger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("control transfer", () => {
  it("enforces the agent → paused → human → resuming → agent lease", () => {
    const lease = new ControlLease();
    expect(lease.agentCanAct()).toBe(true);
    lease.pause("authority required");
    expect(lease.current()).toMatchObject({ phase: "paused", holder: null });
    expect(() => lease.handBack()).toThrow(/Invalid control transition/);
    lease.takeControl("operator@example.test", new Date("2026-08-13T00:00:00.000Z"));
    expect(lease.current()).toMatchObject({ phase: "human_control", holder: "human", operator: "operator@example.test" });
    lease.handBack();
    expect(lease.current().phase).toBe("resuming");
    lease.resumeAgent();
    expect(lease.agentCanAct()).toBe(true);
  });

  it("blocks a request until the human hands the same run back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-control-"));
    roots.push(root);
    const logger = new RunLogger("run_test", root);
    await logger.initialize();
    const controller = new RunController(logger, 2_000);
    const pending = controller.request({ runId: "run_test", capability: "open_sub_account@1.0.0", goal: "Open account", step: "s5", intent: "Confirm account", reason: "Supervisor override required", requestedAction: "Enter a supervisor code" });
    await controller.lease.waitFor("paused", 500);
    const request = controller.list()[0]!;
    await controller.takeControl(request.id, "supervisor@example.test");
    expect(controller.lease.current().phase).toBe("human_control");
    await controller.handBack(request.id);
    await expect(pending).resolves.toMatchObject({ status: "handed_back", operator: "supervisor@example.test" });
    await controller.resumeAgent();
    expect(controller.summary()).toEqual({ count: 1, requestIds: [request.id] });
  });
});
