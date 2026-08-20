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
  // Deliberately NOT sensitive at the output level: "matches" is an innocuous
  // name and the privacy lives on the columns that actually carry member data.
  outputs: { type: "object", required: ["matches"], properties: { matches: { type: "array", items: { type: "object", properties: { member_no: { type: "string", sensitive: true }, name: { type: "string", sensitive: true } } } } } },
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

  it("redacts sensitive columns even when the output's own name looks harmless", async () => {
    // The output is called "matches" and is not marked sensitive itself; the
    // member number and name columns are. Their values must not survive into
    // persisted evidence raw.
    const { logger } = await run(new ResultsSurface(["Member No.", "Name"], [["100234", "Lovelace, Ada"]]));
    const persisted = await readFile(path.join(logger.directory, "result.json"), "utf8");
    expect(persisted).not.toContain("100234");
    expect(persisted).not.toContain("Lovelace");
    expect(persisted).toContain("«redacted»");
  });

  it("refuses a short row instead of fabricating an empty cell", async () => {
    const { result } = await run(new ResultsSurface(["Member No.", "Name"], [["100234"]]));
    expect(result).toMatchObject({ status: "failure", failure: { class: "postcondition_failed" } });
    if (result.status !== "failure") throw new Error("expected failure");
    expect(result.failure.observed).toContain("has no cell");
  });
});

describe("typed table cells", () => {
  const typedArtifact: CapabilityArtifact = {
    ...artifact,
    outputs: { type: "object", required: ["matches"], properties: { matches: { type: "array", items: { type: "object", properties: { member_no: { type: "string", sensitive: true }, balance: { type: "number" }, shares: { type: "integer" } } } } } },
    extract: [{ output: "matches", from: tableTarget, parse: "table", columns: [{ header: "Member No.", property: "member_no" }, { header: "Balance", property: "balance" }, { header: "Shares", property: "shares" }] }]
  };

  async function runTyped(surface: Surface) {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-table-"));
    roots.push(root);
    const logger = new RunLogger("replay_typed", root);
    return replay({ artifact: typedArtifact, params: {}, surface, policy: new PolicyEngine(config), logger });
  }

  it("parses cells to their declared types, currency symbols included", async () => {
    const result = await runTyped(new ResultsSurface(["Member No.", "Balance", "Shares"], [["100234", "$1,240.55", "2"]]));
    expect(result).toMatchObject({ status: "success", outputs: { matches: [{ member_no: "100234", balance: 1240.55, shares: 2 }] } });
  });

  it("fails plainly on an unparseable numeric cell, without quoting the value", async () => {
    const result = await runTyped(new ResultsSurface(["Member No.", "Balance", "Shares"], [["100234", "N/A", "2"]]));
    expect(result).toMatchObject({ status: "failure", failure: { class: "postcondition_failed" } });
    if (result.status !== "failure") throw new Error("expected failure");
    expect(result.failure.observed).toContain("not a valid number");
    expect(result.failure.observed).not.toContain("N/A");
  });

  it("redacts a short sensitive cell in evidence but returns it to the caller", async () => {
    // A two-character share id is below the global-registration length guard, so
    // structural path-based redaction is what keeps it out of result.json.
    const shortArtifact: CapabilityArtifact = {
      ...typedArtifact,
      outputs: { type: "object", required: ["matches"], properties: { matches: { type: "array", items: { type: "object", properties: { share_id: { type: "string", sensitive: true } } } } } },
      extract: [{ output: "matches", from: tableTarget, parse: "table", columns: [{ header: "Share", property: "share_id" }] }]
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-table-"));
    roots.push(root);
    const logger = new RunLogger("replay_short", root);
    const result = await replay({ artifact: shortArtifact, params: {}, surface: new ResultsSurface(["Share"], [["01"]]), policy: new PolicyEngine(config), logger });
    // The authorized caller still gets the real value.
    expect(result).toMatchObject({ status: "success", outputs: { matches: [{ share_id: "01" }] } });
    // Persisted evidence does not.
    const persisted = await readFile(path.join(logger.directory, "result.json"), "utf8");
    expect(JSON.parse(persisted).outputs.matches[0].share_id).toBe("«redacted»");
  });
});

describe("scalar output privacy", () => {
  it("redacts a short scalar sensitive value in evidence, any length", async () => {
    const shortScalar: CapabilityArtifact = {
      ...artifact,
      outputs: { type: "object", required: ["code"], properties: { code: { type: "string", sensitive: true } } },
      extract: [{ output: "code", from: tableTarget, parse: "text" }]
    };
    class ScalarSurface extends ResultsSurface {
      public override async read() { return { text: "01" }; }
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-table-"));
    roots.push(root);
    const logger = new RunLogger("replay_scalar", root);
    const result = await replay({ artifact: shortScalar, params: {}, surface: new ScalarSurface(["Share"], [["01"]]), policy: new PolicyEngine(config), logger });
    expect(result).toMatchObject({ status: "success", outputs: { code: "01" } });
    expect(JSON.parse(await readFile(path.join(logger.directory, "result.json"), "utf8")).outputs.code).toBe("«redacted»");
  });
});
