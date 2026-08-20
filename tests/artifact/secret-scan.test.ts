// A committed capability artifact is a durable, shareable contract, so it must
// never carry run-specific data: no member number or name, no credential, no
// transaction token, no confirmation number. This offline scan runs in the
// default suite and fails the build if a re-recording ever bakes one in.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Values and shapes that only ever come from a real run against the live app.
const forbidden: { label: string; pattern: RegExp }[] = [
  { label: "seed member numbers", pattern: /\b10(0234|0987|1555|2777|3001)\b/ },
  { label: "seed member surnames", pattern: /Lovelace|Turing|Hopper|Johnson|Vaughan/ },
  { label: "seed given names", pattern: /\b(Ada|Alan|Grace|Katherine|Dorothy)\b/ },
  { label: "operator credentials", pattern: /teller1|super1/ },
  { label: "transaction token field", pattern: /_token/ },
  { label: "confirmation numbers", pattern: /\bCN\d{5,}\b/ }
];

describe("artifact secret scan", () => {
  it("has no run-specific data in any committed artifact", async () => {
    const dir = "artifacts";
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const findings: string[] = [];
    for (const file of files) {
      const raw = await readFile(path.join(dir, file), "utf8");
      for (const { label, pattern } of forbidden) {
        const hit = raw.match(pattern);
        if (hit) findings.push(`${file}: ${label} (${hit[0]})`);
      }
    }
    expect(findings).toEqual([]);
  });
});
