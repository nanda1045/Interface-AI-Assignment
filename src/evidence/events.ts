import type { AbstractAction, LocatorBundle } from "../surface/types.js";
import type { PolicyVerdict } from "../policy/engine.js";

export type RunEvent =
  | { type: "run_started"; goal: string; target: string; model: string }
  | { type: "observation"; step: number; url: string; title: string; stateHash: string; elementCount: number; screenshot?: string }
  | { type: "decision"; step: number; reasoning: string; decision: string }
  | { type: "policy_check"; step: number; verdict: PolicyVerdict }
  | { type: "action"; step: number; action: AbstractAction; locators?: LocatorBundle; resultUrl: string }
  | { type: "output_marked"; step: number; name: string; locators: LocatorBundle }
  | { type: "detector_hit"; step: number; detector: string; classification: string }
  | { type: "recovery_applied"; step: number; rule: string }
  | { type: "stopped"; reason: string }
  | { type: "result"; status: "success" | "business_outcome" | "escalated" | "failure"; detail: unknown };

export type PersistedRunEvent = RunEvent & { at: string; runId: string };
