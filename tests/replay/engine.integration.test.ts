import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCorePointApp } from "../../apps/corepoint/app.js";
import { tenants } from "../../apps/corepoint/tenants.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import { WebSurface } from "../../src/surface/web-playwright.js";

let server: Server;
let browser: Browser;
let origin: string;
let temporaryRoot: string;

beforeAll(async () => {
  const tenant = tenants[0];
  if (!tenant) throw new Error("Missing tenant A");
  server = createCorePointApp(tenant).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not resolve test server port");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "corepoint-replay-"));
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryRoot, { recursive: true, force: true });
});

function artifact(): CapabilityArtifact {
  const field = { frame: "workarea", strategies: [{ kind: "label_proximity" as const, label: "Member No.", control: "input", frame: "workarea", unique: true as const, confidence: 0.85 }, { kind: "attr_css" as const, value: "input[name='f_mno']", frame: "workarea", unique: true as const, confidence: 0.7 }] };
  return {
    schema_version: "1.0",
    capability: { id: "lookup_member_savings_balance", version: "1.0.0", title: "Look up member savings balance", description: "Searches for a member and reads regular savings.", app: { id: "corepoint-teller", vendor: "CorePoint Systems", ui_version_range: ">=3.1 <4" }, risk: "read_only", status: "draft", provenance: { discovered_by: "test", discovery_run: "disc_test", recorded_at: "2026-08-13T00:00:00.000Z", approved_by: null, approved_at: null } },
    inputs: { type: "object", required: ["member_id"], properties: { member_id: { type: "string", pattern: "^[0-9]{4}$", sensitive: true } } },
    outputs: { type: "object", required: ["savings_balance"], properties: { savings_balance: { type: "string", "x-format": "usd-currency", sensitive: true } } },
    entry: { url: `${origin}/desk`, preconditions: [{ kind: "authenticated", via: "test session" }] },
    steps: [
      { id: "s1", intent: "Enter the member ID", action: { kind: "type", value_from: { param: "member_id" }, sensitive: true }, target: field, wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "value_equals_param", param: "member_id" }] },
      { id: "s2", intent: "Search for the member", action: { kind: "click" }, target: { frame: "workarea", strategies: [{ kind: "role_name", role: "button", name: "Search", frame: "workarea", unique: true, confidence: 0.9 }] }, wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [] },
      { id: "s3", intent: "Open the member profile", action: { kind: "click" }, target: { frame: "workarea", strategies: [{ kind: "role_name", role: "link", name: "Open Member", frame: "workarea", unique: true, confidence: 0.9 }] }, wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "text_visible", pattern: "Member Profile", frame: "workarea" }] }
    ],
    checkpoint: { assert: [{ kind: "text_visible", pattern: "Member Profile", frame: "workarea" }, { kind: "element_present", target: { frame: "workarea", strategies: [{ kind: "label_adjacent_cell", label: "Regular Savings", frame: "workarea", unique: true, confidence: 0.85 }] } }] },
    extract: [{ output: "savings_balance", from: { frame: "workarea", strategies: [{ kind: "label_adjacent_cell", label: "Regular Savings", frame: "workarea", unique: true, confidence: 0.85 }] }, parse: "currency" }],
    outcomes: [
      { code: "MEMBER_NOT_FOUND", at_steps: ["s2", "s3"], when: [{ kind: "text_visible", pattern: "No member found", frame: "workarea" }], returns: { found: false } },
      { code: "PERMISSION_DENIED", at_steps: ["s2", "s3"], when: [{ kind: "text_visible", pattern: "Access denied", frame: "workarea" }] }
    ],
    recovery: [{ id: "dismiss_session_modal", condition: { kind: "dialog_present", textPattern: "Session expiring" }, action: { kind: "click", target: { frame: "workarea", strategies: [{ kind: "role_name", role: "button", name: "Continue", frame: "workarea", unique: true, confidence: 0.9 }] } }, max_attempts: 1 }],
    policy: { allowed_origins: [origin], allowed_actions: ["navigate", "click", "type"], max_duration_ms: 30_000 }
  };
}

function policy(): PolicyEngine {
  const config: PolicyConfig = { allowed_origins: [origin], allowed_path_patterns: ["^/(desk|workspace)(/.*)?$"], allowed_actions: ["navigate", "click", "focus", "type", "select", "press", "scroll"], max_steps: 25, max_duration_ms: 30_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };
  return new PolicyEngine(config);
}

async function execute(memberId: string, chaos?: string) {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "cp_session", value: "teller:a", url: origin, httpOnly: true, sameSite: "Lax" },
    ...(chaos ? [{ name: "cp_chaos", value: chaos, url: origin, httpOnly: true, sameSite: "Lax" as const }] : [])
  ]);
  const page = await context.newPage();
  const surface = new WebSurface(page, { context });
  const logger = new RunLogger(`replay_${memberId}_${chaos ?? "normal"}`, temporaryRoot);
  try {
    return await replay({ artifact: artifact(), params: { member_id: memberId }, surface, policy: policy(), logger });
  } finally {
    await surface.close();
  }
}

describe("deterministic replay against the hostile live app", () => {
  it("returns success with output for a different invocation value", async () => {
    const result = await execute("8832");
    expect(result).toMatchObject({ status: "success", outputs: { savings_balance: "$3,109.08" } });
    const log = await readFile(path.join(temporaryRoot, "replay_8832_normal", "log.jsonl"), "utf8");
    expect(log).not.toContain("8832");
    expect(log).not.toContain("$3,109.08");
  });

  it("returns not-found as a business outcome rather than a failure", async () => {
    const result = await execute("9999");
    expect(result).toMatchObject({ status: "business_outcome", code: "MEMBER_NOT_FOUND", data: { found: false } });
  });

  it("dismisses a known session modal and continues", async () => {
    const result = await execute("4521", "session_timeout");
    expect(result).toMatchObject({ status: "success", outputs: { savings_balance: "$2,481.13" } });
    const log = await readFile(path.join(temporaryRoot, "replay_4521_session_timeout", "log.jsonl"), "utf8");
    expect(log).toContain('"type":"recovery_applied"');
    expect(log).toContain('"rule":"dismiss_session_modal"');
  });
});
