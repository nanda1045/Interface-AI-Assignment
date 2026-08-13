export type ElementRef = string;

export type AbstractAction =
  | { kind: "navigate"; url: string }
  | { kind: "click" | "focus"; ref: ElementRef }
  | { kind: "type"; ref: ElementRef; text: string; sensitive?: boolean }
  | { kind: "select"; ref: ElementRef; value: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; direction: "up" | "down" };

export interface DigestElement {
  ref: ElementRef;
  frame: string;
  role: string;
  name: string;
  text?: string;
  value?: string;
  state: { visible: boolean; enabled: boolean };
  bboxPct: [number, number, number, number];
  hints: { nearLabel?: string; sectionHeading?: string };
}

export interface Observation {
  url: string;
  title: string;
  frames: string[];
  elements: DigestElement[];
  screenshot?: string;
  stateHash: string;
}

interface LocatorStrategyBase {
  frame: string;
  unique: true;
  confidence: number;
}

export type LocatorStrategy =
  | (LocatorStrategyBase & { kind: "role_name"; role: string; name: string })
  | (LocatorStrategyBase & { kind: "label_proximity"; label: string; control: string })
  | (LocatorStrategyBase & { kind: "text"; value: string; control?: string })
  | (LocatorStrategyBase & { kind: "attr_css"; value: string })
  | (LocatorStrategyBase & { kind: "structural"; value: string })
  | (LocatorStrategyBase & { kind: "geometry"; bboxPct: [number, number, number, number]; nearText?: string });

export interface LocatorBundle {
  capturedAt: string;
  strategies: LocatorStrategy[];
}

export interface TargetSpec {
  frame?: string;
  strategies: LocatorStrategy[];
}

export interface ResolutionAttempt {
  strategy: LocatorStrategy;
  matched: number;
  reason?: "frame_not_found" | "not_unique" | "not_visible" | "disabled" | "geometry_too_far";
}

export interface ResolvedElement {
  ok: true;
  ref: ElementRef;
  frame: string;
  matchedStrategy: LocatorStrategy;
  tier: number;
  attempts: ResolutionAttempt[];
}

export interface ResolutionFailure {
  ok: false;
  reason: "target_not_found";
  attempts: ResolutionAttempt[];
}

export interface ActResult {
  ok: true;
  url: string;
}

export interface Surface {
  observe(options?: { screenshot?: boolean }): Promise<Observation>;
  act(action: AbstractAction): Promise<ActResult>;
  captureLocators(ref: ElementRef): Promise<LocatorBundle>;
  resolve(target: TargetSpec): Promise<ResolvedElement | ResolutionFailure>;
  snapshotDom(): Promise<string>;
  close(): Promise<void>;
}
