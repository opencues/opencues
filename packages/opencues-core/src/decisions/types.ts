/**
 * Decision provider — the seam for calibrated decision models.
 *
 * A DECISION provider answers typed questions about a state and returns
 * probabilities. It never generates text. That makes it a different thing
 * from an LLM provider (`ProviderAdapter` in llm-provider.ts): it gets its
 * own contract, its own scalar (`decisions-provider`) and its own dispatch
 * chokepoint, and is never selectable in the three LLM buckets.
 *
 * The contract mirrors TypeSafe's System One API (docs.typesafe.ai) because
 * that is the one calibrated decision model on the market today, but it is
 * written so a chat model can implement it (see chat-fallback.ts) — the open
 * standard must stay implementable without one vendor.
 *
 * Reference: docs/architecture/decisions.md (primitives, mechanics, limits,
 * authoring rules, and the benchmark rows every number there comes from).
 */

/** JSON-shaped values accepted as state, instructions and criteria text. */
export type DecisionValue = string | number | boolean | null | ReadonlyArray<DecisionValue> | { readonly [key: string]: DecisionValue };

/** Yes/no. Returns P(yes) in [0, 1]. No separate confidence. */
export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: DecisionValue;
  /** Optional clarification of what a yes and a no mean. */
  readonly criteria?: { readonly true?: DecisionValue; readonly false?: DecisionValue };
}

/** Pick one option. Returns the top option, every option's probability, and a confidence. */
export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: DecisionValue;
  /** option id → description (or null when the id is self-explanatory). ≤ 255 options. */
  readonly criteria: Readonly<Record<string, DecisionValue>>;
}

/** Position on an ordered rubric. Returns a probability-weighted position, per-level probabilities, a confidence. */
export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: DecisionValue;
  /** Ordered level descriptions, low to high. 2–10 levels. */
  readonly criteria: ReadonlyArray<DecisionValue>;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer { readonly type: 'noul'; readonly noul: number }
export interface ChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}
export interface ScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Maps a question map to its answer map, by question type. */
export type AnswersFor<Q extends Readonly<Record<string, DecisionQuestion>>> = {
  readonly [K in keyof Q]:
    Q[K] extends NoulQuestion ? NoulAnswer :
    Q[K] extends ChoiceQuestion ? ChoiceAnswer :
    Q[K] extends ScoreQuestion ? ScoreAnswer : DecisionAnswer;
};

export interface DecisionRequest<Q extends Readonly<Record<string, DecisionQuestion>> = Readonly<Record<string, DecisionQuestion>>> {
  /** The content to judge. Key structured state by NAME — never reference
   *  array indices from a question (`rules[3]` was read one-off in the
   *  contradiction bench; `rules.r4` was not). Validated in dispatch. */
  readonly state: DecisionValue;
  readonly questions: Q;
}

export interface DecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface DecisionResult<Q extends Readonly<Record<string, DecisionQuestion>> = Readonly<Record<string, DecisionQuestion>>> {
  readonly answers: AnswersFor<Q>;
  readonly model: string;
  readonly usage: DecisionUsage;
  /** Wall time of the provider call, ms. */
  readonly ms: number;
}

export interface DecisionContext {
  readonly signal?: AbortSignal;
  /** Debug/info log line sink. Lines are prefixed `[decision]` by dispatch. */
  readonly log?: (line: string) => void;
}

/** Typed failure classes so a leg can decide what to do without string-matching. */
export type DecisionErrorKind =
  | 'auth'          // 401 — key missing/invalid
  | 'budget'        // 400 max_tokens_exceeded — state > ~32.9k or total > ~65.8k tokens
  | 'shape'         // 400/422 — too many options/levels, malformed question
  | 'overloaded'    // 429/529 — retried once by the adapter; surfaced if the retry failed
  | 'transport'     // network / timeout / abort
  | 'malformed';    // 200 with a body we could not parse

export class DecisionError extends Error {
  constructor(readonly kind: DecisionErrorKind, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'DecisionError';
  }
}

/** The seam. One method. Implementations: the decision package's provider, ChatFallbackDecisionProvider. */
export interface DecisionProvider {
  readonly id: string;
  /** The model id that will appear in usage rows (pinned for TypeSafe). */
  readonly model: string;
  ask<Q extends Readonly<Record<string, DecisionQuestion>>>(req: DecisionRequest<Q>, ctx?: DecisionContext): Promise<DecisionResult<Q>>;
}

/** Hard limits, from the API and from measurement (docs/architecture/decisions.md § Limits). */
export const DECISION_LIMITS = {
  maxChoiceOptions: 255,
  maxScoreLevels: 10,
  minScoreLevels: 2,
  /** state alone, tokens (measured 32,907 OK / next step failed) */
  approxStateTokens: 32_000,
  /** state + questions, tokens (measured 65,783 OK) */
  approxTotalTokens: 65_000,
} as const;
