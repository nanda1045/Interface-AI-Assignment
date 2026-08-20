import { describe, expect, it, vi } from "vitest";
import { chat, type CapabilityExecutor } from "../../src/chat/chat.js";
import type { CatalogEntry } from "../../src/artifact/catalog.js";
import type { RouteDecision } from "../../src/chat/router.js";
import type { ReplayResult } from "../../src/replay/result.js";

const stability = { resolutions: 1, matched_strategies: {}, matched_tiers: {} };
const success = (outputs: Record<string, unknown>) => ({ status: "success", outputs, evidence: "x", stability }) as unknown as ReplayResult;

function entry(over: Partial<CatalogEntry> & { name: string; risk: CatalogEntry["risk"]; requires_human?: boolean; required?: string[] }): CatalogEntry {
  return {
    reference: `${over.name}@1.0.0`,
    risk: over.risk,
    requires_human: over.requires_human ?? false,
    tool: { name: over.name, description: "d", input_schema: { type: "object", properties: { member_id: { type: "string" }, last_name: { type: "string" }, amount: { type: "string" } }, required: over.required ?? [] } }
  };
}

const catalog = [
  entry({ name: "get_balance", risk: "read_only", required: ["member_id"] }),
  entry({ name: "update_phone", risk: "mutating", required: ["member_id"] }),
  entry({ name: "transfer_funds", risk: "irreversible", requires_human: true, required: ["member_id"] })
];

// A router that always returns the given decision, so chat is tested without a model.
const router = (decision: RouteDecision) => async () => decision;
const base = (execute: CapabilityExecutor, route: RouteDecision, confirm?: boolean) => ({
  message: "do the thing", catalog, execute, apiKey: "k", route: router(route), ...(confirm !== undefined ? { confirm } : {})
});

describe("chat orchestration", () => {
  it("runs a read-only capability and formats its result with code", async () => {
    const execute = vi.fn(async () => success({ savings_balance: "$10.00" })) as unknown as CapabilityExecutor;
    const result = await chat(base(execute, { kind: "capability", name: "get_balance", inputs: { member_id: "4521" } }));
    expect(result.action).toBe("answered");
    expect(result.reply).toContain("$10.00");
    expect(result.invoked?.reference).toBe("get_balance@1.0.0");
  });

  it("passes a clarification and an unsupported straight through without running anything", async () => {
    const execute = vi.fn() as unknown as CapabilityExecutor;
    expect(await chat(base(execute, { kind: "clarification", message: "Which member?" }))).toMatchObject({ action: "clarification", reply: "Which member?" });
    expect(await chat(base(execute, { kind: "unsupported", message: "Can't do that." }))).toMatchObject({ action: "unsupported" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("asks for a missing required input instead of guessing it", async () => {
    const execute = vi.fn() as unknown as CapabilityExecutor;
    const result = await chat(base(execute, { kind: "capability", name: "get_balance", inputs: {} }));
    expect(result.action).toBe("clarification");
    expect(result.reply).toContain("member_id");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires confirmation before a mutation, then runs it with confirmMutations", async () => {
    const execute = vi.fn(async () => success({ status_line: "updated" })) as unknown as CapabilityExecutor;
    const denied = await chat(base(execute, { kind: "capability", name: "update_phone", inputs: { member_id: "4521" } }));
    expect(denied.action).toBe("confirmation_required");
    expect(denied.pending).toMatchObject({ capability: "update_phone@1.0.0", risk: "mutating" });
    expect(execute).not.toHaveBeenCalled();

    const confirmed = await chat(base(execute, { kind: "capability", name: "update_phone", inputs: { member_id: "4521" } }, true));
    expect(confirmed.action).toBe("answered");
    expect(execute).toHaveBeenCalledWith("update_phone@1.0.0", { member_id: "4521" }, { confirmMutations: true });
  });

  it("explains the human boundary for an irreversible request and never runs it", async () => {
    const execute = vi.fn() as unknown as CapabilityExecutor;
    const result = await chat(base(execute, { kind: "capability", name: "transfer_funds", inputs: { member_id: "4521" } }, true));
    expect(result.action).toBe("human_required");
    expect(result.reply).toContain("human operator");
    expect(execute).not.toHaveBeenCalled();
  });
});
