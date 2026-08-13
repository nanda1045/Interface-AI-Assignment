import { z } from "zod";
import type { AgentDecision, ToolDefinition } from "./llm/client.js";

const reasoning = { reasoning: { type: "string", description: "Briefly explain why this is the safest next action." } };
const strictObject = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

export const agentTools: ToolDefinition[] = [
  { name: "navigate", description: "Navigate to an allowlisted absolute URL.", parameters: strictObject({ url: { type: "string" }, ...reasoning }, ["url", "reasoning"]) },
  { name: "click", description: "Click one element ref from the latest observation.", parameters: strictObject({ ref: { type: "string" }, ...reasoning }, ["ref", "reasoning"]) },
  { name: "focus", description: "Focus one element ref from the latest observation.", parameters: strictObject({ ref: { type: "string" }, ...reasoning }, ["ref", "reasoning"]) },
  { name: "type", description: "Replace the value of an editable ref. Mark credentials, member IDs, account data, or PII sensitive.", parameters: strictObject({ ref: { type: "string" }, text: { type: "string" }, sensitive: { type: "boolean" }, ...reasoning }, ["ref", "text", "sensitive", "reasoning"]) },
  { name: "select", description: "Select an option value.", parameters: strictObject({ ref: { type: "string" }, value: { type: "string" }, ...reasoning }, ["ref", "value", "reasoning"]) },
  { name: "press", description: "Press a keyboard key.", parameters: strictObject({ key: { type: "string" }, ...reasoning }, ["key", "reasoning"]) },
  { name: "scroll", description: "Scroll the current page.", parameters: strictObject({ direction: { type: "string", enum: ["up", "down"] }, ...reasoning }, ["direction", "reasoning"]) },
  { name: "note_output", description: "Mark a visible ref as a named goal output before finishing.", parameters: strictObject({ name: { type: "string" }, ref: { type: "string" }, ...reasoning }, ["name", "ref", "reasoning"]) },
  { name: "finish", description: "Finish only after the goal is visibly satisfied and outputs were marked.", parameters: strictObject({ ...reasoning }, ["reasoning"]) },
  { name: "escalate", description: "Stop and request a human when blocked or unsafe.", parameters: strictObject({ reason: { type: "string" }, ...reasoning }, ["reason", "reasoning"]) }
];

const base = { reasoning: z.string().min(1) };
const decisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().url(), ...base }).strict(),
  z.object({ kind: z.literal("click"), ref: z.string(), ...base }).strict(),
  z.object({ kind: z.literal("focus"), ref: z.string(), ...base }).strict(),
  z.object({ kind: z.literal("type"), ref: z.string(), text: z.string(), sensitive: z.boolean(), ...base }).strict(),
  z.object({ kind: z.literal("select"), ref: z.string(), value: z.string(), ...base }).strict(),
  z.object({ kind: z.literal("press"), key: z.string(), ...base }).strict(),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]), ...base }).strict(),
  z.object({ kind: z.literal("note_output"), name: z.string(), ref: z.string(), ...base }).strict(),
  z.object({ kind: z.literal("finish"), ...base }).strict(),
  z.object({ kind: z.literal("escalate"), reason: z.string(), ...base }).strict()
]);

export function parseDecision(name: string, input: unknown): AgentDecision {
  return decisionSchema.parse({ kind: name, ...(input as object) });
}
