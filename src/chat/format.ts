// Turns a structured replay result into a plain-English reply with CODE, not a
// model. Nothing from a run - outputs, evidence, browser state - is ever sent
// back to a language model to be phrased; that is the whole point of this file.
// The values shown here are the real ones the authorized operator asked for;
// only the persisted evidence is redacted.
import type { ReplayResult } from "../replay/result.js";

export type ReplyOutcome = "answer" | "selection_required" | "not_found" | "business_outcome" | "failure";

export interface FormattedReply {
  reply: string;
  outcome: ReplyOutcome;
}

// Known MERIDIAN business-outcome codes get a plain sentence; anything else is
// reported by its code rather than dressed up. A business outcome is a fact the
// application stated, never an automation error.
function businessSentence(code: string): string {
  switch (code) {
    case "MEMBER_NOT_FOUND": return "No member matched that.";
    case "INSUFFICIENT_FUNDS": return "The transfer was declined: insufficient funds.";
    case "VALIDATION_REJECTED": return "The application rejected that as invalid.";
    case "SIGNON_REJECTED": return "Sign-on was rejected.";
    default: return `The application reported: ${code}.`;
  }
}

function dispositionHint(disposition: string): string {
  switch (disposition) {
    case "fix_request": return "Please check the details and try again.";
    case "retry": return "It may succeed on a retry.";
    default: return "This needs a maintainer to look at the capability.";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rowSummary(row: unknown): string {
  if (isObject(row)) return Object.entries(row).map(([key, value]) => `${key}: ${String(value)}`).join(", ");
  return String(row);
}

function valueSentence(name: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${name}: none.`;
    return `${name}: ${value.map((row, index) => `(${index + 1}) ${rowSummary(row)}`).join("; ")}.`;
  }
  return `${name}: ${String(value)}.`;
}

export function formatResult(result: ReplayResult): FormattedReply {
  if (result.status === "business_outcome") {
    return { reply: businessSentence(result.code), outcome: "business_outcome" };
  }
  if (result.status === "failure") {
    return { reply: `I couldn't complete that automatically. ${result.failure.observed} ${dispositionHint(result.failure.disposition)}`.trim(), outcome: "failure" };
  }

  const entries = Object.entries(result.outputs);

  // SELECTION_REQUIRED is derived here, at the chatbot layer, exactly for the
  // shape the last-name inquiry produces: a single list-typed output. Several
  // matches means the user must pick; the capability itself stays a plain,
  // linear lookup. A result that also carries scalar fields (a member record
  // with its share list) is data to present, not a menu to choose from.
  if (entries.length === 1 && Array.isArray(entries[0]![1])) {
    const [name, rows] = entries[0] as [string, unknown[]];
    if (rows.length === 0) return { reply: `No ${name} found.`, outcome: "not_found" };
    if (rows.length > 1) {
      const listed = rows.map((row, index) => `${index + 1}. ${rowSummary(row)}`).join("\n");
      return { reply: `I found ${rows.length} matches. Which one do you mean?\n${listed}`, outcome: "selection_required" };
    }
    return { reply: `Found one match — ${rowSummary(rows[0])}.`, outcome: "answer" };
  }

  if (entries.length === 0) return { reply: "The capability ran successfully but returned no data.", outcome: "answer" };
  return { reply: entries.map(([name, value]) => valueSentence(name, value)).join(" "), outcome: "answer" };
}
