// OpenAI adapter for the same provider-independent LLMClient used by discovery.
// It translates neutral tools into Responses API functions and returns one
// locally validated AgentDecision, without any browser or Playwright access.
import { agentTools, parseDecision } from "../tools.js";
import type { DecideRequest, LLMClient } from "./client.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";

// Minimal untrusted response shape needed to find a Responses API function call.
interface OpenAIResponse {
  id: string;
  output?: { type: string; name?: string; arguments?: string }[];
  error?: { message?: string };
}

export class OpenAIClient implements LLMClient {
  public readonly model: string;

  // Keep credentials private inside the adapter, allow model pinning through the
  // environment, and inject retry behaviour for deterministic unit tests.
  public constructor(
    private readonly apiKey: string,
    model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
    private readonly retry: RetryOptions = {}
  ) {
    this.model = model;
  }

  public async decide(request: DecideRequest) {
    // Translate the common discovery request into OpenAI's Responses API format.
    // fetchWithRetry retries only transient transport or service failures.
    const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        // Request that this provider response is not retained for later retrieval.
        store: false,
        instructions: request.system,
        input: JSON.stringify({ goal: request.goal, marked_outputs: request.markedOutputs, observation: request.observation, history: request.history }),
        tools: agentTools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: true })),
        // Require one structured function decision instead of free-form text.
        tool_choice: "required",
        reasoning: { effort: "low" }
      })
    }, this.retry);

    // Preserve the real provider status/message when retry attempts are exhausted.
    const payload = await response.json() as OpenAIResponse;
    if (!response.ok) throw new Error(`OpenAI Responses API error ${response.status}: ${payload.error?.message ?? "unknown error"}`);

    // OpenAI returns function arguments as JSON text. Parse them, then apply our
    // local Zod schema before the discovery loop receives the decision.
    const call = payload.output?.find((item) => item.type === "function_call");
    if (!call?.name || !call.arguments) throw new Error("OpenAI response did not contain a function_call output item.");
    return { decision: parseDecision(call.name, JSON.parse(call.arguments)), raw: payload };
  }
}
