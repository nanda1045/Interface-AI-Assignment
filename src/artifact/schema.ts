// Executable runtime contract for persisted capabilities. Strict Zod objects
// reject unknown fields, constrain every action/locator/predicate shape, and
// cross-check parameter and output references before replay can load an artifact.
import { z } from "zod";

// Unknown keys are rejected everywhere instead of being silently retained.
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// Exact schema for each of the seven verified locator strategy kinds.
const roleName = strict({ kind: z.literal("role_name"), role: z.string(), name: z.string(), frame: z.string(), unique: z.literal(true), confidence: z.number().min(0).max(1) });
const labelProximity = strict({ kind: z.literal("label_proximity"), label: z.string(), control: z.string(), frame: z.string(), unique: z.literal(true), confidence: z.number().min(0).max(1) });
const text = strict({ kind: z.literal("text"), value: z.string(), control: z.string().optional(), frame: z.string(), unique: z.literal(true), confidence: z.number().min(0).max(1) });
const labelAdjacentCell = strict({ kind: z.literal("label_adjacent_cell"), label: z.string(), frame: z.string(), unique: z.literal(true), confidence: z.number().min(0).max(1) });
const attrCss = strict({ kind: z.literal("attr_css"), value: z.string(), frame: z.string(), unique: z.literal(true), confidence: z.number().min(0).max(1) });
const structural = strict({ kind: z.literal("structural"), value: z.string(), frame: z.string(), unique: z.literal(true), confidence: z.number().min(0).max(1) });
const geometry = strict({ kind: z.literal("geometry"), bboxPct: z.tuple([z.number(), z.number(), z.number(), z.number()]), nearText: z.string().optional(), frame: z.string(), unique: z.literal(true), confidence: z.number().min(0).max(1) });
export const locatorStrategySchema = z.discriminatedUnion("kind", [roleName, labelProximity, text, labelAdjacentCell, attrCss, structural, geometry]);
export const targetSchema = strict({ frame: z.string().optional(), strategies: z.array(locatorStrategySchema).min(1) });

// Small JSON-like contracts describe accepted invocation inputs and returned
// outputs, including sensitivity and parsing-format metadata.
const jsonPropertySchema = strict({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().optional(),
  pattern: z.string().optional(),
  sensitive: z.boolean().optional(),
  "x-format": z.string().optional()
});

export const objectContractSchema = strict({
  type: z.literal("object"),
  required: z.array(z.string()),
  properties: z.record(z.string(), jsonPropertySchema)
}).superRefine((contract, context) => {
  // A required name must also have a declared property schema.
  for (const required of contract.required) {
    if (!(required in contract.properties)) context.addIssue({ code: "custom", message: `Required property ${required} is not declared.` });
  }
});

// Replay actions are declarative and bounded. Type/select values must come from
// named parameters, so credentials or discovery literals cannot hide here.
const actionSchema = z.discriminatedUnion("kind", [
  strict({ kind: z.literal("navigate"), url: z.string().url() }),
  strict({ kind: z.enum(["click", "focus"]) }),
  strict({ kind: z.literal("type"), value_from: strict({ param: z.string() }), sensitive: z.boolean().optional() }),
  strict({ kind: z.literal("select"), value_from: strict({ param: z.string() }) }),
  strict({ kind: z.literal("press"), key: z.string() }),
  strict({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]) })
]);

// Closed predicate vocabulary used for preconditions, step postconditions,
// business outcomes, recovery conditions, and the final checkpoint.
export const predicateSchema = z.discriminatedUnion("kind", [
  strict({ kind: z.literal("text_visible"), pattern: z.string(), frame: z.string().optional() }),
  strict({ kind: z.literal("element_present"), target: targetSchema }),
  strict({ kind: z.literal("value_equals_param"), param: z.string() }),
  strict({ kind: z.literal("url_matches"), pattern: z.string() }),
  strict({ kind: z.literal("dialog_present"), textPattern: z.string() })
]);

const stepSchema = strict({
  id: z.string().regex(/^s\d+$/),
  intent: z.string().min(1),
  action: actionSchema,
  target: targetSchema.optional(),
  wait: strict({ readyWhen: z.enum(["target_resolvable", "page_loaded"]), timeout_ms: z.number().int().positive() }),
  postconditions: z.array(predicateSchema)
}).superRefine((step, context) => {
  // Element actions are invalid without a durable target locator ladder.
  if (["click", "focus", "type", "select"].includes(step.action.kind) && !step.target) {
    context.addIssue({ code: "custom", message: `Action ${step.action.kind} requires a target.` });
  }
});

// Recovery is intentionally narrower than normal steps: one declared condition,
// one target click, and a positive attempt limit.
const recoverySchema = strict({
  id: z.string(),
  condition: predicateSchema,
  action: strict({ kind: z.literal("click"), target: targetSchema }),
  max_attempts: z.number().int().positive()
});

// Complete immutable capability document: identity/provenance, contracts, entry,
// ordered steps, success checkpoint, extraction, outcomes, recovery, and policy.
export const capabilityArtifactSchema = strict({
  schema_version: z.literal("1.0"),
  capability: strict({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    app: strict({ id: z.string(), vendor: z.string(), ui_version_range: z.string() }),
    risk: z.enum(["read_only", "mutating", "irreversible"]),
    status: z.enum(["draft", "approved"]),
    provenance: strict({
      discovered_by: z.string(),
      discovery_run: z.string(),
      recorded_at: z.string().datetime(),
      approved_by: z.string().nullable(),
      approved_at: z.string().datetime().nullable(),
      // Equality fingerprints let approval compare invocations without storing
      // the literal discovery values in these fields.
      input_fingerprint: z.record(z.string(), z.string()).optional(),
      // Successful validation evidence is absent/null while the artifact is draft.
      validation: strict({
        run: z.string(),
        validated_at: z.string().datetime(),
        outcome: z.literal("success"),
        reused_params: z.array(z.string()),
        matched_tiers: z.record(z.string(), z.number())
      }).nullable().optional()
    })
  }),
  inputs: objectContractSchema,
  outputs: objectContractSchema,
  entry: strict({
    url: z.string().url(),
    preconditions: z.array(strict({ kind: z.enum(["authenticated", "text_visible"]), via: z.string().optional(), pattern: z.string().optional() }))
  }),
  steps: z.array(stepSchema).min(1),
  checkpoint: strict({ assert: z.array(predicateSchema).min(1) }),
  extract: z.array(strict({ output: z.string(), from: targetSchema, parse: z.enum(["text", "currency", "number"]) })),
  outcomes: z.array(strict({ code: z.string().regex(/^[A-Z][A-Z0-9_]*$/), at_steps: z.array(z.string()), when: z.array(predicateSchema).min(1), returns: z.record(z.string(), z.unknown()).optional() })),
  recovery: z.array(recoverySchema),
  policy: strict({ allowed_origins: z.array(z.string().url()).min(1), allowed_actions: z.array(z.enum(["navigate", "click", "focus", "type", "select", "press", "scroll"])), max_duration_ms: z.number().int().positive() })
}).superRefine((artifact, context) => {
  // Shape validation is not enough: every step parameter and extraction output
  // must refer to a name declared in the corresponding input/output contract.
  const inputNames = new Set(Object.keys(artifact.inputs.properties));
  const outputNames = new Set(Object.keys(artifact.outputs.properties));
  artifact.steps.forEach((step, index) => {
    if ((step.action.kind === "type" || step.action.kind === "select") && !inputNames.has(step.action.value_from.param)) {
      context.addIssue({ code: "custom", path: ["steps", index, "action", "value_from", "param"], message: "Parameter is not declared in inputs." });
    }
  });
  artifact.extract.forEach((extract, index) => {
    if (!outputNames.has(extract.output)) context.addIssue({ code: "custom", path: ["extract", index, "output"], message: "Extraction output is not declared in outputs." });
  });
});

// Infer TypeScript types from the runtime schemas so compile-time and persisted
// artifact contracts remain sourced from the same definitions.
export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
export type ObjectContract = z.infer<typeof objectContractSchema>;
