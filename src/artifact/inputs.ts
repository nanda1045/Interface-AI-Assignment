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
        // NaN and Infinity are left alone rather than becoming the strings
        // "NaN"/"Infinity"; validation reports them as the wrong type instead.
        normalized[name] = (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" ? String(value) : value;
        break;
      case "number":
        normalized[name] = typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
        break;
      case "integer": {
        // Digits alone are not enough: 9007199254740993 parses to a DIFFERENT
        // integer. Anything outside the safe range stays a string and is
        // rejected by validation rather than silently rounded.
        const text = typeof value === "string" ? value.trim() : "";
        const parsed = Number(text);
        normalized[name] = /^-?\d+$/.test(text) && Number.isSafeInteger(parsed) ? parsed : value;
        break;
      }
      case "boolean":
        normalized[name] = value === "true" ? true : value === "false" ? false : value;
        break;
      default:
        normalized[name] = value;
    }
  }
  return normalized;
}
