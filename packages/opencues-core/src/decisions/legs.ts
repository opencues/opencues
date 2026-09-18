/**
 * Decision legs — what a decision PACKAGE gives the sources.
 *
 * The sources never see a question. They hand a leg the thing to judge
 * (the draft, the sentences, the watchlist) and get back a VERDICT: ids,
 * probabilities and spans over inputs the runtime supplied. How the
 * question is asked — which primitive, what the options say, how a
 * candidate list is cut, which thresholds decide — is the package's, and
 * the package is loaded by name (`loadDecisionLegs` in build-sources).
 * Without one, every leg below has a chat path and takes it.
 *
 * Every leg goes through `dispatchDecision` inside the package (validate →
 * PII floor → meter → log), so the chokepoint is the same whoever asks.
 * A leg THROWS on a failed request (a `DecisionError`); the caller owns
 * the breaker and the fall-through, exactly as it did for a provider.
 */
import type { DecisionProvider } from './types';

export interface DecisionLegContext {
  readonly signal?: AbortSignal;
  readonly log?: (msg: string) => void;
}

/** A tips-catalogue entry as a leg needs it: the id to return, the text to judge, the command a typed trigger pre-checks. */
export interface TipsEntryForDecision { readonly id: string; readonly when?: string; readonly tip: string; readonly command?: string }

/** The best non-`none` tip across the catalogue, with the top two of every slice for the log. */
export interface TipsVerdict { readonly id: string; readonly confidence: number; readonly p: number; readonly top: string }

export interface CommitmentForDecision { readonly id: string; readonly statement: string }
/** A sentence of the draft, cut by the runtime; the unit answer names one of these by id. */
export interface DecisionUnit { readonly id: string; readonly text: string; readonly start: number; readonly end: number }
export interface ContradictionVerdict {
  /** the commitment the gate named, or `none` */
  readonly choice: string;
  readonly confidence: number;
  readonly top: string;
  /** the unit the unit question named (absent when the request carried no unit question) */
  readonly unit?: { readonly choice: string; readonly confidence: number };
}

export interface SpellingVerdict {
  readonly wordIndex: number;
  /** the correction, case following the typed word; punctuation is the caller's */
  readonly fix: string;
  readonly flag: number;
  readonly fixConfidence: number;
}

export interface PauseInput {
  readonly text: string;
  readonly words: ReadonlyArray<string>;
  /** tips leg on: the catalogue to match; absent → no tips question */
  readonly tips?: ReadonlyArray<TipsEntryForDecision>;
  /** contradiction leg on: the watchlist + the runtime-cut units; absent → no gate */
  readonly contradiction?: { readonly commitments: ReadonlyArray<CommitmentForDecision>; readonly units: ReadonlyArray<DecisionUnit> };
  /** ask leg on → the ask-gate noul rides the request */
  readonly ask?: boolean;
  /** spelling passenger on → the typo choice rides the request and a flag costs one fix request */
  readonly spelling?: boolean;
  /** the caret, for the sentence a prose tip attaches to */
  readonly cursor?: number;
}

export interface PauseVerdict {
  /** null when the tips leg was not asked; a verdict of no tip is `{ id: 'none', … }` */
  readonly tips: TipsVerdict | null;
  readonly contradiction: ContradictionVerdict | null;
  /** the ask-gate probability, or null when not asked */
  readonly ask: number | null;
  /** a correction, or null (not asked, no flag, or no one-edit correction) */
  readonly spelling: SpellingVerdict | null;
  /** true when every leg pre-checked out and no request was sent */
  readonly empty: boolean;
}

export type UnderscoreRoute = 'settings' | 'transform' | 'lookup';
export interface UnderscoreRouting {
  /** the chat route the pass is restricted to, or null for the full fan-out */
  readonly route: UnderscoreRoute | null;
  /** the source id for `route`, or null */
  readonly sourceId: string | null;
  /** what the choice said, whatever the thresholds made of it */
  readonly choice: string;
  readonly confidence: number;
  /** the agreement for the chosen route (1 when the choice is not a chat route) */
  readonly agreement: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly ms: number;
}
export interface RouteContext extends DecisionLegContext {
  readonly threshold?: number;
  /** identity-context `safe` catalog: the draft is dehydrated before it ships (the floor is defence in depth, not the hook) */
  readonly identityContext?: { readonly mode: string; readonly catalog: ReadonlyMap<string, string> };
}

/** A replace decision: the exact target substring of the input and the command phrase, both cut from the input. */
export interface ReplaceVerdict { readonly target: string; readonly command: string; readonly kind: 'replace'; readonly confidence: number; readonly summary: string }

export interface DecisionLegs {
  /** the provider underneath (for the meter, doctor, and the breaker's auth classification) */
  readonly provider: DecisionProvider;
  readonly id: string;
  readonly model: string;

  /** ONE request per pause: whichever legs the input turns on, plus the spelling fix request on a flag. */
  pause(input: PauseInput, ctx?: DecisionLegContext): Promise<PauseVerdict>;
  /** the ask gate on its own (fan-out off) → probability the draft holds an open question worth asking */
  askGate(text: string, ctx?: DecisionLegContext): Promise<number>;
  /** the tips match on its own (fan-out off) */
  tipsMatch(text: string, entries: ReadonlyArray<TipsEntryForDecision>, ctx?: DecisionLegContext): Promise<TipsVerdict | null>;
  /** the contradiction gate + unit on their own (fan-out off) */
  contradictionGate(text: string, commitments: ReadonlyArray<CommitmentForDecision>, units: ReadonlyArray<DecisionUnit>, ctx?: DecisionLegContext): Promise<ContradictionVerdict>;
  /** per sentence: [the cue's gate probability, the prose probability]; the caller thresholds */
  sentenceGate(gate: string, sentences: ReadonlyArray<string>, ctx?: DecisionLegContext): Promise<ReadonlyArray<readonly [number, number]>>;
  /** the `_` router */
  route(text: string, ctx?: RouteContext): Promise<UnderscoreRouting>;
  /** the replace detector over the outbound input; null = no single-substring edit */
  replace(input: string, ctx?: DecisionLegContext): Promise<ReplaceVerdict | null>;
}

/** What `loadDecisionLegs` hands the package's factory. */
export interface DecisionLegsFactoryOptions {
  readonly which: string;
  readonly apiKey: string;
  readonly httpAdapter: unknown;
  readonly log?: (msg: string) => void;
}
export type DecisionLegsFactory = (options: DecisionLegsFactoryOptions) => DecisionLegs | null;

/** the source ids a route restricts between; every other source is untouched by the router */
export const UNDERSCORE_ROUTE_SOURCES: Readonly<Record<UnderscoreRoute, string>> = {
  settings: 'config-intent',
  transform: 'transform-blank',
  lookup: 'fluid-blank',
};
export const UNDERSCORE_CHAT_SOURCE_IDS: ReadonlySet<string> = new Set(Object.values(UNDERSCORE_ROUTE_SOURCES));
