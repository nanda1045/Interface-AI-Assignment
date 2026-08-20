// Provider-independent contract between the discovery loop and an LLM. It
// defines the only decisions a model may return and declares a text-only request
// boundary with no screenshot field. Replay never imports or uses this interface.
import type { Observation } from "../../surface/types.js";

// Typed result produced only after a provider tool call passes runtime parsing.
// Browser actions use temporary refs; control decisions manage discovery state.
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

// Complete context for one model turn. Omit<..., "screenshot"> makes the
// text-only boundary explicit at compile time as well as in loop.ts.
export interface DecideRequest {
  system: string;
  goal: string;
  observation: Omit<Observation, "screenshot">;
  history: { decision: string; result: string }[];
  markedOutputs: string[];
}

// Anthropic and OpenAI implement this same small interface, so the discovery
// engine depends on behaviour rather than either provider's SDK/API format.
export interface LLMClient {
  readonly model: string;
  decide(request: DecideRequest): Promise<{ decision: AgentDecision; raw: unknown }>;
}

// Neutral tool description translated by each provider adapter into its own API
// request. `name` is limited to one of the AgentDecision kinds.
export interface ToolDefinition {
  name: AgentDecision["kind"];
  description: string;
  parameters: Record<string, unknown>;
}
