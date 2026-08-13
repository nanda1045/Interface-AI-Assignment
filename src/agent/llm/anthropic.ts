import { agentTools, parseDecision } from "../tools.js";
import type { DecideRequest, LLMClient } from "./client.js";

interface AnthropicResponse {
  content?: { type: string; name?: string; input?: unknown }[];
  error?: { message?: string };
}

export class AnthropicClient implements LLMClient {
  public readonly model: string;

  public constructor(private readonly apiKey: string, model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6") {
    this.model = model;
  }

  public async decide(request: DecideRequest) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 800,
        system: request.system,
        messages: [{ role: "user", content: JSON.stringify({ goal: request.goal, marked_outputs: request.markedOutputs, observation: request.observation, history: request.history }) }],
        tools: agentTools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        // No sampling parameters: current Claude models (Sonnet 5 / Opus 5)
        // reject non-default temperature, so the client stays model-portable.
        tool_choice: { type: "any" }
      })
    });
    const payload = await response.json() as AnthropicResponse;
    if (!response.ok) throw new Error(`Anthropic Messages API error ${response.status}: ${payload.error?.message ?? "unknown error"}`);
    const call = payload.content?.find((item) => item.type === "tool_use");
    if (!call?.name) throw new Error("Anthropic response did not contain a tool_use content block.");
    return { decision: parseDecision(call.name, call.input), raw: payload };
  }
}
