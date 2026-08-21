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
  /** Per-application irreversible action names, applied to the same risk
   *  heuristic replay already runs per control - defence in depth against a
   *  mislabeled artifact whose steps click a final action. */
  irreversibleActions?: readonly string[];
  /** Demo-only fault kind to force on the FIRST entry navigation via the app's
   *  ?inject= mechanism. It is one-shot: a restart_capability recovery re-enters
   *  with the clean entry, so a transient interstitial cannot re-trigger forever. */
  faultInjection?: string;
  /** Debug-only: capture per-step screenshots even for a sensitive run. These
   *  are full-fidelity (unredactable pixels) and are meant for a human to debug
   *  from the loopback dashboard - kept locally under runs/ (git-ignored), never
   *  committed, and swept on a retention schedule. Off by default; a sensitive
   *  run then captures nothing and records that screenshots were withheld. */
  captureScreenshots?: boolean;
}

// Append the demo ?inject= parameter to a URL. Used for the first entry only.
function withInject(url: string, kind: string): string {
  const injected = new URL(url);
  injected.searchParams.set("inject", kind);
  return injected.toString();
}

// Validate the concrete invocation against the artifact's declared input contract
// before opening the capability entry page or performing any business action.
function validateInputs(artifact: CapabilityArtifact, params: Record<string, unknown>): string | undefined {
  for (const required of artifact.inputs.required) if (!(required in params)) return `Missing required parameter: ${required}`;
  for (const name of Object.keys(params)) if (!(name in artifact.inputs.properties)) return `Unknown parameter: ${name}`;
  for (const [name, schema] of Object.entries(artifact.inputs.properties)) {
    // Structured tables exist only as outputs; an invocation cannot supply one.
    if (schema.type === "array") return `${name} is a structured output contract and cannot be an invocation input.`;
    const value = params[name];
    if (value === undefined) continue;
    if (schema.type === "string" && typeof value !== "string") return `${name} must be a string.`;
    if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${name} must be a finite number.`;
    if (schema.type === "integer" && !Number.isSafeInteger(value)) return `${name} must be a safe integer.`;
    if (schema.type === "boolean" && typeof value !== "boolean") return `${name} must be a boolean.`;
    if (schema.pattern && (typeof value !== "string" || !new RegExp(schema.pattern).test(value))) return `${name} does not match its declared pattern.`;
  }
  return undefined;
}

// Combine a declarative saved action with current invocation parameters and the
// fresh element ref returned by locator resolution.
// Exported so the repair flow can walk a capability to a broken step using the
// exact same action-materialisation the production engine uses - reaching the
// step to heal must behave identically to a normal replay of the prior steps.
export function materializeAction(step: CapabilityArtifact["steps"][number], params: Record<string, unknown>, ref?: string): AbstractAction {
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
      // Parameterised selects take the invocation's value; constant selects are
      // the flow's own fixed choice and replay exactly as recorded.
      const value = action.value_from ? String(params[action.value_from.param]) : action.value ?? "";
      return { kind: "select", ref, value };
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

// Build an evidence-safe copy of the outputs. A value marked sensitive in the
// output contract is replaced with the redaction marker regardless of its
// length - a two-character share id must not survive into result.json - while
// the real value is still returned to the authorized caller. This is
// structural: it redacts the exact declared paths, so it cannot leak by being
// too short to register globally, nor over-redact unrelated text by registering
// a short fragment across the whole log.
const REDACTED = "«redacted»";
function redactOutputs(outputs: Record<string, unknown>, contract: CapabilityArtifact["outputs"]): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(outputs)) {
    const declared = contract.properties[name];
    if (declared?.type === "array" && Array.isArray(value)) {
      const columns = declared.items.properties;
      safe[name] = value.map((row) => {
        if (!row || typeof row !== "object") return row;
        return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, cell]) =>
          [key, (declared.sensitive || columns[key]?.sensitive) ? REDACTED : cell]));
      });
    } else {
      safe[name] = declared?.sensitive ? REDACTED : value;
    }
  }
  return safe;
}

// Convert one table cell to its declared item type. Currency symbols and
// grouping commas are stripped for numeric cells the way scalar currency
// extraction already does; anything lossy or ambiguous refuses instead.
function parseCell(raw: string, type: "string" | "number" | "integer" | "boolean"): { ok: true; value: unknown } | { ok: false } {
  const text = raw.trim();
  switch (type) {
    case "string":
      return { ok: true, value: raw };
    case "number": {
      const cleaned = text.replace(/[^0-9.-]/g, "");
      const value = Number(cleaned);
      return cleaned !== "" && Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    case "integer": {
      const cleaned = text.replace(/[^0-9-]/g, "");
      const value = Number(cleaned);
      return /^-?\d+$/.test(cleaned) && Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
    }
    case "boolean":
      return /^(true|false)$/i.test(text) ? { ok: true, value: /^true$/i.test(text) } : { ok: false };
  }
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
// Exported for the repair flow, which resolves prior steps' targets to reach a
// broken step and validates a proposed replacement ladder the same way replay does.
export async function resolveWithWait(surface: Surface, target: TargetSpec, timeoutMs: number): Promise<ResolvedElement | ResolutionFailure> {
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
  // Once an action that changes records may have been attempted, re-entry
  // recoveries are off the table: restarting would run the business action
  // again, and a duplicated transfer is worse than a stopped run.
  let mutationMayHaveOccurred = false;
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
  // The invocation inputs, logged AFTER sensitive values are registered so the
  // event is redacted like every other. Gives the dashboard a clean inputs
  // block; sensitive ones show as «redacted», the rest as given.
  await logger.event({ type: "run_inputs", inputs: params });
  // A run touching a sensitive value captures no screenshots (they would show it
  // and cannot be redacted). Record that so the dashboard explains the absence
  // rather than looking like evidence went missing.
  // Withheld only when we are NOT in debug capture mode; otherwise we do capture
  // (locally, for a human to debug) and there is nothing to explain.
  if (sensitiveRun && !options.captureScreenshots) await logger.event({ type: "screenshots_withheld", reason: "This run handles a sensitive value, so screenshots were not captured." });

  // Reject invalid input, unapproved mutation, and unattended irreversible work
  // before the browser performs the capability.
  const invalidInput = validateInputs(artifact, params);
  if (invalidInput) return fail("invalid_input", "Parameters satisfying the artifact input contract.", invalidInput);
  if (artifact.capability.risk === "mutating" && artifact.capability.status !== "approved" && !options.confirmMutations) {
    return fail("policy_blocked", "An approved artifact or interactive mutation confirmation.", "Artifact is draft and no confirmation was supplied.");
  }
  if (artifact.capability.risk === "irreversible") {
    // Never unattended, and no CLI or API boolean can override this. It runs
    // only when a human boundary is genuinely present: an operator handoff is
    // attached AND the artifact records where the machine must stop.
    // Mirrors the schema validation exactly, as defence in depth for an
    // artifact that never went through the store: the boundary must be the
    // FINAL step and must carry a target, or an agent-executed step after it
    // would perform the irreversible work unattended.
    const finalStep = artifact.steps[artifact.steps.length - 1];
    const humanBounded = finalStep?.execution === "human_required" && finalStep.target !== undefined;
    if (!options.handoff || !humanBounded) {
      return fail(
        "policy_blocked",
        "A human-controlled boundary: an attached operator handoff and a final, targeted human_required step.",
        humanBounded
          ? "No operator handoff is attached; irreversible capabilities never run unattended."
          : "The artifact's final step is not a targeted human_required boundary, so its irreversible action would execute unattended."
      );
    }
  }

  // Entry navigation must pass both the artifact allowlist and deployment policy.
  const entryAction: AbstractAction = { kind: "navigate", url: artifact.entry.url };
  const entryViolation = artifactPolicyViolation(artifact, entryAction);
  if (entryViolation) return fail("policy_blocked", "An entry URL inside the artifact's own allowlist.", entryViolation);

  // A capability with no authenticated precondition (the sign-on flow itself)
  // legitimately operates on the sign-on screen; classifying that screen as
  // session_lost would fail it at its own front door.
  const requiresAuthentication = artifact.entry.preconditions.some((precondition) => precondition.kind === "authenticated");

  // A recovery rule with effect restart_capability re-enters here: some
  // interstitials (MERIDIAN's maintenance page) exit to a menu, so the only
  // sound resumption is from the capability's own entry. Bounded by the rule's
  // max_attempts and the run deadline like every other recovery.
  let firstEntry = true;
  restartLoop: while (true) {
  // The demo fault is forced on the first entry only; a restart re-enters clean,
  // so a transient interstitial recovers instead of looping until it fails.
  const thisEntry: AbstractAction = firstEntry && options.faultInjection
    ? { kind: "navigate", url: withInject(artifact.entry.url, options.faultInjection) }
    : entryAction;
  firstEntry = false;
  const entryVerdict = policy.check(thisEntry, { risk: "read_only" });
  await logger.event({ type: "policy_check", step: 0, verdict: entryVerdict });
  if (!entryVerdict.allowed) return fail("policy_blocked", "Allowlisted capability entry URL.", entryVerdict.detail);
  const entryResult = await surface.act(thisEntry);
  await logger.event({ type: "action", step: 0, action: thisEntry, resultUrl: entryResult.url });

  // Follow saved steps in order. The inner loop exists only so a human handoff or
  // a retry_current_step recovery can re-run the current step from fresh state.
  stepsLoop: for (const [index, step] of artifact.steps.entries()) {
    let retryCurrentStep = true;
    while (retryCurrentStep) {
      retryCurrentStep = false;
      if (Date.now() > deadline) return fail("timeout", `Replay within ${artifact.policy.max_duration_ms}ms.`, "Capability duration limit was exceeded.");
      currentStep = step.id;
      currentIntent = step.intent;
      const stepStartedAt = Date.now();
      let observation = await surface.observe();

      // Before acting, detect global application/session failures, apply bounded
      // recovery, offer handoff for approval walls, and classify business outcomes.
      const rawPreGlobal = detectGlobalFailure(observation, signatures);
      const preGlobal = rawPreGlobal?.class === "session_lost" && !requiresAuthentication ? undefined : rawPreGlobal;
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
      if (recovered === "restart_capability" || recovered === "retry_current_step") {
        if (mutationMayHaveOccurred) return fail("precondition_failed", "A recovery path that cannot repeat a business action.", "Recovery would re-run steps after a record-changing action may already have been attempted; verify the application state before retrying.");
        if (recovered === "restart_capability") continue restartLoop;
        retryCurrentStep = true;
        continue;
      }
      if (recovered === "continue") observation = await surface.observe();
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

      // A human-required step is verified, never performed: resolving the
      // target above proves the screen is the one the boundary was recorded on,
      // and then the machine stops. The person acts in the same browser; on
      // hand-back the artifact's own predicates decide where the run is. This
      // supports the recorded flows, where the irreversible post is the final
      // step - a satisfied checkpoint completes the run.
      if (step.execution === "human_required") {
        if (!options.handoff) return fail("policy_blocked", "An attached operator handoff for the human-required step.", "This step must be performed by a person and no handoff is attached.");
        const resume = await requestHandoff(step, observation, "This step is irreversible and must be performed by a person.", step.intent);
        if (resume === "timed_out") return fail("timeout", "A human operator to take control of the paused run.", "The intervention request expired with no operator.");
        if (resume === "checkpoint") { mutationMayHaveOccurred = true; break stepsLoop; }
        if (resume === "completed") { mutationMayHaveOccurred = true; break; }
        if (resume === "retry") {
          return fail("precondition_failed", "The human-required step performed by the operator.", "Control was handed back but the irreversible step was not performed.");
        }
        return fail("precondition_failed", "A resumable state after human handoff.", "State diverged after handoff.");
      }

      // Materialize the action, enforce the capability allowlist, infer runtime
      // risk, and then enforce the wider deployment policy before Surface.act().
      const action = materializeAction(step, params, resolved?.ref);
      const stepViolation = artifactPolicyViolation(artifact, action);
      if (stepViolation) return fail("policy_blocked", "An action inside the artifact's own allowlist.", stepViolation);
      const targetElement = resolved ? observation.elements.find((element) => element.ref === resolved?.ref) : undefined;
      const risk = inferRisk(action, targetElement?.name ?? currentIntent, options.irreversibleActions ?? []);
      const verdict = policy.check(action, { risk, allowMutations: artifact.capability.status === "approved" || options.confirmMutations, targetName: targetElement?.name });
      await logger.event({ type: "policy_check", step: index + 1, verdict });
      if (!verdict.allowed) return fail("policy_blocked", "An action permitted by policy and risk approval.", verdict.detail);
      const actionResult = await surface.act(action);
      if (risk !== "read_only") mutationMayHaveOccurred = true;
      await logger.event({ type: "action", step: index + 1, action, resultUrl: actionResult.url });
      observation = await observeAfterAction(surface, observation.stateHash, step.wait.timeout_ms);

      // Re-observe after the action, then detect hard failures, declared outcomes,
      // recovery conditions, escalation walls, and finally step postconditions.
      const rawGlobal = detectGlobalFailure(observation, signatures);
      const global = rawGlobal?.class === "session_lost" && !requiresAuthentication ? undefined : rawGlobal;
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
      const recoveredAfter = await applyRecovery(observation, index + 1);
      if (recoveredAfter === "restart_capability" || recoveredAfter === "retry_current_step") {
        if (mutationMayHaveOccurred) return fail("precondition_failed", "A recovery path that cannot repeat a business action.", "Recovery would re-run steps after a record-changing action may already have been attempted; verify the application state before retrying.");
        if (recoveredAfter === "restart_capability") continue restartLoop;
        retryCurrentStep = true;
        continue;
      }
      if (recoveredAfter === "continue") observation = await surface.observe();
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
      await logger.event({ type: "step_completed", step: index + 1, stepId: step.id, durationMs: Date.now() - stepStartedAt });
      // Debug capture: a per-step screenshot of the settled screen, saved locally
      // for a human to debug from the dashboard. Never on the default path.
      if (options.captureScreenshots) {
        const shot = (await surface.observe({ screenshot: true })).screenshot;
        if (shot) {
          const saved = await logger.screenshot(index + 1, shot);
          await logger.event({ type: "observation", step: index + 1, url: observation.url, title: observation.title, stateHash: observation.stateHash, elementCount: observation.elements.length, screenshot: saved });
        }
      }
    }
  }
  // Every step completed without a restart request; leave the restart loop.
  break restartLoop;
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
  // The full live header set per table output, captured for shape-drift
  // detection. Header labels only - never cell values.
  const observedShapes: Record<string, string[]> = {};
  for (const extraction of artifact.extract) {
    const resolution = await surface.resolve(extraction.from);
    lastAttempts = resolution.attempts;
    if (!resolution.ok) return fail("target_not_found", `Extraction target for ${extraction.output}.`, "Extraction locator ladder was exhausted.");
    recordTier(stats, `extract:${extraction.output}`, resolution);
    if (extraction.parse === "table") {
      // Columns are matched by live header text, so a reordered table keeps its
      // meaning and a renamed or missing column fails loudly instead of
      // silently shifting every value one place over.
      const snapshot = await surface.readTable(resolution.ref);
      // Record the live header set (labels only) so the eval sweep can compare
      // it against the declared columns and flag data-shape drift.
      observedShapes[extraction.output] = snapshot.headers.map((header) => header.trim()).filter((header) => header !== "");
      const headerIndex = new Map(snapshot.headers.map((header, index) => [header.trim().toLowerCase(), index]));
      const columns = extraction.columns ?? [];
      const missing = columns.filter((column) => !headerIndex.has(column.header.trim().toLowerCase()));
      if (missing.length > 0) {
        return fail("postcondition_failed", `Table columns for ${extraction.output}: ${columns.map((column) => column.header).join(", ")}.`, `Columns not present: ${missing.map((column) => column.header).join(", ")}.`);
      }
      const declaredOutput = artifact.outputs.properties[extraction.output];
      const itemProperties = declaredOutput?.type === "array" ? declaredOutput.items.properties : {};
      const rows: Record<string, unknown>[] = [];
      for (const [rowIndex, row] of snapshot.rows.entries()) {
        const entry: Record<string, unknown> = {};
        for (const column of columns) {
          const cell = row[headerIndex.get(column.header.trim().toLowerCase())!];
          // A short row means the table's shape is not what the artifact
          // recorded. An empty-string substitute would fabricate data.
          if (cell === undefined) {
            return fail("postcondition_failed", `A value under "${column.header}" in every row of ${extraction.output}.`, `Row ${rowIndex + 1} has no cell under "${column.header}".`);
          }
          const declaredCell = itemProperties[column.property];
          // Sensitivity lives on columns, not on the output's name: a table
          // called "matches" still carries member numbers and names. Register
          // before parsing so even a parse failure's evidence is redacted.
          // Short fragments are skipped - registering "2" would redact every 2.
          if ((declaredOutput?.sensitive || declaredCell?.sensitive) && cell.trim().length >= 4) logger.markSensitive(cell.trim());
          const parsed = parseCell(cell, declaredCell?.type ?? "string");
          if (!parsed.ok) {
            // The raw value is deliberately not quoted here: an unparseable
            // sensitive cell must not leak through a failure message.
            return fail("postcondition_failed", `Column "${column.header}" of ${extraction.output} parseable as ${declaredCell?.type ?? "string"}.`, `Row ${rowIndex + 1}'s value under "${column.header}" is not a valid ${declaredCell?.type ?? "string"}.`);
          }
          entry[column.property] = parsed.value;
        }
        rows.push(entry);
      }
      outputs[extraction.output] = rows;
      continue;
    }
    const raw = (await surface.read(resolution.ref)).text;
    outputs[extraction.output] = extraction.parse === "number" ? Number(raw.replace(/[^0-9.-]/g, "")) : raw;
    if (artifact.outputs.properties[extraction.output]?.sensitive) logger.markSensitive(String(outputs[extraction.output]));
  }

  // Success returns outputs plus locator stability and intervention telemetry,
  // then completes the same evidence/redaction lifecycle as every other outcome.
  const result: ReplayResult = { status: "success", outputs, evidence: logger.directory, stability: stats, ...(Object.keys(observedShapes).length > 0 ? { observedShape: observedShapes } : {}), ...interventionPart() };
  // Persist a structurally redacted copy - short sensitive values included -
  // but return the real outputs to the authorized caller.
  const persisted: ReplayResult = { ...result, outputs: redactOutputs(outputs, artifact.outputs) };
  await logger.event({ type: "result", status: "success", detail: persisted });
  await logger.result(persisted);
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
  // Returns the applied rule's declared effect, or "none" when nothing matched
  // or the rule was exhausted/blocked. The caller decides what the effect means
  // for control flow; this function only performs the bounded click.
  async function applyRecovery(observation: Observation, stepNumber: number): Promise<"none" | "continue" | "retry_current_step" | "restart_capability"> {
    for (const rule of artifact.recovery) {
      if (!(await predicateMatches(rule.condition, observation, surface))) continue;
      const attempts = recoveryAttempts.get(rule.id) ?? 0;
      if (attempts >= rule.max_attempts) return "none";
      recoveryAttempts.set(rule.id, attempts + 1);
      const resolution = await surface.resolve(rule.action.target);
      lastAttempts = resolution.attempts;
      if (!resolution.ok) return "none";
      recordTier(stats, `recovery:${rule.id}`, resolution);
      const action: AbstractAction = { kind: "click", ref: resolution.ref };
      if (artifactPolicyViolation(artifact, action)) return "none";
      const verdict = policy.check(action, { risk: "read_only" });
      await logger.event({ type: "policy_check", step: stepNumber, verdict });
      if (!verdict.allowed) return "none";
      const actionResult = await surface.act(action);
      await logger.event({ type: "action", step: stepNumber, action, resultUrl: actionResult.url });
      await logger.event({ type: "recovery_applied", step: stepNumber, rule: rule.id });
      return rule.effect ?? "continue";
    }
    return "none";
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
    if (!sensitiveRun || options.captureScreenshots) screenshot = (await surface.observe({ screenshot: true })).screenshot;
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
    try { observation = await surface.observe({ screenshot: !sensitiveRun || Boolean(options.captureScreenshots) }); } catch { observation = undefined; }
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
