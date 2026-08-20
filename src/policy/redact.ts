// Recursive text redaction shared by evidence and artifact distillation. It
// removes exact values learned during a run plus common credential/financial
// patterns, while preserving the surrounding JSON structure for auditability.
const redacted = "«redacted»";

// Baseline patterns protect recognised regulated/secret formats even when the
// caller did not explicitly mark that exact value during the run.
const secretPatterns = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d[ -]*?){12,19}\b/g,
  /\b(?:sk|key|token)_[A-Za-z0-9_-]{12,}\b/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Protect dollar balances even when a neighbouring value was never marked.
  /\$\s?\d[\d,]*\.\d{2}\b/g
];

// Replace longer exact values first to avoid a shorter value partially exposing
// or changing a longer secret, then apply the general format patterns.
export function redactString(value: string, sensitiveValues: readonly string[] = []): string {
  let scrubbed = value;
  for (const secret of sensitiveValues.filter(Boolean).sort((left, right) => right.length - left.length)) {
    scrubbed = scrubbed.split(secret).join(redacted);
  }
  for (const pattern of secretPatterns) scrubbed = scrubbed.replace(pattern, redacted);
  return scrubbed;
}

// Walk arbitrary JSON-like data and redact string values without changing keys,
// booleans, numbers, or the overall evidence structure.
export function redactValue<T>(value: T, sensitiveValues: readonly string[] = []): T {
  if (typeof value === "string") return redactString(value, sensitiveValues) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, sensitiveValues)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, sensitiveValues)])) as T;
  }
  return value;
}

export { redacted as REDACTED };
