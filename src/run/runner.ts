// The one composition of store, profile, browser, evidence, handoff and replay.
// CLI commands, approval validation, stress runs and the HTTP API all execute
// capabilities through this path, so none of them can acquire an easier route
// than production replay - the same reason approval's gate lives in the store.
import { chromium } from "playwright";
import { normalizeInputs } from "../artifact/inputs.js";
import { applyOverlay, loadOverlay } from "../artifact/overlay.js";
import { ArtifactStore } from "../artifact/store.js";
import { startConsole } from "../control/console-server.js";
import { RunController } from "../control/controller.js";
import { installHumanRecorder } from "../control/human-recorder.js";
import { RunLogger } from "../evidence/run-logger.js";
import { PolicyEngine } from "../policy/engine.js";
import { signOn } from "../profile/bootstrap.js";
import { profileForApp, resolveCredentials } from "../profile/profile.js";
import { replay } from "../replay/engine.js";
import type { ReplayResult } from "../replay/result.js";
import { WebSurface } from "../surface/web-playwright.js";

// All inputs needed to create one deterministic replay session. Optional fields
// enable test or operational features without changing the replay engine.
export interface CapabilityRunOptions {
  reference: string;
  /** Raw invocation values. Callers arrive with different physics - the CLI
   *  sends strings, a model or API client sends real JSON types - so values
   *  are normalized against the artifact's declared contract before replay. */
  params: Record<string, unknown>;
  runId: string;
  policy?: string;
  artifactRoot?: string;
  runRoot?: string;
  headless?: boolean;
  mockAuth?: boolean;
  overlay?: string;
  chaos?: string;
  handoff?: boolean;
  consolePort?: string;
  confirmMutations?: boolean;
  // Used only by stress runs to change the UI before application scripts run.
  mutationScript?: string;
  /** Named credential set from the app profile; triggers a real sign-on before
   *  replay. The alternative for the fictional target is --mock-auth. */
  auth?: string;
  /** Observability hooks for a service wrapping this runner. Kept as callbacks
   *  so the runner itself stays free of any server or queue concern. */
  onStarted?: (detail: { reference: string }) => void;
}

export interface CapabilityRunOutcome {
  result: ReplayResult;
  runId: string;
  /** The concrete id@version that actually ran - a caller that asked by name
   *  or range needs this for its own records. */
  reference: string;
}

export async function runCapability(options: CapabilityRunOptions): Promise<CapabilityRunOutcome> {
  const artifactRoot = options.artifactRoot ?? "artifacts";
  const runRoot = options.runRoot ?? "runs";
  const headless = options.headless ?? false;

  // Load the immutable capability contract, then optionally adapt its approved
  // deployment-specific fields with a tenant overlay. Resolution happens first
  // so the caller and the evidence both learn which version a bare name chose.
  const store = new ArtifactStore(artifactRoot);
  const resolved = await store.resolve(options.reference);
  if (resolved.reference !== options.reference) console.error(`Resolved ${options.reference} to ${resolved.reference}.`);
  let artifact = await store.load(resolved.reference);
  if (options.overlay) artifact = applyOverlay(artifact, await loadOverlay(options.overlay));

  // The profile is chosen by the artifact's own app id - never by a caller
  // argument, which could select weaker detection than the capability was
  // recorded against. Unprofiled apps keep the built-in CorePoint defaults.
  const profile = await profileForApp(artifact.capability.app.id);
  const policyPath = (options.policy === undefined || options.policy === "policies/default.yaml") && profile
    ? profile.policy
    : options.policy ?? "policies/default.yaml";
  if (options.handoff && headless) throw new Error("--handoff requires a headed browser so the operator can control the live session.");

  // Create the real browser session. Mock authentication is deliberately
  // restricted to the two fictional localhost tenants.
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const entry = new URL(artifact.entry.url);
  if (options.mockAuth) {
    if (!["http://localhost:4478", "http://localhost:4479"].includes(entry.origin)) throw new Error("--mock-auth is restricted to the fictional local CorePoint app.");
    await context.addCookies([{ name: "cp_session", value: `teller:${entry.port === "4479" ? "b" : "a"}`, url: entry.origin, httpOnly: true, sameSite: "Lax" }]);
  }
  if (options.chaos) await context.addCookies([{ name: "cp_chaos", value: options.chaos, url: entry.origin, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();

  // Stress mutations are injected only when explicitly requested. Ordinary
  // replay runs against the page without this script.
  if (options.mutationScript) await page.addInitScript({ content: options.mutationScript });

  // Evidence, human-control coordination, and the Playwright Surface all share
  // this one browser session. The lease prevents agent and human acting together.
  const logger = new RunLogger(options.runId, runRoot);
  await logger.initialize();
  const controller = options.handoff ? new RunController(logger) : undefined;
  const surface = new WebSurface(page, { browser, context, ...(controller ? { canAgentAct: () => controller.lease.agentCanAct() } : {}) });
  const consoleServer = controller ? await startConsole(controller, Number(options.consolePort ?? 4590)) : undefined;
  if (controller) {
    await installHumanRecorder(page, controller, logger);
    console.error(`Operator console: http://127.0.0.1:${options.consolePort ?? 4590}`);
  }
  try {
    // The replay engine receives only abstractions and validated inputs. Both
    // the artifact policy and deployment policy are enforced inside replay.
    const policyEngine = await PolicyEngine.fromFile(policyPath);
    if (options.auth) {
      if (!profile) throw new Error(`--auth needs an app profile for ${artifact.capability.app.id}, and none was found in profiles/.`);
      await signOn({ surface, policy: policyEngine, logger, profile, credentials: resolveCredentials(profile, options.auth) });
    }
    options.onStarted?.({ reference: resolved.reference });
    const result = await replay({
      artifact, params: normalizeInputs(artifact.inputs, options.params), surface, policy: policyEngine,
      logger, confirmMutations: options.confirmMutations ?? false,
      ...(profile ? { signatures: profile.detectors, irreversibleActions: profile.irreversible_actions ?? [] } : {}),
      ...(controller ? { handoff: controller } : {})
    });
    return { result, runId: options.runId, reference: resolved.reference };
  } finally {
    // Always release the local console and browser, including on failure.
    if (consoleServer) await new Promise<void>((resolve, reject) => consoleServer.close((error) => error ? reject(error) : resolve()));
    await surface.close();
  }
}
