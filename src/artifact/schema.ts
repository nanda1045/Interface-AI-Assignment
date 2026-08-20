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
// Structured tabular output: an array of uniform objects with scalar fields,
// extracted deterministically from a table element. Inputs never take this
// shape - the engine rejects an array-typed input contract by name.
const tablePropertySchemaFactory = () => strict({
  type: z.literal("array"),
  description: z.string().optional(),
  sensitive: z.boolean().optional(),
  items: strict({
    type: z.literal("object"),
    properties: z.record(z.string(), jsonPropertySchema)
  })
});

const jsonPropertySchema = strict({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().optional(),
  pattern: z.string().optional(),
  sensitive: z.boolean().optional(),
  "x-format": z.string().optional()
});

const tablePropertySchema = tablePropertySchemaFactory();

export const objectContractSchema = strict({
  type: z.literal("object"),
  required: z.array(z.string()),
  properties: z.record(z.string(), z.union([jsonPropertySchema, tablePropertySchema]))
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
  // "human_required" marks a step the machine verified but must never perform:
  // replay resolves the target to prove the screen is right, then pauses and a
  // person completes the action in the same browser. Absent means "agent".
  execution: z.enum(["agent", "human_required"]).optional(),
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
  max_attempts: z.number().int().positive(),
  // What the recovery click achieves. "continue" is the classic dismissed
  // modal: the interrupted screen is still there. Some interstitials exit the
  // flow entirely - MERIDIAN's maintenance Continue lands on the main menu -
  // so a rule can declare that the step must be retried or the capability
  // restarted from its entry. Absent means "continue".
  effect: z.enum(["continue", "retry_current_step", "restart_capability"]).optional()
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
  extract: z.array(strict({
    output: z.string(),
    from: targetSchema,
    parse: z.enum(["text", "currency", "number", "table"]),
    // Table extraction maps live header text to declared item properties, so a
    // reordered column keeps its meaning and a missing one fails loudly.
    columns: z.array(strict({ header: z.string(), property: z.string() })).optional()
  })),
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

    // Table extraction and the array contract it fills must agree completely:
    // a mapping that references a property the items do not declare, or a
    // scalar parse pointed at an array output, would only fail later and
    // further from the cause.
    const declared = artifact.outputs.properties[extract.output];
    if (extract.parse === "table") {
      if (!extract.columns || extract.columns.length === 0) {
        context.addIssue({ code: "custom", path: ["extract", index, "columns"], message: "Table extraction requires a column mapping." });
        return;
      }
      if (!declared || declared.type !== "array") {
        context.addIssue({ code: "custom", path: ["extract", index, "output"], message: "Table extraction must fill an array-typed output." });
        return;
      }
      const properties = new Set<string>();
      const headers = new Set<string>();
      extract.columns.forEach((column, columnIndex) => {
        if (!(column.property in declared.items.properties)) {
          context.addIssue({ code: "custom", path: ["extract", index, "columns", columnIndex, "property"], message: `Column property ${column.property} is not declared in the output's items.` });
        }
        if (properties.has(column.property)) {
          context.addIssue({ code: "custom", path: ["extract", index, "columns", columnIndex, "property"], message: `Column property ${column.property} is mapped twice.` });
        }
        properties.add(column.property);
        const header = column.header.trim().toLowerCase();
        if (header === "") {
          context.addIssue({ code: "custom", path: ["extract", index, "columns", columnIndex, "header"], message: "Column header is blank; replay could not match it." });
        }
        if (headers.has(header)) {
          context.addIssue({ code: "custom", path: ["extract", index, "columns", columnIndex, "header"], message: `Column header "${column.header}" appears twice; matching by header would be ambiguous.` });
        }
        headers.add(header);
      });
    } else {
      if (extract.columns) context.addIssue({ code: "custom", path: ["extract", index, "columns"], message: "Only table extraction takes a column mapping." });
      if (declared && declared.type === "array") context.addIssue({ code: "custom", path: ["extract", index, "parse"], message: "An array-typed output needs table extraction." });
    }
  });

  // Every required output must be produced by exactly one extraction; a missing
  // rule can never satisfy the contract and duplicates would race each other.
  for (const required of artifact.outputs.required) {
    const producers = artifact.extract.filter((extract) => extract.output === required).length;
    if (producers !== 1) {
      context.addIssue({ code: "custom", path: ["extract"], message: `Required output ${required} has ${producers} extraction rules; it needs exactly one.` });
    }
  }

  // An irreversible capability must carry its human boundary in a shape replay
  // can actually honour: the final business action is the human step, it has a
  // verified target to prove the screen, and nothing agent-executed follows it
  // (the capability checkpoint is the completion proof for a final step). The
  // runtime enforces this too - this check keeps a malformed artifact from ever
  // being stored as reviewable.
  // The implication runs both ways. A human boundary in a capability whose
  // declared risk is not irreversible would list in the catalog as
  // requires_human: false - a capability that pauses for a person while
  // claiming it does not. Rejection is chosen over silently deriving the risk:
  // the tier is a reviewed declaration, not something a recording infers.
  const humanBounded = artifact.steps.some((step) => step.execution === "human_required");
  if (humanBounded && artifact.capability.risk !== "irreversible") {
    context.addIssue({ code: "custom", path: ["capability", "risk"], message: "A capability with a human_required step must declare risk irreversible; record it with --risk irreversible." });
  }
  if (artifact.capability.risk === "irreversible") {
    const last = artifact.steps[artifact.steps.length - 1];
    const humanIndex = artifact.steps.findIndex((step) => step.execution === "human_required");
    if (humanIndex === -1) {
      context.addIssue({ code: "custom", path: ["steps"], message: "An irreversible capability must record a human_required step." });
    } else if (last?.execution !== "human_required") {
      context.addIssue({ code: "custom", path: ["steps"], message: "The final step of an irreversible capability must be the human_required boundary; agent-executed steps after it would perform the irreversible work unattended." });
    } else if (!last.target) {
      context.addIssue({ code: "custom", path: ["steps", artifact.steps.length - 1, "target"], message: "The human_required boundary needs a target locator so replay can verify the screen before pausing." });
    }
  }
});

// Infer TypeScript types from the runtime schemas so compile-time and persisted
// artifact contracts remain sourced from the same definitions.
export type CapabilityArtifact = z.infer<typeof capabilityArtifactSchema>;
export type ObjectContract = z.infer<typeof objectContractSchema>;
