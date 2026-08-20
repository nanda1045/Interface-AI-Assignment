// Deterministic capability executor. It contains no LLM dependency: it validates
// invocation inputs, walks saved steps/locator ladders, enforces artifact and
// deployment policy, verifies state, extracts outputs, and records one of three
// terminal results with evidence.
import type { CapabilityArtifact } from "../artifact/schema.js";
import type { HandoffCoordinator } from "../control/intervention.js";
import type { RunLogger } from "../evidence/run-logger.js";
import { inferRisk, type PolicyEngine } from "../policy/engine.js";
import type { AbstractAction, Observation, ResolutionFailure, ResolvedElement, Surface, TargetSpec } from "../surface/types.js";
import { allPredicatesMatch, corePointSignatures, detectEscalation, detectGlobalFailure, predicateMatches, type DetectorSignatures } from "./detectors.js";
import { dispositionFor, type FailureClass, type ReplayResult, type TierStats } from "./result.js";

// All runtime dependencies are explicit and browser-independent through Surface.
export interface ReplayOptions {
  artifact: CapabilityArtifact;
  params: Record<string, unknown>;
  surface: Surface;
  policy: PolicyEngine;
  logger: RunLogger;
  confirmMutations?: boolean;
  handoff?: HandoffCoordinator;
  /** Per-application failure/escalation signatures from the app profile.
   *  Defaults to CorePoint's so existing artifacts keep their behaviour. */
  signatures?: DetectorSignatures;
}

// Validate the concrete invocation against the artifact's declared input contract
// before opening the capability entry page or performing any business action.
function validateInputs(artifact: CapabilityArtifact, params: Record<string, unknown>): string | undefined {
  for (const required of artifact.inputs.required) if (!(required in params)) return `Missing required parameter: ${required}`;
  for (const name of Object.keys(params)) if (!(name in artifact.inputs.properties)) return `Unknown parameter: ${name}`;
  for (const [name, schema] of Object.entries(artifact.inputs.properties)) {
    const value = params[name];
    if (value === undefined) continue;
    if (schema.type === "string" && typeof value !== "string") return `${name} must be a string.`;
    if (schema.type === "number" && typeof value !== "number") return `${name} must be a number.`;
    if (schema.type === "integer" && (!Number.isInteger(value))) return `${name} must be an integer.`;
    if (schema.type === "boolean" && typeof value !== "boolean") return `${name} must be a boolean.`;
    if (schema.pattern && (typeof value !== "string" || !new RegExp(schema.pattern).test(value))) return `${name} does not match its declared pattern.`;
  }
  return undefined;
}

// Combine a declarative saved action with current invocation parameters and the
// fresh element ref returned by locator resolution.
function materializeAction(step: CapabilityArtifact["steps"][number], params: Record<string, unknown>, ref?: string): AbstractAction {
  const action = step.action;
  switch (action.kind) {
    case "navigate": return action;
    case "click":
    case "focus":
      if (!ref) throw new Error(`${action.kind} is missing a resolved target.`);
      return { kind: action.kind, ref };
    case "type": {
      if (!ref) throw new Error("type is missing a resolved target.");
      const value = params[action.value_from.param];
      return { kind: "type", ref, text: String(value), ...(action.sensitive ? { sensitive: true } : {}) };
    }
    case "select": {
      if (!ref) throw new Error("select is missing a resolved target.");
      return { kind: "select", ref, value: String(params[action.value_from.param]) };
    }
    case "press": return action;
    case "scroll": return action;
  }
}

// Capability-level least privilege: every action and navigation origin must stay
// inside the narrower contract reviewers approved for this artifact.
function artifactPolicyViolation(artifact: CapabilityArtifact, action: AbstractAction): string | undefined {
  if (!artifact.policy.allowed_actions.includes(action.kind)) return `Action ${action.kind} is outside the artifact's allowed_actions.`;
  if (action.kind === "navigate") {
    let origin: string;
    try { origin = new URL(action.url).origin; } catch { return "Navigation target is not an absolute URL."; }
    if (!artifact.policy.allowed_origins.includes(origin)) return `Origin ${origin} is outside the artifact's allowed_origins.`;
  }
  return undefined;
}

// Record both ladder position and actual strategy kind. Tier is useful within a
// target; strategy kind is comparable across different steps and runs.
function recordTier(stats: TierStats, step: string, resolution: ResolvedElement): void {
  stats.resolutions += 1;
  stats.matched_tiers[String(resolution.tier)] = (stats.matched_tiers[String(resolution.tier)] ?? 0) + 1;
  const kind = resolution.matchedStrategy.kind;
  stats.matched_strategies[kind] = (stats.matched_strategies[kind] ?? 0) + 1;
  if (resolution.tier > 1 && !stats.rescued_steps.includes(step)) stats.rescued_steps.push(step);
}

// Allow asynchronously rendered targets to appear within the step timeout while
// tolerating short-lived iframe/navigation context replacement.
async function resolveWithWait(surface: Surface, target: TargetSpec, timeoutMs: number): Promise<ResolvedElement | ResolutionFailure> {
  const deadline = Date.now() + timeoutMs;
  let last: ResolvedElement | ResolutionFailure = { ok: false, reason: "target_not_found", attempts: [] };
  do {
    try {
      last = await surface.resolve(target);
    } catch (error) {
      if (!/Execution context was destroyed|Frame was detached/i.test(String(error))) throw error;
    }
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return last;
}

// After acting, wait briefly for logical UI state to change before evaluating
// outcomes and postconditions. Never wait beyond two seconds here.
async function observeAfterAction(surface: Surface, priorHash: string, timeoutMs: number): Promise<Observation> {
  const deadline = Date.now() + Math.min(timeoutMs, 2_000);
  let observation = await surface.observe();
  while (observation.stateHash === priorHash && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 75));
    observation = await surface.observe();
  }
  return observation;
}

// Execute one capability invocation from entry navigation through terminal result.
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const { artifact, params, surface, policy, logger } = options;
  const signatures = options.signatures ?? corePointSignatures;
  const stats: TierStats = { resolutions: 0, matched_tiers: {}, matched_strategies: {}, rescued_steps: [] };
  const recoveryAttempts = new Map<string, number>();
  const deadline = Date.now() + Math.min(artifact.policy.max_duration_ms, policy.config.max_duration_ms);
  let currentStep = "entry";
  let currentIntent = "Open the capability entry point";
  let lastAttempts: unknown;
  let sensitiveRun = false;

  // Initialise evidence and register sensitive invocation values before logging.
  await logger.initialize();
  for (const [name, schema] of Object.entries(artifact.inputs.properties)) {
    if (schema.sensitive && params[name] !== undefined) {
      sensitiveRun = true;
      logger.markSensitive(String(params[name]));
    }
  }
  await logger.event({
    type: "run_started",
    goal: artifact.capability.title,
    target: artifact.entry.url,
    model: "deterministic-replay",
    capability: `${artifact.capability.id}@${artifact.capability.version}`
  });

  // Reject invalid input, unapproved mutation, and unattended irreversible work
  // before the browser performs the capability.
  const invalidInput = validateInputs(artifact, params);
  if (invalidInput) return fail("invalid_input", "Parameters satisfying the artifact input contract.", invalidInput);
  if (artifact.capability.risk === "mutating" && artifact.capability.status !== "approved" && !options.confirmMutations) {
    return fail("policy_blocked", "An approved artifact or interactive mutation confirmation.", "Artifact is draft and no confirmation was supplied.");
  }
  if (artifact.capability.risk === "irreversible") {
    return fail("policy_blocked", "A human approval intervention.", "Irreversible capabilities cannot run unattended.");
  }

  // Entry navigation must pass both the artifact allowlist and deployment policy.
  const entryAction: AbstractAction = { kind: "navigate", url: artifact.entry.url };
  const entryViolation = artifactPolicyViolation(artifact, entryAction);
  if (entryViolation) return fail("policy_blocked", "An entry URL inside the artifact's own allowlist.", entryViolation);
  const entryVerdict = policy.check(entryAction, { risk: "read_only" });
  await logger.event({ type: "policy_check", step: 0, verdict: entryVerdict });
  if (!entryVerdict.allowed) return fail("policy_blocked", "Allowlisted capability entry URL.", entryVerdict.detail);
  const entryResult = await surface.act(entryAction);
  await logger.event({ type: "action", step: 0, action: entryAction, resultUrl: entryResult.url });

  // Follow saved steps in order. The inner loop exists only so a human handoff can
  // return control and request that the current step be retried from fresh state.
  stepsLoop: for (const [index, step] of artifact.steps.entries()) {
    let retryCurrentStep = true;
    while (retryCurrentStep) {
      retryCurrentStep = false;
      if (Date.now() > deadline) return fail("timeout", `Replay within ${artifact.policy.max_duration_ms}ms.`, "Capability duration limit was exceeded.");
      currentStep = step.id;
      currentIntent = step.intent;
      let observation = await surface.observe();

      // Before acting, detect global application/session failures, apply bounded
      // recovery, offer handoff for approval walls, and classify business outcomes.
      const preGlobal = detectGlobalFailure(observation, signatures);
      if (preGlobal) {
        if (preGlobal.class !== "session_lost" || !options.handoff) return fail(preGlobal.class, "An authenticated, healthy application screen.", preGlobal.observed);
        const resume = await requestHandoff(step, observation, preGlobal.observed, "Re-authenticate in the live browser session.");
        if (resume === "timed_out") return fail("timeout", "A human operator to take control of the paused run.", "The intervention request expired with no operator.");
        if (resume === "checkpoint") break stepsLoop;
        if (resume === "retry") { retryCurrentStep = true; continue; }
        if (resume === "completed") break;
        return fail("precondition_failed", "A resumable state after human handoff.", "State diverged after handoff.");
      }

      const recovered = await applyRecovery(observation, index + 1);
      if (recovered) observation = await surface.observe();
      const preEscalation = detectEscalation(observation, signatures);
      if (preEscalation && options.handoff) {
        const resume = await requestHandoff(step, observation, preEscalation.reason, preEscalation.requestedAction);
        if (resume === "timed_out") return fail("timeout", "A human operator to take control of the paused run.", "The intervention request expired with no operator.");
        if (resume === "checkpoint") break stepsLoop;
        if (resume === "retry") { retryCurrentStep = true; continue; }
        if (resume === "completed") break;
        return fail("precondition_failed", "A resumable state after human handoff.", "State diverged after handoff.");
      }
      const preOutcome = await detectOutcome(step.id, observation);
      if (preOutcome) return preOutcome;

      // Resolve the saved target ladder and retain attempt evidence. A missing
      // target fails closed rather than asking a model to improvise.
      let resolved: ResolvedElement | undefined;
      if (step.target) {
        const resolution = await resolveWithWait(surface, step.target, step.wait.timeout_ms);
        lastAttempts = resolution.attempts;
        if (!resolution.ok) return fail("target_not_found", "One unique, visible, enabled locator strategy to resolve.", "Every locator strategy was exhausted.");
        resolved = resolution;
        recordTier(stats, step.id, resolution);
      }

      // Materialize the action, enforce the capability allowlist, infer runtime
      // risk, and then enforce the wider deployment policy before Surface.act().
      const action = materializeAction(step, params, resolved?.ref);
      const stepViolation = artifactPolicyViolation(artifact, action);
      if (stepViolation) return fail("policy_blocked", "An action inside the artifact's own allowlist.", stepViolation);
      const targetElement = resolved ? observation.elements.find((element) => element.ref === resolved?.ref) : undefined;
      const risk = inferRisk(action, targetElement?.name ?? currentIntent);
      const verdict = policy.check(action, { risk, allowMutations: artifact.capability.status === "approved" || options.confirmMutations, targetName: targetElement?.name });
      await logger.event({ type: "policy_check", step: index + 1, verdict });
      if (!verdict.allowed) return fail("policy_blocked", "An action permitted by policy and risk approval.", verdict.detail);
      const actionResult = await surface.act(action);
      await logger.event({ type: "action", step: index + 1, action, resultUrl: actionResult.url });
      observation = await observeAfterAction(surface, observation.stateHash, step.wait.timeout_ms);

      // Re-observe after the action, then detect hard failures, declared outcomes,
      // recovery conditions, escalation walls, and finally step postconditions.
      const global = detectGlobalFailure(observation, signatures);
      if (global) {
        if (global.class !== "session_lost" || !options.handoff) return fail(global.class, "A healthy application screen after the action.", global.observed);
        const resume = await requestHandoff(step, observation, global.observed, "Re-authenticate in the live browser session.");
        if (resume === "timed_out") return fail("timeout", "A human operator to take control of the paused run.", "The intervention request expired with no operator.");
        if (resume === "checkpoint") break stepsLoop;
        if (resume === "retry") { retryCurrentStep = true; continue; }
        if (resume === "completed") break;
        return fail("precondition_failed", "A resumable state after human handoff.", "State diverged after handoff.");
      }
      const outcome = await detectOutcome(step.id, observation);
      if (outcome) return outcome;
      if (await applyRecovery(observation, index + 1)) observation = await surface.observe();
      const escalation = detectEscalation(observation, signatures);
      if (escalation && options.handoff) {
        const resume = await requestHandoff(step, observation, escalation.reason, escalation.requestedAction);
        if (resume === "timed_out") return fail("timeout", "A human operator to take control of the paused run.", "The intervention request expired with no operator.");
        if (resume === "checkpoint") break stepsLoop;
        if (resume === "retry") { retryCurrentStep = true; continue; }
        if (resume === "completed") break;
        return fail("precondition_failed", "A resumable state after human handoff.", "State diverged after handoff.");
      }
      if (!(await postconditionsMatch(step, observation))) {
        return fail("postcondition_failed", JSON.stringify(step.postconditions), `Postcondition did not match at ${observation.url}.`);
      }
    }
  }

  // Steps alone do not prove success. Require the capability-level checkpoint,
  // then independently resolve and read every declared extraction target.
  currentStep = "checkpoint";
  currentIntent = "Verify the capability-level success condition";
  const finalObservation = await surface.observe();
  if (!(await allPredicatesMatch(artifact.checkpoint.assert, finalObservation, surface))) {
    return fail("checkpoint_failed", JSON.stringify(artifact.checkpoint.assert), `Checkpoint did not match at ${finalObservation.url}.`);
  }
  const outputs: Record<string, unknown> = {};
  for (const extraction of artifact.extract) {
    const resolution = await surface.resolve(extraction.from);
    lastAttempts = resolution.attempts;
    if (!resolution.ok) return fail("target_not_found", `Extraction target for ${extraction.output}.`, "Extraction locator ladder was exhausted.");
    recordTier(stats, `extract:${extraction.output}`, resolution);
    const raw = (await surface.read(resolution.ref)).text;
    outputs[extraction.output] = extraction.parse === "number" ? Number(raw.replace(/[^0-9.-]/g, "")) : raw;
    if (artifact.outputs.properties[extraction.output]?.sensitive) logger.markSensitive(String(outputs[extraction.output]));
  }

  // Success returns outputs plus locator stability and intervention telemetry,
  // then completes the same evidence/redaction lifecycle as every other outcome.
  const result: ReplayResult = { status: "success", outputs, evidence: logger.directory, stability: stats, ...interventionPart() };
  await logger.event({ type: "result", status: "success", detail: result });
  await logger.result(result);
  await logger.finalizeRedaction();
  return result;

  // Declared business states are valid terminal outcomes, not system failures.
  async function detectOutcome(stepId: string, observation: Observation): Promise<ReplayResult | undefined> {
    for (const outcome of artifact.outcomes) {
      if (!outcome.at_steps.includes(stepId)) continue;
      if (await allPredicatesMatch(outcome.when, observation, surface)) {
        const result: ReplayResult = { status: "business_outcome", code: outcome.code, ...(outcome.returns ? { data: outcome.returns } : {}), evidence: logger.directory, ...interventionPart() };
        await logger.event({ type: "detector_hit", step: Number(stepId.replace(/^s/, "")) || 0, detector: outcome.code, classification: "business_outcome" });
        await logger.event({ type: "result", status: "business_outcome", detail: result });
        await logger.result(result);
        await logger.finalizeRedaction();
        return result;
      }
    }
    return undefined;
  }

  // Apply only artifact-declared, attempt-bounded recovery. Recovery actions pass
  // the same capability and deployment policy checks as normal steps.
  async function applyRecovery(observation: Observation, stepNumber: number): Promise<boolean> {
    for (const rule of artifact.recovery) {
      if (!(await predicateMatches(rule.condition, observation, surface))) continue;
      const attempts = recoveryAttempts.get(rule.id) ?? 0;
      if (attempts >= rule.max_attempts) return false;
      recoveryAttempts.set(rule.id, attempts + 1);
      const resolution = await surface.resolve(rule.action.target);
      lastAttempts = resolution.attempts;
      if (!resolution.ok) return false;
      recordTier(stats, `recovery:${rule.id}`, resolution);
      const action: AbstractAction = { kind: "click", ref: resolution.ref };
      if (artifactPolicyViolation(artifact, action)) return false;
      const verdict = policy.check(action, { risk: "read_only" });
      await logger.event({ type: "policy_check", step: stepNumber, verdict });
      if (!verdict.allowed) return false;
      const actionResult = await surface.act(action);
      await logger.event({ type: "action", step: stepNumber, action, resultUrl: actionResult.url });
      await logger.event({ type: "recovery_applied", step: stepNumber, rule: rule.id });
      return true;
    }
    return false;
  }

  // Verify every saved postcondition. Input-value checks re-resolve the target and
  // compare the live control value with the invocation parameter.
  async function postconditionsMatch(step: CapabilityArtifact["steps"][number], observation: Observation): Promise<boolean> {
    for (const predicate of step.postconditions) {
      const predicateTarget = step.target;
      const matches = predicate.kind === "value_equals_param"
        ? Boolean(predicateTarget && await (async () => {
            const current = await surface.resolve(predicateTarget);
            return current.ok && (await surface.read(current.ref)).value === String(params[predicate.param]);
          })())
        : await predicateMatches(predicate, observation, surface);
      if (!matches) return false;
    }
    return true;
  }

  async function requestHandoff(
    step: CapabilityArtifact["steps"][number],
    observation: Observation,
    reason: string,
    requestedAction: string
  ): Promise<"completed" | "retry" | "checkpoint" | "failed" | "timed_out"> {
    // Pause the same browser session and avoid screenshots when the invocation is
    // sensitive. The human receives reason, intent, current state, and requested work.
    const handoff = options.handoff;
    if (!handoff) return "failed";
    let screenshot: string | undefined;
    if (!sensitiveRun) screenshot = (await surface.observe({ screenshot: true })).screenshot;
    const request = await handoff.request({
      runId: logger.runId,
      capability: `${artifact.capability.id}@${artifact.capability.version}`,
      goal: artifact.capability.title,
      step: step.id,
      intent: step.intent,
      reason,
      requestedAction,
      ...(screenshot ? { screenshot } : {}),
      recentEvents: [{ url: observation.url, title: observation.title, stateHash: observation.stateHash }]
    });

    // An expired request leaves no state to resume and becomes a structured timeout.
    if (request.status === "aborted") return "timed_out";

    // Re-observe after handback and derive the next position from actual UI state:
    // final checkpoint, completed step, retryable target, or unsafe divergence.
    const resumedObservation = await surface.observe();
    let decision: "completed" | "retry" | "checkpoint" | "failed" = "failed";
    if (await allPredicatesMatch(artifact.checkpoint.assert, resumedObservation, surface)) decision = "checkpoint";
    else if (step.postconditions.length > 0 && await postconditionsMatch(step, resumedObservation)) decision = "completed";
    else if (step.target && (await surface.resolve(step.target)).ok) decision = "retry";
    await handoff.resume();
    return decision;
  }

  // Add intervention metadata only when at least one handoff occurred.
  function interventionPart(): { intervention?: { count: number; requestIds: string[] } } {
    const summary = options.handoff?.summary();
    return summary && summary.count > 0 ? { intervention: summary } : {};
  }

  // Convert every technical terminal path into a structured failure. Evidence
  // capture is defensive so even a dead browser still produces result.json.
  async function fail(failureClass: FailureClass, expected: string, observed: string): Promise<ReplayResult> {
    let observation: Observation | undefined;
    try { observation = await surface.observe({ screenshot: !sensitiveRun }); } catch { observation = undefined; }
    let dom = "DOM snapshot unavailable: the browser session was no longer reachable.";
    try { dom = await surface.snapshotDom(); } catch { /* Browser may already be unreachable; keep the fallback text. */ }
    const bundle = await logger.failureBundle({ screenshot: observation?.screenshot, dom, ...(lastAttempts ? { attempts: lastAttempts } : {}) });
    const result: ReplayResult = {
      status: "failure",
      failure: {
        class: failureClass,
        disposition: dispositionFor(failureClass, artifact.capability.risk),
        step: currentStep, intent: currentIntent, expected, observed, ...bundle
      },
      evidence: logger.directory,
      ...interventionPart()
    };
    await logger.event({ type: "result", status: "failure", detail: result });
    await logger.result(result);
    await logger.finalizeRedaction();
    return result;
  }
}
