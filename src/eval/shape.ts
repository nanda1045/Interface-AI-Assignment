// Data-shape drift detection for the eval sweep. Locator drift is about *finding*
// an element; shape drift is about the *structure of the data* a capability reads
// back. A capability can still succeed - every declared column resolves - while
// the app has quietly grown a new column or renamed one the recording didn't map.
// Replay already fails loudly when a declared column disappears; this catches the
// quieter case a successful run hides: the live table no longer matches the shape
// the recording was built against.
import type { CapabilityArtifact } from "../artifact/schema.js";

export interface ShapeDrift {
  /** The table output whose live shape diverged from the recorded contract. */
  output: string;
  /** Live headers the recording does not map - the app grew or renamed a column. */
  added: string[];
  /** Declared headers no longer present live (usually already a run failure). */
  missing: string[];
}

/** Compare each table output's declared columns against the live headers the run
 *  observed. Pure: header labels in, drift out, no I/O. */
export function detectShapeDrift(artifact: CapabilityArtifact, observedShape: Record<string, string[]>): ShapeDrift[] {
  const drifts: ShapeDrift[] = [];
  for (const extraction of artifact.extract) {
    if (extraction.parse !== "table" || !extraction.columns) continue;
    const observed = observedShape[extraction.output];
    if (!observed) continue;
    const declaredHeaders = extraction.columns.map((column) => column.header.trim());
    const declaredLower = new Set(declaredHeaders.map((header) => header.toLowerCase()));
    const live = observed.map((header) => header.trim()).filter((header) => header !== "");
    const liveLower = new Set(live.map((header) => header.toLowerCase()));
    const added = live.filter((header) => !declaredLower.has(header.toLowerCase()));
    const missing = declaredHeaders.filter((header) => !liveLower.has(header.toLowerCase()));
    if (added.length > 0 || missing.length > 0) drifts.push({ output: extraction.output, added, missing });
  }
  return drifts;
}

/** A short, human-readable summary of shape drift for the health report, or
 *  undefined when there is none. */
export function describeShapeDrift(drifts: ShapeDrift[]): string | undefined {
  if (drifts.length === 0) return undefined;
  return `shape drift: ${drifts.map((drift) => {
    const parts: string[] = [];
    if (drift.added.length > 0) parts.push(`+${drift.added.join(", ")}`);
    if (drift.missing.length > 0) parts.push(`-${drift.missing.join(", ")}`);
    return `${drift.output} (${parts.join(" ")})`;
  }).join("; ")}`;
}
