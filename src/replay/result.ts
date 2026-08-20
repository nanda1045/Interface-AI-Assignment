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

export interface InterventionSummary { count: number; requestIds: string[] }

// Exactly one of success, declared business outcome, or evidence-backed failure.
export type ReplayResult =
  | { status: "success"; outputs: Record<string, unknown>; evidence: string; stability: TierStats; intervention?: InterventionSummary }
  | { status: "business_outcome"; code: string; data?: Record<string, unknown>; evidence: string; intervention?: InterventionSummary }
  | { status: "failure"; failure: { class: FailureClass; step: string; intent: string; expected: string; observed: string; screenshot?: string; domSnapshot: string; resolutionAttempts?: string }; evidence: string; intervention?: InterventionSummary };
