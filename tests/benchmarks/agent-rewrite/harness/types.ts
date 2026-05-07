/**
 * Harness types — typing-simulator vocabulary.
 *
 * A scenario is a sequence of steps. Each step is one of:
 *   type(text)        — user typed `text` (cumulative; appended to buffer)
 *   replace(text)     — user replaced the WHOLE buffer (paste / select-all + paste)
 *   moveCursor(pos)   — user moved their cursor (e.g. clicked back)
 *   tick()            — trigger one AgentRewrite round (simulates the 1.5s timer firing)
 *   expectBuffer(s)   — assert the live buffer equals `s`
 *   expectContains(s) — assert the live buffer contains `s`
 *   expectMissing(s)  — assert the live buffer does NOT contain `s`
 *   note(label)       — annotate the trace (debug aid)
 *
 * The simulator records a trace of buffer states + invariant
 * violations after every tick. Invariants are checked AFTER each
 * tick automatically; you don't need to spell them out.
 */

export type Step =
  | { kind: 'type'; text: string }
  | { kind: 'replace'; text: string }
  | { kind: 'moveCursor'; pos: number }
  | { kind: 'tick' }
  | { kind: 'expectBuffer'; expected: string }
  | { kind: 'expectContains'; needle: string }
  | { kind: 'expectMissing'; forbidden: string }
  | { kind: 'note'; label: string };

export interface ScenarioState {
  /** Buffer text BEFORE the step. */
  readonly bufferBefore: string;
  /** Buffer text AFTER the step. */
  readonly bufferAfter: string;
  /** Cursor position after the step. */
  readonly cursorAfter: number;
  /** The step itself. */
  readonly step: Step;
  /** Tick count at this point (0 if no tick has fired). */
  readonly tickCount: number;
}

export interface InvariantViolation {
  readonly invariant: string;
  readonly tickCount: number;
  readonly message: string;
  readonly bufferAtViolation: string;
}

export interface ScenarioResult {
  readonly name: string;
  readonly trace: ReadonlyArray<ScenarioState>;
  readonly violations: ReadonlyArray<InvariantViolation>;
  /** True iff every invariant held AND every expect* step passed. */
  readonly passed: boolean;
}

export interface Invariant {
  readonly name: string;
  /** Returns null if the invariant holds; otherwise an explanation. */
  readonly check: (ctx: InvariantContext) => string | null;
}

export interface InvariantContext {
  /** Cumulative text the user has TYPED in the scenario so far (their intent). */
  readonly userTypedSoFar: string;
  /** The most recent buffer state. */
  readonly bufferNow: string;
  /** The buffer state BEFORE the most recent tick (snapshot for that tick). */
  readonly bufferBeforeLastTick: string;
  /** All buffer states recorded so far. */
  readonly history: ReadonlyArray<string>;
  /** Cursor position now. */
  readonly cursorNow: number;
}

export type LlmMode =
  | { kind: 'mock'; respond: (snapshot: string, task: string, tickIdx: number) => string }
  | { kind: 'groq'; task: string }
  | { kind: 'identity' };       // returns the snapshot verbatim — useful as a baseline
