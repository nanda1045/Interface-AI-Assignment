// Answers a question by letting a model choose a capability and then running
// that capability deterministically. The model decides *which* job to do; the
// recorded artifact decides *how* it is done. Nothing here influences replay -
// this sits above the engine and calls it exactly as a production caller would.
import { fetchWithRetry, type RetryOptions } from "../agent/llm/retry.js";
import type { CatalogEntry } from "../artifact/catalog.js";
import type { ReplayResult } from "../replay/result.js";

/** Runs one capability and returns its result. Injected so this module is
 *  testable without a browser, and so it cannot reach past the same replay
 *  path every other caller uses. */
export type CapabilityExecutor = (reference: string, params: Record<string, string>) => Promise<ReplayResult>;

export interface AskOptions {
  question: string;
  catalog: CatalogEntry[];
  execute: CapabilityExecutor;
  apiKey: string;
  model?: string;
  /** A capability that changes records is never run to answer a question unless
   *  this is set, because a wrong choice would be a real change to real data. */
  allowMutations?: boolean;
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

export interface AskResult {
  answer: string;
  invoked?: { reference: string; params: Record<string, string>; status: ReplayResult["status"] };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

interface MessagesResponse {
  content?: ContentBlock[];
  error?: { message?: string };
}

const systemPrompt = `You answer questions about a back-office banking system by calling the capabilities you have been given.

- Use only the capabilities provided. If none of them can answer the question, say so plainly.
- Never invent an identifier the user did not supply. Ask for it instead.
- A capability can come back three ways, and they mean different things:
  - success: the outputs are the answer.
  - business_outcome: the application gave a legitimate answer such as "no such member". Report it as fact, not as an error.
  - failure: the automation itself could not complete. Say so, and pass on what should happen next.
- Answer in one or two plain sentences. Do not describe the tools you used.`;

// Only the shape of a replay result the model needs. A failure's debug bundle
// paths and evidence directory are for a human, not for a language model.
function toolResultFor(result: ReplayResult): string {
  if (result.status === "success") return JSON.stringify({ status: "success", outputs: result.outputs });
  if (result.status === "business_outcome") return JSON.stringify({ status: "business_outcome", code: result.code, ...(result.data ? { data: result.data } : {}) });
  return JSON.stringify({ status: "failure", class: result.failure.class, disposition: result.failure.disposition, observed: result.failure.observed });
}

// The model proposes arguments; it does not get to define them. Values are
// coerced to the strings a capability invocation takes, and replay validates
// them against the artifact's own input contract before acting on anything.
function toParams(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([name, value]) => [name, String(value)]));
}

function textOf(content: ContentBlock[] | undefined): string {
  return (content ?? []).filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .join("\n")
    .trim();
}

export async function ask(options: AskOptions): Promise<AskResult> {
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  const messages: unknown[] = [{ role: "user", content: options.question }];
  const call = async (): Promise<MessagesResponse> => {
    const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 700, system: systemPrompt, tools: options.catalog.map((entry) => entry.tool), messages })
    }, { ...options.retry, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const payload = await response.json() as MessagesResponse;
    if (!response.ok) throw new Error(`Anthropic Messages API error ${response.status}: ${payload.error?.message ?? "unknown error"}`);
    return payload;
  };

  const chosen = await call();
  const invocation = chosen.content?.find((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
  if (!invocation) return { answer: textOf(chosen.content) || "I could not answer that with the capabilities available." };

  const entry = options.catalog.find((candidate) => candidate.tool.name === invocation.name);
  if (!entry) throw new Error(`The model asked for a capability that is not in the catalog: ${invocation.name}`);
  if (entry.risk !== "read_only" && !options.allowMutations) {
    return { answer: `Answering that would run ${entry.reference}, which changes records. Re-run with --allow-mutations if that is intended.` };
  }

  const params = toParams(invocation.input);
  const result = await options.execute(entry.reference, params);

  messages.push({ role: "assistant", content: chosen.content });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: invocation.id, content: toolResultFor(result) }] });
  const answered = await call();
  return {
    answer: textOf(answered.content) || "The capability ran but produced no answer.",
    invoked: { reference: entry.reference, params, status: result.status }
  };
}
