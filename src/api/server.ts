// The thin adaptation API. It validates every request, resolves only approved
// capabilities, gates mutations behind an envelope confirmation, and executes
// through the one shared RunService/CapabilityRunner path - so an HTTP caller
// gets no easier or less safe route to the live app than the CLI does.
//
// Everything the server needs is injected, so tests drive it with a fake runner
// and never launch a browser, and the same app can be mounted by the dashboard.
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { buildCatalog } from "../artifact/catalog.js";
import type { ArtifactStore } from "../artifact/store.js";
import type { CapabilityArtifact, ObjectContract } from "../artifact/schema.js";
import type { RunController } from "../control/controller.js";
import { createRunId } from "../evidence/run-logger.js";
import type { CapabilityRunOptions, CapabilityRunOutcome } from "../run/runner.js";
import { runCapability } from "../run/runner.js";
import type { RunService } from "../run/service.js";
import { evidenceFileSchema, runIdSchema, runRequestSchema, takeControlSchema } from "./schemas.js";

// A controller registry the dashboard/console shares with the API: a handoff run
// registers its coordinator here so the intervention routes can serve it. Read
// runs never register, so their intervention routes simply 404.
export type InterventionRegistry = Map<string, RunController>;

export interface ApiDependencies {
  store: ArtifactStore;
  runs: RunService;
  runRoot?: string;
  /** Fault injection and any other demo affordance is honoured only here. */
  demoMode?: boolean;
  /** Injectable executor. Defaults to the real browser runner; tests pass a
   *  fake so the API can be exercised without Playwright or a live target. */
  execute?: (options: CapabilityRunOptions) => Promise<CapabilityRunOutcome>;
  interventions?: InterventionRegistry;
}

// Reject unknown and missing inputs at the door. Type coercion and deep checks
// stay with the runner/engine; the point here is to fail a surprising request
// before a browser ever launches, and to never run with a stray argument.
function inputErrors(contract: ObjectContract, inputs: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const name of Object.keys(inputs)) {
    if (!(name in contract.properties)) errors.push(`Unknown parameter "${name}".`);
  }
  for (const name of contract.required) {
    if (inputs[name] === undefined || inputs[name] === null) errors.push(`Missing required parameter "${name}".`);
  }
  return errors;
}

export function createApiApp(deps: ApiDependencies) {
  const runRoot = deps.runRoot ?? "runs";
  const execute = deps.execute ?? runCapability;
  const interventions = deps.interventions ?? new Map<string, RunController>();
  // Maps an idempotency key to the run it first created, so a duplicate request
  // returns the original run rather than starting a second.
  const idempotency = new Map<string, string>();

  const app = express();
  // Bounded body: the API takes small JSON envelopes, never uploads.
  app.use(express.json({ limit: "64kb" }));

  // The approved catalog, exactly as an agent or UI would consume it. Drafts are
  // never listed; irreversible capabilities are listed with requires_human.
  app.get("/api/capabilities", async (_request, response, next) => {
    try {
      response.json({ capabilities: buildCatalog(await deps.store.approved()) });
    } catch (error) { next(error); }
  });

  app.post("/api/runs", async (request, response, next) => {
    try {
      const parsed = runRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid request.", details: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`) });
        return;
      }
      const body = parsed.data;

      // A duplicate request short-circuits to the run the key already created.
      if (body.idempotency_key) {
        const existing = idempotency.get(body.idempotency_key);
        if (existing) {
          const record = deps.runs.get(existing);
          response.status(200).json({ run_id: existing, status: record?.state ?? "queued", status_url: `/api/runs/${existing}`, idempotent_replay: true });
          return;
        }
      }

      // Resolve to a concrete approved version. A draft or unknown name throws
      // here, before any browser work, and is reported as a 404.
      let resolved: { reference: string };
      let artifact: CapabilityArtifact;
      try {
        resolved = await deps.store.resolve(body.capability);
        artifact = await deps.store.load(resolved.reference);
      } catch (error) {
        response.status(404).json({ error: error instanceof Error ? error.message : "No such approved capability." });
        return;
      }

      const errors = inputErrors(artifact.inputs, body.inputs);
      if (errors.length > 0) {
        response.status(400).json({ error: "Invalid inputs.", details: errors });
        return;
      }

      // Fault injection is a demo affordance only, and only for a kind the
      // profile allow-lists (the runner enforces the allow-list itself).
      if (body.fault_injection && !deps.demoMode) {
        response.status(403).json({ error: "fault_injection is only accepted in demo mode." });
        return;
      }

      const risk = artifact.capability.risk;
      // An irreversible capability cannot be completed by this headless endpoint:
      // its final step is performed by a human in an attended session. Say so
      // plainly instead of enqueueing a run that can only fail at the boundary.
      if (risk === "irreversible") {
        response.status(409).json({
          error: "This capability is irreversible and pauses for a human operator to complete the final step.",
          risk, requires_human: true,
          capability: resolved.reference,
          detail: "Run it through the attended operator-console handoff flow, not the unattended API run endpoint."
        });
        return;
      }
      // An ordinary mutation needs an explicit confirmation in the envelope,
      // outside the model-controlled capability inputs.
      if (risk === "mutating" && body.confirm_mutation !== true) {
        response.status(409).json({
          error: "This capability changes data and needs confirmation.",
          status: "confirmation_required",
          risk, capability: resolved.reference, inputs: body.inputs,
          detail: "Re-send with confirm_mutation: true to proceed."
        });
        return;
      }

      const runId = createRunId("replay");
      if (body.idempotency_key) idempotency.set(body.idempotency_key, runId);

      deps.runs.submit({
        runId,
        capability: resolved.reference,
        execute: async () => {
          const outcome = await execute({
            reference: resolved.reference,
            params: body.inputs,
            runId,
            runRoot,
            headless: true,
            ...(body.auth ? { auth: body.auth } : {}),
            ...(risk === "mutating" ? { confirmMutations: true } : {}),
            ...(body.fault_injection ? { faultInjection: body.fault_injection } : {})
          });
          return { result: outcome.result, reference: outcome.reference };
        }
      });

      response.status(202).json({ run_id: runId, status: "queued", status_url: `/api/runs/${runId}` });
    } catch (error) { next(error); }
  });

  app.get("/api/runs", async (_request, response, next) => {
    try { response.json({ runs: await deps.runs.list() }); } catch (error) { next(error); }
  });

  app.get("/api/runs/:runId", async (request, response) => {
    try {
      const runId = runIdSchema.parse(request.params.runId);
      const live = deps.runs.get(runId);
      if (live) { response.json(live); return; }
      const fromList = (await deps.runs.list()).find((record) => record.runId === runId);
      if (!fromList) { response.status(404).json({ error: "No such run." }); return; }
      response.json(fromList);
    } catch { response.status(400).json({ error: "Invalid run id." }); }
  });

  // The run's own event log, already redacted on disk. Parsed line by line so a
  // partially written trailing line never breaks the response.
  app.get("/api/runs/:runId/events", async (request, response) => {
    try {
      const runId = runIdSchema.parse(request.params.runId);
      let raw: string;
      try {
        raw = await readFile(path.join(runRoot, runId, "log.jsonl"), "utf8");
      } catch { response.status(404).json({ error: "No events recorded for this run." }); return; }
      const events = raw.split("\n").filter((line) => line.trim()).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      response.json({ events });
    } catch { response.status(400).json({ error: "Invalid run id." }); }
  });

  // Evidence file download with strict path containment: the resolved absolute
  // path must live inside this run's own directory or the request is refused.
  app.get("/api/runs/:runId/evidence/:file", (request, response) => {
    const runId = runIdSchema.safeParse(request.params.runId);
    const file = evidenceFileSchema.safeParse(request.params.file);
    if (!runId.success || !file.success) { response.status(400).json({ error: "Invalid evidence path." }); return; }
    const directory = path.resolve(runRoot, runId.data);
    const target = path.resolve(directory, file.data);
    if (target !== directory && !target.startsWith(directory + path.sep)) {
      response.status(400).json({ error: "Evidence path escapes the run directory." });
      return;
    }
    createReadStream(target)
      .on("error", () => { if (!response.headersSent) response.status(404).json({ error: "No such evidence file." }); })
      .pipe(response);
  });

  // Intervention routes serve a handoff run's shared controller. A read run
  // never registers one, so its id 404s here rather than inventing a coordinator.
  app.post("/api/interventions/:id/take", async (request, response, next) => {
    try {
      const parsed = takeControlSchema.safeParse(request.body);
      if (!parsed.success) { response.status(400).json({ error: "operator is required." }); return; }
      const controller = interventions.get(String(request.params.id));
      if (!controller) { response.status(404).json({ error: "No active intervention for this run." }); return; }
      response.json(await controller.takeControl(String(request.params.id), parsed.data.operator));
    } catch (error) { next(error); }
  });

  app.post("/api/interventions/:id/hand-back", async (request, response, next) => {
    try {
      const controller = interventions.get(String(request.params.id));
      if (!controller) { response.status(404).json({ error: "No active intervention for this run." }); return; }
      response.json(await controller.handBack(String(request.params.id)));
    } catch (error) { next(error); }
  });

  // Any thrown error becomes a 409 with its message - never a stack trace, which
  // could carry a path or value that does not belong in a client response.
  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    response.status(409).json({ error: error.message });
  });

  return { app, interventions };
}

export async function startApiServer(deps: ApiDependencies, port = 4599): Promise<{ server: Server; interventions: InterventionRegistry }> {
  const { app, interventions } = createApiApp(deps);
  // Loopback only: this server drives a live banking session and is never for
  // a public interface.
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  return { server, interventions };
}
