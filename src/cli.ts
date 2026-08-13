#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { chromium } from "playwright";
import { runDiscovery } from "./agent/loop.js";
import { AnthropicClient } from "./agent/llm/anthropic.js";
import type { LLMClient } from "./agent/llm/client.js";
import { OpenAIClient } from "./agent/llm/openai.js";
import { createRunId, RunLogger } from "./evidence/run-logger.js";
import { PolicyEngine } from "./policy/engine.js";
import { WebSurface } from "./surface/web-playwright.js";

function chooseClient(provider: "openai" | "anthropic"): LLMClient {
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for --provider openai.");
    return new OpenAIClient(process.env.OPENAI_API_KEY);
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for --provider anthropic.");
  return new AnthropicClient(process.env.ANTHROPIC_API_KEY);
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
  .action(async (raw: { goal: string; url: string; provider: string; policy: string; headless: boolean; allowMutations: boolean; mockAuth: boolean }) => {
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
    try {
      const result = await runDiscovery({ goal: raw.goal, target: raw.url, surface, policy, llm: chooseClient(raw.provider), logger, allowMutations: raw.allowMutations });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "failure") process.exitCode = 1;
    } finally {
      await surface.close();
    }
  });

await program.parseAsync();
