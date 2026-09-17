/**
 * underscore-router — the `_` router (Jev plan step 5, design A: serial).
 *
 * Today a `_` fans out to every chat blank source at once (config-intent's
 * classifier + summon extraction, transform-blank's fused call +
 * replace-detect, fluid-blank's lookup): five chat calls so that one can
 * win. With a decision provider the runtime asks ONE stacked decision
 * request first — a 5-way `choice` over the kinds of request plus one
 * agreement noul per chat route — and dispatches only the routed source.
 * Below the thresholds, or when the choice and its noul disagree, the full
 * fan-out runs as today; a routed source that cedes is followed by the
 * fan-out over the rest (the runtime's cede fallback), so the router can
 * cost a round trip but never an answer.
 *
 * Measured on 171 labelled cases from the three pipelines' own suites (the
 * stacked request, choice conf ≥ 0.5 AND noul ≥ 0.5): 59% of underscores
 * routed, 95% of those to the right source; of the 5 wrong, 3 are
 * out-of-scope settings requests the settings classifier rejects anyway
 * (cede → fan-out). The plain choice at the same threshold: 68% routed,
 * 93% right. Stacking costs +148 input tokens and no latency (223 vs
 * 240 ms). tests/benchmarks/decisions/RESULTS.md § `_` router.
 *
 * The `device` and `other` routes never restrict the pass: keyword blanks
 * are shape-matched by BlankFill before the resolver runs, and a plain
 * prose fill-in is fluid's to judge. Question text is measured; change it
 * only with the router bench re-run (`route-bench.mts`).
 */
import { dispatchDecision, type DispatchDecisionContext } from './dispatch';
import type { ChoiceQuestion, DecisionProvider, DecisionRequest, NoulQuestion } from './types';
import { getDehydrator } from '../dehydrate';

export const UNDERSCORE_ROUTE_THRESHOLD_DEFAULT = 0.5;
/** the agreement noul for the chosen route must clear this */
export const UNDERSCORE_ROUTE_AGREE_THRESHOLD = 0.5;
/** the state is the draft around the `_`; longer drafts are windowed to this many chars ending at the `_` line */
export const UNDERSCORE_ROUTE_MAX_CHARS = 6000;

/** the routes that name a chat source; `device` / `other` mean "no restriction" */
export type UnderscoreRoute = 'settings' | 'transform' | 'lookup';
export const UNDERSCORE_ROUTE_SOURCES: Readonly<Record<UnderscoreRoute, string>> = {
  settings: 'config-intent',
  transform: 'transform-blank',
  lookup: 'fluid-blank',
};
/** the source ids a route restricts between; every other source is untouched by the router */
export const UNDERSCORE_CHAT_SOURCE_IDS: ReadonlySet<string> = new Set(Object.values(UNDERSCORE_ROUTE_SOURCES));

const ROUTE_QUESTION: ChoiceQuestion = {
  type: 'choice',
  instructions: {
    question: 'The writer typed `draft` in a text editor and ended it with `_`, a blank the assistant fills. Which kind of request is the part of the draft that leads up to the `_`?',
    focus: 'Judge the intent of the phrase that owns the `_`, not the whole draft.',
  },
  criteria: {
    settings: { what: 'change one of the writing assistant\'s OWN settings or modes (voice mode, debug logging, which LLM provider, tips, a mode on/off)', not_for: 'controlling the computer, a device, or looking something up', examples: ['voice mode off _', 'enable debug logging _', 'switch to the cheaper provider _'] },
    transform: { what: 'an INSTRUCTION to rewrite, transform, translate, reformat or edit the text around it', not_for: 'a question that wants a short factual answer in the blank', examples: ['<some text> fix typos _', 'make it formal _ hey wanna grab lunch', 'change boy to girl _ the boy ran fast'] },
    lookup: { what: 'a factual lookup, calculation, conversion or translation of one item whose short ANSWER goes into the blank', not_for: 'rewriting surrounding text', examples: ['capital of france _', 'the boiling point of water in kelvin is _', '3 x 17 = _'] },
    device: { what: 'control or read the computer or an external thing: volume, brightness, weather, stock price, time, location', not_for: 'the assistant\'s own settings', examples: ['volume 40 _', 'brightness up _', 'weather in london _'] },
    other: { what: 'none of the above: a plain fill-in-the-blank in prose, a vague pronoun with no target, or a placeholder', examples: ['click _ to continue', 'I should probably do that thing _'] },
  },
};

const AGREE_QUESTIONS: Readonly<Record<UnderscoreRoute, NoulQuestion>> = {
  settings: { type: 'noul', instructions: 'The phrase before the `_` in `draft` asks the writing assistant to change one of its OWN settings or modes (a mode on or off, which model or provider it uses, how it shows things), not to control the computer or answer a question.' },
  transform: { type: 'noul', instructions: 'The phrase before the `_` in `draft` is an instruction to rewrite, edit, reformat or translate OTHER text that is present in the draft (there is text for the instruction to act on).' },
  lookup: { type: 'noul', instructions: 'The `_` in `draft` stands for a short factual answer, number, word or conversion the writer wants filled in, not a rewrite of the surrounding text.' },
};

export type UnderscoreRouteQuestions = {
  readonly route: ChoiceQuestion;
  readonly is_settings: NoulQuestion;
  readonly is_transform: NoulQuestion;
  readonly is_lookup: NoulQuestion;
};

/** The stacked request: one choice + one agreement noul per chat route. Exported for the bench and tests. */
export function underscoreRouteRequest(draft: string): DecisionRequest<UnderscoreRouteQuestions> {
  return {
    state: { draft },
    questions: { route: ROUTE_QUESTION, is_settings: AGREE_QUESTIONS.settings, is_transform: AGREE_QUESTIONS.transform, is_lookup: AGREE_QUESTIONS.lookup },
  };
}

/** Window a long buffer to the part that carries the `_`, so the state stays far under the budget. */
export function underscoreRouteDraft(text: string, maxChars = UNDERSCORE_ROUTE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const us = text.lastIndexOf('_');
  const end = Math.min(text.length, Math.max(us + 1, 0) + Math.floor(maxChars / 4));
  return text.slice(Math.max(0, end - maxChars), end);
}

export interface UnderscoreRouting {
  /** the chat route the pass is restricted to, or null for the full fan-out */
  readonly route: UnderscoreRoute | null;
  /** the source id for `route`, or null */
  readonly sourceId: string | null;
  /** what the choice said, whatever the thresholds made of it */
  readonly choice: string;
  readonly confidence: number;
  /** the agreement noul for the chosen route (1 when the choice is not a chat route) */
  readonly agreement: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly ms: number;
}

/** Decide the routing from the answers; pure, exported for tests and the bench. */
export function decideUnderscoreRoute(
  answers: { route: { choice: string; confidence: number; probabilities: Readonly<Record<string, number>> }; is_settings: { noul: number }; is_transform: { noul: number }; is_lookup: { noul: number } },
  ms: number,
  threshold = UNDERSCORE_ROUTE_THRESHOLD_DEFAULT,
): UnderscoreRouting {
  const { choice, confidence, probabilities } = answers.route;
  const isChat = choice === 'settings' || choice === 'transform' || choice === 'lookup';
  const agreement = choice === 'settings' ? answers.is_settings.noul : choice === 'transform' ? answers.is_transform.noul : choice === 'lookup' ? answers.is_lookup.noul : 1;
  const routed = isChat && confidence >= threshold && agreement >= UNDERSCORE_ROUTE_AGREE_THRESHOLD;
  const route = routed ? (choice as UnderscoreRoute) : null;
  return { route, sourceId: route ? UNDERSCORE_ROUTE_SOURCES[route] : null, choice, confidence, agreement, probabilities, ms };
}

export interface RouteUnderscoreContext extends DispatchDecisionContext {
  readonly threshold?: number;
  /** identity-context `safe` catalog: the draft is dehydrated before it ships (the floor is defence in depth, not the hook) */
  readonly identityContext?: { readonly mode: string; readonly catalog: ReadonlyMap<string, string> };
}

/**
 * Ask the router. Throws the DecisionError on failure — the caller owns the
 * breaker and the fall-through to the fan-out, exactly as the session rail
 * does for its legs.
 */
export async function routeUnderscore(provider: DecisionProvider, text: string, ctx: RouteUnderscoreContext = {}): Promise<UnderscoreRouting> {
  let draft = underscoreRouteDraft(text);
  const idCtx = ctx.identityContext;
  if (idCtx && idCtx.mode === 'safe' && idCtx.catalog.size > 0) {
    const d = getDehydrator(idCtx.catalog, (m) => ctx.log?.(`[decision][route] ${m}`)).dehydrate(draft);
    if (d.changed) draft = d.text;
  }
  const res = await dispatchDecision(provider, underscoreRouteRequest(draft), { signal: ctx.signal, leg: 'route', log: ctx.log });
  const routing = decideUnderscoreRoute(res.answers, res.ms, ctx.threshold);
  ctx.log?.(`[decision][route] ${routing.choice} ${routing.confidence.toFixed(2)} agree ${routing.agreement.toFixed(2)} → ${routing.sourceId ?? 'fan-out'}`);
  return routing;
}
