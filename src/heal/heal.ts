// Self-healing orchestration. When a capability breaks because the legacy UI
// drifted, this walks the capability to the broken step, asks a proposer to
// re-discover that one step's element on the LIVE page, validates the proposed
// ladder actually resolves, and produces a repaired DRAFT via the pure patch.
//
// The one invariant that keeps this safe: healing NEVER runs during a production
// replay. A locator failure at replay is still an honest fix_capability failure.
// Healing is a separate, operator-initiated, offline flow whose only output is a
// DRAFT that must pass the ordinary human approval gate before it can run. No
// model ever enters the decision loop of a real run.
import type { CapabilityArtifact } from "../artifact/schema.js";
import { materializeAction, resolveWithWait } from "../replay/engine.js";
import { inferRisk, type PolicyEngine } from "../policy/engine.js";
import type { LocatorStrategy, Observation, Surface } from "../surface/types.js";
import { applyStepRepair } from "./patch.js";

export interface RepairContext {
  observation: Observation;
  step: CapabilityArtifact["steps"][number];
  artifact: CapabilityArtifact;
}

/** The single LLM-touching seam: pick the element that satisfies the broken
 *  step's intent on the live page and return a durable ladder for it. Its real
 *  implementation asks a model to choose the element ref and then reuses
 *  Surface.captureLocators to build the ladder - exactly how discovery does it.
 *  Tests supply a deterministic proposer, so the whole flow runs offline. */
export type StepProposer = (context: RepairContext) => Promise<LocatorStrategy[]>;

export interface HealInput {
  /** The broken, approved capability being repaired. */
  artifact: CapabilityArtifact;
  /** An invocation that reaches the broken step (e.g. a known-good member). */
  params: Record<string, unknown>;
  /** The step whose locator ladder drifted. */
  stepId: string;
  surface: Surface;
  policy: PolicyEngine;
  proposer: StepProposer;
  /** Version for the produced draft; the CLI derives it from the store. */
  newVersion: string;
  /** The failed run that motivated the repair. */
  fromRun: string;
  /** Identity credited with the re-discovery (kept distinct from the approver). */
  model: string;
  now?: Date;
}

export interface HealResult {
  patched: CapabilityArtifact;
  before: LocatorStrategy[];
  after: LocatorStrategy[];
}

// Walk the capability's prior steps against the live app to land on the broken
// step's screen, using the SAME resolution and action materialisation the
// production engine uses. It performs only the steps BEFORE the target step, so
// the step being healed (and any irreversible boundary, which is always last) is
// never executed here.
async function reachStep(
  artifact: CapabilityArtifact,
  params: Record<string, unknown>,
  targetIndex: number,
  surface: Surface,
  policy: PolicyEngine
): Promise<Observation> {
  await surface.act({ kind: "navigate", url: artifact.entry.url });
  for (const step of artifact.steps.slice(0, targetIndex)) {
    await surface.observe();
    let ref: string | undefined;
    if (step.target) {
      const resolution = await resolveWithWait(surface, step.target, step.wait.timeout_ms);
      if (!resolution.ok) {
        throw new Error(`Cannot reach ${artifact.steps[targetIndex]!.id}: prior step ${step.id} no longer resolves. The break is at ${step.id}; heal that step instead.`);
      }
      ref = resolution.ref;
    }
    const action = materializeAction(step, params, ref);
    const risk = inferRisk(action, step.intent);
    const verdict = policy.check(action, { risk, allowMutations: artifact.capability.status === "approved" });
    if (!verdict.allowed) {
      throw new Error(`Policy blocked reaching ${artifact.steps[targetIndex]!.id} at step ${step.id}: ${verdict.detail}`);
    }
    await surface.act(action);
  }
  return surface.observe();
}

/** Re-discover and validate a repair for one drifted step, returning a repaired
 *  DRAFT (not yet saved, not yet approved). Throws if the break is upstream, if
 *  the proposer offers nothing, or if the proposed ladder does not resolve to a
 *  single visible, enabled element on the live page - an unverified patch is
 *  never produced. */
export async function healCapability(input: HealInput): Promise<HealResult> {
  const targetIndex = input.artifact.steps.findIndex((step) => step.id === input.stepId);
  if (targetIndex === -1) {
    throw new Error(`Step ${input.stepId} is not part of ${input.artifact.capability.id}@${input.artifact.capability.version}.`);
  }
  const step = input.artifact.steps[targetIndex]!;
  if (!step.target) {
    throw new Error(`Step ${input.stepId} has no locator target to repair.`);
  }

  const observation = await reachStep(input.artifact, input.params, targetIndex, input.surface, input.policy);
  const proposed = await input.proposer({ observation, step, artifact: input.artifact });
  if (proposed.length === 0) {
    throw new Error(`No replacement locator could be proposed for ${input.stepId}.`);
  }

  // A proposal is only accepted if it actually resolves on the live page the way
  // replay would resolve it: exactly one visible, enabled match. This is what
  // stops a plausible-but-wrong ladder from ever being written to a draft.
  const candidate = { frame: proposed[0]!.frame, strategies: proposed };
  const resolution = await resolveWithWait(input.surface, candidate, step.wait.timeout_ms);
  if (!resolution.ok) {
    throw new Error(`The proposed repair for ${input.stepId} did not resolve to a unique, visible, enabled element; not writing a draft.`);
  }

  const patched = applyStepRepair(input.artifact, {
    stepId: input.stepId,
    newStrategies: proposed,
    newVersion: input.newVersion,
    fromRun: input.fromRun,
    model: input.model,
    ...(input.now ? { now: input.now } : {})
  });
  return { patched, before: step.target.strategies, after: proposed };
}
