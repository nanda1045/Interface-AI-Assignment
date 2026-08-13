import type { RunLogger } from "../evidence/run-logger.js";
import { ControlLease } from "./lease.js";
import type { HandoffCoordinator, InterventionContext, InterventionRequest } from "./intervention.js";

export class RunController implements HandoffCoordinator {
  public readonly lease = new ControlLease();
  private readonly requests = new Map<string, InterventionRequest>();
  private sequence = 0;

  public constructor(private readonly logger: RunLogger, private readonly timeoutMs = 15 * 60_000) {}

  public list(): InterventionRequest[] { return [...this.requests.values()]; }
  public get(id: string): InterventionRequest | undefined { return this.requests.get(id); }
  public summary() { return { count: this.requests.size, requestIds: [...this.requests.keys()] }; }

  public async request(context: InterventionContext): Promise<InterventionRequest> {
    this.sequence += 1;
    const id = `${context.runId}_int_${this.sequence}`;
    const request: InterventionRequest = { ...context, id, status: "waiting", requestedAt: new Date().toISOString() };
    this.requests.set(id, request);
    this.lease.pause(context.reason);
    await this.logger.event({ type: "intervention_requested", request });
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
    await this.lease.waitFor("resuming", this.timeoutMs);
    const completed = this.requests.get(id);
    if (!completed) throw new Error(`Intervention ${id} disappeared.`);
    return completed;
  }

  public async takeControl(id: string, operator: string): Promise<InterventionRequest> {
    const request = this.requireRequest(id, "waiting");
    this.lease.takeControl(operator);
    const updated: InterventionRequest = { ...request, status: "human_control", operator };
    this.requests.set(id, updated);
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
    return updated;
  }

  public async handBack(id: string): Promise<InterventionRequest> {
    const request = this.requireRequest(id, "human_control");
    this.lease.handBack();
    const updated: InterventionRequest = { ...request, status: "handed_back", handedBackAt: new Date().toISOString() };
    this.requests.set(id, updated);
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
    return updated;
  }

  public async resumeAgent(): Promise<void> {
    this.lease.resumeAgent();
    await this.logger.event({ type: "lease_change", state: this.lease.current() });
  }

  public resume(): Promise<void> { return this.resumeAgent(); }

  private requireRequest(id: string, status: InterventionRequest["status"]): InterventionRequest {
    const request = this.requests.get(id);
    if (!request) throw new Error(`Unknown intervention: ${id}`);
    if (request.status !== status) throw new Error(`Intervention ${id} is ${request.status}, expected ${status}.`);
    return request;
  }
}
