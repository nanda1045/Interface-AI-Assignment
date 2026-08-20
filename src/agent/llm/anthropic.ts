// Anthropic adapter for the provider-independent LLMClient contract. It sends
// one text-only discovery turn with bounded tools and returns one locally
// validated AgentDecision; it never receives browser or Playwright access.
import { agentTools, parseDecision } from "../tools.js";
import type { DecideRequest, LLMClient } from "./client.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";

// Minimal response shape used by this adapter. The full external response is
// treated as untrusted and only the selected tool block is used for execution.
interface AnthropicResponse {
  content?: { type: string; name?: string; input?: unknown }[];
  error?: { message?: string };
}

export class AnthropicClient implements LLMClient {
  public readonly model: string;

  // The API key stays private inside the adapter. Model selection can be pinned
  // through ANTHROPIC_MODEL, and retry options are injectable for fast tests.
  public constructor(
    private readonly apiKey: string,
    model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    private readonly retry: RetryOptions = {}
  ) {
    this.model = model;
  }

  public async decide(request: DecideRequest) {
    // Translate our neutral request and tool definitions into Anthropic's
    // Messages API format. fetchWithRetry handles only transient failures.
    const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 800,
        system: request.system,
        messages: [{ role: "user", content: JSON.stringify({ goal: request.goal, marked_outputs: request.markedOutputs, observation: request.observation, history: request.history }) }],
        tools: agentTools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        // Force a structured tool response instead of accepting free-form text.
        tool_choice: { type: "any" }
      })
    }, this.retry);

    // Preserve the provider's real status/message after retries are exhausted.
    const payload = await response.json() as AnthropicResponse;
    if (!response.ok) throw new Error(`Anthropic Messages API error ${response.status}: ${payload.error?.message ?? "unknown error"}`);

    // Select the tool-use block, then validate its name and arguments locally
    // with Zod before the discovery loop is allowed to consume the decision.
    const call = payload.content?.find((item) => item.type === "tool_use");
    if (!call?.name) throw new Error("Anthropic response did not contain a tool_use content block.");
    return { decision: parseDecision(call.name, call.input), raw: payload };
  }
}
