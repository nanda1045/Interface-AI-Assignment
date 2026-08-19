import type { HandoffCoordinator } from "../control/intervention.js";
import type { RunLogger } from "../evidence/run-logger.js";
import { inferRisk, type PolicyEngine } from "../policy/engine.js";
import type { AbstractAction, LocatorBundle, Observation, Surface } from "../surface/types.js";
import type { AgentDecision, LLMClient } from "./llm/client.js";
import { discoverySystemPrompt } from "./prompts.js";

export interface RecordedStep {
  step: number;
  reasoning: string;
  action: AbstractAction;
  locators?: LocatorBundle;
  beforeUrl: string;
  afterUrl: string;
}

export interface DiscoveryResult {
  status: "success" | "escalated" | "failure";
  runId: string;
  steps: RecordedStep[];
  outputs: Record<string, LocatorBundle>;
  reason?: string;
}

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
  await logger.initialize();
  for (const likelyIdentifier of goal.match(/\b\d{4,10}\b/g) ?? []) logger.markSensitive(likelyIdentifier);
  await logger.event({ type: "run_started", goal, target, model: llm.model });

  const initialAction: AbstractAction = { kind: "navigate", url: target };
  const initialVerdict = policy.check(initialAction, { risk: "read_only" });
  await logger.event({ type: "policy_check", step: 0, verdict: initialVerdict });
  if (!initialVerdict.allowed) return finish("failure", initialVerdict.detail);
  const initialResult = await surface.act(initialAction);
  await logger.event({ type: "action", step: 0, action: initialAction, resultUrl: initialResult.url });

  for (let step = 1; step <= policy.config.max_steps; step += 1) {
    if (Date.now() - startedAt > policy.config.max_duration_ms) return finish("failure", "Discovery exceeded max_duration_ms.");
    const observation = await surface.observe({ screenshot: true });
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
    const markedOutputs = Object.keys(outputs);
    const response = await llm.decide({ system: discoverySystemPrompt(policy.config, Boolean(options.allowMutations), options.expectedOutputs), goal, observation: modelObservation, history, markedOutputs });
    if (response.decision.kind === "type" && response.decision.sensitive) logger.markSensitive(response.decision.text);
    await logger.transcript({ step, request: { goal, markedOutputs, observation: modelObservation, history }, response: response.raw });
    const decision = response.decision;
    await logger.event({ type: "decision", step, reasoning: decision.reasoning, decision: decision.kind });

    if (decision.kind === "finish") return finish("success", "Goal completed.");
    if (decision.kind === "escalate") {
      if (await humanUnblocked(step, observation, decision.reason, "Resolve the blocker the agent reported, then hand back.")) continue;
      return finish("escalated", decision.reason);
    }
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

    const action = toAction(decision);
    if (!action) return finish("failure", "Unsupported model decision.");
    const targetElement = "ref" in action ? observation.elements.find((element) => element.ref === action.ref) : undefined;
    if ("ref" in action && !targetElement) return finish("failure", `Model selected stale or unknown ref ${action.ref}.`);
    const risk = inferRisk(action, targetElement?.name ?? targetElement?.text ?? "");
    const verdict = policy.check(action, { risk, allowMutations: options.allowMutations, targetName: targetElement?.name });
    await logger.event({ type: "policy_check", step, verdict });
    if (!verdict.allowed) {
      if (verdict.rule === "irreversible_requires_human") {
        if (await humanUnblocked(step, observation, verdict.detail, "Perform or decline the irreversible step manually, then hand back.")) continue;
        return finish("escalated", verdict.detail);
      }
      return finish("failure", verdict.detail);
    }
    const locators = "ref" in action ? await surface.captureLocators(action.ref) : undefined;
    const result = await surface.act(action);
    steps.push({ step, reasoning: decision.reasoning, action, ...(locators ? { locators } : {}), beforeUrl: observation.url, afterUrl: result.url });
    await logger.event({ type: "action", step, action, ...(locators ? { locators } : {}), resultUrl: result.url });
    history.push({ decision: decision.kind, result: `Action completed; URL is ${result.url}.` });
  }
  return finish("failure", `Discovery exceeded max_steps (${policy.config.max_steps}).`);

  // A stuck discovery pauses into the same lease/console handoff as replay: the
  // human resolves the blocker in the live session, hands back, and the loop
  // re-observes instead of ending the run.
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
    // An expired request leaves the lease aborted, so there is nothing to resume.
    // Reporting it as unresolved lets the run finish normally, which matters here
    // because the retrospective redaction pass only runs on a terminal result.
    if (request.status === "aborted") return false;
    await handoff.resume();
    hashVisits.clear();
    duplicateOutputMarks = 0;
    history.push({ decision: "handoff", result: "A human operator resolved the blocker in the live session; re-observe before deciding." });
    return true;
  }

  async function finish(status: DiscoveryResult["status"], reason: string): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { status, runId: logger.runId, steps, outputs, ...(status === "success" ? {} : { reason }) };
    await logger.event({ type: "result", status, detail: { reason, steps: steps.length, outputs: Object.keys(outputs) } });
    await logger.result(result);
    await logger.finalizeRedaction();
    return result;
  }
}
