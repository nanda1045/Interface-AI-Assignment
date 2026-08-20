// Scores and formats deterministic replay under controlled UI mutations. Exact
// expected outputs prevent a wrong-element read from being counted as survival.
import type { ReplayResult } from "../replay/result.js";
import type { UiMutation } from "./mutations.js";

export interface StressRow {
  mutation: string;
  survived: boolean;
  verdict: string;
  detail: string;
  strategies: Record<string, number>;
  predicted: string[];
}

// Success status is insufficient: every named expected output must match exactly.
export function scoreStress(mutation: UiMutation, result: ReplayResult, expected: Record<string, string>): StressRow {
  const outputs = result.status === "success" ? result.outputs : {};
  const wrong = Object.entries(expected)
    .filter(([name, value]) => String(outputs[name] ?? "") !== value)
    .map(([name]) => name);
  return {
    mutation: mutation.id,
    survived: result.status === "success" && wrong.length === 0,
    verdict: result.status !== "success" ? result.status : wrong.length > 0 ? `wrong ${wrong.join(", ")}` : "correct",
    detail: result.status === "failure" ? result.failure.class : "",
    strategies: result.status === "success" ? result.stability.matched_strategies : {},
    predicted: mutation.predicts
  };
}

// Produce a compact operator report with survival, correctness, failure class,
// matched strategy counts, and an aggregate survivor total.
export function formatStressReport(rows: StressRow[]): string {
  const resolvedBy = (row: StressRow) =>
    Object.entries(row.strategies).map(([kind, count]) => `${kind}×${count}`).join(" ") || "—";
  const outcome = (row: StressRow) => `${row.survived ? "survived" : "BROKE"}${row.detail ? ` (${row.detail})` : ""}`;
  const columns: [string, (row: StressRow) => string][] = [
    ["mutation", (row) => row.mutation],
    ["outcome", outcome],
    ["result", (row) => row.verdict],
    ["resolved by", resolvedBy]
  ];
  const widths = columns.map(([heading, pick]) => Math.max(heading.length, ...rows.map((row) => pick(row).length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  const survivors = rows.filter((row) => row.survived).length;
  return [
    line(columns.map(([heading]) => heading)),
    line(widths.map((size) => "─".repeat(size))),
    ...rows.map((row) => line(columns.map(([, pick]) => pick(row)))),
    "",
    `${survivors}/${rows.length} mutations survived.`
  ].join("\n");
}
