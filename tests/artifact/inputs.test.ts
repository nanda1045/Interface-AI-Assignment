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

  it("never rounds an integer outside JavaScript's safe range", () => {
    // 9007199254740993 would silently parse to 9007199254740992 - a different
    // number. It stays a string, and validation rejects it by name.
    expect(normalizeInputs(contract, { count: "9007199254740993" })).toEqual({ count: "9007199254740993" });
    expect(normalizeInputs(contract, { count: "-42" })).toEqual({ count: -42 });
    expect(normalizeInputs(contract, { count: "9007199254740991" })).toEqual({ count: 9007199254740991 });
  });

  it("refuses to launder NaN and Infinity into strings or numbers", () => {
    expect(normalizeInputs(contract, { member_id: Number.NaN })).toEqual({ member_id: Number.NaN });
    expect(normalizeInputs(contract, { member_id: Number.POSITIVE_INFINITY })).toEqual({ member_id: Number.POSITIVE_INFINITY });
    expect(normalizeInputs(contract, { amount: "Infinity" })).toEqual({ amount: "Infinity" });
    expect(normalizeInputs(contract, { amount: "NaN" })).toEqual({ amount: "NaN" });
  });

  it("keeps identifiers declared as strings exactly as given", () => {
    // A member number is an identifier, not a quantity: "0100234" must not
    // become 100234 anywhere in the pipeline.
    expect(normalizeInputs(contract, { member_id: "0100234" })).toEqual({ member_id: "0100234" });
  });

  it("leaves undeclared names untouched for the engine to reject by name", () => {
    expect(normalizeInputs(contract, { surprise: "1" })).toEqual({ surprise: "1" });
  });
});
