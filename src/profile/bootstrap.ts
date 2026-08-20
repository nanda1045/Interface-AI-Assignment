// Signs an operator on to a target application before discovery or replay.
// This is runner plumbing, not a capability: credentials come from the
// environment via the profile, the password is registered with the logger
// before any event can mention it, and the whole exchange is driven through
// the same Surface and policy engine as every other action - authentication
// must not be a side door around either boundary.
import type { RunLogger } from "../evidence/run-logger.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { AbstractAction, Surface, TargetSpec } from "../surface/types.js";
import type { AppProfile, ResolvedCredentials } from "./profile.js";

function fieldTarget(name: string): TargetSpec {
  // Sign-on forms are addressed by their control names, which the profile
  // declares. attr_css is the right rung here: the page is unauthenticated
  // chrome we control the description of, not a recorded capability.
  return { strategies: [{ kind: "attr_css", value: `input[name="${name}"]`, frame: "main", unique: true, confidence: 0.7 }] };
}

function selectTarget(name: string): TargetSpec {
  return { strategies: [{ kind: "attr_css", value: `select[name="${name}"]`, frame: "main", unique: true, confidence: 0.7 }] };
}

const submitTarget: TargetSpec = {
  strategies: [{ kind: "attr_css", value: 'input[type="submit"]', frame: "main", unique: true, confidence: 0.7 }]
};

async function act(surface: Surface, policy: PolicyEngine, action: AbstractAction): Promise<void> {
  const verdict = policy.check(action, { risk: "read_only" });
  if (!verdict.allowed) throw new Error(`Sign-on blocked by policy: ${verdict.detail}`);
  await surface.act(action);
}

async function resolveOrFail(surface: Surface, target: TargetSpec, describe: string): Promise<string> {
  const resolution = await surface.resolve(target);
  if (!resolution.ok) throw new Error(`Could not find the ${describe} field on the sign-on screen.`);
  return resolution.ref;
}

/** Drives the profile's sign-on form and verifies the authenticated state.
 *  Throws with a plain message on refusal - a bad credential is an operator
 *  problem to fix, not a replay failure to classify. */
export async function signOn(options: {
  surface: Surface;
  policy: PolicyEngine;
  logger: RunLogger;
  profile: AppProfile;
  credentials: ResolvedCredentials;
}): Promise<void> {
  const { surface, policy, logger, profile, credentials } = options;
  const signon = profile.signon;
  if (!signon) throw new Error(`Profile ${profile.app.id} has no sign-on definition.`);
  // Before anything else: the password must never reach evidence, even in a
  // policy-denied error path.
  logger.markSensitive(credentials.password);

  await act(surface, policy, { kind: "navigate", url: signon.url });
  await surface.observe();

  const operatorRef = await resolveOrFail(surface, fieldTarget(signon.fields.operator), "operator");
  await act(surface, policy, { kind: "type", ref: operatorRef, text: credentials.operator });
  const passwordRef = await resolveOrFail(surface, fieldTarget(signon.fields.password), "password");
  await act(surface, policy, { kind: "type", ref: passwordRef, text: credentials.password, sensitive: true });
  if (signon.fields.branch && credentials.branch) {
    const branchRef = await resolveOrFail(surface, selectTarget(signon.fields.branch), "branch");
    await act(surface, policy, { kind: "select", ref: branchRef, value: credentials.branch });
  }
  const submitRef = await resolveOrFail(surface, submitTarget, "submit");
  await act(surface, policy, { kind: "click", ref: submitRef });

  const observation = await surface.observe();
  const text = observation.elements.map((element) => `${element.name} ${element.text ?? ""}`).join("\n");
  if (new RegExp(signon.failure_pattern, "i").test(text)) {
    throw new Error(`Sign-on was refused for operator "${credentials.operator}". Check the credential environment variables.`);
  }
  if (!new RegExp(signon.authenticated_pattern, "i").test(text)) {
    throw new Error("Sign-on did not reach an authenticated screen.");
  }
  await logger.event({ type: "signed_on", operator: credentials.operator, app: profile.app.id });
}
