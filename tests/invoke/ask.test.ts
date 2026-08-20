import { describe, expect, it, vi } from "vitest";
import { buildCatalog } from "../../src/artifact/catalog.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { ask } from "../../src/invoke/ask.js";
import type { ReplayResult } from "../../src/replay/result.js";
import { validArtifact } from "../artifact/schema.test.js";

function catalogOf(risk: CapabilityArtifact["capability"]["risk"] = "read_only") {
  const artifact = structuredClone(validArtifact) as CapabilityArtifact;
  artifact.capability.risk = risk;
  return buildCatalog([artifact]);
}

// Canned Anthropic responses, returned in order across the two turns.
function modelReturning(...payloads: unknown[]) {
  let turn = 0;
  return (async () => new Response(JSON.stringify(payloads[turn++] ?? { content: [] }), { status: 200 })) as unknown as typeof fetch;
}

const picks = (input: unknown) => ({ content: [{ type: "tool_use", id: "call_1", name: "lookup_balance", input }] });
const says = (text: string) => ({ content: [{ type: "text", text }] });
const succeeded: ReplayResult = { status: "success", outputs: { balance: "$3,109.08" }, evidence: "runs/x", stability: { resolutions: 1, matched_tiers: {}, matched_strategies: {}, rescued_steps: [] } };
const base = { apiKey: "test-key", question: "What is member 8832's balance?", retry: { attempts: 1 } };

describe("answering a question by invoking a capability", () => {
  it("runs the capability the model chose and answers from its outputs", async () => {
    const execute = vi.fn(async () => succeeded);
    const result = await ask({
      ...base, catalog: catalogOf(), execute,
      fetchImpl: modelReturning(picks({ member_id: "8832" }), says("The balance is $3,109.08."))
    });
    expect(execute).toHaveBeenCalledWith("lookup_balance@1.0.0", { member_id: "8832" });
    expect(result).toMatchObject({ answer: "The balance is $3,109.08.", invoked: { reference: "lookup_balance@1.0.0", status: "success" } });
  });

  it("hands a business outcome back as an outcome rather than as a failure", async () => {
    // The three-way result contract is what lets a caller tell "no such member"
    // apart from "the automation broke". The distinction has to survive the trip.
    const outcome: ReplayResult = { status: "business_outcome", code: "MEMBER_NOT_FOUND", evidence: "runs/x" };
    let toolResult = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: unknown }[] };
      const last = body.messages.at(-1)?.content;
      if (Array.isArray(last)) toolResult = String((last[0] as { content: string }).content);
      return new Response(JSON.stringify(toolResult ? says("There is no member 9999.") : picks({ member_id: "9999" })), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await ask({ ...base, catalog: catalogOf(), execute: async () => outcome, fetchImpl });
    expect(toolResult).toContain("business_outcome");
    expect(toolResult).toContain("MEMBER_NOT_FOUND");
    expect(result.invoked?.status).toBe("business_outcome");
  });

  it("will not answer a question by changing records unless told to", async () => {
    const execute = vi.fn(async () => succeeded);
    const result = await ask({
      ...base, catalog: catalogOf("mutating"), execute,
      fetchImpl: modelReturning(picks({ member_id: "8832" }))
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.answer).toMatch(/changes records/);
  });

  it("runs a mutating capability once that is explicitly permitted", async () => {
    const execute = vi.fn(async () => succeeded);
    await ask({
      ...base, catalog: catalogOf("mutating"), execute, allowMutations: true,
      fetchImpl: modelReturning(picks({ member_id: "8832" }), says("Done."))
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("refuses a capability that is not in the catalog", async () => {
    // The catalog is the whole set of things that may be invoked; a name outside
    // it is never reached for, however the model came to ask for it.
    const invented = { content: [{ type: "tool_use", id: "call_1", name: "transfer_funds", input: {} }] };
    await expect(ask({ ...base, catalog: catalogOf(), execute: async () => succeeded, fetchImpl: modelReturning(invented) }))
      .rejects.toThrow(/not in the catalog: transfer_funds/);
  });

  it("passes the model's arguments through untouched for contract-aware normalization", async () => {
    // Blind stringification here would let a model satisfy a boolean with
    // "true" or an integer with "12.5". The runner normalizes against the
    // artifact's declared contract; replay validates the result.
    const execute = vi.fn(async () => succeeded);
    await ask({
      ...base, catalog: catalogOf(), execute,
      fetchImpl: modelReturning(picks({ member_id: 8832 }), says("Done."))
    });
    expect(execute).toHaveBeenCalledWith("lookup_balance@1.0.0", { member_id: 8832 });
  });

  it("answers directly when no capability is needed", async () => {
    const execute = vi.fn(async () => succeeded);
    const result = await ask({ ...base, catalog: catalogOf(), execute, fetchImpl: modelReturning(says("I can look up member balances.")) });
    expect(execute).not.toHaveBeenCalled();
    expect(result.answer).toBe("I can look up member balances.");
    expect(result.invoked).toBeUndefined();
  });
});
