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
  /** Values the run marked sensitive. The artifact is scrubbed against the same
   *  list the evidence logger uses, so a capability cannot retain data the run
   *  already decided was not safe to persist. */
  sensitiveValues?: readonly string[];
}

// Values shorter than this would match almost any serialized locator and blank
// an entire ladder, so they are ignored rather than treated as run data.
const minimumTaintedLength = 3;

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => needle.length >= minimumTaintedLength && haystack.includes(needle));
}

// A locator built out of the run's own data is not a redaction problem, it is a
// correctness problem: it resolves for the discovery member and fails for
// everyone else. Dropping the strategy leaves the rest of the ladder usable;
// only an emptied ladder is fatal.
function untaintedTarget(bundle: LocatorBundle, tainted: readonly string[], describe: string): TargetSpec {
  const strategies: LocatorStrategy[] = bundle.strategies.filter((strategy) => !containsAny(JSON.stringify(strategy), tainted));
  if (strategies.length === 0) throw new Error(`Every locator strategy for ${describe} was built from run-specific data.`);
  return { frame: strategies[0]?.frame, strategies };
}

// Geometry drifts between two captures of the same element, so identity rests on
// the semantic rungs; an element with none of those is never treated as matching.
function targetIdentity(bundle?: LocatorBundle): string | undefined {
  const semantic = bundle?.strategies.filter((strategy) => strategy.kind !== "geometry") ?? [];
  return semantic.length > 0 ? JSON.stringify(semantic) : undefined;
}

// The model sometimes re-enters a value it has already entered. `type` and
// `select` set a value rather than trigger one, so a consecutive repeat on the
// same control is a no-op that should not be replayed forever. A repeated click
// can be meaningful — adding a second row, say — so clicks are never collapsed.
function repeatsNextValue(step: RecordedStep, next: RecordedStep): boolean {
  const identity = targetIdentity(step.locators);
  if (!identity || identity !== targetIdentity(next.locators)) return false;
  if (step.action.kind === "type" && next.action.kind === "type") return step.action.text === next.action.text;
  if (step.action.kind === "select" && next.action.kind === "select") return step.action.value === next.action.value;
  return false;
}

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
  // The model's reasoning becomes the intent text and can quote anything it read
  // on screen, so it gets the same scrub as a persisted evidence line.
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

export function distillDiscovery(result: DiscoveryResult, options: DistillOptions): CapabilityArtifact {
  if (result.status !== "success") throw new Error(`Cannot distill a ${result.status} discovery run.`);
  if (result.steps.length === 0) throw new Error("Cannot distill a discovery run with no recorded actions.");
  const used = new Set<string>();
  // Invocation values are tainted whether or not they were marked sensitive: a
  // locator carrying one is broken for every other invocation.
  const tainted = [...new Set([...Object.values(options.params), ...(options.sensitiveValues ?? [])])].filter(Boolean);
  // Keeping the last of a run of repeats preserves the settled URL the flow
  // actually reached, which is what the postconditions are derived from.
  const recorded = result.steps.filter((step, index) => {
    const next = result.steps[index + 1];
    return !(next && repeatsNextValue(step, next));
  });
  const steps = recorded.map((step, index) => distillStep(step, index, options.params, used, tainted));
  const unbound = Object.keys(options.params).filter((param) => !used.has(param));
  if (unbound.length > 0) throw new Error(`Supplied parameters were never bound: ${unbound.join(", ")}`);
  const outputEntries = Object.entries(result.outputs);
  if (outputEntries.length === 0) throw new Error("Discovery finished without any note_output calls.");
  const extract = outputEntries.map(([output, bundle]) => ({
    output,
    from: untaintedTarget(bundle, tainted, `extraction of ${output}`),
    parse: options.outputs.properties[output]?.["x-format"] === "usd-currency" ? "currency" as const : "text" as const
  }));
  const undeclared = extract.map((item) => item.output).filter((output) => !(output in options.outputs.properties));
  if (undeclared.length > 0) throw new Error(`Marked outputs are not declared in the output contract: ${undeclared.join(", ")}`);
  const origin = new URL(options.entryUrl).origin;
  return capabilityArtifactSchema.parse({
    schema_version: "1.0",
    capability: {
      id: options.id,
      version: "1.0.0",
      title: options.title,
      description: options.description,
      app: { id: "corepoint-teller", vendor: "CorePoint Systems", ui_version_range: ">=3.1 <4" },
      risk: options.risk ?? "read_only",
      status: "draft",
      provenance: { discovered_by: options.model, discovery_run: options.runId, recorded_at: (options.recordedAt ?? new Date()).toISOString(), approved_by: null, approved_at: null }
    },
    inputs: options.inputs,
    outputs: options.outputs,
    entry: { url: options.entryUrl, preconditions: [{ kind: "authenticated", via: "mock-auth or an existing teller session" }] },
    steps,
    checkpoint: { assert: extract.map((item) => ({ kind: "element_present" as const, target: item.from })) },
    extract,
    outcomes: [
      { code: "MEMBER_NOT_FOUND", at_steps: steps.map((step) => step.id), when: [{ kind: "text_visible", pattern: "No member found", frame: "workarea" }], returns: { found: false } },
      { code: "PERMISSION_DENIED", at_steps: steps.map((step) => step.id), when: [{ kind: "text_visible", pattern: "Access denied", frame: "workarea" }] }
    ],
    recovery: [{
      id: "dismiss_session_modal",
      condition: { kind: "dialog_present", textPattern: "Session expiring" },
      action: { kind: "click", target: { strategies: [{ kind: "role_name", role: "button", name: "Continue", frame: "workarea", unique: true, confidence: 0.9 }] } },
      max_attempts: 1
    }],
    policy: { allowed_origins: [origin], allowed_actions: ["navigate", "click", "focus", "type", "select", "press", "scroll"], max_duration_ms: 120_000 }
  });
}
