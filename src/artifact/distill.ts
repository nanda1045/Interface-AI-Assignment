// Deterministic compiler from a successful discovery trajectory to a typed,
// parameterized capability artifact. It makes no second LLM call, removes
// run-specific data/locators, derives policy, and validates the final contract.
import { createHash } from "node:crypto";
import type { DiscoveryResult, RecordedStep } from "../agent/loop.js";
import { redactString } from "../policy/redact.js";
import type { AbstractAction, LocatorBundle, LocatorStrategy, TargetSpec } from "../surface/types.js";
import { capabilityArtifactSchema, type CapabilityArtifact, type ObjectContract } from "./schema.js";

export interface DistillOptions {
  id: string;
  title: string;
  description: string;
  entryUrl: string;
  model: string;
  runId: string;
  params: Record<string, string>;
  inputs: ObjectContract;
  outputs: ObjectContract;
  risk?: "read_only" | "mutating" | "irreversible";
  recordedAt?: Date;
  // The first recording defaults to 1.0.0; re-recording supplies a bumped version.
  version?: string;
  // Values collected by the evidence logger and scrubbed from artifact strings.
  sensitiveValues?: readonly string[];
  /** Which application this capability belongs to, from the app profile.
   *  Defaults to the fictional CorePoint target for compatibility. */
  app?: CapabilityArtifact["capability"]["app"];
  /** Authoring templates from the app profile. The selected concrete rules are
   *  copied into the artifact, so replay still follows a reviewable contract -
   *  the profile informs authoring, it is never consulted at run time. */
  outcomeTemplates?: OutcomeTemplate[];
  recoveryTemplates?: CapabilityArtifact["recovery"];
  authenticatedVia?: string;
}

export interface OutcomeTemplate {
  code: string;
  when: CapabilityArtifact["outcomes"][number]["when"];
  returns?: Record<string, unknown>;
}

// CorePoint's authoring defaults, kept so existing behaviour is unchanged when
// no profile is supplied. profiles/corepoint.yaml carries the same values.
const corePointOutcomeTemplates: OutcomeTemplate[] = [
  { code: "MEMBER_NOT_FOUND", when: [{ kind: "text_visible", pattern: "No member found", frame: "workarea" }], returns: { found: false } },
  { code: "PERMISSION_DENIED", when: [{ kind: "text_visible", pattern: "Access denied", frame: "workarea" }] }
];

const corePointRecoveryTemplates: CapabilityArtifact["recovery"] = [{
  id: "dismiss_session_modal",
  condition: { kind: "dialog_present", textPattern: "Session expiring" },
  action: { kind: "click", target: { strategies: [{ kind: "role_name", role: "button", name: "Continue", frame: "workarea", unique: true, confidence: 0.9 }] } },
  max_attempts: 1
}];

// Very short values would accidentally match common locator syntax and remove
// almost every strategy, so taint matching starts at three characters.
const minimumTaintedLength = 3;

// Store comparison fingerprints rather than literal discovery inputs so approval
// can reject an identical invocation without writing the original value directly.
export function fingerprintParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex").slice(0, 16)])
  );
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => needle.length >= minimumTaintedLength && haystack.includes(needle));
}

// Remove every locator containing an invocation/sensitive value. Keep the safe
// remainder of the ladder, but fail closed when no reusable strategy remains.
function untaintedTarget(bundle: LocatorBundle, tainted: readonly string[], describe: string): TargetSpec {
  const strategies: LocatorStrategy[] = bundle.strategies.filter((strategy) => !containsAny(JSON.stringify(strategy), tainted));
  if (strategies.length === 0) throw new Error(`Every locator strategy for ${describe} was built from run-specific data.`);
  return { frame: strategies[0]?.frame, strategies };
}

// Compare repeated targets using non-geometry strategies because coordinates can
// move slightly between two observations of the same logical element.
function targetIdentity(bundle?: LocatorBundle): string | undefined {
  const semantic = bundle?.strategies.filter((strategy) => strategy.kind !== "geometry") ?? [];
  return semantic.length > 0 ? JSON.stringify(semantic) : undefined;
}

// Collapse only consecutive identical type/select operations on the same target.
// Repeated clicks are preserved because they may represent meaningful actions.
function repeatsNextValue(step: RecordedStep, next: RecordedStep): boolean {
  const identity = targetIdentity(step.locators);
  if (!identity || identity !== targetIdentity(next.locators)) return false;
  if (step.action.kind === "type" && next.action.kind === "type") return step.action.text === next.action.text;
  if (step.action.kind === "select" && next.action.kind === "select") return step.action.value === next.action.value;
  return false;
}

// Replace recorded type/select literals with references to declared parameters.
// Ambiguous, constant, or unused values fail instead of leaking into the artifact.
function bindAction(action: AbstractAction, params: Record<string, string>, used: Set<string>): CapabilityArtifact["steps"][number]["action"] {
  if (action.kind === "type" || action.kind === "select") {
    const value = action.kind === "type" ? action.text : action.value;
    const matches = Object.entries(params).filter(([, candidate]) => candidate === value);
    if (matches.length !== 1) throw new Error(`Could not uniquely bind recorded ${action.kind} value to a supplied parameter.`);
    const param = matches[0]?.[0];
    if (!param) throw new Error(`Could not bind recorded ${action.kind} value.`);
    used.add(param);
    return action.kind === "type"
      ? { kind: "type", value_from: { param }, ...(action.sensitive ? { sensitive: true } : {}) }
      : { kind: "select", value_from: { param } };
  }
  if (action.kind === "navigate") return { kind: "navigate", url: action.url };
  if (action.kind === "press") return { kind: "press", key: action.key };
  if (action.kind === "scroll") return { kind: "scroll", direction: action.direction };
  return { kind: action.kind };
}

// Compile one recorded action into an artifact step with safe intent text,
// durable target, wait rule, and deterministic postconditions.
function distillStep(
  recorded: RecordedStep,
  index: number,
  params: Record<string, string>,
  used: Set<string>,
  tainted: readonly string[]
): CapabilityArtifact["steps"][number] {
  const action = bindAction(recorded.action, params, used);
  const target = recorded.locators ? untaintedTarget(recorded.locators, tainted, `step ${index + 1}`) : undefined;
  const targetName = target?.strategies.find((strategy) => strategy.kind === "role_name");
  const rawIntent = recorded.reasoning || `${recorded.action.kind} ${targetName && "name" in targetName ? targetName.name : "the target control"}`;
  const parameterized = Object.entries(params).reduce(
    (current, [name, value]) => value ? current.split(value).join(`{{${name}}}`) : current,
    rawIntent
  );

  // Model reasoning may repeat data read from the page, so parameterize known
  // inputs and redact every remaining run-sensitive value before persistence.
  const intent = redactString(parameterized, tainted);
  const postconditions: CapabilityArtifact["steps"][number]["postconditions"] = [];
  if (action.kind === "type" || action.kind === "select") postconditions.push({ kind: "value_equals_param", param: action.value_from.param });
  if (recorded.afterUrl !== recorded.beforeUrl) postconditions.push({ kind: "url_matches", pattern: `^${recorded.afterUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` });
  return {
    id: `s${index + 1}`,
    intent,
    action,
    ...(target ? { target } : {}),
    wait: { readyWhen: target ? "target_resolvable" : "page_loaded", timeout_ms: 10_000 },
    postconditions
  };
}

// Compile only a successful, non-empty discovery and fail closed whenever the
// result cannot become a complete, reusable, schema-valid capability.
export function distillDiscovery(result: DiscoveryResult, options: DistillOptions): CapabilityArtifact {
  if (result.status !== "success") throw new Error(`Cannot distill a ${result.status} discovery run.`);
  if (result.steps.length === 0) throw new Error("Cannot distill a discovery run with no recorded actions.");
  const used = new Set<string>();

  // Every invocation value is run-specific even when it is not classified as
  // sensitive; locators containing one would fail for future invocations.
  const tainted = [...new Set([...Object.values(options.params), ...(options.sensitiveValues ?? [])])].filter(Boolean);

  // Keep the final step in each consecutive repeated type/select run because it
  // contains the settled after-URL used to derive postconditions.
  const recorded = result.steps.filter((step, index) => {
    const next = result.steps[index + 1];
    return !(next && repeatsNextValue(step, next));
  });
  const steps = recorded.map((step, index) => distillStep(step, index, options.params, used, tainted));
  const unbound = Object.keys(options.params).filter((param) => !used.has(param));
  if (unbound.length > 0) throw new Error(`Supplied parameters were never bound: ${unbound.join(", ")}`);
  const outputEntries = Object.entries(result.outputs);
  if (outputEntries.length === 0) throw new Error("Discovery finished without any note_output calls.");

  // Output extraction also uses taint-safe locator ladders. Parsing behaviour is
  // derived from the declared output contract, not from model reasoning.
  const extract = outputEntries.map(([output, bundle]) => ({
    output,
    from: untaintedTarget(bundle, tainted, `extraction of ${output}`),
    parse: options.outputs.properties[output]?.["x-format"] === "usd-currency" ? "currency" as const : "text" as const
  }));

  // Known bounded recovery is explicit in the artifact rather than improvised by
  // the model during replay. Templates come from the app profile at authoring
  // time; the copied rules are what reviewers approve and replay follows.
  const recovery: CapabilityArtifact["recovery"] = options.recoveryTemplates ?? corePointRecoveryTemplates;

  // Derive least privilege from recorded steps plus engine-driven entry and
  // recovery actions; do not grant every action supported by the platform.
  const allowedActions = [...new Set<CapabilityArtifact["policy"]["allowed_actions"][number]>([
    "navigate",
    ...steps.map((step) => step.action.kind),
    ...recovery.map((rule) => rule.action.kind)
  ])];
  const undeclared = extract.map((item) => item.output).filter((output) => !(output in options.outputs.properties));
  if (undeclared.length > 0) throw new Error(`Marked outputs are not declared in the output contract: ${undeclared.join(", ")}`);
  const origin = new URL(options.entryUrl).origin;

  // Construct the complete draft, including provenance, business outcomes,
  // recovery, checkpoint, and capability-level policy. The strict Zod schema is
  // the final runtime gate before the artifact may be saved.
  return capabilityArtifactSchema.parse({
    schema_version: "1.0",
    capability: {
      id: options.id,
      version: options.version ?? "1.0.0",
      title: options.title,
      description: options.description,
      app: options.app ?? { id: "corepoint-teller", vendor: "CorePoint Systems", ui_version_range: ">=3.1 <4" },
      risk: options.risk ?? "read_only",
      status: "draft",
      provenance: {
        discovered_by: options.model,
        discovery_run: options.runId,
        recorded_at: (options.recordedAt ?? new Date()).toISOString(),
        approved_by: null,
        approved_at: null,
        input_fingerprint: fingerprintParams(options.params),
        validation: null
      }
    },
    inputs: options.inputs,
    outputs: options.outputs,
    entry: { url: options.entryUrl, preconditions: [{ kind: "authenticated", via: options.authenticatedVia ?? "mock-auth or an existing teller session" }] },
    steps,
    checkpoint: { assert: extract.map((item) => ({ kind: "element_present" as const, target: item.from })) },
    extract,
    outcomes: (options.outcomeTemplates ?? corePointOutcomeTemplates).map((template) => ({
      code: template.code,
      at_steps: steps.map((step) => step.id),
      when: template.when,
      ...(template.returns ? { returns: template.returns } : {})
    })),
    recovery,
    policy: { allowed_origins: [origin], allowed_actions: allowedActions, max_duration_ms: 120_000 }
  });
}
