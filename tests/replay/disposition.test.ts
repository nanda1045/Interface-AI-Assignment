import { describe, expect, it } from "vitest";
import { dispositionFor, type FailureClass } from "../../src/replay/result.js";

const everyClass: FailureClass[] = [
  "target_not_found", "precondition_failed", "postcondition_failed", "checkpoint_failed",
  "policy_blocked", "timeout", "app_error", "session_lost", "invalid_input"
];

describe("what a caller should do about a failure", () => {
  it("tells a read-only caller to retry only the conditions the app produced", () => {
    expect(dispositionFor("app_error", "read_only")).toBe("retry");
    expect(dispositionFor("timeout", "read_only")).toBe("retry");
    expect(dispositionFor("session_lost", "read_only")).toBe("retry");
  });

  it("will not tell a caller to blindly repeat a capability that changes records", () => {
    // A 500 raised after the account was created looks identical to one raised
    // before anything happened, and only one of them is safe to repeat.
    expect(dispositionFor("app_error", "mutating")).toBe("verify_then_retry");
    expect(dispositionFor("app_error", "irreversible")).toBe("verify_then_retry");
  });

  it("sends a broken recording to a human rather than round the loop again", () => {
    for (const failureClass of ["target_not_found", "postcondition_failed", "checkpoint_failed"] as FailureClass[]) {
      expect(dispositionFor(failureClass, "read_only")).toBe("fix_capability");
      expect(dispositionFor(failureClass, "mutating")).toBe("fix_capability");
    }
  });

  it("never suggests retrying something the caller got wrong or was refused", () => {
    // Retrying a blocked action is not merely useless; it is an attempt to get
    // around a control, so risk must not soften it.
    for (const risk of ["read_only", "mutating", "irreversible"] as const) {
      expect(dispositionFor("invalid_input", risk)).toBe("fix_request");
      expect(dispositionFor("policy_blocked", risk)).toBe("fix_request");
    }
  });

  it("classifies every failure class, so no caller ever sees an unhandled one", () => {
    for (const failureClass of everyClass) {
      for (const risk of ["read_only", "mutating", "irreversible"] as const) {
        expect(["retry", "verify_then_retry", "fix_capability", "fix_request"]).toContain(dispositionFor(failureClass, risk));
      }
    }
  });
});
