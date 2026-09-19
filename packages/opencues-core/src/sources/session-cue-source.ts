/**
 * SessionCueSource — the unified "reason over the session watchlist" cue. It
 * composes the two context-aware cues into ONE source so they no longer overlap
 * or evict each other:
 *
 *   1. session-contradiction (⚠) — is the draft going AGAINST a decision?
 *   2. ask-cues (❓)             — is there an open question worth asking?
 *
 * Contradiction is the more urgent signal and WINS when it fires; the ask call
 * (the biggest of the three, opt-in) is only spent when neither contradiction
 * nor tips flagged anything, since the priority rail would evict it anyway.
 *
 * Ordering (Sep 2026): contradiction and tips run IN PARALLEL. They used to run
 * one after the other, so a tip waited for the contradiction call even on a
 * draft with nothing to contradict — measured live as +400ms on every pause
 * with a watchlist loaded, and 2.2s on a slow provider call. Now a tip lands at
 * max(contradiction, tips) instead of their sum; the only cost is the tips
 * call being spent on the rare pause where a contradiction also fires (it is
 * one cached-prefix call). Each job keeps its own proven prompt — never fused.
 *
 * Per-type gating: constructed with `enableContradiction` / `enableAsk` from the
 * `session-contradiction-mode` / `ask-cues-mode` scalars — so contradiction-only,
 * question-only, and both all work. The emitted CueResults keep their own
 * source-ids (`sentence-cue:session-contradiction` / `sentence-cue:tool-ask`)
 * and priorities, so rendering + tests are unchanged.
 *
 * A future step could FUSE the two prompts into a single LLM call (one classify
 * → contradiction | question | nothing); that's held behind a bench because
 * overloading one prompt with two jobs has regressed quality here before.
 */

import type { CueContext, CueResult, CueSource, CueSourceResult } from '../types';
import { SessionContradictionSource, type SessionContradictionSourceConfig } from '../contradiction/session-contradiction-source';
import { ToolPromptCueSource } from './tool-prompt-source';
import { SemanticTipsSource } from './semantic-tips-source';
import { contradictionUnits, type DeferredRewrite } from '../contradiction/session-contradiction-source';
import { DecisionBreaker } from '../decisions/breaker';
import type { PauseInput, SpellingVerdict, OfferVerdict } from '../decisions/legs';
import { entriesForDecision } from './semantic-tips-source';
import type { TipsCatalog } from '../tips-catalog';
import type { SessionCommitmentsSnapshot } from '../session-commitments';

export interface SessionCueSourceConfig extends SessionContradictionSourceConfig {
  readonly enableContradiction: boolean;
  readonly enableAsk: boolean;
  /** the tips pack matched as a watchlist (`tips-mode: semantic`) — runs
   *  alongside contradiction, before ask; its own call, never folded in. */
  readonly enableSemanticTips?: boolean;
  // `decisions` comes from SessionContradictionSourceConfig and reaches the tips
  // matcher (step 1, `tipsThreshold`) and the contradiction gate (step 2,
  // `contradictionGateThreshold`) — two thresholds, two meanings (fire vs skip).
  readonly tipsThreshold?: number;
  /**
   * `decisions-fanout` (default on when a decision provider is set): ONE
   * decision request per pause carrying the tips Choice, the contradiction
   * gate and the ask gate, instead of one per leg (plan step 3). Off → each
   * leg makes its own decision call as in steps 1–2.
   */
  readonly decisionsFanout?: boolean;
  /** the ask leg's chat call runs only when the fused ask noul ≥ this (bench: 0.7 → 39/40). */
  readonly askGateThreshold?: number;
  /**
   * Spelling as a passenger on the pause request (plan step 7B,
   * spelling-decide.ts): a Choice over the draft's words flags a typo, a
   * second small request picks the correction from its edit-1
   * neighbourhood, and the result is a plain word-cue (`source: 'spelling'`)
   * next to whatever the rail emits. Only meaningful with `decisions` and
   * the fanout on; build-sources sets it in place of the shipped spelling
   * word-cue so the word-cues chat call is not spent on spelling.
   */
  readonly enableSpelling?: boolean;
  /**
   * Blank offers (`blank-offers-mode`): on a pause with no `_`, the package
   * stacks its table / device / settings questions when the draft could
   * mean one, and a hit becomes a passive note on the draft's last sentence
   * carrying the computed answer — `📎 5432 (underscore to apply)` — so the
   * `_` gesture is learnt from the product. Only the deterministic kinds are
   * ever offered. Only meaningful with `decisions` and the fanout on.
   */
  readonly enableOffer?: boolean;
}

export const ASK_GATE_THRESHOLD_DEFAULT = 0.7;
/** the offer note's priority: above a tip (86) on the same sentence, below a session contradiction (88) */
export const OFFER_PRIORITY = 87;
/** breaker windows after a failed decision request — re-exported from the shared breaker */
export { DECISIONS_BREAKER_MS, DECISIONS_BREAKER_AUTH_MS } from '../decisions/breaker';

export class SessionCueSource implements CueSource {
  readonly id = 'session-cue';
  readonly priority = 88;   // nominal source-order key; emitted results carry their own priority
  readonly isCycleable = true;

  private readonly contradiction?: SessionContradictionSource;
  private readonly ask?: ToolPromptCueSource;
  private readonly tips?: SemanticTipsSource;

  private readonly cfg: SessionCueSourceConfig;
  private readonly log: (msg: string) => void;
  /**
   * Circuit breaker (decisions/breaker.ts — shared with the `_` router). A
   * failed decision request marks the provider down for a window; while
   * down, every leg runs its chat path with no decision call at all, so an
   * outage costs one failed request per window, not one per leg per pause.
   */
  private readonly breaker: DecisionBreaker;
  private readonly decisionsHealthy = (): boolean => this.breaker.healthy();

  constructor(cfg: SessionCueSourceConfig) {
    this.cfg = cfg;
    this.log = cfg.log ?? (() => {});
    this.breaker = new DecisionBreaker(this.log, 'SessionCue');
    const legCfg = { ...cfg, decisionsHealthy: this.decisionsHealthy };
    if (cfg.enableContradiction) this.contradiction = new SessionContradictionSource(legCfg);
    if (cfg.enableAsk) this.ask = new ToolPromptCueSource(cfg);
    if (cfg.enableSemanticTips) this.tips = new SemanticTipsSource(legCfg);
  }

  private tripBreaker(err: { kind?: string; message?: string }): void { this.breaker.trip(err); }

  supports(context: CueContext): boolean {
    return (this.contradiction?.supports(context) ?? false) || (this.tips?.supports(context) ?? false) || (this.ask?.supports(context) ?? false) || this.spellingOn(context) || this.offerOn(context);
  }

  /** a blank offer is asked only on the fused path, on a draft with no `_` and at least one sentence */
  private offerOn(context: CueContext): boolean {
    return !!this.cfg.enableOffer && !!this.cfg.decisions && (this.cfg.decisionsFanout ?? true) && this.decisionsHealthy() && !!(context.text ?? '').trim() && !context.words.includes('_');
  }

  /** the spelling passenger runs only on the fused path with a healthy provider and at least one eligible word */
  private spellingOn(context: CueContext): boolean {
    return !!this.cfg.enableSpelling && !!this.cfg.decisions && (this.cfg.decisionsFanout ?? true) && this.decisionsHealthy() && context.words.length > 0 && !!(context.text ?? '').trim();
  }

  /** The deferred contradiction rewrite (plan step 6), for the runtime to fetch when the person goes to the cue. */
  reconcileContradiction(rewrite: DeferredRewrite, signal?: AbortSignal): Promise<string | null> {
    return this.contradiction ? this.contradiction.reconcile(rewrite, signal) : Promise.resolve(null);
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const empty: CueSourceResult = { results: [] };
    if (this.cfg.decisions && (this.cfg.decisionsFanout ?? true) && this.decisionsHealthy()) {
      const fused = await this.getCuesFused(context);
      if (fused) return fused;
      // the fused request failed → the breaker is tripped, and the per-leg
      // path below runs every leg on its CHAT path, so a pause never goes
      // silent because one request did and an outage costs one failed
      // request per breaker window, not one per leg.
    }
    // Contradiction and tips together; contradiction wins if it fires (the
    // more urgent signal), else the tip. A leg that throws is an empty leg —
    // the other still lands.
    const [c, t] = await Promise.all([
      this.contradiction?.supports(context) ? this.contradiction.getCues(context).catch(() => empty) : Promise.resolve(empty),
      this.tips?.supports(context) ? this.tips.getCues(context).catch(() => empty) : Promise.resolve(empty),
    ]);
    if (c.results.length > 0) return c;
    if (t.results.length > 0) return t;
    // Neither flagged → the ask cue is free to surface an open question.
    // With a healthy decision provider and the fanout off, the ask gate
    // still runs (its own small request) so the ask chat call is gated the
    // same way on both paths.
    if (this.ask?.supports(context)) {
      if (this.cfg.decisions && this.decisionsHealthy()) {
        try {
          const p = await this.cfg.decisions.askGate(context.text ?? '', { signal: context.signal, log: (m) => this.log(m) });
          const threshold = this.cfg.askGateThreshold ?? ASK_GATE_THRESHOLD_DEFAULT;
          if (p < threshold) { this.log(`SessionCue: ask gate ${p.toFixed(2)} < ${threshold} — ask call skipped`); return empty; }
        } catch (e) {
          const err = e as { name?: string; kind?: string; message?: string };
          if (err?.name === 'AbortError' || /abort/i.test(err?.message ?? '')) return empty;
          this.tripBreaker(err);   // and fall through to the ungated ask call
        }
      }
      return this.ask.getCues(context);
    }
    return empty;
  }

  /**
   * ONE request per pause (plan step 3): the decision package composes the
   * legs' questions — tips, the contradiction gate + unit, the ask gate,
   * the spelling passenger — into one request and hands back a verdict per
   * leg. The legs make no decision call of their own; the chat calls that
   * remain (an ask hit's question, a contradiction hit under the fire floor)
   * run as before. Returns null when the request itself failed, so the
   * caller can fall back.
   */
  private async getCuesFused(context: CueContext): Promise<CueSourceResult | null> {
    const empty: CueSourceResult = { results: [] };
    const text = context.text ?? '';
    const tipsOn = !!this.tips?.supports(context);
    const contraOn = !!this.contradiction?.supports(context);
    const askOn = !!this.ask?.supports(context);
    const spellingOn = this.spellingOn(context);
    const offerOn = this.offerOn(context);
    const snapshot = context.sessionCommitments as SessionCommitmentsSnapshot | undefined;
    const units = contraOn ? contradictionUnits(text, context.words) : [];
    const input: PauseInput = {
      text,
      words: context.words,
      cursor: context.cursor,
      tips: tipsOn ? entriesForDecision(context.tipsCatalog as TipsCatalog) : undefined,
      contradiction: contraOn && snapshot ? { commitments: snapshot.commitments.map((c) => ({ id: c.id, statement: c.statement })), units } : undefined,
      ask: askOn,
      spelling: spellingOn,
      offer: offerOn,
    };
    if (!input.tips && !input.contradiction && !askOn && !spellingOn && !offerOn) return empty;

    let verdict;
    try {
      verdict = await this.cfg.decisions!.pause(input, { signal: context.signal, log: (m) => this.log(m) });
    } catch (e) {
      const err = e as Error;
      if (err?.name === 'AbortError' || /abort/i.test(err?.message ?? '')) { this.log('SessionCue[fused]: superseded (newer keystroke)'); return empty; }
      this.log(`SessionCue[fused]: request failed (${err?.message}) — falling back to the chat path`);
      this.tripBreaker(err as { kind?: string; message?: string });
      return null;
    }
    if (verdict.empty) return empty;

    // The spelling passenger: a correction rides along with whatever the
    // rail emits (a different word than any sentence cue; the resolver
    // keeps both). Never a chat call.
    const spelling = verdict.spelling ? this.spellingResult(context, verdict.spelling) : [];
    // The blank offer rides the same way: its own passive note on the last
    // sentence, next to whatever the rail emits (the resolver keeps the
    // higher priority where two claim one sentence).
    const offer = offerOn && verdict.offer ? this.offerResult(context, verdict.offer) : [];
    const riders = [...spelling, ...offer];
    const withSpelling = (r: CueSourceResult): CueSourceResult => riders.length ? { ...r, results: [...r.results, ...riders] } : r;

    // Contradiction first (its chat call runs only on a gate hit under the
    // fire floor), then tips (no call at all), then ask (its chat call only
    // above the gate).
    if (contraOn && verdict.contradiction) {
      const c = await this.contradiction!.getCues(context, verdict.contradiction, units).catch(() => empty);
      if (c.results.length > 0) return withSpelling(c);
    }
    if (tipsOn) {
      const t = this.tips!.getCuesFromVerdict(context, verdict.tips);
      if (t.results.length > 0) return withSpelling(t);
    }
    if (askOn) {
      const p = verdict.ask ?? 0;
      const threshold = this.cfg.askGateThreshold ?? ASK_GATE_THRESHOLD_DEFAULT;
      if (p >= threshold) { this.log(`SessionCue[fused]: ask gate ${p.toFixed(2)} ≥ ${threshold} — running the ask call`); return withSpelling(await this.ask!.getCues(context)); }
      this.log(`SessionCue[fused]: ask gate ${p.toFixed(2)} < ${threshold} — ask call skipped`);
    }
    return withSpelling(empty);
  }

  /**
   * The offer as a passive TOGGLE note on the draft's last sentence:
   * alternatives [sentence, what `_` applies], so the ordinary `_`-on-note
   * gesture (cycling) applies it and the hint reads `(underscore to apply)`.
   * A device or a control applies by putting the `_` there — the sentence
   * plus ` _` — so the blank machinery runs exactly as if the person had
   * typed it (the setting is written, the tool runs). A table's answer is
   * computed by the RUNTIME (it holds the tables): the result carries the
   * verdict in `metadata.offer` and the resolver fills the second stop and
   * the note, or drops the offer on a miss.
   */
  private offerResult(context: CueContext, v: OfferVerdict): CueResult[] {
    const units = contradictionUnits(context.text ?? '', context.words);
    const last = units[units.length - 1];
    if (!last || !last.text.trim()) return [];
    const wordIndex = Math.max(0, (context.text ?? '').slice(0, last.start).split(/\s+/).filter(Boolean).length);
    const base = { wordIndex, word: context.words[wordIndex] ?? last.text.split(/\s+/)[0], source: 'sentence-cue:offer', priority: OFFER_PRIORITY, spanStart: last.start, spanEnd: last.end };
    const meta = { sentenceCue: { cueName: 'offer' }, offer: v, offerSentence: last.text };
    if (v.kind === 'table') {
      this.log(`SessionCue[offer]: table ${v.table.table} (${v.table.top}) on "${last.text.slice(0, 40)}…" — the runtime answers`);
      return [{ ...base, alternatives: [last.text], metadata: meta }];
    }
    const label = v.kind === 'device'
      ? `${v.device.blank} ${v.device.value}`
      : v.control.kind === 'setting' ? `${v.control.setting} ${v.control.value}`
        : v.control.kind === 'provider' ? `${v.control.scope}-llm-provider ${v.control.provider}${v.control.model ? `:${v.control.model}` : ''}`
          : `${v.control.action}${v.control.count > 1 ? ` ×${v.control.count}` : ''}`;
    this.log(`SessionCue[offer]: ${label} on "${last.text.slice(0, 40)}…"`);
    return [{ ...base, alternatives: [last.text, `${last.text} _`], cueTip: `📎 ${label}`, metadata: meta }];
  }

  /** The flagged word's correction as a word-cue result. The correction keeps the token's punctuation, as the word-cue path expects a whole-token alternative. */
  private spellingResult(context: CueContext, v: SpellingVerdict): CueResult[] {
    const typed = context.words[v.wordIndex];
    if (!typed) return [];
    const bare = typed.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (!bare || bare === v.fix) return [];
    this.log(`SessionCue[spelling]: "${bare}" → "${v.fix}" (flag ${v.flag.toFixed(2)}, fix ${v.fixConfidence.toFixed(2)})`);
    const alt = typed.replace(bare, v.fix);
    return [{ wordIndex: v.wordIndex, word: typed, alternatives: [alt], source: 'spelling', priority: 10, confidence: v.flag, metadata: { spelling: { flag: v.flag, fix: v.fixConfidence } } }];
  }
}
