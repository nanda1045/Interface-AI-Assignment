const redacted = "«redacted»";
const secretPatterns = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d[ -]*?){12,19}\b/g,
  /\b(?:sk|key|token)_[A-Za-z0-9_-]{12,}\b/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Regulated financial data: no dollar balance persists raw, even when it was
  // never individually marked sensitive (e.g. adjacent accounts in a digest).
  /\$\s?\d[\d,]*\.\d{2}\b/g
];

export function redactString(value: string, sensitiveValues: readonly string[] = []): string {
  let scrubbed = value;
  for (const secret of sensitiveValues.filter(Boolean).sort((left, right) => right.length - left.length)) {
    scrubbed = scrubbed.split(secret).join(redacted);
  }
  for (const pattern of secretPatterns) scrubbed = scrubbed.replace(pattern, redacted);
  return scrubbed;
}

export function redactValue<T>(value: T, sensitiveValues: readonly string[] = []): T {
  if (typeof value === "string") return redactString(value, sensitiveValues) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, sensitiveValues)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, sensitiveValues)])) as T;
  }
  return value;
}

export { redacted as REDACTED };
