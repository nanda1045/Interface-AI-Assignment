// Pure scoring and formatting for the capability health sweep. The eval harness
// replays each approved read-only capability against the live app; this turns one
// ReplayResult into a health verdict, and a set of verdicts into an operator
// report. The signal it cares about is drift: a capability that still succeeds but
// only by falling back to weaker locators is the early warning that the UI is
// changing under it - the moment to `heal` it before it breaks in front of a user.
import type { ReplayResult } from "../replay/result.js";
import { describeShapeDrift, type ShapeDrift } from "./shape.js";

export type Health =
  /** Succeeded and every step matched its strongest locator. */
  | "healthy"
  /** Succeeded, but at least one step was rescued by a weaker fallback tier -
   *  the recording is drifting and should be healed soon. */
  | "degraded"
  /** Did not succeed. If the disposition is fix_capability, it needs a repair. */
  | "failed"
  /** The app gave a declared business answer (e.g. not-found) rather than the
   *  expected read - informational, neither pass nor technical failure. */
  | "business"
  /** Not exercised by the sweep (mutating/irreversible, or no safe invocation). */
  | "skipped";

export interface HealthVerdict {
  health: Health;
  detail: string;
  /** The weakest ladder tier any step fell to (1 = strongest). Present on runs. */
  weakestTier?: number;
  /** Steps that only resolved via a fallback tier - the concrete drift points. */
  rescued?: string[];
  /** For a failure, what to do about it - surfaced so the report can flag heal. */
  disposition?: string;
}

// Derive a health verdict from one replay result. Pure: no I/O, no clock.
// shapeDrift (from detectShapeDrift) folds in the second, orthogonal signal: a
// run can match every locator on its strongest tier yet still be drifting because
// the app restructured the data it reads back.
export function scoreHealth(result: ReplayResult, shapeDrift: ShapeDrift[] = []): HealthVerdict {
  if (result.status === "success") {
    const tiers = Object.keys(result.stability.matched_tiers).map(Number);
    const weakestTier = tiers.length > 0 ? Math.max(...tiers) : 1;
    const rescued = result.stability.rescued_steps;
    const shapeNote = describeShapeDrift(shapeDrift);
    // Either kind of drift means "still succeeds, but the recording is slipping."
    if (rescued.length > 0 || shapeNote) {
      const parts: string[] = [];
      if (rescued.length > 0) parts.push(`rescued ${rescued.join(", ")} to tier ${weakestTier}`);
      if (shapeNote) parts.push(shapeNote);
      return { health: "degraded", detail: parts.join("; "), weakestTier, rescued };
    }
    return { health: "healthy", detail: "all steps matched tier 1", weakestTier, rescued: [] };
  }
  if (result.status === "business_outcome") {
    return { health: "business", detail: result.code };
  }
  return { health: "failed", detail: result.failure.class, disposition: result.failure.disposition };
}

export interface HealthRow {
  capability: string;
  risk: string;
  verdict: HealthVerdict;
}

// Compact operator table plus an aggregate and an explicit heal work-list, so a
// bounded sweep never reads as "everything is fine" when something needs repair.
export function formatHealthReport(rows: HealthRow[]): string {
  const symbol: Record<Health, string> = { healthy: "OK", degraded: "DRIFT", failed: "FAIL", business: "biz", skipped: "—" };
  const columns: [string, (row: HealthRow) => string][] = [
    ["capability", (row) => row.capability],
    ["risk", (row) => row.risk],
    ["health", (row) => symbol[row.verdict.health]],
    ["detail", (row) => row.verdict.detail]
  ];
  const widths = columns.map(([heading, pick]) => Math.max(heading.length, ...rows.map((row) => pick(row).length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();

  const count = (health: Health) => rows.filter((row) => row.verdict.health === health).length;
  // A capability whose failure a maintainer must repair is exactly what `heal`
  // exists for; name those so the sweep ends with a concrete next action.
  const needsHeal = rows.filter((row) => row.verdict.health === "failed" && row.verdict.disposition === "fix_capability").map((row) => row.capability);
  const drifting = rows.filter((row) => row.verdict.health === "degraded").map((row) => row.capability);

  return [
    line(columns.map(([heading]) => heading)),
    line(widths.map((size) => "─".repeat(size))),
    ...rows.map((row) => line(columns.map(([, pick]) => pick(row)))),
    "",
    `${count("healthy")} healthy · ${count("degraded")} drifting · ${count("failed")} failed · ${count("business")} business · ${count("skipped")} skipped`,
    ...(drifting.length > 0 ? [`Drifting (heal soon): ${drifting.join(", ")}`] : []),
    ...(needsHeal.length > 0 ? [`Broken — repair with heal: ${needsHeal.join(", ")}`] : [])
  ].join("\n");
}
