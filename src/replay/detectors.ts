// Deterministic predicate, global-failure, and escalation detection over semantic
// observations. These replace model interpretation during replay.
import type { CapabilityArtifact } from "../artifact/schema.js";
import type { Observation, Surface } from "../surface/types.js";

function pageText(observation: Observation): string {
  return observation.elements.map((element) => `${element.name} ${element.text ?? ""}`).join("\n");
}

// Evaluate one predicate from the artifact's closed predicate vocabulary.
export async function predicateMatches(
  predicate: CapabilityArtifact["checkpoint"]["assert"][number],
  observation: Observation,
  surface: Surface
): Promise<boolean> {
  switch (predicate.kind) {
    case "text_visible":
      return new RegExp(predicate.pattern, "i").test(pageText(observation));
    case "element_present":
      return (await surface.resolve(predicate.target)).ok;
    case "url_matches":
      return new RegExp(predicate.pattern).test(observation.url);
    case "dialog_present":
      return observation.elements.some((element) => element.role === "dialog" && new RegExp(predicate.textPattern, "i").test(`${element.name} ${element.text ?? ""}`));
    case "value_equals_param":
      // Invocation parameters are intentionally available only in replay engine.
      return false;
  }
}

// A checkpoint/outcome/recovery condition succeeds only when every predicate does.
export async function allPredicatesMatch(predicates: CapabilityArtifact["checkpoint"]["assert"], observation: Observation, surface: Surface): Promise<boolean> {
  for (const predicate of predicates) if (!(await predicateMatches(predicate, observation, surface))) return false;
  return true;
}

// Recognise application-wide terminal failures before/after individual steps.
export function detectGlobalFailure(observation: Observation): { class: "session_lost" | "app_error"; observed: string } | undefined {
  const text = pageText(observation);
  if (new URL(observation.url).pathname === "/login") return { class: "session_lost", observed: "The application redirected to the login screen." };
  if (/Unexpected Application Error|could not complete the request|HTTP\s*5\d\d/i.test(text)) return { class: "app_error", observed: "The application displayed an unexpected error page." };
  return undefined;
}

// Recognise authority walls and unknown dialogs that require human judgement.
export function detectEscalation(observation: Observation): { reason: string; requestedAction: string } | undefined {
  const text = pageText(observation);
  if (/Supervisor override required/i.test(text)) return { reason: "Supervisor override required", requestedAction: "Enter an authorized supervisor code and submit the confirmation form." };
  const dialog = observation.elements.find((element) => element.role === "dialog");
  if (dialog) return { reason: `Unrecognized dialog: ${dialog.name || dialog.text || "dialog"}`, requestedAction: "Review and safely resolve the dialog." };
  return undefined;
}
