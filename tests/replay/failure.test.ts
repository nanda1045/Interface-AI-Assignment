import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import type { AbstractAction, LocatorBundle, Observation, Surface, TargetSpec } from "../../src/surface/types.js";

class ErrorSurface implements Surface {
  private acted = false;

  public async observe(options?: { screenshot?: boolean }): Promise<Observation> {
    const error = this.acted;
    return { url: "http://localhost:4478/workspace/submit", title: "CorePoint", frames: ["main"], elements: error ? [{ ref: "error", frame: "main", role: "heading", name: "Unexpected Application Error", text: "Unexpected Application Error", state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.1], hints: {} }] : [{ ref: "submit", frame: "main", role: "button", name: "Submit", text: "Submit", state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.1, 0.1], hints: {} }], ...(options?.screenshot ? { screenshot: "data:image/png;base64,iVBORw0KGgo=" } : {}), stateHash: error ? "error" : "ready" };
  }

  public async act(action: AbstractAction) {
    if (action.kind !== "navigate") this.acted = true;
    return { ok: true as const, url: "http://localhost:4478/workspace/submit" };
  }

  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async resolve(_target: TargetSpec) { return { ok: true as const, ref: "submit", frame: "main", matchedStrategy: target.strategies[0]!, tier: 1, attempts: [{ strategy: target.strategies[0]!, matched: 1 }] }; }
  public async read() { return { text: "" }; }
  public async snapshotDom() { return "<html><h1>Unexpected Application Error</h1><p>member 4521</p></html>"; }
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

describe("replay hard failures", () => {
  it("returns an app_error with a redacted DOM debug bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-failure-"));
    roots.push(root);
    const logger = new RunLogger("replay_error", root);
    const result = await replay({ artifact, params: { member_id: "4521" }, surface: new ErrorSurface(), policy: new PolicyEngine(config), logger });
    expect(result).toMatchObject({ status: "failure", failure: { class: "app_error", step: "s1", domSnapshot: "failure/dom.html" } });
    const dom = await readFile(path.join(logger.directory, "failure/dom.html"), "utf8");
    expect(dom).not.toContain("4521");
    expect(dom).toContain("«redacted»");
  });
});
