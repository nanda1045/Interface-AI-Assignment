// Closed replay result contract: technical failures are classified separately
// from expected business outcomes, while success carries outputs and drift data.
export type FailureClass =
  | "target_not_found"
  | "precondition_failed"
  | "postcondition_failed"
  | "checkpoint_failed"
  | "policy_blocked"
  | "timeout"
  | "app_error"
  | "session_lost"
  | "invalid_input";

export interface TierStats {
  resolutions: number;
  // Ladder position is useful within one target but not comparable across targets.
  matched_tiers: Record<string, number>;
  // Strategy kind is comparable across steps/runs and is the better drift signal.
  matched_strategies: Record<string, number>;
  rescued_steps: string[];
}

/** What the caller should do next.
 *
 *  A failure class says what went wrong; a disposition says what to do about
 *  it, which is a different question and the one an automated caller actually
 *  needs. Without it every caller has to build its own list of which of the
 *  nine classes are safe to retry, and each will get it wrong differently. */
export type FailureDisposition =
  /** Nothing was changed and the cause is likely transient. Safe to run again. */
  | "retry"
  /** Likely transient, but this capability changes records and may have done so
   *  before it stopped. Establish whether the work landed before re-running. */
  | "verify_then_retry"
  /** The recording no longer matches the application. Running it again produces
   *  the same failure; a human has to repair the capability. */
  | "fix_capability"
  /** The caller asked for something invalid or forbidden. Retrying a blocked
   *  action is not merely useless, it is an attempt to get around a control. */
  | "fix_request";

const callerFault = new Set<FailureClass>(["invalid_input", "policy_blocked"]);
// Conditions the application produced rather than the recording: the same
// capability may well succeed on a later attempt.
const transient = new Set<FailureClass>(["app_error", "timeout", "session_lost", "precondition_failed"]);

export function dispositionFor(failureClass: FailureClass, risk: "read_only" | "mutating" | "irreversible"): FailureDisposition {
  if (callerFault.has(failureClass)) return "fix_request";
  if (!transient.has(failureClass)) return "fix_capability";
  // Retryability is not a property of the class alone. A 500 raised after an
  // account was created but before its confirmation rendered looks identical to
  // one raised before anything happened, and only one of them is safe to repeat.
  return risk === "read_only" ? "retry" : "verify_then_retry";
}

export interface InterventionSummary { count: number; requestIds: string[] }

// Exactly one of success, declared business outcome, or evidence-backed failure.
export type ReplayResult =
  | { status: "success"; outputs: Record<string, unknown>; evidence: string; stability: TierStats; intervention?: InterventionSummary }
  | { status: "business_outcome"; code: string; data?: Record<string, unknown>; evidence: string; intervention?: InterventionSummary }
  | { status: "failure"; failure: { class: FailureClass; disposition: FailureDisposition; step: string; intent: string; expected: string; observed: string; screenshot?: string; domSnapshot: string; resolutionAttempts?: string }; evidence: string; intervention?: InterventionSummary };
