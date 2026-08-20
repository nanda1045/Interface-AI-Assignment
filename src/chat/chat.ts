// The chatbot orchestration. It routes the message to one action (model),
// enforces the same risk gates the API does, executes through the shared
// capability path, and formats the answer with deterministic code. The model
// never sees a result and never writes the reply; anything unexpected fails
// closed to a safe message rather than acting or improvising.
import type { CatalogEntry } from "../artifact/catalog.js";
import type { RetryOptions } from "../agent/llm/retry.js";
import type { ReplayResult } from "../replay/result.js";
import { formatResult } from "./format.js";
import { routeQuestion, type RouteDecision, type RouteOptions } from "./router.js";

/** Runs one capability and returns its structured result. Injected so the
 *  chatbot is testable without a browser and cannot reach past the shared
 *  replay path. confirmMutations is supplied by this orchestration, never by
 *  the model, only after the user has confirmed. */
export type CapabilityExecutor = (
  reference: string,
  params: Record<string, unknown>,
  options?: { confirmMutations?: boolean }
) => Promise<ReplayResult>;

export interface ChatOptions {
  message: string;
  catalog: CatalogEntry[];
  execute: CapabilityExecutor;
  apiKey: string;
  model?: string;
  /** The user's explicit confirmation for a data-changing capability. Carried
   *  in the chat envelope, never inferred by the model. */
  confirm?: boolean;
  /** Injectable router for tests; defaults to the real model router. */
  route?: (options: RouteOptions) => Promise<RouteDecision>;
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

export type ChatAction = "answered" | "clarification" | "unsupported" | "confirmation_required" | "human_required";

export interface ChatResult {
  reply: string;
  action: ChatAction;
  invoked?: { reference: string; params: Record<string, unknown>; status: ReplayResult["status"] };
  /** Present on confirmation_required so a client can re-send with confirm. */
  pending?: { capability: string; inputs: Record<string, unknown>; risk: CatalogEntry["risk"] };
}

function describeInputs(inputs: Record<string, unknown>): string {
  const pairs = Object.entries(inputs).map(([name, value]) => `${name}=${String(value)}`);
  return pairs.length ? pairs.join(", ") : "no inputs";
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const route = await (options.route ?? routeQuestion)({
    question: options.message,
    catalog: options.catalog,
    apiKey: options.apiKey,
    ...(options.model ? { model: options.model } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });

  if (route.kind === "clarification") return { reply: route.message, action: "clarification" };
  if (route.kind === "unsupported") return { reply: route.message, action: "unsupported" };

  const entry = options.catalog.find((candidate) => candidate.tool.name === route.name);
  // Router already validated against the catalog; this is a fail-closed backstop.
  if (!entry) return { reply: "I could not match your request to an available capability.", action: "unsupported" };

  // A missing required input is a request for clarification, never a guess.
  const missing = entry.tool.input_schema.required.filter((name) => route.inputs[name] === undefined || route.inputs[name] === null);
  if (missing.length > 0) return { reply: `I need ${missing.join(" and ")} to do that.`, action: "clarification" };

  // Irreversible: explain the human boundary. The chatbot cannot satisfy it -
  // a person must complete the final step in an attended session.
  if (entry.requires_human) {
    return {
      reply: `${entry.reference} moves or locks money and pauses for a human operator to complete the final step. I can't do that from chat — it needs the attended operator console.`,
      action: "human_required"
    };
  }

  // Ordinary mutation: show what would change and require confirmation first.
  if (entry.risk === "mutating" && options.confirm !== true) {
    return {
      reply: `This will run ${entry.reference} (${describeInputs(route.inputs)}), which changes records. Reply to confirm before I proceed.`,
      action: "confirmation_required",
      pending: { capability: entry.reference, inputs: route.inputs, risk: entry.risk }
    };
  }

  const result = await options.execute(entry.reference, route.inputs, entry.risk === "mutating" ? { confirmMutations: true } : undefined);
  const formatted = formatResult(result);
  return {
    reply: formatted.reply,
    action: "answered",
    invoked: { reference: entry.reference, params: route.inputs, status: result.status }
  };
}
