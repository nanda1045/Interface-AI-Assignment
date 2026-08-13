import { EventEmitter } from "node:events";

export type ControlState =
  | { phase: "agent_running"; holder: "agent" }
  | { phase: "paused"; holder: null; reason: string }
  | { phase: "human_control"; holder: "human"; operator: string; since: string }
  | { phase: "resuming"; holder: null }
  | { phase: "done"; holder: null }
  | { phase: "aborted"; holder: null; reason: string };

export class ControlLease {
  private state: ControlState = { phase: "agent_running", holder: "agent" };
  private readonly events = new EventEmitter();

  public current(): ControlState { return this.state; }
  public agentCanAct(): boolean { return this.state.phase === "agent_running"; }

  public pause(reason: string): void {
    this.transition(["agent_running"], { phase: "paused", holder: null, reason });
  }

  public takeControl(operator: string, now = new Date()): void {
    if (!operator.trim()) throw new Error("Operator identity is required.");
    this.transition(["paused"], { phase: "human_control", holder: "human", operator, since: now.toISOString() });
  }

  public handBack(): void { this.transition(["human_control"], { phase: "resuming", holder: null }); }
  public resumeAgent(): void { this.transition(["resuming"], { phase: "agent_running", holder: "agent" }); }
  public complete(): void { this.transition(["agent_running", "resuming"], { phase: "done", holder: null }); }
  public abort(reason: string): void { this.transition(["agent_running", "paused", "human_control", "resuming"], { phase: "aborted", holder: null, reason }); }

  public async waitFor(phase: ControlState["phase"], timeoutMs: number): Promise<ControlState> {
    if (this.state.phase === phase) return this.state;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for control state ${phase}.`)); }, timeoutMs);
      const listener = (state: ControlState) => { if (state.phase === phase) { cleanup(); resolve(state); } };
      const cleanup = () => { clearTimeout(timer); this.events.off("change", listener); };
      this.events.on("change", listener);
    });
  }

  public onChange(listener: (state: ControlState) => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  private transition(allowed: ControlState["phase"][], next: ControlState): void {
    if (!allowed.includes(this.state.phase)) throw new Error(`Invalid control transition: ${this.state.phase} → ${next.phase}`);
    this.state = next;
    this.events.emit("change", next);
  }
}
