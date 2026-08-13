import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLogger } from "../../src/evidence/run-logger.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RunLogger.finalizeRedaction", () => {
  it("redacts late-marked strings while keeping every evidence file valid JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-logger-"));
    temporaryDirectories.push(root);
    const logger = new RunLogger("finalize", root);
    await logger.initialize();

    // Persisted before the sensitive values are known — exactly the discovery case.
    await logger.event({ type: "observation", step: 1, url: "http://localhost:4478/desk", title: "Member 4521 profile", stateHash: "abc", elementCount: 3 });
    await logger.transcript({ step: 1, request: { text: "member 4521 shows $2,481.13", bboxPct: [0.4521, 0.248113, 0.1, 0.05] } });
    await logger.result({ status: "success", outputs: { savings_balance: "$2,481.13" } });

    logger.markSensitive("4521");
    logger.markSensitive("$2,481.13");
    await logger.finalizeRedaction();

    const transcript = (await readFile(path.join(logger.directory, "transcript.jsonl"), "utf8")).trim();
    const parsedTranscript = JSON.parse(transcript) as { request: { text: string; bboxPct: number[] } };
    expect(parsedTranscript.request.bboxPct).toEqual([0.4521, 0.248113, 0.1, 0.05]);
    expect(parsedTranscript.request.text).toBe("member «redacted» shows «redacted»");

    const log = (await readFile(path.join(logger.directory, "log.jsonl"), "utf8")).trim();
    for (const line of log.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    expect(log).toContain("Member «redacted» profile");

    const result = JSON.parse(await readFile(path.join(logger.directory, "result.json"), "utf8")) as { outputs: { savings_balance: string } };
    expect(result.outputs.savings_balance).toBe("«redacted»");
  });
});
