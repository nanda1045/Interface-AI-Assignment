import { describe, expect, it } from "vitest";
import { redactValue, REDACTED } from "../../src/policy/redact.js";

describe("redaction", () => {
  it("scrubs explicit sensitive values and common regulated-data patterns recursively", () => {
    const original = { member: "4521", nested: ["SSN 123-45-6789", "Bearer abc.def.ghi", "card 4111 1111 1111 1111"] };
    const redacted = redactValue(original, ["4521"]);
    expect(JSON.stringify(redacted)).not.toContain("4521");
    expect(JSON.stringify(redacted)).not.toContain("123-45-6789");
    expect(JSON.stringify(redacted)).not.toContain("4111");
    expect(JSON.stringify(redacted)).toContain(REDACTED);
  });
});
