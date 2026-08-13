import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCorePointApp } from "../../apps/corepoint/app.js";
import { tenants } from "../../apps/corepoint/tenants.js";
import { applyOverlay } from "../../src/artifact/overlay.js";
import { capabilityArtifactSchema } from "../../src/artifact/schema.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import { WebSurface } from "../../src/surface/web-playwright.js";

let server: Server;
let browser: Browser;
let origin: string;
let root: string;

beforeAll(async () => {
  const tenant = tenants[1];
  if (!tenant) throw new Error("Missing tenant B");
  server = createCorePointApp(tenant).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  root = await mkdtemp(path.join(os.tmpdir(), "corepoint-tenant-b-"));
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("tenant overlay", () => {
  it("replays the base capability against relabeled and reordered Tenant B", async () => {
    const base = capabilityArtifactSchema.parse(JSON.parse(await readFile("artifacts/lookup_member_savings_balance@1.0.0.json", "utf8")));
    const artifact = applyOverlay(base, {
      schema_version: "1.0", capability: "lookup_member_savings_balance", tenant: "b", entry_url: `${origin}/operations`,
      step_targets: { s1: { frame: "workarea", strategies: [{ kind: "label_proximity", label: "Acct Holder ID", control: "input", frame: "workarea", unique: true, confidence: 0.85 }, { kind: "attr_css", value: "input[name='f_ahid']", frame: "workarea", unique: true, confidence: 0.7 }] } }
    });
    const context = await browser.newContext();
    await context.addCookies([{ name: "cp_session", value: "teller:b", url: origin, httpOnly: true, sameSite: "Lax" }]);
    const surface = new WebSurface(await context.newPage(), { context });
    const config: PolicyConfig = { allowed_origins: [origin], allowed_path_patterns: ["^/(operations|workspace)(/.*)?$"], allowed_actions: ["navigate", "click", "focus", "type", "select", "press", "scroll"], max_steps: 10, max_duration_ms: 30_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };
    try {
      const result = await replay({ artifact, params: { member_id: "4521" }, surface, policy: new PolicyEngine(config), logger: new RunLogger("tenant_b", root) });
      expect(result).toMatchObject({ status: "success", outputs: { member_name: "Alex Testman", savings_balance: "$2,481.13" } });
    } finally {
      await surface.close();
    }
  });
});
