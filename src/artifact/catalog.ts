// Projects approved capabilities into the tool definitions an AI agent can be
// given. This is deliberately a projection rather than a second contract: the
// typed inputs, typed outputs and description were written for a human reviewer,
// and they turn out to be exactly what a calling model needs to know.
import type { CapabilityArtifact, ObjectContract } from "./schema.js";

/** A tool definition in the shape both major providers accept. */
export interface CapabilityTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

export interface CatalogEntry {
  /** The concrete id@version this entry describes, so a caller records what it
   *  actually invoked rather than the name it asked for. */
  reference: string;
  risk: CapabilityArtifact["capability"]["risk"];
  tool: CapabilityTool;
}

// Copy the JSON Schema fields across explicitly rather than spreading and
// deleting our own. An allow-list cannot leak a field added to the artifact
// schema later; a deny-list silently would.
function toJsonSchema(contract: ObjectContract): CapabilityTool["input_schema"] {
  return {
    type: "object",
    required: [...contract.required],
    properties: Object.fromEntries(
      Object.entries(contract.properties).map(([name, property]) => [name, {
        type: property.type,
        ...(property.description ? { description: property.description } : {}),
        ...(property.pattern ? { pattern: property.pattern } : {})
      }])
    )
  };
}

// A tool definition has no place to declare what comes back, so the outputs are
// described in prose. A model that knows what it will receive picks better.
function describeOutputs(outputs: ObjectContract): string {
  const described = Object.entries(outputs.properties)
    .map(([name, property]) => `${name} (${property["x-format"] ?? property.type})`)
    .join(", ");
  return described ? ` Returns: ${described}.` : "";
}

export function toCapabilityTool(artifact: CapabilityArtifact): CapabilityTool {
  return {
    name: artifact.capability.id,
    description: `${artifact.capability.description}${describeOutputs(artifact.outputs)}`,
    input_schema: toJsonSchema(artifact.inputs)
  };
}

/** Irreversible capabilities are omitted entirely. Replay refuses them
 *  unattended, so listing one would advertise a call that is guaranteed to
 *  fail - and an agent should not be told it can do something it cannot. */
export function buildCatalog(artifacts: CapabilityArtifact[]): CatalogEntry[] {
  return artifacts
    .filter((artifact) => artifact.capability.risk !== "irreversible")
    .map((artifact) => ({
      reference: `${artifact.capability.id}@${artifact.capability.version}`,
      risk: artifact.capability.risk,
      tool: toCapabilityTool(artifact)
    }))
    .sort((left, right) => left.tool.name.localeCompare(right.tool.name));
}
