// The chatbot's model boundary. The model does ONE job here: turn a user's
// message into exactly one of three validated outcomes - call this capability,
// ask this clarifying question, or this is unsupported. It never sees a replay
// result and never phrases the final answer; that is deterministic code
// downstream. If the model does anything unexpected, we fail closed.
import { fetchWithRetry, type RetryOptions } from "../agent/llm/retry.js";
import type { CatalogEntry } from "../artifact/catalog.js";

export type RouteDecision =
  | { kind: "capability"; name: string; inputs: Record<string, unknown> }
  | { kind: "clarification"; message: string }
  | { kind: "unsupported"; message: string };

export interface RouteOptions {
  question: string;
  catalog: CatalogEntry[];
  apiKey: string;
  model?: string;
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

interface MessagesResponse {
  content?: ContentBlock[];
  error?: { message?: string };
}

// Two meta-tools sit alongside the capability tools so "I need more information"
// and "nothing here fits" are structured tool calls, not free prose we would
// have to trust and parse.
const CLARIFY = "request_clarification";
const UNSUPPORTED = "report_unsupported";
const metaTools = [
  { name: CLARIFY, description: "Ask the user for one specific missing detail (such as a member number) needed before any capability can be chosen or called.", input_schema: { type: "object" as const, properties: { message: { type: "string" } }, required: ["message"] } },
  { name: UNSUPPORTED, description: "State that none of the available capabilities can address the request.", input_schema: { type: "object" as const, properties: { message: { type: "string" } }, required: ["message"] } }
];

const systemPrompt = `You route a back-office banking request to exactly one action. You MUST call exactly one tool and never reply in prose.

- To do the work, call the matching capability tool with only the inputs the user actually supplied.
- Never invent or guess an identifier (member number, share id, amount). If a required input is missing, call ${CLARIFY} naming what you need.
- If no capability fits the request, call ${UNSUPPORTED}.
- You are choosing an action only. You never see results and never write the final answer.`;

function messageText(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { message?: unknown }).message === "string") {
    return (input as { message: string }).message.trim();
  }
  return "";
}

// Keep only inputs the capability actually declares. A model that hallucinates
// an argument cannot smuggle it into a run; an unknown input is dropped here and
// would in any case be rejected downstream.
function knownInputs(entry: CatalogEntry, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const declared = new Set(Object.keys(entry.tool.input_schema.properties));
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([name]) => declared.has(name)));
}

export async function routeQuestion(options: RouteOptions): Promise<RouteDecision> {
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  const tools = [...options.catalog.map((entry) => entry.tool), ...metaTools];
  const response = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 500, system: systemPrompt, tools,
      // Force a tool call: the router must return structure, never prose.
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: options.question }]
    })
  }, { ...options.retry, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const payload = await response.json() as MessagesResponse;
  if (!response.ok) throw new Error(`Anthropic Messages API error ${response.status}: ${payload.error?.message ?? "unknown error"}`);

  const call = payload.content?.find((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
  // Fail closed: no tool call (the model answered in prose despite the
  // instruction, or returned nothing) is treated as unsupported, never as an
  // answer we forward to the user.
  if (!call) return { kind: "unsupported", message: "I can only help with the specific banking tasks I have capabilities for, and I could not match your request to one." };

  if (call.name === CLARIFY) return { kind: "clarification", message: messageText(call.input) || "Could you give me a bit more detail?" };
  if (call.name === UNSUPPORTED) return { kind: "unsupported", message: messageText(call.input) || "I do not have a capability that can do that." };

  const entry = options.catalog.find((candidate) => candidate.tool.name === call.name);
  // A tool name outside the catalog is a routing malfunction, not a request:
  // fail closed rather than trying to run something we did not offer.
  if (!entry) return { kind: "unsupported", message: "I could not match your request to an available capability." };

  return { kind: "capability", name: entry.tool.name, inputs: knownInputs(entry, call.input) };
}
