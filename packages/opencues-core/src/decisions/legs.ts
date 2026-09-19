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
import type { DeviceVerdict } from './device-policy';
export type { DeviceVerdict } from './device-policy';
import type { TableVerdict } from './data-policy';
export type { TableVerdict } from './data-policy';
import type { Claim } from '../contradiction/checks';

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

/**
 * A blank offer: on a pause with no `_`, the deterministic thing the draft's
 * last request could be answered by — an offline table, a shipped device
 * tool, a setting — so the runtime can show the computed answer as a note
 * and `_` applies it. Only these kinds exist: the note is there because the
 * answer is in hand, never as "this looks like a blank".
 */
export type OfferVerdict =
  | { readonly kind: 'table'; readonly table: TableVerdict }
  | { readonly kind: 'device'; readonly device: DeviceVerdict }
  | { readonly kind: 'control'; readonly control: ControlVerdict };

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
  /** blank offers on → the package stacks its table / device / settings questions when the draft could mean one */
  readonly offer?: boolean;
}

export interface PauseVerdict {
  /** null when the tips leg was not asked; a verdict of no tip is `{ id: 'none', … }` */
  readonly tips: TipsVerdict | null;
  readonly contradiction: ContradictionVerdict | null;
  /** the ask-gate probability, or null when not asked */
  readonly ask: number | null;
  /** a correction, or null (not asked, no flag, or no one-edit correction) */
  readonly spelling: SpellingVerdict | null;
  /** the deterministic thing the draft's last request could be answered by, or null (not asked, nothing offered) */
  readonly offer?: OfferVerdict | null;
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
  /** a device blank the same request named (stacked on the route; null when the package asks none, or none was named) */
  readonly device?: DeviceVerdict | null;
  /** an offline table the same request named (stacked on the route; null when the package asks none, or none was named) */
  readonly table?: TableVerdict | null;
}
export interface RouteContext extends DecisionLegContext {
  readonly threshold?: number;
  /** `table-lookups-mode: on`: the package stacks its table question on the request; off (the default) leaves it out and `UnderscoreRouting.table` is null */
  readonly tables?: boolean;
  /** identity-context `safe` catalog: the draft is dehydrated before it ships (the floor is defence in depth, not the hook) */
  readonly identityContext?: { readonly mode: string; readonly catalog: ReadonlyMap<string, string> };
}

/** A settings verdict: a registry scalar and one of its listed values, or null when the draft names no setting. */
export interface SettingsVerdict {
  readonly kind: 'setting';
  readonly setting: string;
  readonly value: string;
  /** confidence the draft asks for THIS setting */
  readonly confidence: number;
  /** confidence the draft wants THIS value of it */
  readonly valueConfidence: number;
  /** the top options, for the log */
  readonly top: string;
}

/** A sentence of the draft, cut by the runtime, for the claims and availability legs. */
export interface ClaimSentence { readonly id: string; readonly text: string }
/** A claims verdict for one sentence: the type named (or `none`), the grammar-captured claim when it cleared the package's threshold. */
export interface ClaimVerdict { readonly id: string; readonly type: Claim['type'] | 'none'; readonly confidence: number; readonly claim: Claim | null; readonly top: string }

/** A posted community rule as the rules leg offers it. */
export interface RuleForDecision { readonly index: number; readonly name: string; readonly description?: string }
/** A rules verdict for one sentence: the rule number it breaks (a posted index the package named at or above its threshold) or null. */
export interface RuleVerdict { readonly id: string; readonly rule: number | null; readonly confidence: number; readonly top: string }

/** A provider-routing verdict: one LLM bucket onto a registered provider, optionally a model from its catalogue (the runtime's apply path probes the provider first). */
export interface ProviderRouteVerdict {
  readonly kind: 'provider';
  readonly scope: 'cues' | 'auditors' | 'blanks';
  readonly provider: string;
  /** a model from the provider's known list, or null for its default */
  readonly model: string | null;
  readonly confidence: number;
  readonly top: string;
}
/** An undo / redo verdict; the count is read from the draft by grammar (digits or number words), never by the model. */
export interface UndoVerdict {
  readonly kind: 'action';
  readonly action: 'undo' | 'redo';
  readonly count: number;
  readonly confidence: number;
  readonly top: string;
}
/** What the settings leg can return: the three things a settings `_` can ask for. */
export type ControlVerdict = SettingsVerdict | ProviderRouteVerdict | UndoVerdict;

/** A word cue as the word gate offers it: what the cue is for, in the author's words. */
export interface WordCueForDecision { readonly name: string; readonly description?: string; readonly gate?: string }

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
  /**
   * The settings change a `_` asks for: which registry scalar, which listed
   * value. Only FEATURES / MENU_TUNABLES at their listed values (never a
   * provider bucket, never a free number); the consumer validates the
   * verdict against the registry before it applies anything. Optional: a
   * package that has no settings leg leaves the chat classifier in place.
   */
  settings?(input: string, ctx?: DecisionLegContext): Promise<ControlVerdict | null>;
  /**
   * Where the settings command begins in a buffer that carries prior
   * writing with no punctuation before the command (`hii world voice mode
   * off _`): a Choice over the runtime-cut word starts, so the wipe span is a
   * boundary the runtime supplied, never a model-echoed substring. The
   * consumer's regex decides every punctuated case without a request.
   * Optional: without it the summon chat call stays.
   */
  commandStart?(input: string, candidates: ReadonlyArray<{ readonly id: string; readonly start: number; readonly suffix: string }>, ctx?: DecisionLegContext): Promise<{ readonly id: string; readonly confidence: number } | null>;
  /**
   * The device blank a `_` asks for and which of its closed values (or
   * `number` / `named` for an argument the runtime captures from the draft
   * by grammar). The consumer resolves it under `device-policy.ts` (tier 2
   * built-ins only) before anything is invoked. Optional.
   */
  device?(input: string, ctx?: DecisionLegContext): Promise<DeviceVerdict | null>;
  /**
   * The offline table a `_` asks for (a unicode symbol, a CSS colour, an
   * HTTP status, a port, a conversion, arithmetic, a chemistry constant, a
   * country fact). The consumer captures the argument from the draft under
   * `data-policy.ts` and looks it up with no model at all. Optional.
   */
  table?(input: string, ctx?: DecisionLegContext): Promise<TableVerdict | null>;
  /**
   * The checkable claims a pass's sentences make (contradiction cues as
   * select-then-compute): per sentence the claim TYPE the package named,
   * with the operands the consumer's grammar cut from the writer's own
   * words (`captureClaim`); `verifyClaim` computes the truth. The package
   * never emits a value. A sentence the grammar cannot ground is not asked.
   * Optional: without it the source keeps its chat parse.
   */
  claims?(sentences: ReadonlyArray<ClaimSentence>, ctx?: DecisionLegContext): Promise<ReadonlyArray<ClaimVerdict>>;
  /**
   * Per sentence, the probability it states the writer's availability or
   * proposes a day / time — from the sentence alone. The consumer resolves
   * the day and time (`captureAvailabilityRef`) and reads the calendar
   * locally (`findClashes`); nothing calendar-shaped is in the request.
   * Optional: without it the calendar cue keeps its chat path.
   */
  availability?(sentences: ReadonlyArray<ClaimSentence>, ctx?: DecisionLegContext): Promise<ReadonlyArray<number>>;
  /**
   * Contradiction cues tier 5d: which of the community's posted rules a
   * sentence clearly breaks — a Choice over the rule ids + none, per
   * sentence, one request per pass. The rules are untrusted community
   * text (sanitized and capped by the provider) and ride as data. The
   * consumer builds the tip from its CACHED rule, never from the answer,
   * and the flagged span is the runtime-cut sentence. Optional: without it
   * the source keeps its dedicated judge call.
   */
  communityRules?(sentences: ReadonlyArray<ClaimSentence>, rules: ReadonlyArray<RuleForDecision>, ctx?: DecisionLegContext): Promise<ReadonlyArray<RuleVerdict>>;
  /**
   * The word-cues gate: per claimed word, the probability that the cue
   * would offer an alternative for it as used in the draft. The consumer
   * sends only the words at or above its threshold to the cue's chat
   * call, and no call at all when none clear it. The words are the
   * cue's own `match:` / `keywords:` claims; the cue's description is
   * the criterion. Optional: without it every claimed word goes to the call.
   */
  wordGate?(cue: WordCueForDecision, draft: string, words: ReadonlyArray<{ readonly id: string; readonly word: string }>, ctx?: DecisionLegContext): Promise<ReadonlyArray<number>>;
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
