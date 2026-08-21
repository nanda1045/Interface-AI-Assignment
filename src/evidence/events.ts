import type { AbstractAction, LocatorBundle } from "../surface/types.js";
import type { PolicyVerdict } from "../policy/engine.js";
import type { InterventionRequest } from "../control/intervention.js";
import type { ControlState } from "../control/lease.js";

export type RunEvent =
  // `capability` is the concrete id@version that ran. A caller may name a
  // capability without a version, so the evidence has to record which one
  // resolution actually selected rather than what was asked for.
  | { type: "run_started"; goal: string; target: string; model: string; capability?: string }
  // The run's invocation inputs (redacted), so the dashboard can show what was
  // requested alongside the structured result.
  | { type: "run_inputs"; inputs: Record<string, unknown> }
  | { type: "observation"; step: number; url: string; title: string; stateHash: string; elementCount: number; screenshot?: string }
  | { type: "decision"; step: number; reasoning: string; decision: string }
  | { type: "policy_check"; step: number; verdict: PolicyVerdict }
  | { type: "action"; step: number; action: AbstractAction; locators?: LocatorBundle; resultUrl: string }
  // A browser action the Surface could not perform (wrong option value, detached
  // element). Discovery survives it and feeds the failure back to the model.
  | { type: "action_failed"; step: number; action: AbstractAction; detail: string }
  | { type: "output_marked"; step: number; name: string; locators: LocatorBundle }
  | { type: "detector_hit"; step: number; detector: string; classification: string }
  | { type: "recovery_applied"; step: number; rule: string }
  | { type: "intervention_requested"; request: InterventionRequest }
  | { type: "lease_change"; state: ControlState }
  | { type: "human_action"; action: { kind: string; control?: string; value?: string; url?: string } }
  | { type: "signed_on"; operator: string; app: string }
  | { type: "human_step_recorded"; step: number; action: AbstractAction }
  | { type: "stopped"; reason: string }
  // A demo fault forced on the entry URL by trusted runner code. Recorded so
  // the evidence explains any resulting business outcome or failure.
  | { type: "fault_injected"; kind: string; url: string }
  // Wall-clock a step took, so the dashboard can show per-step timings without
  // reconstructing them from event gaps.
  | { type: "step_completed"; step: number; stepId: string; durationMs: number }
  // Recorded once when screenshots stop being captured because a sensitive value
  // has entered the run; the dashboard explains the gap instead of implying loss.
  | { type: "screenshots_withheld"; reason: string }
  | { type: "result"; status: "success" | "business_outcome" | "escalated" | "failure"; detail: unknown };

export type PersistedRunEvent = RunEvent & { at: string; runId: string };
