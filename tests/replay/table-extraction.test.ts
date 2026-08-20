import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import type { LocatorBundle, Observation, Surface, TargetSpec } from "../../src/surface/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// A results page whose table can present its columns in any order.
class ResultsSurface implements Surface {
  public constructor(private readonly headers: string[], private readonly rows: string[][]) {}

  public async observe(): Promise<Observation> {
    return {
      url: "https://target.test/results", title: "Results",
      frames: [{ path: "main", url: "https://target.test/results" }],
      elements: [{ ref: "results", frame: "main", role: "table", name: "results", state: { visible: true, enabled: true }, bboxPct: [0, 0, 1, 0.5], hints: {} }],
      stateHash: "results"
    };
  }

  public async act() { return { ok: true as const, url: "https://target.test/results" }; }
  public async resolve(target: TargetSpec) {
    return { ok: true as const, ref: "results", frame: "main", matchedStrategy: target.strategies[0]!, tier: 1, attempts: [] };
  }
  public async captureLocators(): Promise<LocatorBundle> { throw new Error("not used"); }
  public async read() { return { text: "" }; }
  public async readTable() { return { headers: this.headers, rows: this.rows }; }
  public async snapshotDom() { return "<html></html>"; }
  public async close() {}
}

const tableTarget = { frame: "main", strategies: [{ kind: "structural" as const, value: "/html/body/table", frame: "main", unique: true as const, confidence: 0.5 }] };

const artifact: CapabilityArtifact = {
  schema_version: "1.0",
  capability: { id: "find_members", version: "1.0.0", title: "Find members", description: "Structured search results.", app: { id: "meridian-core", vendor: "Cornerstone", ui_version_range: ">=4 <5" }, risk: "read_only", status: "approved", provenance: { discovered_by: "test", discovery_run: "test", recorded_at: "2026-08-20T00:00:00.000Z", approved_by: "reviewer", approved_at: "2026-08-20T00:01:00.000Z" } },
  inputs: { type: "object", required: [], properties: {} },
  outputs: { type: "object", required: ["matches"], properties: { matches: { type: "array", sensitive: true, items: { type: "object", properties: { member_no: { type: "string" }, name: { type: "string" } } } } } },
  entry: { url: "https://target.test/results", preconditions: [] },
  steps: [{ id: "s1", intent: "Open the results", action: { kind: "scroll", direction: "down" }, wait: { readyWhen: "page_loaded", timeout_ms: 300 }, postconditions: [] }],
  checkpoint: { assert: [{ kind: "element_present", target: tableTarget }] },
  extract: [{ output: "matches", from: tableTarget, parse: "table", columns: [{ header: "Member No.", property: "member_no" }, { header: "Name", property: "name" }] }],
  outcomes: [], recovery: [],
  policy: { allowed_origins: ["https://target.test"], allowed_actions: ["navigate", "scroll"], max_duration_ms: 5_000 }
};

const config: PolicyConfig = { allowed_origins: ["https://target.test"], allowed_path_patterns: ["^/.*$"], allowed_actions: ["navigate", "scroll"], max_steps: 10, max_duration_ms: 5_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };

async function run(surface: Surface) {
  const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-table-"));
  roots.push(root);
  const logger = new RunLogger("replay_table", root);
  return { result: await replay({ artifact, params: {}, surface, policy: new PolicyEngine(config), logger }), logger };
}

describe("structured table extraction", () => {
  it("returns rows as typed objects mapped by header text", async () => {
    const { result } = await run(new ResultsSurface(["Member No.", "Name", "Shares"], [["100234", "Lovelace, Ada", "2"], ["100987", "Hopper, Grace", "3"]]));
    expect(result).toMatchObject({
      status: "success",
      outputs: { matches: [{ member_no: "100234", name: "Lovelace, Ada" }, { member_no: "100987", name: "Hopper, Grace" }] }
    });
  });

  it("survives a reordered table because columns match by header, not position", async () => {
    const { result } = await run(new ResultsSurface(["Name", "Shares", "Member No."], [["Lovelace, Ada", "2", "100234"]]));
    expect(result).toMatchObject({ status: "success", outputs: { matches: [{ member_no: "100234", name: "Lovelace, Ada" }] } });
  });

  it("fails loudly when a declared column disappears, never shifting values over", async () => {
    const { result } = await run(new ResultsSurface(["Name", "Shares"], [["Lovelace, Ada", "2"]]));
    expect(result).toMatchObject({ status: "failure", failure: { class: "postcondition_failed" } });
    if (result.status !== "failure") throw new Error("expected failure");
    expect(result.failure.observed).toContain("Member No.");
  });

  it("registers sensitive row values so evidence is redacted", async () => {
    const { logger } = await run(new ResultsSurface(["Member No.", "Name"], [["100234", "Lovelace, Ada"]]));
    const persisted = await readFile(path.join(logger.directory, "result.json"), "utf8");
    expect(persisted).not.toContain("Lovelace");
    expect(persisted).toContain("«redacted»");
  });
});
