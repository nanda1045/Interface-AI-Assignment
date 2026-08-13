export interface InterventionContext {
  runId: string;
  capability: string;
  goal: string;
  step: string;
  intent: string;
  reason: string;
  requestedAction: string;
  screenshot?: string;
  recentEvents?: unknown[];
}

export interface InterventionRequest extends InterventionContext {
  id: string;
  status: "waiting" | "human_control" | "handed_back" | "aborted";
  requestedAt: string;
  operator?: string;
  handedBackAt?: string;
}

export interface HandoffCoordinator {
  request(context: InterventionContext): Promise<InterventionRequest>;
  resume(): Promise<void>;
  summary(): { count: number; requestIds: string[] };
}
