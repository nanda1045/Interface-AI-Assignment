import { agentTools, parseDecision } from "../tools.js";
import type { DecideRequest, LLMClient } from "./client.js";
import { fetchWithRetry, type RetryOptions } from "./retry.js";

interface OpenAIResponse {
  id: string;
  output?: { type: string; name?: string; arguments?: string }[];
  error?: { message?: string };
}

export class OpenAIClient implements LLMClient {
  public readonly model: string;

  public constructor(
    private readonly apiKey: string,
    model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
    private readonly retry: RetryOptions = {}
  ) {
    this.model = model;
  }

  public async decide(request: DecideRequest) {
    const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        store: false,
        instructions: request.system,
        input: JSON.stringify({ goal: request.goal, marked_outputs: request.markedOutputs, observation: request.observation, history: request.history }),
        tools: agentTools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: true })),
        tool_choice: "required",
        reasoning: { effort: "low" }
      })
    }, this.retry);
    const payload = await response.json() as OpenAIResponse;
    if (!response.ok) throw new Error(`OpenAI Responses API error ${response.status}: ${payload.error?.message ?? "unknown error"}`);
    const call = payload.output?.find((item) => item.type === "function_call");
    if (!call?.name || !call.arguments) throw new Error("OpenAI response did not contain a function_call output item.");
    return { decision: parseDecision(call.name, JSON.parse(call.arguments)), raw: payload };
  }
}
