import { describe, expect, it } from "vitest";
import { formatHealthReport, scoreHealth, type HealthRow } from "../../src/eval/health.js";
import type { ReplayResult } from "../../src/replay/result.js";

const success = (matched_tiers: Record<string, number>, rescued_steps: string[]): ReplayResult => ({
  status: "success", outputs: {}, evidence: "runs/x",
  stability: { resolutions: 1, matched_tiers, matched_strategies: {}, rescued_steps }
});

describe("scoreHealth", () => {
  it("is healthy when every step matched the strongest tier", () => {
    expect(scoreHealth(success({ "1": 3 }, []))).toMatchObject({ health: "healthy", weakestTier: 1 });
  });

  it("is degraded when a step was rescued by a weaker fallback tier", () => {
    const verdict = scoreHealth(success({ "1": 2, "3": 1 }, ["s2"]));
    expect(verdict).toMatchObject({ health: "degraded", weakestTier: 3, rescued: ["s2"] });
    expect(verdict.detail).toContain("s2");
  });

  it("reports a declared business outcome as its own health, not a failure", () => {
    const result: ReplayResult = { status: "business_outcome", code: "MEMBER_NOT_FOUND", evidence: "runs/x" };
    expect(scoreHealth(result)).toMatchObject({ health: "business", detail: "MEMBER_NOT_FOUND" });
  });

  it("marks a failure and surfaces the disposition that decides whether to heal", () => {
    const result: ReplayResult = { status: "failure", evidence: "runs/x", failure: { class: "target_not_found", disposition: "fix_capability", step: "s3", intent: "click", expected: "x", observed: "y", domSnapshot: "<html>" } };
    expect(scoreHealth(result)).toMatchObject({ health: "failed", detail: "target_not_found", disposition: "fix_capability" });
  });

  it("degrades a locator-healthy run when the data shape drifted (a new column)", () => {
    const verdict = scoreHealth(success({ "1": 3 }, []), [{ output: "matches", added: ["Branch"], missing: [] }]);
    expect(verdict.health).toBe("degraded");
    expect(verdict.detail).toContain("shape drift");
    expect(verdict.detail).toContain("Branch");
  });

  it("combines locator drift and shape drift in one detail line", () => {
    const verdict = scoreHealth(success({ "1": 2, "2": 1 }, ["s2"]), [{ output: "matches", added: ["Branch"], missing: [] }]);
    expect(verdict.health).toBe("degraded");
    expect(verdict.detail).toContain("rescued s2");
    expect(verdict.detail).toContain("shape drift");
  });
});

describe("formatHealthReport", () => {
  const rows: HealthRow[] = [
    { capability: "find_member_by_number", risk: "read_only", verdict: { health: "healthy", detail: "all steps matched tier 1", weakestTier: 1, rescued: [] } },
    { capability: "find_members_by_last_name", risk: "read_only", verdict: { health: "degraded", detail: "rescued s2 to tier 2", weakestTier: 2, rescued: ["s2"] } },
    { capability: "get_member_record", risk: "read_only", verdict: { health: "failed", detail: "target_not_found", disposition: "fix_capability" } },
    { capability: "transfer_funds", risk: "irreversible", verdict: { health: "skipped", detail: "irreversible — exercised only via the attended path" } }
  ];

  it("aggregates counts and names an explicit heal work-list", () => {
    const report = formatHealthReport(rows);
    expect(report).toContain("1 healthy · 1 drifting · 1 failed · 0 business · 1 skipped");
    expect(report).toContain("Drifting (heal soon): find_members_by_last_name");
    expect(report).toContain("Broken — repair with heal: get_member_record");
  });

  it("omits the heal work-list when nothing is broken or drifting", () => {
    const clean = formatHealthReport([rows[0]!]);
    expect(clean).not.toContain("repair with heal");
    expect(clean).not.toContain("Drifting");
  });
});
