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
  /** Keyed by position in that step's ladder. A step that captured four
   *  strategies calls geometry "4"; one that captured seven calls a healthy
   *  label match "4". Useful per step, meaningless once aggregated. */
  matched_tiers: Record<string, number>;
  /** Keyed by strategy kind, which is comparable across steps and across runs.
   *  This is the signal to watch for drift. */
  matched_strategies: Record<string, number>;
  rescued_steps: string[];
}

export interface InterventionSummary { count: number; requestIds: string[] }

export type ReplayResult =
  | { status: "success"; outputs: Record<string, unknown>; evidence: string; stability: TierStats; intervention?: InterventionSummary }
  | { status: "business_outcome"; code: string; data?: Record<string, unknown>; evidence: string; intervention?: InterventionSummary }
  | { status: "failure"; failure: { class: FailureClass; step: string; intent: string; expected: string; observed: string; screenshot?: string; domSnapshot: string; resolutionAttempts?: string }; evidence: string; intervention?: InterventionSummary };
