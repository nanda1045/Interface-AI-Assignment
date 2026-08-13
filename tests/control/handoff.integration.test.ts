import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCorePointApp } from "../../apps/corepoint/app.js";
import { tenants } from "../../apps/corepoint/tenants.js";
import type { CapabilityArtifact } from "../../src/artifact/schema.js";
import { RunController } from "../../src/control/controller.js";
import { installHumanRecorder } from "../../src/control/human-recorder.js";
import { RunLogger } from "../../src/evidence/run-logger.js";
import { PolicyEngine, type PolicyConfig } from "../../src/policy/engine.js";
import { replay } from "../../src/replay/engine.js";
import { WebSurface } from "../../src/surface/web-playwright.js";

let server: Server;
let browser: Browser;
let origin: string;
let root: string;
let preserveEvidence = false;

beforeAll(async () => {
  const tenant = tenants[0];
  if (!tenant) throw new Error("Missing tenant A");
  server = createCorePointApp(tenant).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const configuredEvidenceRoot = process.env.HANDOFF_EVIDENCE_ROOT;
  preserveEvidence = Boolean(configuredEvidenceRoot);
  root = configuredEvidenceRoot ? path.resolve(configuredEvidenceRoot) : await mkdtemp(path.join(os.tmpdir(), "corepoint-handoff-"));
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!preserveEvidence) await rm(root, { recursive: true, force: true });
});

function capability(): CapabilityArtifact {
  const role = (roleName: string, name: string) => ({ frame: "workarea", strategies: [{ kind: "role_name" as const, role: roleName, name, frame: "workarea", unique: true as const, confidence: 0.9 }] });
  const label = (text: string, control: string) => ({ frame: "workarea", strategies: [{ kind: "label_proximity" as const, label: text, control, frame: "workarea", unique: true as const, confidence: 0.85 }] });
  return {
    schema_version: "1.0",
    capability: { id: "open_sub_account", version: "1.0.0", title: "Open a new sub-account", description: "Creates a new savings sub-account after review.", app: { id: "corepoint", vendor: "CorePoint", ui_version_range: ">=3.1" }, risk: "mutating", status: "approved", provenance: { discovered_by: "test", discovery_run: "disc_test", recorded_at: "2026-08-13T00:00:00.000Z", approved_by: "reviewer", approved_at: "2026-08-13T00:01:00.000Z" } },
    inputs: { type: "object", required: ["member_id", "account_type", "opening_deposit"], properties: { member_id: { type: "string", sensitive: true }, account_type: { type: "string" }, opening_deposit: { type: "string" } } },
    outputs: { type: "object", required: ["account_number"], properties: { account_number: { type: "string", sensitive: true } } },
    entry: { url: `${origin}/desk`, preconditions: [{ kind: "authenticated", via: "test session" }] },
    steps: [
      { id: "s1", intent: "Enter the member ID", action: { kind: "type", value_from: { param: "member_id" }, sensitive: true }, target: label("Member No.", "input"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "value_equals_param", param: "member_id" }] },
      { id: "s2", intent: "Search for the member", action: { kind: "click" }, target: role("button", "Search"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "text_visible", pattern: "Member Search Results", frame: "workarea" }] },
      { id: "s3", intent: "Open the member profile", action: { kind: "click" }, target: role("link", "Open Member"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "text_visible", pattern: "Member Profile", frame: "workarea" }] },
      { id: "s4", intent: "Open the new sub-account form", action: { kind: "click" }, target: role("link", "Open New Sub-Account"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "text_visible", pattern: "Open New Sub-Account", frame: "workarea" }] },
      { id: "s5", intent: "Choose the sub-account product", action: { kind: "select", value_from: { param: "account_type" } }, target: label("Sub-Account Type", "select"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "value_equals_param", param: "account_type" }] },
      { id: "s6", intent: "Enter the opening deposit", action: { kind: "type", value_from: { param: "opening_deposit" } }, target: label("Opening Deposit", "input"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "value_equals_param", param: "opening_deposit" }] },
      { id: "s7", intent: "Review the new account", action: { kind: "click" }, target: role("button", "Review"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "text_visible", pattern: "Review New Sub-Account", frame: "workarea" }] },
      { id: "s8", intent: "Confirm and open the account", action: { kind: "click" }, target: role("button", "Confirm & Open Account"), wait: { readyWhen: "target_resolvable", timeout_ms: 2_000 }, postconditions: [{ kind: "text_visible", pattern: "Sub-Account Opened", frame: "workarea" }] }
    ],
    checkpoint: { assert: [{ kind: "text_visible", pattern: "Sub-Account Opened", frame: "workarea" }] },
    extract: [{ output: "account_number", from: { frame: "workarea", strategies: [{ kind: "label_adjacent_cell", label: "New Account No.", frame: "workarea", unique: true, confidence: 0.85 }] }, parse: "text" }],
    outcomes: [], recovery: [], policy: { allowed_origins: [origin], allowed_actions: ["navigate", "click", "type", "select"], max_duration_ms: 30_000 }
  };
}

describe("same-session human handoff", () => {
  it("cedes the lease, records redacted human work, and resumes at the checkpoint", async () => {
    const context = await browser.newContext();
    await context.addCookies([
      { name: "cp_session", value: "teller:a", url: origin, httpOnly: true, sameSite: "Lax" },
      { name: "cp_chaos", value: "supervisor", url: origin, httpOnly: true, sameSite: "Lax" }
    ]);
    const page = await context.newPage();
    const logger = new RunLogger("replay_handoff", root);
    await logger.initialize();
    const controller = new RunController(logger, 5_000);
    const surface = new WebSurface(page, { context, canAgentAct: () => controller.lease.agentCanAct() });
    await installHumanRecorder(page, controller, logger);
    const config: PolicyConfig = { allowed_origins: [origin], allowed_path_patterns: ["^/(desk|workspace)(/.*)?$"], allowed_actions: ["navigate", "click", "type", "select"], max_steps: 20, max_duration_ms: 30_000, risk: { discovery_mutations: "block", irreversible: "escalate" } };

    const running = replay({ artifact: capability(), params: { member_id: "4521", account_type: "Holiday Savings", opening_deposit: "25.00" }, surface, policy: new PolicyEngine(config), logger, handoff: controller });
    await controller.lease.waitFor("paused", 5_000);
    const request = controller.list()[0]!;
    expect(request).toMatchObject({ step: "s8", reason: "Supervisor override required" });
    await controller.takeControl(request.id, "supervisor@example.test");

    const workarea = page.frameLocator("iframe[name='workarea']");
    await workarea.locator("input[name='override_code']").pressSequentially("2468");
    await workarea.getByRole("button", { name: "Confirm & Open Account" }).click();
    await workarea.getByRole("heading", { name: "Sub-Account Opened" }).waitFor();
    await controller.handBack(request.id);

    const result = await running;
    expect(result).toMatchObject({ status: "success", outputs: { account_number: "S03-4521" }, intervention: { count: 1 } });
    const log = await readFile(path.join(logger.directory, "log.jsonl"), "utf8");
    expect(log).toContain('"phase":"human_control"');
    expect(log).toContain('"type":"human_action"');
    expect(log).not.toContain("2468");
    expect(log).toContain("«redacted»");
    await surface.close();
  }, 15_000);
});
