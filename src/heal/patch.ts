// Pure, deterministic patch step of the self-healing repair flow. Given an
// approved artifact whose one step's locator ladder has drifted, and a freshly
// re-discovered ladder for that step, it produces a NEW DRAFT version that is
// byte-identical to the original except for that step's target strategies.
//
// This is where the safety of self-healing lives, so it is intentionally pure
// and narrow:
//   - It changes ONLY the named step's target.strategies. The action, execution
//     ("human_required"), postconditions, inputs, outputs, outcomes, recovery,
//     and policy are all carried over untouched.
//   - The result is status: "draft" and carries no approval - a healed capability
//     is a proposal, never something that becomes runnable on its own.
//   - It re-parses through the strict artifact schema, so a patch that would
//     break any invariant (an empty ladder, a corrupted irreversible human
//     boundary) is rejected here rather than reaching disk.
//   - The original input_fingerprint is preserved, so the existing approval gate
//     still demands a different invocation before this draft can be promoted.
import { capabilityArtifactSchema, type CapabilityArtifact } from "../artifact/schema.js";
import type { LocatorStrategy } from "../surface/types.js";

export interface StepRepair {
  /** The step whose target ladder is being replaced, e.g. "s4". */
  stepId: string;
  /** The re-discovered ladder, strongest strategy first. Must be non-empty. */
  newStrategies: LocatorStrategy[];
  /** The version to give the produced draft (caller derives it from the store). */
  newVersion: string;
  /** The failed replay run that motivated the repair, recorded in provenance. */
  fromRun: string;
  /** Identity credited with the re-discovery - kept distinct from the eventual
   *  approver so the existing "approver != discoverer" rule still applies. */
  model: string;
  now?: Date;
}

/** Produce a draft capability that repairs one step's locator ladder. Throws if
 *  the step does not exist, is not a locator-bearing step, or if the resulting
 *  artifact would violate the schema. */
export function applyStepRepair(artifact: CapabilityArtifact, repair: StepRepair): CapabilityArtifact {
  if (repair.newStrategies.length === 0) {
    throw new Error("A repair needs at least one locator strategy.");
  }
  const index = artifact.steps.findIndex((step) => step.id === repair.stepId);
  if (index === -1) {
    throw new Error(`Step ${repair.stepId} is not part of ${artifact.capability.id}@${artifact.capability.version}.`);
  }
  const original = artifact.steps[index]!;
  if (!original.target) {
    throw new Error(`Step ${repair.stepId} has no locator target to repair; only element steps can be healed.`);
  }
  const before = original.target.strategies.length;

  // Replace ONLY this step's target. Everything else about the step - its action,
  // whether it is the human_required boundary, its postconditions - is preserved
  // exactly, so healing can never quietly change what a step does, only how its
  // element is found.
  const steps = artifact.steps.map((step, at) =>
    at === index
      ? { ...step, target: { frame: repair.newStrategies[0]!.frame, strategies: repair.newStrategies } }
      : step
  );

  const now = (repair.now ?? new Date()).toISOString();
  const draft: CapabilityArtifact = {
    ...artifact,
    capability: {
      ...artifact.capability,
      version: repair.newVersion,
      status: "draft",
      provenance: {
        ...artifact.capability.provenance,
        discovered_by: repair.model,
        discovery_run: repair.fromRun,
        recorded_at: now,
        approved_by: null,
        approved_at: null,
        // input_fingerprint is carried over deliberately: approval must still
        // prove the healed capability works on a DIFFERENT invocation than the
        // one it was originally recorded against.
        validation: null,
        repair: {
          from_version: artifact.capability.version,
          from_run: repair.fromRun,
          step: repair.stepId,
          strategies_before: before,
          strategies_after: repair.newStrategies.length,
          repaired_at: now
        }
      }
    },
    steps
  };

  // Final gate: the strict schema re-validates the whole document. A patch that
  // somehow broke an invariant (e.g. the final human_required boundary of an
  // irreversible capability) is rejected here, before it can be saved.
  return capabilityArtifactSchema.parse(draft);
}
