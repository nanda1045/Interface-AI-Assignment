// Model-driven discovery engine. It repeatedly gives the LLM a text-only page
// observation, validates its bounded decision, applies policy, asks the trusted
// Surface to perform the action, and records verified locators for distillation.
// The LLM chooses actions here but never operates Playwright directly.
import type { HandoffCoordinator } from "../control/intervention.js";
import type { RunLogger } from "../evidence/run-logger.js";
import { inferRisk, type PolicyEngine } from "../policy/engine.js";
import type { AbstractAction, LocatorBundle, Observation, Surface } from "../surface/types.js";
import type { AgentDecision, LLMClient } from "./llm/client.js";
import { discoverySystemPrompt } from "./prompts.js";

// One browser action captured during discovery. This trajectory is later
// distilled into a capability; it is not itself the replay artifact.
export interface RecordedStep {
  step: number;
  reasoning: string;
  action: AbstractAction;
  locators?: LocatorBundle;
  beforeUrl: string;
  afterUrl: string;
  /** Set when the model proposed an irreversible action: the target was
   *  verified and recorded, a human performed it, the model never did. */
  execution?: "human_required";
}

// Discovery has three explicit terminal states and returns verified output
// locations rather than persisting the output values seen in this run.
export interface DiscoveryResult {
  status: "success" | "escalated" | "failure";
  runId: string;
  steps: RecordedStep[];
  outputs: Record<string, LocatorBundle>;
  reason?: string;
}

// Translate the model's validated decision into the small action vocabulary
// understood by Surface. The model chooses; trusted code performs the action.
function toAction(decision: AgentDecision): AbstractAction | undefined {
  switch (decision.kind) {
    case "navigate": return { kind: "navigate", url: decision.url };
    case "click": return { kind: "click", ref: decision.ref };
    case "focus": return { kind: "focus", ref: decision.ref };
    case "type": return { kind: "type", ref: decision.ref, text: decision.text, sensitive: decision.sensitive };
    case "select": return { kind: "select", ref: decision.ref, value: decision.value };
    case "press": return { kind: "press", key: decision.key };
    case "scroll": return { kind: "scroll", direction: decision.direction };
    case "note_output":
    case "finish":
    case "escalate": return undefined;
  }
}

// Model-driven discovery loop. It observes semantic text, accepts one bounded
// decision, checks it, captures locators, acts, and records the trajectory.
export async function runDiscovery(options: {
  goal: string;
  target: string;
  surface: Surface;
  policy: PolicyEngine;
  llm: LLMClient;
  logger: RunLogger;
  allowMutations?: boolean;
  expectedOutputs?: string[];
  handoff?: HandoffCoordinator;
}): Promise<DiscoveryResult> {
  const { goal, target, surface, policy, llm, logger } = options;
  const steps: RecordedStep[] = [];
  const outputs: Record<string, LocatorBundle> = {};
  const history: { decision: string; result: string }[] = [];
  const hashVisits = new Map<string, number>();
  let duplicateOutputMarks = 0;
  const startedAt = Date.now();

  // Start evidence collection and mark identifier-like values from the goal so
  // the final retrospective redaction pass can remove them from every file.
  await logger.initialize();
  for (const likelyIdentifier of goal.match(/\b\d{4,10}\b/g) ?? []) logger.markSensitive(likelyIdentifier);
  await logger.event({ type: "run_started", goal, target, model: llm.model });

  // Even opening the target page is an action, so deployment policy checks the
  // initial navigation before the browser is allowed to perform it.
  const initialAction: AbstractAction = { kind: "navigate", url: target };
  const initialVerdict = policy.check(initialAction, { risk: "read_only" });
  await logger.event({ type: "policy_check", step: 0, verdict: initialVerdict });
  if (!initialVerdict.allowed) return finish("failure", initialVerdict.detail);
  const initialResult = await surface.act(initialAction);
  await logger.event({ type: "action", step: 0, action: initialAction, resultUrl: initialResult.url });

  // Policy limits both step count and wall-clock time so discovery cannot run
  // indefinitely or consume unbounded model/browser resources.
  for (let step = 1; step <= policy.config.max_steps; step += 1) {
    if (Date.now() - startedAt > policy.config.max_duration_ms) return finish("failure", "Discovery exceeded max_duration_ms.");

    // Surface creates a semantic page digest, temporary refs, and state hash.
    // A screenshot may be retained as evidence but is never sent to the model.
    const observation = await surface.observe({ screenshot: true });

    // Seeing the same state three times after attempted work indicates a dead
    // end. Prefer same-session human handoff when it is enabled.
    const visits = (hashVisits.get(observation.stateHash) ?? 0) + 1;
    hashVisits.set(observation.stateHash, visits);
    const recentDecisions = history.slice(-2).map((entry) => entry.decision);
    if (visits >= 3 && recentDecisions.some((decision) => decision !== "note_output")) {
      const reason = "The same UI state was observed three times; discovery is in a dead end.";
      if (await humanUnblocked(step, observation, reason, "Unblock the flow in the live browser, then hand back.")) continue;
      return finish("escalated", reason);
    }
    const screenshot = observation.screenshot ? await logger.screenshot(step, observation.screenshot) : undefined;
    await logger.event({ type: "observation", step, url: observation.url, title: observation.title, stateHash: observation.stateHash, elementCount: observation.elements.length, ...(screenshot ? { screenshot } : {}) });
    const { screenshot: _ignored, ...modelObservation } = observation;
    void _ignored;

    // The LLM sees only the system prompt, goal, semantic text observation,
    // recent history, and output names. It returns one schema-checked decision.
    const markedOutputs = Object.keys(outputs);
    const response = await llm.decide({ system: discoverySystemPrompt(policy.config, Boolean(options.allowMutations), options.expectedOutputs), goal, observation: modelObservation, history, markedOutputs });
    if (response.decision.kind === "type" && response.decision.sensitive) logger.markSensitive(response.decision.text);
    await logger.transcript({ step, request: { goal, markedOutputs, observation: modelObservation, history }, response: response.raw });
    const decision = response.decision;
    await logger.event({ type: "decision", step, reasoning: decision.reasoning, decision: decision.kind });

    // finish and escalate control the discovery loop; neither directly changes
    // the browser. Escalation can pause for a human in the same live session.
    if (decision.kind === "finish") return finish("success", "Goal completed.");
    if (decision.kind === "escalate") {
      if (await humanUnblocked(step, observation, decision.reason, "Resolve the blocker the agent reported, then hand back.")) continue;
      return finish("escalated", decision.reason);
    }

    // note_output records a verified way to locate an output on future replays.
    // The current value is read only so it can be marked sensitive, not saved as
    // the capability's output value.
    if (decision.kind === "note_output") {
      if (!observation.elements.some((element) => element.ref === decision.ref)) return finish("failure", `Model selected stale or unknown ref ${decision.ref}.`);
      if (options.expectedOutputs?.length && !options.expectedOutputs.includes(decision.name)) {
        history.push({ decision: "note_output", result: `${decision.name} is not in the declared output contract: ${options.expectedOutputs.join(", ")}.` });
        continue;
      }
      if (outputs[decision.name]) {
        duplicateOutputMarks += 1;
        if (duplicateOutputMarks >= 3) return finish("escalated", `The model repeatedly marked the already-recorded output ${decision.name}.`);
        history.push({ decision: "note_output", result: `${decision.name} is already marked; choose a different output or finish if the goal is complete.` });
        continue;
      }
      const locators = await surface.captureLocators(decision.ref);
      const outputValue = await surface.read(decision.ref);
      logger.markSensitive(outputValue.text);
      if (outputValue.value) logger.markSensitive(outputValue.value);
      outputs[decision.name] = locators;
      await logger.event({ type: "output_marked", step, name: decision.name, locators });
      if (options.expectedOutputs?.length && options.expectedOutputs.every((name) => outputs[name])) {
        return finish("success", "Every declared output was visibly marked.");
      }
      history.push({ decision: decision.kind, result: `Marked output ${decision.name}.` });
      continue;
    }

    // Convert the decision, reject stale refs, infer observational risk, and
    // enforce deployment policy before any browser action can occur.
    const action = toAction(decision);
    if (!action) return finish("failure", "Unsupported model decision.");
    const targetElement = "ref" in action ? observation.elements.find((element) => element.ref === action.ref) : undefined;
    if ("ref" in action && !targetElement) return finish("failure", `Model selected stale or unknown ref ${action.ref}.`);
    const risk = inferRisk(action, targetElement?.name ?? targetElement?.text ?? "");
    const verdict = policy.check(action, { risk, allowMutations: options.allowMutations, targetName: targetElement?.name });
    await logger.event({ type: "policy_check", step, verdict });
    if (!verdict.allowed) {
      if (verdict.rule === "irreversible_requires_human") {
        // Capture the verified target and record the step as human-required
        // BEFORE control transfers: the human is about to perform it, and the
        // capability must carry the boundary the model was stopped at.
        if (options.handoff && "ref" in action) {
          const locators = await surface.captureLocators(action.ref);
          steps.push({ step, reasoning: decision.reasoning, action, locators, beforeUrl: observation.url, afterUrl: observation.url, execution: "human_required" });
          await logger.event({ type: "human_step_recorded", step, action });
        }
        if (await humanUnblocked(step, observation, verdict.detail, "Perform or decline the irreversible step manually, then hand back.")) continue;
        return finish("escalated", verdict.detail);
      }
      return finish("failure", verdict.detail);
    }

    // Capture locators before acting because a click or navigation can remove
    // the selected element. Surface.act(), not the model, operates Playwright.
    const locators = "ref" in action ? await surface.captureLocators(action.ref) : undefined;
    const result = await surface.act(action);
    steps.push({ step, reasoning: decision.reasoning, action, ...(locators ? { locators } : {}), beforeUrl: observation.url, afterUrl: result.url });
    await logger.event({ type: "action", step, action, ...(locators ? { locators } : {}), resultUrl: result.url });
    history.push({ decision: decision.kind, result: `Action completed; URL is ${result.url}.` });
  }
  return finish("failure", `Discovery exceeded max_steps (${policy.config.max_steps}).`);

  // Pause a stuck, escalated, or irreversible flow for a human. Successful
  // handback clears loop counters and forces a fresh observation before the
  // model decides again.
  async function humanUnblocked(step: number, observation: Observation, reason: string, requestedAction: string): Promise<boolean> {
    const handoff = options.handoff;
    if (!handoff) return false;
    const request = await handoff.request({
      runId: logger.runId,
      capability: "discovery",
      goal,
      step: `step-${step}`,
      intent: reason,
      reason,
      requestedAction,
      ...(observation.screenshot ? { screenshot: observation.screenshot } : {}),
      recentEvents: [{ url: observation.url, title: observation.title, stateHash: observation.stateHash }]
    });

    // An unanswered request is a controlled terminal condition. Returning false
    // lets finish() persist evidence and complete redaction instead of throwing.
    if (request.status === "aborted") return false;
    await handoff.resume();
    hashVisits.clear();
    duplicateOutputMarks = 0;
    history.push({ decision: "handoff", result: "A human operator resolved the blocker in the live session; re-observe before deciding." });
    return true;
  }

  // Every exit passes through one place so result evidence and retrospective
  // redaction are completed for success, escalation, and failure.
  async function finish(status: DiscoveryResult["status"], reason: string): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { status, runId: logger.runId, steps, outputs, ...(status === "success" ? {} : { reason }) };
    await logger.event({ type: "result", status, detail: { reason, steps: steps.length, outputs: Object.keys(outputs) } });
    await logger.result(result);
    await logger.finalizeRedaction();
    return result;
  }
}
