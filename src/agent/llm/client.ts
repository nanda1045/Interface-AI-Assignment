import type { Observation } from "../../surface/types.js";

export type AgentDecision =
  | { kind: "navigate"; url: string; reasoning: string }
  | { kind: "click" | "focus"; ref: string; reasoning: string }
  | { kind: "type"; ref: string; text: string; sensitive: boolean; reasoning: string }
  | { kind: "select"; ref: string; value: string; reasoning: string }
  | { kind: "press"; key: string; reasoning: string }
  | { kind: "scroll"; direction: "up" | "down"; reasoning: string }
  | { kind: "note_output"; name: string; ref: string; reasoning: string }
  | { kind: "finish"; reasoning: string }
  | { kind: "escalate"; reason: string; reasoning: string };

export interface DecideRequest {
  system: string;
  goal: string;
  observation: Omit<Observation, "screenshot">;
  history: { decision: string; result: string }[];
  markedOutputs: string[];
}

export interface LLMClient {
  readonly model: string;
  decide(request: DecideRequest): Promise<{ decision: AgentDecision; raw: unknown }>;
}

export interface ToolDefinition {
  name: AgentDecision["kind"];
  description: string;
  parameters: Record<string, unknown>;
}
