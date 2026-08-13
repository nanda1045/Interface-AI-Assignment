import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { AbstractAction } from "../surface/types.js";

const actionKinds = ["navigate", "click", "focus", "type", "select", "press", "scroll"] as const;

export const policySchema = z.object({
  allowed_origins: z.array(z.string().url()).min(1),
  allowed_path_patterns: z.array(z.string()).min(1),
  allowed_actions: z.array(z.enum(actionKinds)).min(1),
  max_steps: z.number().int().positive().max(100),
  max_duration_ms: z.number().int().positive(),
  risk: z.object({
    discovery_mutations: z.enum(["block", "confirm"]),
    irreversible: z.literal("escalate")
  }).strict()
}).strict();

export type PolicyConfig = z.infer<typeof policySchema>;
export type RiskTier = "read_only" | "mutating" | "irreversible";

export interface PolicyContext {
  risk: RiskTier;
  allowMutations?: boolean;
  targetName?: string;
}

export type PolicyVerdict =
  | { allowed: true; rule: "allowed" }
  | { allowed: false; rule: "action_not_allowed" | "origin_not_allowed" | "route_not_allowed" | "mutation_requires_confirmation" | "irreversible_requires_human"; detail: string };

export class PolicyEngine {
  private readonly pathPatterns: RegExp[];

  public constructor(public readonly config: PolicyConfig) {
    this.pathPatterns = config.allowed_path_patterns.map((pattern) => new RegExp(pattern));
  }

  public static async fromFile(path: string): Promise<PolicyEngine> {
    const contents = await readFile(path, "utf8");
    return new PolicyEngine(policySchema.parse(YAML.parse(contents)));
  }

  public check(action: AbstractAction, context: PolicyContext): PolicyVerdict {
    if (!this.config.allowed_actions.includes(action.kind)) {
      return { allowed: false, rule: "action_not_allowed", detail: `Action ${action.kind} is not in allowed_actions.` };
    }
    if (action.kind === "navigate") {
      let url: URL;
      try {
        url = new URL(action.url);
      } catch {
        return { allowed: false, rule: "origin_not_allowed", detail: "Navigation target is not an absolute URL." };
      }
      if (!this.config.allowed_origins.includes(url.origin)) {
        return { allowed: false, rule: "origin_not_allowed", detail: `Origin ${url.origin} is not allowlisted.` };
      }
      if (!this.pathPatterns.some((pattern) => pattern.test(url.pathname))) {
        return { allowed: false, rule: "route_not_allowed", detail: `Path ${url.pathname} does not match an allowed route.` };
      }
    }
    if (context.risk === "irreversible") {
      return { allowed: false, rule: "irreversible_requires_human", detail: "Irreversible actions require a human control transfer." };
    }
    if (context.risk === "mutating" && !context.allowMutations) {
      return { allowed: false, rule: "mutation_requires_confirmation", detail: `Mutation${context.targetName ? ` (${context.targetName})` : ""} was not explicitly enabled.` };
    }
    return { allowed: true, rule: "allowed" };
  }
}

export function inferRisk(action: AbstractAction, targetName = ""): RiskTier {
  if (action.kind !== "click") return "read_only";
  if (/delete|close account|transfer funds|wire/i.test(targetName)) return "irreversible";
  if (/confirm|submit|save|open account|create/i.test(targetName) && !/search/i.test(targetName)) return "mutating";
  return "read_only";
}
