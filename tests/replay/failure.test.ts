import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunController } from "../../src/control/controller.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import type { AbstractAction, LocatorBundle, Observation, Surface, TargetSpec } from "../../src/surface/types.js";

class ErrorSurface implements Surface {
  private acted = false;

  public async observe(options?: { screenshot?: boolean }): Promise<Observation> {
    const error = this.acted;
    return { url: "http://localhost:4478/workspace/submit", title: "CorePoint", frames: [{ path: "main", url: "http://localhost:4478/workspace/submit" }], elements: error ? [{ ref: "error", frame: "main", role: "heading", name: "Unexpected Application Error", text: "Unexpected Application Error", state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.1], hints: {} }] : [{ ref: "submit", frame: "main", role: "button", name: "Submit", text: "Submit", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.1, 0.1], hints: {} }], ...(options?.screenshot ? { screenshot: "data:image/png;base64,iVBORw0KGgo=" } : {}), stateHash: error ? "error" : "ready" };
  }

  public async act(action: AbstractAction) {
    if (action.kind !== "navigate") this.acted = true;
    return { ok: true as const, url: "http://localhost:4478/workspace/submit" };
  }

  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async resolve(_target: TargetSpec) { return { ok: true as const, ref: "submit", frame: "main", matchedStrategy: target.strategies[0]!, tier: 1, attempts: [{ strategy: target.strategies[0]!, matched: 1 }] }; }
  public async read() { return { text: "" }; }
  public async readTable() { return { headers: [], rows: [] }; }
  public async snapshotDom() { return "<html><h1>Unexpected Application Error</h1><p>member 4521</p></html>"; }
  public async close() {}
}

// Sits on a screen the escalation detector recognises, so replay asks for a
// human on the very first observation and then waits for one who never arrives.
class SupervisorWallSurface implements Surface {
  public async observe(options?: { screenshot?: boolean }): Promise<Observation> {
    return {
      url: "http://localhost:4478/workspace/submit", title: "CorePoint", frames: [{ path: "main", url: "http://localhost:4478/workspace/submit" }],
      elements: [{ ref: "wall", frame: "main", role: "heading", name: "Supervisor override required", text: "Supervisor override required", state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.1], hints: {} }],
      ...(options?.screenshot ? { screenshot: "data:image/png;base64,iVBORw0KGgo=" } : {}),
      stateHash: "wall"
    };
  }

  public async act() { return { ok: true as const, url: "http://localhost:4478/workspace/submit" }; }
  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async resolve(_target: TargetSpec) { return { ok: false as const, reason: "target_not_found" as const, attempts: [] }; }
  public async read() { return { text: "" }; }
  public async readTable() { return { headers: [], rows: [] }; }
  public async snapshotDom() { return "<html><h1>Supervisor override required</h1></html>"; }
  public async close() {}
}

// Sits on the sign-on screen itself - the legitimate workplace of an
// unauthenticated sign-on capability and a session_lost path for everyone else.
class SignOnScreenSurface implements Surface {
  public async observe(options?: { screenshot?: boolean }): Promise<Observation> {
    return {
      url: "http://localhost:4478/login", title: "Sign On", frames: [{ path: "main", url: "http://localhost:4478/login" }],
      elements: [{ ref: "submit", frame: "main", role: "button", name: "Submit", text: "Submit", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.1, 0.1], hints: {} }],
      ...(options?.screenshot ? { screenshot: "data:image/png;base64,iVBORw0KGgo=" } : {}),
      stateHash: "signon"
    };
  }

  public async act() { return { ok: true as const, url: "http://localhost:4478/login" }; }
  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async resolve(_target: TargetSpec) { return { ok: true as const, ref: "submit", frame: "main", matchedStrategy: target.strategies[0]!, tier: 1, attempts: [{ strategy: target.strategies[0]!, matched: 1 }] }; }
  public async read() { return { text: "done" }; }
  public async readTable() { return { headers: [], rows: [] }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

const target = { frame: "main", strategies: [{ kind: "role_name" as const, role: "button", name: "Submit", frame: "main", unique: true as const, confidence: 0.9 }] };
const artifact: CapabilityArtifact = {
  schema_version: "1.0",
  capability: { id: "test_error", version: "1.0.0", title: "Test error", description: "Exercises error classification.", app: { id: "corepoint", vendor: "CorePoint", ui_version_range: ">=3.1" }, risk: "mutating", status: "approved", provenance: { discovered_by: "test", discovery_run: "test", recorded_at: "2026-08-13T00:00:00.000Z", approved_by: "reviewer", approved_at: "2026-08-13T00:01:00.000Z" } },
  inputs: { type: "object", required: ["member_id"], properties: { member_id: { type: "string", sensitive: true } } },
  outputs: { type: "object", required: ["result"], properties: { result: { type: "string" } } },
  entry: { url: "http://localhost:4478/workspace/submit", preconditions: [] },
  steps: [{ id: "s1", intent: "Submit the operation", action: { kind: "click" }, target, wait: { readyWhen: "target_resolvable", timeout_ms: 100 }, postconditions: [] }],
  checkpoint: { assert: [{ kind: "text_visible", pattern: "complete" }] },
  extract: [{ output: "result", from: target, parse: "text" }], outcomes: [], recovery: [],
  policy: { allowed_origins: ["http://localhost:4478"], allowed_actions: ["navigate", "click"], max_duration_ms: 1_000 }
};
const config: PolicyConfig = { allowed_origins: ["http://localhost:4478"], allowed_path_patterns: ["^/workspace(/.*)?$"], allowed_actions: ["navigate", "click"], max_steps: 5, max_duration_ms: 1_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("session_lost and the unauthenticated capability", () => {
  const signOnArtifact = (preconditions: CapabilityArtifact["entry"]["preconditions"]): CapabilityArtifact => ({
    ...structuredClone(artifact),
    capability: { ...structuredClone(artifact.capability), risk: "read_only" },
    entry: { url: "http://localhost:4478/login", preconditions },
    checkpoint: { assert: [{ kind: "text_visible", pattern: "Submit" }] },
    policy: { ...artifact.policy }
  });
  const loginConfig: PolicyConfig = { ...config, allowed_path_patterns: ["^/(login|workspace)(/.*)?$"] };

  it("does not fail a capability with no authenticated precondition at its own front door", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-replay-"));
    roots.push(root);
    const result = await replay({ artifact: signOnArtifact([]), params: { member_id: "4521" }, surface: new SignOnScreenSurface(), policy: new PolicyEngine(loginConfig), logger: new RunLogger("replay_signon", root) });
    expect(result).toMatchObject({ status: "success", outputs: { result: "done" } });
  });

  it("still classifies the sign-on screen as session_lost when the capability requires authentication", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-replay-"));
    roots.push(root);
    const result = await replay({ artifact: signOnArtifact([{ kind: "authenticated", via: "test session" }]), params: { member_id: "4521" }, surface: new SignOnScreenSurface(), policy: new PolicyEngine(loginConfig), logger: new RunLogger("replay_signon_auth", root) });
    expect(result).toMatchObject({ status: "failure", failure: { class: "session_lost" } });
  });
});

describe("replay hard failures", () => {
  it("reports a timeout with a debug bundle when no operator answers the handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-expired-"));
    roots.push(root);
    const logger = new RunLogger("replay_expired", root);
    await logger.initialize();
    // A run that pauses for a human it never gets must still terminate as a
    // reportable result, not an unhandled rejection with no evidence written.
    const handoff = new RunController(logger, 25);
    const escalating: CapabilityArtifact = { ...artifact, steps: [{ ...artifact.steps[0]!, intent: "Confirm with supervisor approval" }] };
    const result = await replay({ artifact: escalating, params: { member_id: "4521" }, surface: new SupervisorWallSurface(), policy: new PolicyEngine(config), logger, handoff });
    expect(result).toMatchObject({ status: "failure", failure: { class: "timeout", step: "s1", domSnapshot: "failure/dom.html" } });
    expect(handoff.lease.current().phase).toBe("aborted");
    await readFile(path.join(logger.directory, "result.json"), "utf8");
  });

  it("returns an app_error with a redacted DOM debug bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-failure-"));
    roots.push(root);
    const logger = new RunLogger("replay_error", root);
    const result = await replay({ artifact, params: { member_id: "4521" }, surface: new ErrorSurface(), policy: new PolicyEngine(config), logger });
    // The artifact under test is `mutating`, so the caller is told to establish
    // whether the work landed rather than to repeat it.
    expect(result).toMatchObject({ status: "failure", failure: { class: "app_error", disposition: "verify_then_retry", step: "s1", domSnapshot: "failure/dom.html" } });
    const dom = await readFile(path.join(logger.directory, "failure/dom.html"), "utf8");
    expect(dom).not.toContain("4521");
    expect(dom).toContain("«redacted»");
  });
});
