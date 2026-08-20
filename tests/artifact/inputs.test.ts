import { describe, expect, it } from "vitest";
import { normalizeInputs } from "../../src/artifact/inputs.js";
import type { ObjectContract } from "../../src/artifact/schema.js";

const contract: ObjectContract = {
  type: "object",
  required: ["member_id"],
  properties: {
    member_id: { type: "string" },
    amount: { type: "number" },
    count: { type: "integer" },
    confirmed: { type: "boolean" }
  }
};

describe("normalizing invocation values against the declared contract", () => {
  it("converts JSON numbers and booleans to declared strings", () => {
    expect(normalizeInputs(contract, { member_id: 100234 })).toEqual({ member_id: "100234" });
    expect(normalizeInputs(contract, { member_id: true })).toEqual({ member_id: "true" });
  });

  it("converts numeric strings to declared numbers and integers", () => {
    expect(normalizeInputs(contract, { amount: "25.00", count: "3" })).toEqual({ amount: 25, count: 3 });
  });

  it("refuses lossy conversions so validation reports them honestly", () => {
    // "12.5" is not an integer and blind coercion would quietly truncate it.
    expect(normalizeInputs(contract, { count: "12.5" })).toEqual({ count: "12.5" });
    expect(normalizeInputs(contract, { amount: "not-a-number" })).toEqual({ amount: "not-a-number" });
    expect(normalizeInputs(contract, { confirmed: "yes" })).toEqual({ confirmed: "yes" });
  });

  it("converts only the literal true/false strings to booleans", () => {
    expect(normalizeInputs(contract, { confirmed: "true" })).toEqual({ confirmed: true });
    expect(normalizeInputs(contract, { confirmed: "false" })).toEqual({ confirmed: false });
  });

  it("leaves undeclared names untouched for the engine to reject by name", () => {
    expect(normalizeInputs(contract, { surprise: "1" })).toEqual({ surprise: "1" });
  });
});
