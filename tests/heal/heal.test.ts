import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifact/store.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { healCapability, type StepProposer } from "../../src/heal/heal.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import type { AbstractAction, LocatorBundle, LocatorStrategy, Observation, Surface, TargetSpec } from "../../src/surface/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const ladder = (name: string): LocatorStrategy[] => [{ kind: "role_name", role: "button", name, frame: "main", unique: true, confidence: 0.9 }];
const target = (name: string) => ({ frame: "main", strategies: ladder(name) });

// A fake screen whose elements are simply a set of names that currently resolve.
// Dropping a name from the set simulates the legacy UI drifting so a locator
// stops resolving - exactly the condition healing exists to repair.
class FakeSurface implements Surface {
  public readonly acts: AbstractAction[] = [];
  public constructor(private readonly present: Set<string>) {}

  public async observe(): Promise<Observation> {
    return {
      url: "https://target.test/members", title: "Meridian",
      frames: [{ path: "main", url: "https://target.test/members" }],
      elements: [...this.present].map((name) => ({ ref: name, frame: "main", role: "button", name, text: name, state: { visible: true, enabled: true }, bboxPct: [0, 0, 0.2, 0.05] as [number, number, number, number], hints: {} })),
      stateHash: [...this.present].join(",")
    };
  }
  public async act(action: AbstractAction) { this.acts.push(action); return { ok: true as const, url: "https://target.test/members" }; }
  public async resolve(spec: TargetSpec) {
    const first = spec.strategies[0];
    const name = first && first.kind === "role_name" ? first.name : "";
    if (!this.present.has(name)) return { ok: false as const, reason: "target_not_found" as const, attempts: [] };
    return { ok: true as const, ref: name, frame: "main", matchedStrategy: first!, tier: 1, attempts: [] };
  }
  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used in tests"); }
  public async read() { return { text: "" }; }
  public async readTable() { return { headers: [], rows: [], hasHeaderRow: false }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

const base: CapabilityArtifact = {
  schema_version: "1.0",
  capability: {
    id: "find_member", version: "1.0.0", title: "Find member", description: "Look a member up.",
    app: { id: "meridian-core", vendor: "Cornerstone", ui_version_range: ">=4 <5" }, risk: "read_only", status: "approved",
    provenance: { discovered_by: "gpt", discovery_run: "disc_1", recorded_at: "2026-08-20T00:00:00.000Z", approved_by: "alice", approved_at: "2026-08-20T00:01:00.000Z", input_fingerprint: { member_number: "abc123" }, validation: { run: "val_1", validated_at: "2026-08-20T00:01:00.000Z", outcome: "success", reused_params: [], matched_tiers: { "1": 2 } } }
  },
  inputs: { type: "object", required: ["member_number"], properties: { member_number: { type: "string" } } },
  outputs: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  entry: { url: "https://target.test/members", preconditions: [] },
  steps: [
    { id: "s1", intent: "Type member number", action: { kind: "type", value_from: { param: "member_number" } }, target: target("Member No."), wait: { readyWhen: "target_resolvable", timeout_ms: 200 }, postconditions: [] },
    { id: "s2", intent: "Click Search", action: { kind: "click" }, target: target("Search"), wait: { readyWhen: "target_resolvable", timeout_ms: 200 }, postconditions: [] }
  ],
  checkpoint: { assert: [{ kind: "element_present", target: target("Member Name") }] },
  extract: [{ output: "name", from: target("Member Name"), parse: "text" }],
  outcomes: [], recovery: [],
  policy: { allowed_origins: ["https://target.test"], allowed_actions: ["navigate", "type", "click"], max_duration_ms: 60_000 }
};

const config: PolicyConfig = { allowed_origins: ["https://target.test"], allowed_path_patterns: ["^/.*$"], allowed_actions: ["navigate", "type", "click"], max_steps: 10, max_duration_ms: 60_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };

// A proposer that offers a fixed replacement ladder, standing in for the LLM.
const proposes = (name: string): StepProposer => async () => ladder(name);

describe("healCapability - reach, propose, validate, patch", () => {
  it("re-discovers a drifted step and returns a repaired draft that resolves live", async () => {
    // s1 still resolves ("Member No." present); s2's old "Search" is gone; the
    // proposer offers "Search Members", which the live page does resolve.
    const surface = new FakeSurface(new Set(["Member No.", "Search Members", "Member Name"]));
    const result = await healCapability({ artifact: base, params: { member_number: "100987" }, stepId: "s2", surface, policy: new PolicyEngine(config), proposer: proposes("Search Members"), newVersion: "1.1.0", fromRun: "replay_bad", model: "gpt-heal" });

    expect(result.before).toEqual(ladder("Search"));
    expect(result.after).toEqual(ladder("Search Members"));
    expect(result.patched.capability.version).toBe("1.1.0");
    expect(result.patched.capability.status).toBe("draft");
    expect(result.patched.steps[1]!.target!.strategies).toEqual(ladder("Search Members"));
    // Reaching the step navigated then typed the member number - never clicked s2.
    expect(surface.acts.map((a) => a.kind)).toEqual(["navigate", "type"]);
  });

  it("refuses to write a draft when the proposed ladder does not resolve", async () => {
    // The proposer's suggestion is not actually on the page: auto-rejected.
    const surface = new FakeSurface(new Set(["Member No.", "Member Name"]));
    await expect(healCapability({ artifact: base, params: { member_number: "100987" }, stepId: "s2", surface, policy: new PolicyEngine(config), proposer: proposes("Nonexistent"), newVersion: "1.1.0", fromRun: "r", model: "m" }))
      .rejects.toThrow(/did not resolve/);
  });

  it("reports when the real break is an earlier step, not the one asked for", async () => {
    // s1 itself no longer resolves, so we can't even reach s2 to heal it.
    const surface = new FakeSurface(new Set(["Search Members", "Member Name"]));
    await expect(healCapability({ artifact: base, params: { member_number: "100987" }, stepId: "s2", surface, policy: new PolicyEngine(config), proposer: proposes("Search Members"), newVersion: "1.1.0", fromRun: "r", model: "m" }))
      .rejects.toThrow(/break is at s1/);
  });

  it("produces a draft that is still not runnable by name until approved", async () => {
    const surface = new FakeSurface(new Set(["Member No.", "Search Members", "Member Name"]));
    const { patched } = await healCapability({ artifact: base, params: { member_number: "100987" }, stepId: "s2", surface, policy: new PolicyEngine(config), proposer: proposes("Search Members"), newVersion: "1.1.0", fromRun: "r", model: "m" });

    const root = await mkdtemp(path.join(os.tmpdir(), "heal-store-"));
    roots.push(root);
    const store = new ArtifactStore(root);
    await store.save(base);      // 1.0.0 approved
    await store.save(patched);   // 1.1.0 healed draft

    // Asking for the capability by name still resolves the APPROVED 1.0.0, never
    // the healed draft - the repair has to pass human approval to go live.
    const resolved = await store.resolve("find_member");
    expect(resolved.version).toBe("1.0.0");
    // The draft exists and is reachable only by an explicit, exact, deliberate pin.
    expect((await store.resolve("find_member@1.1.0")).version).toBe("1.1.0");
  });
});
