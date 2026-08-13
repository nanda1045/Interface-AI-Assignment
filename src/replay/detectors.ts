import type { CapabilityArtifact } from "../artifact/schema.js";
import type { Observation, Surface } from "../surface/types.js";

function pageText(observation: Observation): string {
  return observation.elements.map((element) => `${element.name} ${element.text ?? ""}`).join("\n");
}

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
    case "load_timeout":
    case "value_equals_param":
      return false;
  }
}

export async function allPredicatesMatch(predicates: CapabilityArtifact["checkpoint"]["assert"], observation: Observation, surface: Surface): Promise<boolean> {
  for (const predicate of predicates) if (!(await predicateMatches(predicate, observation, surface))) return false;
  return true;
}

export function detectGlobalFailure(observation: Observation): { class: "session_lost" | "app_error"; observed: string } | undefined {
  const text = pageText(observation);
  if (new URL(observation.url).pathname === "/login") return { class: "session_lost", observed: "The application redirected to the login screen." };
  if (/Unexpected Application Error|could not complete the request|HTTP\s*5\d\d/i.test(text)) return { class: "app_error", observed: "The application displayed an unexpected error page." };
  return undefined;
}
