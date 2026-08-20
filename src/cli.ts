#!/usr/bin/env node
// Application composition root: this file accepts CLI commands and wires the
// browser adapter, engines, policies, artifact store, evidence, and handoff.
// Business logic stays in those modules; this file coordinates their use.
import "dotenv/config";
import { Command } from "commander";
import { chromium } from "playwright";
import { runDiscovery } from "./agent/loop.js";
import { AnthropicClient } from "./agent/llm/anthropic.js";
import type { LLMClient } from "./agent/llm/client.js";
import { OpenAIClient } from "./agent/llm/openai.js";
import { distillDiscovery } from "./artifact/distill.js";
import { buildCatalog } from "./artifact/catalog.js";
import { ArtifactStore } from "./artifact/store.js";
import { bumpVersion } from "./artifact/versioning.js";
import { startConsole } from "./control/console-server.js";
import { RunController } from "./control/controller.js";
import { installHumanRecorder } from "./control/human-recorder.js";
import { mutationById, uiMutations } from "./eval/mutations.js";
import { formatStressReport, scoreStress, type StressRow } from "./eval/stress.js";
import { createRunId, RunLogger } from "./evidence/run-logger.js";
import { chat } from "./chat/chat.js";
import { PolicyEngine } from "./policy/engine.js";
import { signOn } from "./profile/bootstrap.js";
import { profileForOrigin, resolveCredentials } from "./profile/profile.js";
import { runCapability } from "./run/runner.js";
import { RunService } from "./run/service.js";
import { startApiServer } from "./api/server.js";
import { WebSurface } from "./surface/web-playwright.js";

// Discovery can use either provider through one LLMClient interface. Replay
// never calls this function, which keeps the model out of deterministic runs.
function chooseClient(provider: "openai" | "anthropic"): LLMClient {
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for --provider openai.");
    return new OpenAIClient(process.env.OPENAI_API_KEY);
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for --provider anthropic.");
  return new AnthropicClient(process.env.ANTHROPIC_API_KEY);
}

// Convert repeatable CLI values such as --param member_id=8832 into an object.
// Splitting at the first '=' also permits values that contain '=' themselves.
function parseAssignments(values: string[]): Record<string, string> {
  return Object.fromEntries(values.map((assignment) => {
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error(`Expected name=value, received: ${assignment}`);
    return [assignment.slice(0, separator), assignment.slice(separator + 1)];
  }));
}

const program = new Command();
program.name("corepoint-automation").description("Discover and replay deterministic computer-use capabilities.");

// DISCOVER: let the LLM operate the browser through the bounded Surface API,
// record the successful trajectory, and optionally distil it into a draft.
program.command("discover")
  .requiredOption("--goal <goal>")
  .requiredOption("--url <url>")
  .option("--provider <provider>", "openai or anthropic", "openai")
  .option("--policy <path>", "policy YAML", "policies/default.yaml")
  .option("--headless", "run without a visible browser", false)
  .option("--allow-mutations", "permit mutating discovery actions", false)
  .option("--mock-auth", "bootstrap a fictional CorePoint training session", false)
  .option("--auth <credentials>", "named credential set from the app profile; performs a real sign-on")
  .option("--capability-id <id>", "distill a draft artifact with this id")
  .option("--risk <tier>", "declared risk of the recorded capability: read_only, mutating or irreversible", "read_only")
  .option("--title <title>", "artifact title")
  .option("--description <description>", "artifact description")
  .option("--param <name=value>", "bind a discovery value to an input parameter", (value, previous: string[]) => [...previous, value], [])
  .option("--output <name>", "declared output name; repeat for multiple outputs", (value, previous: string[]) => [...previous, value], [])
  .option("--artifact-root <path>", "artifact directory", "artifacts")
  .option("--bump <level>", "re-record an existing capability as the next patch, minor or major version")
  .option("--overwrite-artifact", "replace an existing artifact after a successful discovery", false)
  .option("--handoff", "enable same-session human intervention when discovery is stuck", false)
  .option("--console-port <port>", "operator console port", "4590")
  .option("--run-root <path>", "run evidence directory", "runs")
  .option("--run-id <id>", "explicit run id (useful for reproducible evidence)")
  .action(async (raw: { goal: string; url: string; provider: string; policy: string; headless: boolean; allowMutations: boolean; mockAuth: boolean; auth?: string; capabilityId?: string; risk: string; title?: string; description?: string; param: string[]; output: string[]; artifactRoot: string; bump?: string; overwriteArtifact: boolean; handoff: boolean; consolePort: string; runRoot: string; runId?: string }) => {
    // Discovery is the only command that creates an LLM client.
    if (raw.provider !== "openai" && raw.provider !== "anthropic") throw new Error("--provider must be openai or anthropic.");
    if (!["read_only", "mutating", "irreversible"].includes(raw.risk)) throw new Error("--risk must be read_only, mutating or irreversible.");
    if (raw.handoff && raw.headless) throw new Error("--handoff requires a headed browser so the operator can control the live session.");
    const browser = await chromium.launch({ headless: raw.headless });
    const context = await browser.newContext();
    const target = new URL(raw.url);
    if (raw.mockAuth) {
      if (!["http://localhost:4478", "http://localhost:4479"].includes(target.origin)) throw new Error("--mock-auth is restricted to the fictional local CorePoint app.");
      await context.addCookies([{ name: "cp_session", value: `teller:${target.port === "4479" ? "b" : "a"}`, url: target.origin, httpOnly: true, sameSite: "Lax" }]);
    }
    const page = await context.newPage();
    const logger = new RunLogger(raw.runId ?? createRunId("disc"), raw.runRoot);
    const controller = raw.handoff ? new RunController(logger) : undefined;
    const surface = new WebSurface(page, { browser, context, ...(controller ? { canAgentAct: () => controller.lease.agentCanAct() } : {}) });
    const consoleServer = controller ? await startConsole(controller, Number(raw.consolePort)) : undefined;
    if (controller) {
      await logger.initialize();
      await installHumanRecorder(page, controller, logger);
      console.error(`Operator console: http://127.0.0.1:${raw.consolePort}`);
    }
    // Discovery selects a profile by where it is pointed, before any artifact
    // exists to carry an app id. The profile supplies the default policy, the
    // sign-on bootstrap and the authoring templates for distillation.
    const profile = await profileForOrigin(target.origin);
    const policyPath = raw.policy === "policies/default.yaml" && profile ? profile.policy : raw.policy;
    const policy = await PolicyEngine.fromFile(policyPath);
    const llm = chooseClient(raw.provider);
    try {
      if (raw.auth) {
        if (!profile) throw new Error(`--auth needs an app profile for ${target.origin}, and none was found in profiles/.`);
        await logger.initialize();
        await signOn({ surface, policy, logger, profile, credentials: resolveCredentials(profile, raw.auth) });
      }
      // The discovery loop returns a recorded trajectory with verified locator
      // ladders; it does not directly write a capability artifact.
      const result = await runDiscovery({ goal: raw.goal, target: raw.url, surface, policy, llm, logger, allowMutations: raw.allowMutations, expectedOutputs: raw.output, irreversibleActions: profile?.irreversible_actions ?? [], ...(controller ? { handoff: controller } : {}) });
      if (result.status === "success" && raw.capabilityId) {
        const params = parseAssignments(raw.param);
        const store = new ArtifactStore(raw.artifactRoot);

        // Re-recording normally creates a semantic successor so the previous
        // reviewed artifact remains available for audit and rollback.
        let version: string | undefined;
        if (raw.bump) {
          if (raw.bump !== "patch" && raw.bump !== "minor" && raw.bump !== "major") throw new Error("--bump must be patch, minor or major.");
          const previous = await store.latestVersion(raw.capabilityId);
          if (!previous) throw new Error(`No existing ${raw.capabilityId} to bump; omit --bump to record the first version.`);
          version = bumpVersion(previous, raw.bump);
        }

        // Plain deterministic code converts the successful trajectory into a
        // typed draft. Parameters replace literals, and known run values are
        // supplied so intent text and data-dependent locators can be scrubbed.
        const artifact = distillDiscovery(result, {
          id: raw.capabilityId,
          title: raw.title ?? raw.capabilityId.replace(/_/g, " "),
          description: raw.description ?? raw.goal,
          entryUrl: raw.url,
          model: llm.model,
          runId: result.runId,
          params,
          risk: raw.risk as "read_only" | "mutating" | "irreversible",
          ...(version ? { version } : {}),
          sensitiveValues: logger.knownSensitiveValues(),
          ...(profile ? {
            app: { id: profile.app.id, vendor: profile.app.vendor, ui_version_range: profile.app.ui_version_range },
            outcomeTemplates: profile.outcome_templates,
            recoveryTemplates: profile.recovery_templates,
            // A capability recorded without credentials (the sign-on flow
            // itself) has no authenticated precondition to declare.
            ...(raw.auth || raw.mockAuth ? { authenticatedVia: raw.auth ? `profile sign-on (${raw.auth})` : "mock-auth training session" } : {})
          } : {}),
          inputs: { type: "object", required: Object.keys(params), properties: Object.fromEntries(Object.keys(params).map((name) => [name, { type: "string", sensitive: /member|account|ssn|password|pin|secret/i.test(name) }])) },
          outputs: { type: "object", required: Object.keys(result.outputs), properties: Object.fromEntries(Object.keys(result.outputs).map((name) => [name, { type: "string", ...(/member|name|balance|account|ssn/i.test(name) ? { sensitive: true } : {}), ...(name.includes("balance") ? { "x-format": "usd-currency" } : {}) }])) }
        });

        // save() is create-only by default. In-place replacement requires the
        // explicit --overwrite-artifact escape hatch.
        const artifactPath = raw.overwriteArtifact ? await store.write(artifact) : await store.save(artifact);
        await logger.artifact(artifact);
        console.error(`Draft artifact saved to ${artifactPath}`);
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "failure") process.exitCode = 1;
    } finally {
      if (consoleServer) await new Promise<void>((resolve, reject) => consoleServer.close((error) => error ? reject(error) : resolve()));
      await surface.close();
    }
  });

// APPROVE: first prove the draft through the real replay path using different
// inputs, then store reviewer identity and validation evidence in the artifact.
program.command("approve")
  .argument("<reference>", "capability@version")
  .requiredOption("--by <reviewer>", "reviewer identity recorded in provenance")
  .requiredOption("--param <name=value>", "validation parameter; must differ from the discovery invocation", (value, previous: string[] = []) => [...previous, value])
  .option("--policy <path>", "policy YAML", "policies/default.yaml")
  .option("--artifact-root <path>", "artifact directory", "artifacts")
  .option("--overlay <path>", "tenant overlay JSON")
  .option("--handoff", "attach the operator console so a human can complete an irreversible capability's final step", false)
  .option("--console-port <port>", "operator console port", "4590")
  .option("--headless", "run the validation replay without a visible browser", false)
  .option("--mock-auth", "bootstrap a fictional CorePoint training session", false)
  .option("--auth <credentials>", "named credential set from the app profile; performs a real sign-on")
  .option("--run-root <path>", "run evidence directory", "runs")
  .action(async (reference: string, raw: { by: string; param: string[]; policy: string; artifactRoot: string; overlay?: string; handoff: boolean; consolePort: string; headless: boolean; mockAuth: boolean; auth?: string; runRoot: string }) => {
    const store = new ArtifactStore(raw.artifactRoot);
    const params = parseAssignments(raw.param);

    // confirmMutations permits validation of a mutating draft, which means
    // approval of such capabilities must always use safe test data.
    const validation = await runCapability({
      reference, params, policy: raw.policy, artifactRoot: raw.artifactRoot, overlay: raw.overlay,
      handoff: raw.handoff, consolePort: raw.consolePort,
      headless: raw.headless, mockAuth: raw.mockAuth, auth: raw.auth, runRoot: raw.runRoot, runId: createRunId("approval"),
      confirmMutations: true
    });
    if (validation.result.status !== "success") {
      throw new Error(`Validation replay ended as ${validation.result.status}, so ${reference} stays a draft. Evidence: ${validation.result.evidence}`);
    }
    const artifact = await store.approve(reference, raw.by, { run: validation.runId, params, matchedTiers: validation.result.stability.matched_tiers });
    console.log(JSON.stringify({
      id: artifact.capability.id, version: artifact.capability.version, status: artifact.capability.status,
      approvedBy: artifact.capability.provenance.approved_by, validation: artifact.capability.provenance.validation
    }, null, 2));
  });

// REPLAY: run a saved capability with no LLM. A technical failure receives a
// non-zero exit code; a declared business outcome remains a valid run result.
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
  .option("--auth <credentials>", "named credential set from the app profile; performs a real sign-on")
  .option("--handoff", "enable same-session human intervention", false)
  .option("--console-port <port>", "operator console port", "4590")
  .option("--run-root <path>", "run evidence directory", "runs")
  .option("--run-id <id>", "explicit run id (useful for reproducible evidence)")
  .action(async (reference: string, raw: { param: string[]; policy: string; artifactRoot: string; overlay?: string; chaos?: string; headless: boolean; confirmMutations: boolean; mockAuth: boolean; auth?: string; handoff: boolean; consolePort: string; runRoot: string; runId?: string }) => {
    const { result } = await runCapability({
      reference, params: parseAssignments(raw.param), policy: raw.policy, artifactRoot: raw.artifactRoot,
      overlay: raw.overlay, chaos: raw.chaos, headless: raw.headless, confirmMutations: raw.confirmMutations,
      mockAuth: raw.mockAuth, auth: raw.auth, handoff: raw.handoff, consolePort: raw.consolePort, runRoot: raw.runRoot,
      runId: raw.runId ?? createRunId("replay")
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failure") process.exitCode = 1;
  });

// STRESS: replay under controlled UI mutations and require exact expected
// outputs, so a run that resolves the wrong element cannot be called a success.
program.command("capabilities")
  .description("List approved capabilities as tool definitions an AI agent can be given.")
  .option("--artifact-root <path>", "artifact directory", "artifacts")
  .option("--json", "emit the tool definitions themselves rather than a summary", false)
  .action(async (raw: { artifactRoot: string; json: boolean }) => {
    const catalog = buildCatalog(await new ArtifactStore(raw.artifactRoot).approved());
    if (raw.json) {
      console.log(JSON.stringify(catalog.map((entry) => entry.tool), null, 2));
      return;
    }
    if (catalog.length === 0) {
      console.log("No approved capabilities. Discover one, then approve it with a validation replay.");
      return;
    }
    for (const entry of catalog) {
      const inputs = Object.entries(entry.tool.input_schema.properties)
        .map(([name, schema]) => `${name}: ${(schema as { type: string }).type}${entry.tool.input_schema.required.includes(name) ? "" : "?"}`)
        .join(", ");
      console.log(`${entry.tool.name}  [${entry.reference}, ${entry.risk}]`);
      console.log(`  ${entry.tool.description}`);
      console.log(`  takes (${inputs})\n`);
    }
  });

program.command("ask")
  .description("Answer a question by letting a model pick an approved capability and replaying it deterministically.")
  .argument("<question>", "a plain-language question")
  .option("--policy <path>", "policy YAML", "policies/default.yaml")
  .option("--artifact-root <path>", "artifact directory", "artifacts")
  .option("--mock-auth", "bootstrap a fictional CorePoint training session", false)
  .option("--auth <credentials>", "named credential set from the app profile; performs a real sign-on")
  .option("--headless", "run the capability without a visible browser", false)
  .option("--allow-mutations", "permit answering with a capability that changes records", false)
  .option("--run-root <path>", "run evidence directory", "runs")
  .action(async (question: string, raw: { policy: string; artifactRoot: string; mockAuth: boolean; auth?: string; headless: boolean; allowMutations: boolean; runRoot: string }) => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required to answer a question.");
    const catalog = buildCatalog(await new ArtifactStore(raw.artifactRoot).approved());
    if (catalog.length === 0) throw new Error("No approved capabilities to answer with. Approve one first.");
    const result = await chat({
      message: question, catalog, apiKey: process.env.ANTHROPIC_API_KEY,
      // The CLI is one-shot, so --allow-mutations is the user's confirmation for
      // a data-changing capability. Irreversible capabilities still refuse here.
      confirm: raw.allowMutations,
      // The model only chooses the capability; this runs it through exactly the
      // path every other caller uses, and the reply is formatted by code, never
      // by the model.
      execute: async (reference, params, executeOptions) => {
        console.error(`Invoking ${reference} with ${JSON.stringify(params)}`);
        const { result: replayed } = await runCapability({
          reference, params, policy: raw.policy, artifactRoot: raw.artifactRoot, headless: raw.headless,
          mockAuth: raw.mockAuth, auth: raw.auth, runRoot: raw.runRoot, runId: createRunId("replay"),
          confirmMutations: executeOptions?.confirmMutations ?? false
        });
        console.error(`→ ${replayed.status}`);
        return replayed;
      }
    });
    console.log(result.reply);
  });

program.command("stress")
  .description("Replay a capability under injected UI changes and report what the locator ladder survives.")
  .argument("<reference>", "capability@version")
  .requiredOption("--param <name=value>", "capability parameter", (value, previous: string[] = []) => [...previous, value])
  .requiredOption("--expect <name=value>", "output the replay must return; a run that succeeds with the wrong value has not survived", (value, previous: string[] = []) => [...previous, value])
  .option("--mutations <ids>", "comma-separated mutation ids; defaults to all")
  .option("--policy <path>", "policy YAML", "policies/default.yaml")
  .option("--artifact-root <path>", "artifact directory", "artifacts")
  .option("--mock-auth", "bootstrap a fictional CorePoint training session", false)
  .option("--auth <credentials>", "named credential set from the app profile; performs a real sign-on")
  .option("--run-root <path>", "run evidence directory", "runs")
  .action(async (reference: string, raw: { param: string[]; expect: string[]; mutations?: string; policy: string; artifactRoot: string; mockAuth: boolean; auth?: string; runRoot: string }) => {
    const params = parseAssignments(raw.param);
    const expected = parseAssignments(raw.expect);
    const chosen = raw.mutations ? raw.mutations.split(",").map((id) => mutationById(id.trim())) : uiMutations;
    const rows: StressRow[] = [];
    for (const mutation of chosen) {
      const { result } = await runCapability({
        reference, params, policy: raw.policy, artifactRoot: raw.artifactRoot, headless: true,
        mockAuth: raw.mockAuth, auth: raw.auth, runRoot: raw.runRoot, runId: `stress_${mutation.id}`,
        ...(mutation.script ? { mutationScript: mutation.script } : {})
      });
      rows.push(scoreStress(mutation, result, expected));
    }
    console.log(formatStressReport(rows));
  });

// SERVE: run the loopback API and operator dashboard on one port. This is the
// demo surface - capabilities, runs, evidence, chat and interventions - over the
// same runner every other caller uses.
program.command("serve")
  .description("Serve the loopback API and operator dashboard.")
  .option("--port <port>", "port to bind on 127.0.0.1", "4599")
  .option("--artifact-root <path>", "artifact directory", "artifacts")
  .option("--run-root <path>", "run evidence directory", "runs")
  .option("--policy <path>", "policy YAML", "policies/default.yaml")
  .option("--demo", "enable demo affordances such as fault injection", false)
  .action(async (raw: { port: string; artifactRoot: string; runRoot: string; policy: string; demo: boolean }) => {
    const store = new ArtifactStore(raw.artifactRoot);
    const runs = new RunService(raw.runRoot);
    const interventions = new Map<string, RunController>();
    const { server } = await startApiServer({
      store, runs, runRoot: raw.runRoot, demoMode: raw.demo, interventions,
      // The API runs headless replays through the shared runner; attended runs
      // register their controller in the shared registry the dashboard serves.
      execute: (options) => runCapability({ ...options, policy: raw.policy, onController: (controller) => interventions.set(options.runId, controller), startConsole: false }),
      ...(process.env.ANTHROPIC_API_KEY ? { chatApiKey: process.env.ANTHROPIC_API_KEY } : {})
    }, Number(raw.port));
    console.error(`Dashboard and API on http://127.0.0.1:${raw.port}${raw.demo ? " (demo mode)" : ""}`);
    await new Promise<void>((resolve) => server.on("close", resolve));
  });

// Present expected operator errors as concise messages while preserving a
// failure exit code for scripts and CI.
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
