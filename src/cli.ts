#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { chromium } from "playwright";
import { runDiscovery } from "./agent/loop.js";
import { AnthropicClient } from "./agent/llm/anthropic.js";
import type { LLMClient } from "./agent/llm/client.js";
import { OpenAIClient } from "./agent/llm/openai.js";
import { distillDiscovery } from "./artifact/distill.js";
import { applyOverlay, loadOverlay } from "./artifact/overlay.js";
import { ArtifactStore } from "./artifact/store.js";
import { startConsole } from "./control/console-server.js";
import { RunController } from "./control/controller.js";
import { installHumanRecorder } from "./control/human-recorder.js";
import { createRunId, RunLogger } from "./evidence/run-logger.js";
import { PolicyEngine } from "./policy/engine.js";
import { replay } from "./replay/engine.js";
import { WebSurface } from "./surface/web-playwright.js";

function chooseClient(provider: "openai" | "anthropic"): LLMClient {
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for --provider openai.");
    return new OpenAIClient(process.env.OPENAI_API_KEY);
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for --provider anthropic.");
  return new AnthropicClient(process.env.ANTHROPIC_API_KEY);
}

function parseAssignments(values: string[]): Record<string, string> {
  return Object.fromEntries(values.map((assignment) => {
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error(`Expected name=value, received: ${assignment}`);
    return [assignment.slice(0, separator), assignment.slice(separator + 1)];
  }));
}

const program = new Command();
program.name("corepoint-automation").description("Discover and replay deterministic computer-use capabilities.");
program.command("discover")
  .requiredOption("--goal <goal>")
  .requiredOption("--url <url>")
  .option("--provider <provider>", "openai or anthropic", "openai")
  .option("--policy <path>", "policy YAML", "policies/default.yaml")
  .option("--headless", "run without a visible browser", false)
  .option("--allow-mutations", "permit mutating discovery actions", false)
  .option("--mock-auth", "bootstrap a fictional CorePoint training session", false)
  .option("--capability-id <id>", "distill a draft artifact with this id")
  .option("--title <title>", "artifact title")
  .option("--description <description>", "artifact description")
  .option("--param <name=value>", "bind a discovery value to an input parameter", (value, previous: string[]) => [...previous, value], [])
  .action(async (raw: { goal: string; url: string; provider: string; policy: string; headless: boolean; allowMutations: boolean; mockAuth: boolean; capabilityId?: string; title?: string; description?: string; param: string[] }) => {
    if (raw.provider !== "openai" && raw.provider !== "anthropic") throw new Error("--provider must be openai or anthropic.");
    const browser = await chromium.launch({ headless: raw.headless });
    const context = await browser.newContext();
    const target = new URL(raw.url);
    if (raw.mockAuth) {
      if (!["http://localhost:4478", "http://localhost:4479"].includes(target.origin)) throw new Error("--mock-auth is restricted to the fictional local CorePoint app.");
      await context.addCookies([{ name: "cp_session", value: `teller:${target.port === "4479" ? "b" : "a"}`, url: target.origin, httpOnly: true, sameSite: "Lax" }]);
    }
    const page = await context.newPage();
    const surface = new WebSurface(page, { browser, context });
    const policy = await PolicyEngine.fromFile(raw.policy);
    const logger = new RunLogger(createRunId("disc"));
    const llm = chooseClient(raw.provider);
    try {
      const result = await runDiscovery({ goal: raw.goal, target: raw.url, surface, policy, llm, logger, allowMutations: raw.allowMutations });
      if (result.status === "success" && raw.capabilityId) {
        const params = parseAssignments(raw.param);
        const artifact = distillDiscovery(result, {
          id: raw.capabilityId,
          title: raw.title ?? raw.capabilityId.replace(/_/g, " "),
          description: raw.description ?? raw.goal,
          entryUrl: raw.url,
          model: llm.model,
          runId: result.runId,
          params,
          inputs: { type: "object", required: Object.keys(params), properties: Object.fromEntries(Object.keys(params).map((name) => [name, { type: "string", sensitive: /member|account|ssn/i.test(name) }])) },
          outputs: { type: "object", required: Object.keys(result.outputs), properties: Object.fromEntries(Object.keys(result.outputs).map((name) => [name, { type: "string", ...(name.includes("balance") ? { "x-format": "usd-currency" } : {}) }])) }
        });
        const artifactPath = await new ArtifactStore().save(artifact);
        console.error(`Draft artifact saved to ${artifactPath}`);
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "failure") process.exitCode = 1;
    } finally {
      await surface.close();
    }
  });

program.command("approve")
  .argument("<reference>", "capability@version")
  .requiredOption("--by <reviewer>", "reviewer identity recorded in provenance")
  .action(async (reference: string, raw: { by: string }) => {
    const artifact = await new ArtifactStore().approve(reference, raw.by);
    console.log(JSON.stringify({ id: artifact.capability.id, version: artifact.capability.version, status: artifact.capability.status, approvedBy: artifact.capability.provenance.approved_by }, null, 2));
  });

program.command("replay")
  .argument("<reference>", "capability@version")
  .option("--param <name=value>", "capability parameter", (value, previous: string[]) => [...previous, value], [])
  .option("--policy <path>", "policy YAML", "policies/default.yaml")
  .option("--artifact-root <path>", "artifact directory", "artifacts")
  .option("--overlay <path>", "tenant overlay JSON")
  .option("--chaos <flags>", "comma-separated mock-app chaos flags")
  .option("--headless", "run without a visible browser", false)
  .option("--confirm-mutations", "interactively approved this mutating replay", false)
  .option("--mock-auth", "bootstrap a fictional CorePoint training session", false)
  .option("--handoff", "enable same-session human intervention", false)
  .option("--console-port <port>", "operator console port", "4590")
  .action(async (reference: string, raw: { param: string[]; policy: string; artifactRoot: string; overlay?: string; chaos?: string; headless: boolean; confirmMutations: boolean; mockAuth: boolean; handoff: boolean; consolePort: string }) => {
    const store = new ArtifactStore(raw.artifactRoot);
    let artifact = await store.load(reference);
    if (raw.overlay) artifact = applyOverlay(artifact, await loadOverlay(raw.overlay));
    const browser = await chromium.launch({ headless: raw.headless });
    const context = await browser.newContext();
    const entry = new URL(artifact.entry.url);
    if (raw.mockAuth) {
      if (!["http://localhost:4478", "http://localhost:4479"].includes(entry.origin)) throw new Error("--mock-auth is restricted to the fictional local CorePoint app.");
      await context.addCookies([{ name: "cp_session", value: `teller:${entry.port === "4479" ? "b" : "a"}`, url: entry.origin, httpOnly: true, sameSite: "Lax" }]);
    }
    if (raw.chaos) await context.addCookies([{ name: "cp_chaos", value: raw.chaos, url: entry.origin, httpOnly: true, sameSite: "Lax" }]);
    if (raw.handoff && raw.headless) throw new Error("--handoff requires a headed browser so the operator can control the live session.");
    const page = await context.newPage();
    const logger = new RunLogger(createRunId("replay"));
    await logger.initialize();
    const controller = raw.handoff ? new RunController(logger) : undefined;
    const surface = new WebSurface(page, { browser, context, ...(controller ? { canAgentAct: () => controller.lease.agentCanAct() } : {}) });
    const consoleServer = controller ? await startConsole(controller, Number(raw.consolePort)) : undefined;
    if (controller) {
      await installHumanRecorder(page, controller, logger);
      console.error(`Operator console: http://127.0.0.1:${raw.consolePort}`);
    }
    try {
      const result = await replay({ artifact, params: parseAssignments(raw.param), surface, policy: await PolicyEngine.fromFile(raw.policy), logger, confirmMutations: raw.confirmMutations, ...(controller ? { handoff: controller } : {}) });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "failure") process.exitCode = 1;
    } finally {
      if (consoleServer) await new Promise<void>((resolve, reject) => consoleServer.close((error) => error ? reject(error) : resolve()));
      await surface.close();
    }
  });

await program.parseAsync();
