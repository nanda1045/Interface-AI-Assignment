// Normalizes invocation values against the artifact's declared input contract.
// Callers arrive with different physics - the CLI sends strings, a model or an
// API client sends real JSON numbers and booleans - and blindly stringifying
// everything would let "true" satisfy a boolean or "12.5" satisfy an integer.
// Conversion happens only when the declared type asks for it and the value
// converts losslessly; anything else is left untouched for validation to
// reject with its usual message.
import type { ObjectContract } from "./schema.js";

export function normalizeInputs(contract: ObjectContract, values: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const declared = contract.properties[name];
    if (!declared || value === undefined || value === null) {
      normalized[name] = value;
      continue;
    }
    switch (declared.type) {
      case "string":
        normalized[name] = typeof value === "number" || typeof value === "boolean" ? String(value) : value;
        break;
      case "number":
        normalized[name] = typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
        break;
      case "integer":
        normalized[name] = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
        break;
      case "boolean":
        normalized[name] = value === "true" ? true : value === "false" ? false : value;
        break;
      default:
        normalized[name] = value;
    }
  }
  return normalized;
}
