import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "../../src/api/server.js";
import { ArtifactStore } from "../../src/artifact/store.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunService } from "../../src/run/service.js";
import type { CapabilityRunOptions } from "../../src/run/runner.js";
import type { RouteDecision, RouteOptions } from "../../src/chat/router.js";

type ApiChatRoute = (options: RouteOptions) => Promise<RouteDecision>;
import { validArtifact } from "../artifact/schema.test.js";
import type { ReplayResult } from "../../src/replay/result.js";

// A minimal successful replay result for the fake runner.
const okResult = { status: "success", outputs: { balance: "$10.00" }, stability: { resolutions: 1, matched_strategies: { attr_css: 1 }, matched_tiers: { 1: 1 } } } as unknown as ReplayResult;

function approvedArtifact(overrides: Partial<CapabilityArtifact["capability"]>): CapabilityArtifact {
  const base = structuredClone(validArtifact) as CapabilityArtifact;
  base.capability = { ...base.capability, status: "approved", ...overrides } as CapabilityArtifact["capability"];
  base.capability.provenance = { ...base.capability.provenance, approved_by: "reviewer", approved_at: "2026-08-13T00:00:00.000Z" };
  return base;
}

describe("adaptation API", () => {
  let root: string;
  let store: ArtifactStore;
  let runs: RunService;
  let server: Server;
  let base: string;
  let calls: CapabilityRunOptions[];

  async function boot(demoMode = false, chatRoute?: ApiChatRoute) {
    const execute = async (options: CapabilityRunOptions) => {
      calls.push(options);
      return { result: okResult, runId: options.runId, reference: options.reference };
    };
    const built = createApiApp({ store, runs, runRoot: path.join(root, "runs"), demoMode, execute, ...(chatRoute ? { chatRoute } : {}) });
    server = built.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "api-test-"));
    store = new ArtifactStore(path.join(root, "artifacts"));
    runs = new RunService(path.join(root, "runs"));
    calls = [];
    // Approved read-only, mutating, irreversible; plus a draft that must never surface.
    await store.write(approvedArtifact({ id: "read_cap", version: "1.0.0", risk: "read_only" }));
    await store.write(approvedArtifact({ id: "mutate_cap", version: "1.0.0", risk: "mutating" }));
    // Irreversible needs a human_required final step; reuse the read step shape but flag it.
    const irr = approvedArtifact({ id: "irr_cap", version: "1.0.0", risk: "irreversible" });
    irr.steps = [{ ...irr.steps[0]!, id: "s1", execution: "human_required" }];
    await store.write(irr);
    const draft = structuredClone(validArtifact) as CapabilityArtifact;
    draft.capability = { ...draft.capability, id: "draft_cap", version: "1.0.0", status: "draft" };
    await store.write(draft);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function post(pathname: string, body: unknown) {
    const response = await fetch(`${base}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  async function get(pathname: string) {
    const response = await fetch(`${base}${pathname}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("lists only approved capabilities and flags the irreversible one", async () => {
    await boot();
    const { status, body } = await get("/api/capabilities");
    expect(status).toBe(200);
    const names = (body.capabilities as { tool: { name: string }; requires_human: boolean }[]).map((entry) => entry.tool.name);
    expect(names).toEqual(["irr_cap", "mutate_cap", "read_cap"]);
    expect(names).not.toContain("draft_cap");
    const irr = (body.capabilities as { tool: { name: string }; requires_human: boolean }[]).find((entry) => entry.tool.name === "irr_cap");
    expect(irr?.requires_human).toBe(true);
  });

  it("runs a read-only capability and reports 202 with a status url", async () => {
    await boot();
    const { status, body } = await post("/api/runs", { capability: "read_cap", inputs: { member_id: "4521" } });
    expect(status).toBe(202);
    expect(body.status).toBe("queued");
    expect(body.status_url).toBe(`/api/runs/${body.run_id}`);
    // Let the queued job run, then confirm it reached the (fake) runner.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headless).toBe(true);
    const record = await get(`/api/runs/${body.run_id}`);
    expect(record.body.state).toBe("success");
  });

  it("rejects an unknown capability, unknown params, and missing required params", async () => {
    await boot();
    expect((await post("/api/runs", { capability: "nope", inputs: {} })).status).toBe(404);
    expect((await post("/api/runs", { capability: "read_cap", inputs: { member_id: "4521", surprise: 1 } })).status).toBe(400);
    expect((await post("/api/runs", { capability: "read_cap", inputs: {} })).status).toBe(400);
  });

  it("rejects an unknown envelope field", async () => {
    await boot();
    const { status, body } = await post("/api/runs", { capability: "read_cap", inputs: { member_id: "4521" }, sudo: true });
    expect(status).toBe(400);
    expect(JSON.stringify(body.details)).toContain("sudo");
  });

  it("never resolves a draft capability", async () => {
    await boot();
    expect((await post("/api/runs", { capability: "draft_cap", inputs: { member_id: "4521" } })).status).toBe(404);
  });

  it("gates an ordinary mutation behind envelope confirmation", async () => {
    await boot();
    const denied = await post("/api/runs", { capability: "mutate_cap", inputs: { member_id: "4521" } });
    expect(denied.status).toBe(409);
    expect(denied.body.status).toBe("confirmation_required");
    expect(calls).toHaveLength(0);

    const confirmed = await post("/api/runs", { capability: "mutate_cap", inputs: { member_id: "4521" }, confirm_mutation: true });
    expect(confirmed.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls[0]?.confirmMutations).toBe(true);
  });

  it("refuses to run an irreversible capability unattended", async () => {
    await boot();
    const { status, body } = await post("/api/runs", { capability: "irr_cap", inputs: { member_id: "4521" } });
    expect(status).toBe(409);
    expect(body.requires_human).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("runs an irreversible capability as an attended, headed handoff run", async () => {
    await boot();
    const { status } = await post("/api/runs", { capability: "irr_cap", inputs: { member_id: "4521" }, attended: true });
    expect(status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Attended irreversible starts headed with handoff so a human completes it.
    expect(calls[0]?.headless).toBe(false);
    expect(calls[0]?.handoff).toBe(true);
    expect(calls[0]?.confirmMutations).toBe(true);
  });

  it("accepts fault_injection only in demo mode and passes it to the runner", async () => {
    await boot(false);
    expect((await post("/api/runs", { capability: "read_cap", inputs: { member_id: "4521" }, fault_injection: "timeout" })).status).toBe(403);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await boot(true);
    const { status, body } = await post("/api/runs", { capability: "read_cap", inputs: { member_id: "4521" }, fault_injection: "timeout" });
    expect(status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls[0]?.faultInjection).toBe("timeout");
    void body;
  });

  it("maps a duplicate idempotency key to the same run without running twice", async () => {
    await boot();
    const first = await post("/api/runs", { capability: "read_cap", inputs: { member_id: "4521" }, idempotency_key: "abc" });
    expect(first.status).toBe(202);
    const second = await post("/api/runs", { capability: "read_cap", inputs: { member_id: "4521" }, idempotency_key: "abc" });
    expect(second.status).toBe(200);
    expect(second.body.run_id).toBe(first.body.run_id);
    expect(second.body.idempotent_replay).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
  });

  it("serves run events and refuses an invalid run id", async () => {
    await boot();
    const runDir = path.join(root, "runs", "replay_evttest");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "log.jsonl"), `${JSON.stringify({ type: "run_started", capability: "read_cap@1.0.0" })}\n`, "utf8");
    const events = await get("/api/runs/replay_evttest/events");
    expect(events.status).toBe(200);
    expect((events.body.events as unknown[]).length).toBe(1);
    expect((await get("/api/runs/..%2Fescape/events")).status).toBe(400);
  });

  it("contains evidence downloads within the run directory", async () => {
    await boot();
    const runDir = path.join(root, "runs", "replay_evidence");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({ status: "success" }), "utf8");
    const secret = path.join(root, "runs", "secret.txt");
    await writeFile(secret, "top secret", "utf8");

    const ok = await fetch(`${base}/api/runs/replay_evidence/evidence/result.json`);
    expect(ok.status).toBe(200);
    // A traversal file name is rejected by the segment schema (400), never served.
    const escape = await fetch(`${base}/api/runs/replay_evidence/evidence/..%2Fsecret.txt`);
    expect(escape.status).toBe(400);
    expect(await escape.text()).not.toContain("top secret");
  });

  it("404s interventions for a run with no registered controller", async () => {
    await boot();
    expect((await post("/api/interventions/replay_none/take", { operator: "me" })).status).toBe(404);
    expect((await post("/api/interventions/replay_none/hand-back", {})).status).toBe(404);
  });

  it("reports the chat endpoint unconfigured without a key or injected router", async () => {
    await boot();
    expect((await post("/api/chat", { message: "hi" })).status).toBe(503);
  });

  it("routes a chat message through to a formatted answer, executing the shared runner", async () => {
    await boot(false, async () => ({ kind: "capability", name: "read_cap", inputs: { member_id: "4521" } }));
    const { status, body } = await post("/api/chat", { message: "balance for 4521" });
    expect(status).toBe(200);
    expect(body.action).toBe("answered");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headless).toBe(true);
  });

  it("gates a mutating chat action behind confirmation", async () => {
    await boot(false, async () => ({ kind: "capability", name: "mutate_cap", inputs: { member_id: "4521" } }));
    const denied = await post("/api/chat", { message: "update it" });
    expect(denied.body.action).toBe("confirmation_required");
    expect(calls).toHaveLength(0);
    const confirmed = await post("/api/chat", { message: "update it", confirm: true });
    expect(confirmed.body.action).toBe("answered");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls[0]?.confirmMutations).toBe(true);
  });

  it("serves the dashboard page from the same server", async () => {
    await boot();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("MERIDIAN Automation Dashboard");
    expect(html).toContain("/api/runs");
    // The chat panel posts to /api/chat and carries the confirm-to-run control.
    expect(html).toContain("/api/chat");
    expect(html).toContain("chatinput");
  });

  it("lists a run's evidence files including one subdirectory level", async () => {
    await boot();
    const runDir = path.join(root, "runs", "replay_ev");
    await mkdir(path.join(runDir, "steps"), { recursive: true });
    await writeFile(path.join(runDir, "result.json"), "{}", "utf8");
    await writeFile(path.join(runDir, "steps", "01.png"), "x", "utf8");
    const { status, body } = await get("/api/runs/replay_ev/evidence");
    expect(status).toBe(200);
    expect((body.files as string[]).sort()).toEqual(["result.json", "steps/01.png"]);
    // The subpath download works and stays contained.
    expect((await fetch(`${base}/api/runs/replay_ev/evidence/steps/01.png`)).status).toBe(200);
  });

  it("aggregates the intervention queue across registered controllers", async () => {
    await boot();
    const queue = await get("/api/interventions");
    expect(queue.status).toBe(200);
    expect(Array.isArray(queue.body)).toBe(true);
  });
});
