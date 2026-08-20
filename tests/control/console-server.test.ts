import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleApp } from "../../src/control/console-server.js";
import { RunController } from "../../src/control/controller.js";
import { RunLogger } from "../../src/evidence/run-logger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// The console's HTML/JS is shipped as a string; these guards lock the two
// bugs that made it unusable during the first live irreversible recording.
describe("operator console page", () => {
  async function page(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "corepoint-console-"));
    roots.push(root);
    const app = createConsoleApp(new RunController(new RunLogger("console_test", root)));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      return await response.text();
    } finally {
      server.close();
    }
  }

  it("does not gather operator identity through a native prompt", async () => {
    // prompt() was destroyed by the 1.5s auto-refresh before it could be typed.
    const body = await page();
    expect(body).not.toContain("prompt(");
    expect(body).toContain('placeholder=\'operator identity\'');
  });

  it("re-renders only when the queue signature changes", async () => {
    // The signature guard is what stops the periodic refresh from wiping an
    // input the operator is mid-way through using.
    const body = await page();
    expect(body).toContain("if(sig===lastSig)return");
  });
});
