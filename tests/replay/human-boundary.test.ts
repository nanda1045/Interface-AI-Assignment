import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import type { HandoffCoordinator, InterventionContext, InterventionRequest } from "../../src/control/intervention.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import type { AbstractAction, LocatorBundle, Observation, Surface, TargetSpec } from "../../src/surface/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// A review screen with a Post button. The machine may fill and verify; only
// performHumanPost() - standing in for a person in the same browser - moves the
// application to its posted state.
class ReviewSurface implements Surface {
  public readonly agentActions: AbstractAction[] = [];
  private posted = false;

  public performHumanPost(): void { this.posted = true; }

  public async observe(): Promise<Observation> {
    const text = this.posted ? "TRANSFER POSTED TRANSACTION COMPLETE TXN-42" : "CONFIRM FUNDS TRANSFER Post Transfer";
    return {
      url: `https://target.test/${this.posted ? "posted" : "review"}`, title: "Meridian",
      frames: [{ path: "main", url: `https://target.test/${this.posted ? "posted" : "review"}` }],
      elements: [
        { ref: "headline", frame: "main", role: "heading", name: text, text, state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.1], hints: {} },
        ...(this.posted
          ? [{ ref: "confirmation", frame: "main", role: "cell" as const, name: "TXN-42", text: "TXN-42", state: { visible: true, enabled: true }, bboxPct: [0, 0.3, 0.4, 0.05] as [number, number, number, number], hints: {} }]
          : [{ ref: "post", frame: "main", role: "button" as const, name: "Post Transfer", text: "Post Transfer", state: { visible: true, enabled: true }, bboxPct: [0, 0.2, 0.2, 0.05] as [number, number, number, number], hints: {} }])
      ],
      stateHash: this.posted ? "posted" : "review"
    };
  }

  public async act(action: AbstractAction) {
    this.agentActions.push(action);
    return { ok: true as const, url: "https://target.test/review" };
  }

  public async resolve(target: TargetSpec) {
    const first = target.strategies[0];
    const wanted = first?.kind === "role_name" ? first.name : "";
    const observation = await this.observe();
    const found = observation.elements.find((element) => element.name === wanted);
    if (!found) return { ok: false as const, reason: "target_not_found" as const, attempts: [] };
    return { ok: true as const, ref: found.ref, frame: "main", matchedStrategy: first!, tier: 1, attempts: [] };
  }

  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async read(ref: string) { return { text: ref === "confirmation" ? "TXN-42" : "" }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

// A coordinator whose "human" performs the post during the intervention.
class HumanPostsCoordinator implements HandoffCoordinator {
  public requests = 0;
  public constructor(private readonly perform: () => void) {}
  public async request(context: InterventionContext): Promise<InterventionRequest> {
    this.requests += 1;
    this.perform();
    return { ...context, id: `int_${this.requests}`, status: "handed_back", requestedAt: new Date().toISOString() };
  }
  public async resume(): Promise<void> {}
  public summary() { return { count: this.requests, requestIds: ["int_1"] }; }
}

class AbsentCoordinator implements HandoffCoordinator {
  public async request(context: InterventionContext): Promise<InterventionRequest> {
    return { ...context, id: "int_1", status: "aborted", requestedAt: new Date().toISOString() };
  }
  public async resume(): Promise<void> {}
  public summary() { return { count: 1, requestIds: ["int_1"] }; }
}

const postTarget = { frame: "main", strategies: [{ kind: "role_name" as const, role: "button", name: "Post Transfer", frame: "main", unique: true as const, confidence: 0.9 }] };
const confirmationTarget = { frame: "main", strategies: [{ kind: "role_name" as const, role: "cell", name: "TXN-42", frame: "main", unique: true as const, confidence: 0.9 }] };

const artifact: CapabilityArtifact = {
  schema_version: "1.0",
  capability: { id: "transfer_case", version: "1.0.0", title: "Transfer case", description: "Exercises the human boundary.", app: { id: "meridian-core", vendor: "Cornerstone", ui_version_range: ">=4 <5" }, risk: "irreversible", status: "approved", provenance: { discovered_by: "test", discovery_run: "test", recorded_at: "2026-08-20T00:00:00.000Z", approved_by: "reviewer", approved_at: "2026-08-20T00:01:00.000Z" } },
  inputs: { type: "object", required: [], properties: {} },
  outputs: { type: "object", required: ["confirmation"], properties: { confirmation: { type: "string" } } },
  entry: { url: "https://target.test/review", preconditions: [] },
  steps: [{ id: "s1", intent: "Post the transfer", action: { kind: "click" }, target: postTarget, wait: { readyWhen: "target_resolvable", timeout_ms: 300 }, execution: "human_required", postconditions: [] }],
  checkpoint: { assert: [{ kind: "text_visible", pattern: "TRANSACTION COMPLETE" }] },
  extract: [{ output: "confirmation", from: confirmationTarget, parse: "text" }],
  outcomes: [], recovery: [],
  policy: { allowed_origins: ["https://target.test"], allowed_actions: ["navigate", "click"], max_duration_ms: 5_000 }
};

const config: PolicyConfig = { allowed_origins: ["https://target.test"], allowed_path_patterns: ["^/.*$"], allowed_actions: ["navigate", "click"], max_steps: 10, max_duration_ms: 5_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };

async function loggerIn(): Promise<RunLogger> {
  const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-boundary-"));
  roots.push(root);
  return new RunLogger("replay_boundary", root);
}

describe("the irreversible human boundary", () => {
  it("refuses to run at all without an attached handoff - no flag overrides this", async () => {
    const result = await replay({ artifact, params: {}, surface: new ReviewSurface(), policy: new PolicyEngine(config), logger: await loggerIn(), confirmMutations: true });
    expect(result).toMatchObject({ status: "failure", failure: { class: "policy_blocked", disposition: "fix_request" } });
  });

  it("refuses an irreversible artifact that records no human boundary", async () => {
    // Without a human_required step the irreversible action would execute
    // unattended the moment a handoff was attached. Both halves are required.
    const unbounded: CapabilityArtifact = { ...artifact, steps: [{ ...artifact.steps[0]!, execution: undefined }] };
    const result = await replay({ artifact: unbounded, params: {}, surface: new ReviewSurface(), policy: new PolicyEngine(config), logger: await loggerIn(), handoff: new HumanPostsCoordinator(() => undefined) });
    expect(result).toMatchObject({ status: "failure", failure: { class: "policy_blocked" } });
    if (result.status !== "failure") throw new Error("expected failure");
    expect(result.failure.observed).toContain("no human_required step");
  });

  it("verifies the boundary screen, pauses, and completes from the human's work", async () => {
    const surface = new ReviewSurface();
    const handoff = new HumanPostsCoordinator(() => surface.performHumanPost());
    const result = await replay({ artifact, params: {}, surface, policy: new PolicyEngine(config), logger: await loggerIn(), handoff });
    expect(result).toMatchObject({ status: "success", outputs: { confirmation: "TXN-42" }, intervention: { count: 1 } });
    // The machine navigated to the entry and did nothing else: the post itself
    // was never an agent action.
    expect(surface.agentActions.map((action) => action.kind)).toEqual(["navigate"]);
  });

  it("fails plainly when control returns but the human did not perform the step", async () => {
    const surface = new ReviewSurface();
    const handoff = new HumanPostsCoordinator(() => undefined); // hands back untouched
    const result = await replay({ artifact, params: {}, surface, policy: new PolicyEngine(config), logger: await loggerIn(), handoff });
    expect(result).toMatchObject({ status: "failure", failure: { class: "precondition_failed" } });
    if (result.status !== "failure") throw new Error("expected failure");
    expect(result.failure.observed).toContain("was not performed");
  });

  it("times out cleanly when no operator ever takes the intervention", async () => {
    const surface = new ReviewSurface();
    const result = await replay({ artifact, params: {}, surface, policy: new PolicyEngine(config), logger: await loggerIn(), handoff: new AbsentCoordinator() });
    expect(result).toMatchObject({ status: "failure", failure: { class: "timeout" } });
  });
});
