import type { RunLogger } from "../evidence/run-logger.js";
import { inferRisk, type PolicyEngine } from "../policy/engine.js";
import type { AbstractAction, LocatorBundle, Surface } from "../surface/types.js";
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
}): Promise<DiscoveryResult> {
  const { goal, target, surface, policy, llm, logger } = options;
  const steps: RecordedStep[] = [];
  const outputs: Record<string, LocatorBundle> = {};
  const history: { decision: string; result: string }[] = [];
  const hashVisits = new Map<string, number>();
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
      return finish("escalated", "The same UI state was observed three times; discovery is in a dead end.");
    }
    const screenshot = observation.screenshot ? await logger.screenshot(step, observation.screenshot) : undefined;
    await logger.event({ type: "observation", step, url: observation.url, title: observation.title, stateHash: observation.stateHash, elementCount: observation.elements.length, ...(screenshot ? { screenshot } : {}) });
    const { screenshot: _ignored, ...modelObservation } = observation;
    void _ignored;
    const response = await llm.decide({ system: discoverySystemPrompt(policy.config, Boolean(options.allowMutations)), goal, observation: modelObservation, history });
    if (response.decision.kind === "type" && response.decision.sensitive) logger.markSensitive(response.decision.text);
    await logger.transcript({ step, request: { goal, observation: modelObservation, history }, response: response.raw });
    const decision = response.decision;
    await logger.event({ type: "decision", step, reasoning: decision.reasoning, decision: decision.kind });

    if (decision.kind === "finish") return finish("success", "Goal completed.");
    if (decision.kind === "escalate") return finish("escalated", decision.reason);
    if (decision.kind === "note_output") {
      if (!observation.elements.some((element) => element.ref === decision.ref)) return finish("failure", `Model selected stale or unknown ref ${decision.ref}.`);
      const locators = await surface.captureLocators(decision.ref);
      outputs[decision.name] = locators;
      await logger.event({ type: "output_marked", step, name: decision.name, locators });
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
    if (!verdict.allowed) return finish(verdict.rule === "irreversible_requires_human" ? "escalated" : "failure", verdict.detail);
    const locators = "ref" in action ? await surface.captureLocators(action.ref) : undefined;
    const result = await surface.act(action);
    steps.push({ step, reasoning: decision.reasoning, action, ...(locators ? { locators } : {}), beforeUrl: observation.url, afterUrl: result.url });
    await logger.event({ type: "action", step, action, ...(locators ? { locators } : {}), resultUrl: result.url });
    history.push({ decision: decision.kind, result: `Action completed; URL is ${result.url}.` });
  }
  return finish("failure", `Discovery exceeded max_steps (${policy.config.max_steps}).`);

  async function finish(status: DiscoveryResult["status"], reason: string): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { status, runId: logger.runId, steps, outputs, ...(status === "success" ? {} : { reason }) };
    await logger.event({ type: "result", status, detail: { reason, steps: steps.length, outputs: Object.keys(outputs) } });
    await logger.result(result);
    return result;
  }
}
