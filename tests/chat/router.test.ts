import { describe, expect, it } from "vitest";
import { routeQuestion } from "../../src/chat/router.js";
import type { CatalogEntry } from "../../src/artifact/catalog.js";

// A fetch that returns one canned OpenAI Responses payload, so the router is
// tested without a model call.
function modelReturning(output: unknown[]): typeof fetch {
  return (async () => new Response(JSON.stringify({ output }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}
// One function_call output item in the Responses API shape.
const fnCall = (name: string, args: unknown) => ({ type: "function_call", name, arguments: JSON.stringify(args) });

const findMembers: CatalogEntry = {
  reference: "find_members_by_last_name@1.0.0",
  risk: "read_only",
  requires_human: false,
  tool: { name: "find_members_by_last_name", description: "Search members by last name.", input_schema: { type: "object", properties: { last_name: { type: "string" } }, required: ["last_name"] } }
};
const catalog = [findMembers];
const base = { question: "find members named Turing", catalog, apiKey: "k" };

describe("chat router", () => {
  it("returns a validated capability call keeping only declared inputs", async () => {
    const fetchImpl = modelReturning([fnCall("find_members_by_last_name", { last_name: "Turing", extra: "drop me" })]);
    const decision = await routeQuestion({ ...base, fetchImpl });
    expect(decision).toEqual({ kind: "capability", name: "find_members_by_last_name", inputs: { last_name: "Turing" } });
  });

  it("surfaces a clarification request as its own outcome", async () => {
    const fetchImpl = modelReturning([fnCall("request_clarification", { message: "Which last name?" })]);
    expect(await routeQuestion({ ...base, fetchImpl })).toEqual({ kind: "clarification", message: "Which last name?" });
  });

  it("surfaces an unsupported report as its own outcome", async () => {
    const fetchImpl = modelReturning([fnCall("report_unsupported", { message: "I can't reset passwords." })]);
    expect(await routeQuestion({ ...base, fetchImpl })).toEqual({ kind: "unsupported", message: "I can't reset passwords." });
  });

  it("fails closed when the model answers in prose instead of calling a tool", async () => {
    const fetchImpl = modelReturning([{ type: "message", content: "Sure, the balance is probably fine." }]);
    const decision = await routeQuestion({ ...base, fetchImpl });
    expect(decision.kind).toBe("unsupported");
  });

  it("fails closed when the model names a capability outside the catalog", async () => {
    const fetchImpl = modelReturning([fnCall("delete_everything", {})]);
    expect((await routeQuestion({ ...base, fetchImpl })).kind).toBe("unsupported");
  });
});
