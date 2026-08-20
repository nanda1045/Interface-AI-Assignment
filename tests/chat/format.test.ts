import { describe, expect, it } from "vitest";
import { formatResult } from "../../src/chat/format.js";
import type { ReplayResult } from "../../src/replay/result.js";

const stability = { resolutions: 1, matched_strategies: {}, matched_tiers: {} };

describe("deterministic chat formatting", () => {
  it("formats scalar outputs as a plain sentence", () => {
    const result = { status: "success", outputs: { savings_balance: "$2,481.13" }, evidence: "x", stability } as unknown as ReplayResult;
    expect(formatResult(result)).toEqual({ reply: "savings_balance: $2,481.13.", outcome: "answer" });
  });

  it("derives SELECTION_REQUIRED from a single list output with several rows", () => {
    const result = { status: "success", outputs: { matches: [{ member_no: "100234", name: "Lovelace, Ada" }, { member_no: "100987", name: "Turing, Alan" }] }, evidence: "x", stability } as unknown as ReplayResult;
    const formatted = formatResult(result);
    expect(formatted.outcome).toBe("selection_required");
    expect(formatted.reply).toContain("I found 2 matches");
    expect(formatted.reply).toContain("Lovelace, Ada");
    expect(formatted.reply).toContain("Turing, Alan");
  });

  it("presents a single match as an answer, not a menu", () => {
    const result = { status: "success", outputs: { matches: [{ member_no: "100234", name: "Lovelace, Ada" }] }, evidence: "x", stability } as unknown as ReplayResult;
    const formatted = formatResult(result);
    expect(formatted.outcome).toBe("answer");
    expect(formatted.reply).toContain("Lovelace, Ada");
  });

  it("treats a record with scalar fields plus a list as data, never a selection", () => {
    // get_member_record returns a name AND a share list; the list is data to
    // show, not a menu to pick from.
    const result = { status: "success", outputs: { member_name: "Turing, Alan", shares: [{ share_id: "01" }, { share_id: "02" }] }, evidence: "x", stability } as unknown as ReplayResult;
    const formatted = formatResult(result);
    expect(formatted.outcome).toBe("answer");
    expect(formatted.reply).toContain("member_name: Turing, Alan");
  });

  it("reports a business outcome as fact, not an error", () => {
    const result = { status: "business_outcome", code: "MEMBER_NOT_FOUND", evidence: "x" } as unknown as ReplayResult;
    expect(formatResult(result)).toEqual({ reply: "No member matched that.", outcome: "business_outcome" });
    const declined = { status: "business_outcome", code: "INSUFFICIENT_FUNDS", evidence: "x" } as unknown as ReplayResult;
    expect(formatResult(declined).reply).toContain("insufficient funds");
  });

  it("explains a failure with its observation and a disposition hint", () => {
    const result = { status: "failure", failure: { class: "app_error", disposition: "fix_capability", step: "s1", intent: "i", expected: "e", observed: "The app returned an error.", domSnapshot: "d" }, evidence: "x" } as unknown as ReplayResult;
    const formatted = formatResult(result);
    expect(formatted.outcome).toBe("failure");
    expect(formatted.reply).toContain("The app returned an error.");
    expect(formatted.reply).toContain("maintainer");
  });
});
