// Deployment-level authorization and runtime risk classification shared by
// discovery and replay. The engine returns allow/deny verdicts only; Surface is
// called later and cannot be reached through this module.
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { AbstractAction } from "../surface/types.js";

// Closed action vocabulary accepted by the deployment policy file.
const actionKinds = ["navigate", "click", "focus", "type", "select", "press", "scroll"] as const;

// Strictly validate operator-controlled YAML before it can authorize any run.
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

// Per-action runtime facts supplied by discovery/replay in addition to the static
// deployment policy. Explicit mutation permission never permits irreversible work.
export interface PolicyContext {
  risk: RiskTier;
  allowMutations?: boolean;
  targetName?: string;
}

// Named verdict rules make denial reasons auditable and machine-classifiable.
export type PolicyVerdict =
  | { allowed: true; rule: "allowed" }
  | { allowed: false; rule: "action_not_allowed" | "origin_not_allowed" | "route_not_allowed" | "mutation_requires_confirmation" | "irreversible_requires_human"; detail: string };

export class PolicyEngine {
  private readonly pathPatterns: RegExp[];

  // Compile route patterns once when loading policy rather than on every action.
  public constructor(public readonly config: PolicyConfig) {
    this.pathPatterns = config.allowed_path_patterns.map((pattern) => new RegExp(pattern));
  }

  // Parse YAML as untrusted configuration and validate it through Zod.
  public static async fromFile(path: string): Promise<PolicyEngine> {
    const contents = await readFile(path, "utf8");
    return new PolicyEngine(policySchema.parse(YAML.parse(contents)));
  }

  // Enforce action kind first, navigation origin/path second, and runtime risk
  // last. Passing this function is authorization, not execution.
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

    // Irreversible actions always require human transfer, even when ordinary
    // mutations were explicitly enabled for this run.
    if (context.risk === "irreversible") {
      return { allowed: false, rule: "irreversible_requires_human", detail: "Irreversible actions require a human control transfer." };
    }
    if (context.risk === "mutating" && !context.allowMutations) {
      return { allowed: false, rule: "mutation_requires_confirmation", detail: `Mutation${context.targetName ? ` (${context.targetName})` : ""} was not explicitly enabled.` };
    }
    return { allowed: true, rule: "allowed" };
  }
}

// Observational defence-in-depth: classify click intent from the current visible
// target name when available, otherwise from the saved intent supplied by caller.
// This heuristic can make policy stricter; it does not replace declared controls.
export function inferRisk(action: AbstractAction, targetName = ""): RiskTier {
  if (action.kind !== "click") return "read_only";
  if (/delete|close account|transfer funds|wire/i.test(targetName)) return "irreversible";
  if (/confirm|submit|save|open account|create/i.test(targetName) && !/search/i.test(targetName)) return "mutating";
  return "read_only";
}
