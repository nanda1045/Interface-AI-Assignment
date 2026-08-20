// The chatbot's model boundary. The model does ONE job here: turn a user's
// message into exactly one of three validated outcomes - call this capability,
// ask this clarifying question, or this is unsupported. It never sees a replay
// result and never phrases the final answer; that is deterministic code
// downstream. If the model does anything unexpected, we fail closed.
//
// Uses OpenAI's Responses API with required function-calling, so the model must
// return one structured call rather than free prose.
import { fetchWithRetry, type RetryOptions } from "../agent/llm/retry.js";
import type { CatalogEntry } from "../artifact/catalog.js";

export type RouteDecision =
  | { kind: "capability"; name: string; inputs: Record<string, unknown> }
  | { kind: "clarification"; message: string }
  | { kind: "unsupported"; message: string };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface RouteOptions {
  question: string;
  catalog: CatalogEntry[];
  apiKey: string;
  model?: string;
  /** Prior turns, so a follow-up ("1234") is routed with the context of the
   *  question it answers instead of being treated as a fresh, contextless
   *  request. Routing still returns exactly one validated outcome. */
  history?: ChatTurn[];
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

// Minimal untrusted shape needed to find one Responses API function call.
interface OpenAIResponse {
  output?: { type: string; name?: string; arguments?: string }[];
  error?: { message?: string };
}

// Two meta-tools sit alongside the capability tools so "I need more information"
// and "nothing here fits" are structured function calls, not free prose we would
// have to trust and parse.
const CLARIFY = "request_clarification";
const UNSUPPORTED = "report_unsupported";
const metaTools = [
  { name: CLARIFY, description: "Ask the user for one specific missing detail (such as a member number) needed before any capability can be chosen or called.", parameters: { type: "object" as const, properties: { message: { type: "string" } }, required: ["message"] } },
  { name: UNSUPPORTED, description: "State that none of the available capabilities can address the request.", parameters: { type: "object" as const, properties: { message: { type: "string" } }, required: ["message"] } }
];

const systemPrompt = `You route a back-office banking request to exactly one action. You MUST call exactly one function and never reply in prose.

- To do the work, call the matching capability function with only the inputs the user actually supplied.
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
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
  const tools = [
    ...options.catalog.map((entry) => ({ type: "function" as const, name: entry.tool.name, description: entry.tool.description, parameters: entry.tool.input_schema })),
    ...metaTools.map((tool) => ({ type: "function" as const, ...tool }))
  ];
  const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model, store: false, instructions: systemPrompt,
      // The conversation so far, then the new message, so the model can resolve
      // a follow-up against the question it answers.
      input: [...(options.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })), { role: "user" as const, content: options.question }],
      tools,
      // Force one function call: the router must return structure, never prose.
      tool_choice: "required",
      reasoning: { effort: "low" }
    })
  }, { ...options.retry, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const payload = await response.json() as OpenAIResponse;
  if (!response.ok) throw new Error(`OpenAI Responses API error ${response.status}: ${payload.error?.message ?? "unknown error"}`);

  const call = payload.output?.find((item) => item.type === "function_call");
  // Fail closed: no function call (the model answered in prose despite the
  // instruction, or returned nothing) is treated as unsupported, never as an
  // answer we forward to the user.
  if (!call?.name) return { kind: "unsupported", message: "I can only help with the specific banking tasks I have capabilities for, and I could not match your request to one." };

  let input: unknown = {};
  try { input = call.arguments ? JSON.parse(call.arguments) : {}; } catch { input = {}; }

  if (call.name === CLARIFY) return { kind: "clarification", message: messageText(input) || "Could you give me a bit more detail?" };
  if (call.name === UNSUPPORTED) return { kind: "unsupported", message: messageText(input) || "I do not have a capability that can do that." };

  const entry = options.catalog.find((candidate) => candidate.tool.name === call.name);
  // A function name outside the catalog is a routing malfunction, not a request:
  // fail closed rather than trying to run something we did not offer.
  if (!entry) return { kind: "unsupported", message: "I could not match your request to an available capability." };

  return { kind: "capability", name: entry.tool.name, inputs: knownInputs(entry, input) };
}
