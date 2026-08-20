import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import type { AbstractAction, LocatorBundle, Observation, Surface, TargetSpec } from "../../src/surface/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// Models MERIDIAN's maintenance interstitial: the first entry lands on the
// maintenance page, its Continue link exits to the menu (NOT back to the
// interrupted screen), and only a fresh entry navigation reaches the form.
class MaintenanceSurface implements Surface {
  public entries = 0;
  public navUrls: string[] = [];
  private screen: "maintenance" | "menu" | "form" | "done" = "maintenance";

  public async observe(): Promise<Observation> {
    const text =
      this.screen === "maintenance" ? "SCHEDULED MAINTENANCE IN PROGRESS Continue" :
      this.screen === "menu" ? "MAIN MENU" :
      this.screen === "form" ? "MEMBER INQUIRY Value" : "RESULT READY value-cell";
    return {
      url: `https://target.test/${this.screen}`, title: "Meridian",
      frames: [{ path: "main", url: `https://target.test/${this.screen}` }],
      elements: [
        { ref: `${this.screen}-text`, frame: "main", role: "heading", name: text, text, state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.1], hints: {} },
        // Only the maintenance page offers Continue and only the form offers
        // Search - a menu with a Search button would let a lost run limp on.
        { ref: `${this.screen}-target`, frame: "main", role: "button", name: this.screen === "maintenance" ? "Continue" : this.screen === "form" ? "Search" : "Nothing Useful", text: this.screen === "maintenance" ? "Continue" : this.screen === "form" ? "Search" : "Nothing Useful", state: { visible: true, enabled: true }, bboxPct: [0, 0.2, 0.2, 0.05], hints: {} }
      ],
      stateHash: `${this.screen}-${this.entries}`
    };
  }

  public async act(action: AbstractAction) {
    if (action.kind === "navigate") {
      this.entries += 1;
      this.navUrls.push(action.url);
      // The maintenance window has cleared by the second entry.
      this.screen = this.entries === 1 ? "maintenance" : "form";
    } else if (action.kind === "click" && this.screen === "maintenance") {
      this.screen = "menu"; // Continue exits the flow - the trap this test exists for.
    } else if (action.kind === "click" && this.screen === "form") {
      this.screen = "done";
    }
    return { ok: true as const, url: `https://target.test/${this.screen}` };
  }

  public async resolve(target: TargetSpec) {
    const first = target.strategies[0];
    const wanted = first?.kind === "text" ? first.value : first?.kind === "role_name" ? first.name : "";
    const observation = await this.observe();
    const found = observation.elements.find((element) => element.name === wanted);
    if (!found) return { ok: false as const, reason: "target_not_found" as const, attempts: [] };
    return { ok: true as const, ref: found.ref, frame: "main", matchedStrategy: target.strategies[0]!, tier: 1, attempts: [] };
  }

  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async read() { return { text: "value" }; }
  public async readTable() { return { headers: [], rows: [], hasHeaderRow: false }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

const searchTarget = { frame: "main", strategies: [{ kind: "role_name" as const, role: "button", name: "Search", frame: "main", unique: true as const, confidence: 0.9 }] };
const continueTarget = { strategies: [{ kind: "text" as const, value: "Continue", control: "a", frame: "main", unique: true as const, confidence: 0.8 }] };
const resultTarget = { frame: "main", strategies: [{ kind: "role_name" as const, role: "heading", name: "RESULT READY value-cell", frame: "main", unique: true as const, confidence: 0.9 }] };

function artifactWith(effect: "restart_capability" | undefined): CapabilityArtifact {
  return {
    schema_version: "1.0",
    capability: { id: "maintenance_case", version: "1.0.0", title: "Maintenance case", description: "Exercises bounded recovery effects.", app: { id: "meridian-core", vendor: "Cornerstone", ui_version_range: ">=4 <5" }, risk: "read_only", status: "approved", provenance: { discovered_by: "test", discovery_run: "test", recorded_at: "2026-08-20T00:00:00.000Z", approved_by: "reviewer", approved_at: "2026-08-20T00:01:00.000Z" } },
    inputs: { type: "object", required: [], properties: {} },
    outputs: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    entry: { url: "https://target.test/entry", preconditions: [] },
    steps: [{ id: "s1", intent: "Run the search", action: { kind: "click" }, target: searchTarget, wait: { readyWhen: "target_resolvable", timeout_ms: 300 }, postconditions: [] }],
    checkpoint: { assert: [{ kind: "text_visible", pattern: "RESULT READY" }] },
    extract: [{ output: "value", from: resultTarget, parse: "text" }],
    outcomes: [],
    recovery: [{ id: "maintenance_continue", condition: { kind: "text_visible", pattern: "SCHEDULED MAINTENANCE" }, action: { kind: "click", target: continueTarget }, max_attempts: 2, ...(effect ? { effect } : {}) }],
    policy: { allowed_origins: ["https://target.test"], allowed_actions: ["navigate", "click"], max_duration_ms: 5_000 }
  };
}

const config: PolicyConfig = { allowed_origins: ["https://target.test"], allowed_path_patterns: ["^/.*$"], allowed_actions: ["navigate", "click"], max_steps: 10, max_duration_ms: 5_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };

async function run(artifact: CapabilityArtifact, surface: Surface, extra: { faultInjection?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-recovery-"));
  roots.push(root);
  const logger = new RunLogger("replay_recovery", root);
  return replay({ artifact, params: {}, surface, policy: new PolicyEngine(config), logger, ...extra });
}

// A mutating flow: clicking "Confirm Payment" posts something, and THEN the
// maintenance interstitial appears. Re-entering would post it again.
class MutationThenMaintenanceSurface implements Surface {
  public entries = 0;
  private screen: "form" | "maintenance" = "form";

  public async observe(): Promise<Observation> {
    const text = this.screen === "form" ? "PAYMENT FORM Confirm Payment" : "SCHEDULED MAINTENANCE IN PROGRESS Continue";
    return {
      url: `https://target.test/${this.screen}`, title: "Meridian",
      frames: [{ path: "main", url: `https://target.test/${this.screen}` }],
      elements: [
        { ref: "text", frame: "main", role: "heading", name: text, text, state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.1], hints: {} },
        { ref: "button", frame: "main", role: "button", name: this.screen === "form" ? "Confirm Payment" : "Continue", text: this.screen === "form" ? "Confirm Payment" : "Continue", state: { visible: true, enabled: true }, bboxPct: [0, 0.2, 0.2, 0.05], hints: {} }
      ],
      stateHash: `${this.screen}-${this.entries}`
    };
  }

  public async act(action: AbstractAction) {
    if (action.kind === "navigate") this.entries += 1;
    // The mutating click "posts" and the maintenance window swallows the result.
    else if (action.kind === "click" && this.screen === "form") this.screen = "maintenance";
    return { ok: true as const, url: `https://target.test/${this.screen}` };
  }

  public async resolve(target: TargetSpec) {
    const first = target.strategies[0];
    const wanted = first?.kind === "text" ? first.value : first?.kind === "role_name" ? first.name : "";
    const observation = await this.observe();
    const found = observation.elements.find((element) => element.name === wanted);
    if (!found) return { ok: false as const, reason: "target_not_found" as const, attempts: [] };
    return { ok: true as const, ref: found.ref, frame: "main", matchedStrategy: first!, tier: 1, attempts: [] };
  }

  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async read() { return { text: "value" }; }
  public async readTable() { return { headers: [], rows: [], hasHeaderRow: false }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

describe("bounded recovery effects", () => {
  it("restart_capability re-enters from the entry URL and completes", async () => {
    const surface = new MaintenanceSurface();
    const result = await run(artifactWith("restart_capability"), surface);
    expect(result).toMatchObject({ status: "success", outputs: { value: "value" } });
    // One entry that hit maintenance, one clean re-entry after the recovery.
    expect(surface.entries).toBe(2);
  });

  it("applies a demo fault to the first entry only, so a restart re-enters clean", async () => {
    // Fault injection is one-shot. If the injected parameter rode along on every
    // restart, a transient interstitial would re-trigger until recovery gave up.
    const surface = new MaintenanceSurface();
    const result = await run(artifactWith("restart_capability"), surface, { faultInjection: "maintenance" });
    expect(result).toMatchObject({ status: "success" });
    expect(surface.navUrls[0]).toContain("inject=maintenance");
    expect(surface.navUrls[1]).not.toContain("inject=");
  });

  it("refuses to restart once a record-changing action may have been attempted", async () => {
    // Same maintenance page, same declared recovery - but this time the
    // interstitial appeared AFTER a mutating click. Re-entering from the top
    // would run the payment again, so the run stops with verify_then_retry
    // instead of quietly double-posting.
    const surface = new MutationThenMaintenanceSurface();
    const confirmTarget = { frame: "main", strategies: [{ kind: "role_name" as const, role: "button", name: "Confirm Payment", frame: "main", unique: true as const, confidence: 0.9 }] };
    const mutating: CapabilityArtifact = {
      ...artifactWith("restart_capability"),
      capability: { ...artifactWith("restart_capability").capability, id: "pay_case", risk: "mutating" },
      steps: [{ id: "s1", intent: "Confirm the payment", action: { kind: "click" }, target: confirmTarget, wait: { readyWhen: "target_resolvable", timeout_ms: 300 }, postconditions: [{ kind: "text_visible", pattern: "RESULT READY" }] }]
    };
    const result = await run(mutating, surface);
    expect(result).toMatchObject({ status: "failure", failure: { class: "precondition_failed", disposition: "verify_then_retry" } });
    if (result.status !== "failure") throw new Error("expected failure");
    expect(result.failure.observed).toContain("may already have been attempted");
    // No second entry navigation ever happened.
    expect(surface.entries).toBe(1);
  });

  it("a plain continue recovery cannot rescue an interstitial that exits the flow", async () => {
    // Same page, same click - but without the declared effect the engine stays
    // where the Continue link left it and the step's target never appears.
    const surface = new MaintenanceSurface();
    const result = await run(artifactWith(undefined), surface);
    expect(result).toMatchObject({ status: "failure", failure: { class: "target_not_found", step: "s1" } });
    expect(surface.entries).toBe(1);
  });
});
