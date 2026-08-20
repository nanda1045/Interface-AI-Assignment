// Explicit ownership state machine for one live browser session. At most one
// actor can hold control: the agent, a named human, or nobody during a safe
// transition/terminal state.
import { EventEmitter } from "node:events";

// Discriminated states make legal ownership and required metadata visible in the
// type system rather than representing control with a loose boolean flag.
export type ControlState =
  | { phase: "agent_running"; holder: "agent" }
  | { phase: "paused"; holder: null; reason: string }
  | { phase: "human_control"; holder: "human"; operator: string; since: string }
  | { phase: "resuming"; holder: null }
  | { phase: "done"; holder: null }
  | { phase: "aborted"; holder: null; reason: string };

export class ControlLease {
  private state: ControlState = { phase: "agent_running", holder: "agent" };
  // State changes wake the waiting controller and can update observers.
  private readonly events = new EventEmitter();

  public current(): ControlState { return this.state; }
  // WebSurface calls this immediately before every agent browser action.
  public agentCanAct(): boolean { return this.state.phase === "agent_running"; }

  // Each public method permits only the valid predecessor phase. Invalid or
  // concurrent control operations fail instead of silently corrupting ownership.
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

  // Await a handback/resume transition without polling, with a bounded timeout so
  // an unanswered intervention cannot leave the run paused forever.
  public async waitFor(phase: ControlState["phase"], timeoutMs: number): Promise<ControlState> {
    if (this.state.phase === phase) return this.state;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for control state ${phase}.`)); }, timeoutMs);
      const listener = (state: ControlState) => { if (state.phase === phase) { cleanup(); resolve(state); } };
      const cleanup = () => { clearTimeout(timer); this.events.off("change", listener); };
      this.events.on("change", listener);
    });
  }

  // Subscribe to control changes and receive an unsubscribe function.
  public onChange(listener: (state: ControlState) => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  // Central transition guard and notification point for the entire state machine.
  private transition(allowed: ControlState["phase"][], next: ControlState): void {
    if (!allowed.includes(this.state.phase)) throw new Error(`Invalid control transition: ${this.state.phase} → ${next.phase}`);
    this.state = next;
    this.events.emit("change", next);
  }
}
