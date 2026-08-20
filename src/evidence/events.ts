import type { AbstractAction, LocatorBundle } from "../surface/types.js";
import type { PolicyVerdict } from "../policy/engine.js";
import type { InterventionRequest } from "../control/intervention.js";
import type { ControlState } from "../control/lease.js";

export type RunEvent =
  // `capability` is the concrete id@version that ran. A caller may name a
  // capability without a version, so the evidence has to record which one
  // resolution actually selected rather than what was asked for.
  | { type: "run_started"; goal: string; target: string; model: string; capability?: string }
  | { type: "observation"; step: number; url: string; title: string; stateHash: string; elementCount: number; screenshot?: string }
  | { type: "decision"; step: number; reasoning: string; decision: string }
  | { type: "policy_check"; step: number; verdict: PolicyVerdict }
  | { type: "action"; step: number; action: AbstractAction; locators?: LocatorBundle; resultUrl: string }
  | { type: "output_marked"; step: number; name: string; locators: LocatorBundle }
  | { type: "detector_hit"; step: number; detector: string; classification: string }
  | { type: "recovery_applied"; step: number; rule: string }
  | { type: "intervention_requested"; request: InterventionRequest }
  | { type: "lease_change"; state: ControlState }
  | { type: "human_action"; action: { kind: string; control?: string; value?: string; url?: string } }
  | { type: "signed_on"; operator: string; app: string }
  | { type: "human_step_recorded"; step: number; action: AbstractAction }
  | { type: "stopped"; reason: string }
  | { type: "result"; status: "success" | "business_outcome" | "escalated" | "failure"; detail: unknown };

export type PersistedRunEvent = RunEvent & { at: string; runId: string };
