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

// What "the session died", "the app broke" and "a human is needed" look like on
// one target application. This is per-app data, not engine logic: MERIDIAN's
// timeout renders an inline page on the SAME url, so its detection is a text
// pattern, while CorePoint's is a redirect to /login. Profiles supply these;
// the defaults below are CorePoint's, and a test pins the corepoint.yaml
// profile to them so the two cannot drift apart.
export interface DetectorSignatures {
  session_lost: { paths: string[]; patterns: string[] };
  app_error: { patterns: string[] };
  escalation: { patterns: string[] };
}

export const corePointSignatures: DetectorSignatures = {
  session_lost: { paths: ["/login"], patterns: [] },
  app_error: { patterns: ["Unexpected Application Error", "could not complete the request", "HTTP\\s*5\\d\\d"] },
  escalation: { patterns: ["Supervisor override required"] }
};

function matchesAny(patterns: string[], text: string): string | undefined {
  return patterns.find((pattern) => new RegExp(pattern, "i").test(text));
}

// Recognise application-wide terminal failures before/after individual steps.
// Frames report locations like "about:blank" that are not parseable URLs, and a
// detector must never be the thing that throws.
function pathOf(location: string): string | undefined {
  try {
    return new URL(location).pathname;
  } catch {
    return undefined;
  }
}

export function detectGlobalFailure(
  observation: Observation,
  signatures: DetectorSignatures = corePointSignatures
): { class: "session_lost" | "app_error"; observed: string } | undefined {
  const text = pageText(observation);
  // A framed application loses its session inside the workspace frame while the
  // top-level document stays exactly where it was, so every location has to be
  // considered rather than only the outermost one.
  const locations = [observation.url, ...observation.frames.map((frame) => frame.url)];
  const loggedOut = locations.find((location) => signatures.session_lost.paths.includes(pathOf(location) ?? ""));
  if (loggedOut) {
    const where = loggedOut === observation.url ? "" : " in the workspace frame";
    return { class: "session_lost", observed: `The application redirected to the sign-on screen${where}.` };
  }
  const timedOut = matchesAny(signatures.session_lost.patterns, text);
  if (timedOut) return { class: "session_lost", observed: `The application reports the session has ended ("${timedOut}").` };
  if (matchesAny(signatures.app_error.patterns, text)) return { class: "app_error", observed: "The application displayed an unexpected error page." };
  return undefined;
}

// Recognise authority walls and unknown dialogs that require human judgement.
// The unknown-dialog rule is generic engine behaviour and applies everywhere;
// only the authority wording is per-application.
export function detectEscalation(
  observation: Observation,
  signatures: DetectorSignatures = corePointSignatures
): { reason: string; requestedAction: string } | undefined {
  const text = pageText(observation);
  const wall = matchesAny(signatures.escalation.patterns, text);
  if (wall) return { reason: "Supervisor authority required", requestedAction: "Complete or decline the restricted step with supervisor authority, then hand back." };
  const dialog = observation.elements.find((element) => element.role === "dialog");
  if (dialog) return { reason: `Unrecognized dialog: ${dialog.name || dialog.text || "dialog"}`, requestedAction: "Review and safely resolve the dialog." };
  return undefined;
}
