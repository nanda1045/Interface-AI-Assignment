// Coordinates human interventions around the ControlLease. It creates auditable
// requests, waits for a human to take and return the same browser session, and
// converts an unanswered request into a controlled aborted terminal state.
import type { RunLogger } from "../evidence/run-logger.js";
import { ControlLease } from "./lease.js";
import type { HandoffCoordinator, InterventionContext, InterventionRequest } from "./intervention.js";

export class RunController implements HandoffCoordinator {
  public readonly lease = new ControlLease();
  // Requests are retained for the local console, result summary, and audit trail.
  private readonly requests = new Map<string, InterventionRequest>();
  private sequence = 0;

  public constructor(private readonly logger: RunLogger, private readonly timeoutMs = 15 * 60_000) {}

  // Read-only views used by the operator console and replay result summary.
  public list(): InterventionRequest[] { return [...this.requests.values()]; }
  public get(id: string): InterventionRequest | undefined { return this.requests.get(id); }
  public summary() { return { count: this.requests.size, requestIds: [...this.requests.keys()] }; }

  // Pause the agent, publish an intervention, and wait until the human hands back
  // or the bounded timeout expires. The caller remains in the same async run.
  public async request(context: InterventionContext): Promise<InterventionRequest> {
    this.sequence += 1;
    const id = `${context.runId}_int_${this.sequence}`;
    const request: InterventionRequest = { ...context, id, status: "waiting", requestedAt: new Date().toISOString() };
    this.requests.set(id, request);
    this.lease.pause(context.reason);
    await this.logger.event({ type: "intervention_requested", request });
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
    try {
      await this.lease.waitFor("resuming", this.timeoutMs);
    } catch {
      // Nobody arrived: abort ownership, persist the reason, and return a normal
      // request result so replay/discovery can finish with structured evidence.
      const abandoned: InterventionRequest = { ...request, status: "aborted" };
      this.requests.set(id, abandoned);
      this.lease.abort(`No operator took control within ${this.timeoutMs}ms.`);
      await this.logger.event({ type: "lease_change", state: this.lease.current() });
      await this.logger.event({ type: "stopped", reason: `Intervention ${id} expired with no operator.` });
      return abandoned;
    }
    const completed = this.requests.get(id);
    if (!completed) throw new Error(`Intervention ${id} disappeared.`);
    return completed;
  }

  // A named operator may claim only a currently waiting intervention.
  public async takeControl(id: string, operator: string): Promise<InterventionRequest> {
    const request = this.requireRequest(id, "waiting");
    this.lease.takeControl(operator);
    const updated: InterventionRequest = { ...request, status: "human_control", operator };
    this.requests.set(id, updated);
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
    return updated;
  }

  // Handback removes human ownership and enters a neutral resuming phase. The
  // replay engine will inspect actual UI state before restoring agent ownership.
  public async handBack(id: string): Promise<InterventionRequest> {
    const request = this.requireRequest(id, "human_control");
    this.lease.handBack();
    const updated: InterventionRequest = { ...request, status: "handed_back", handedBackAt: new Date().toISOString() };
    this.requests.set(id, updated);
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
    return updated;
  }

  // Called only after the engine has re-derived a safe resume decision.
  public async resumeAgent(): Promise<void> {
    this.lease.resumeAgent();
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
  }

  public resume(): Promise<void> { return this.resumeAgent(); }

  // Validate both request identity and expected lifecycle status for console calls.
  private requireRequest(id: string, status: InterventionRequest["status"]): InterventionRequest {
    const request = this.requests.get(id);
    if (!request) throw new Error(`Unknown intervention: ${id}`);
    if (request.status !== status) throw new Error(`Intervention ${id} is ${request.status}, expected ${status}.`);
    return request;
  }
}
