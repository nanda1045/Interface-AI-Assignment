import { describe, expect, it } from "vitest";
import { shapeTable } from "../../src/surface/web-playwright.js";

describe("shapeTable header detection", () => {
  it("treats a MERIDIAN results grid (label header, digit data) as columnar", () => {
    const rows = [["Member No.", "Name", "Shares", ""], ["100987", "Turing, Alan", "13", "Select"]];
    const shaped = shapeTable(rows, -1);
    expect(shaped.hasHeaderRow).toBe(true);
    expect(shaped.headers).toEqual(["Member No.", "Name", "Shares", ""]);
    expect(shaped.rows).toEqual([["100987", "Turing, Alan", "13", "Select"]]);
  });

  it("treats a key:value details panel (value in first row) as headerless", () => {
    // Confirmation: / CN480101 - the first row already carries a value, so it is
    // not a header and the caller reads the table as scalar text.
    const rows = [["Confirmation:", "CN480101"], ["Amount:", "$5.00"]];
    expect(shapeTable(rows, -1).hasHeaderRow).toBe(false);
  });

  it("honours a real th header row", () => {
    expect(shapeTable([["A1", "B2"], ["x", "y"]], 0).hasHeaderRow).toBe(true);
  });

  it("is headerless for an empty or single-column table", () => {
    expect(shapeTable([], -1).hasHeaderRow).toBe(false);
    expect(shapeTable([["only"]], -1).hasHeaderRow).toBe(false);
  });
});
