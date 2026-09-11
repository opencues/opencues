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

import type { CueContext, CueSource, CueSourceResult } from '../types';
import { SessionContradictionSource, type SessionContradictionSourceConfig } from '../contradiction/session-contradiction-source';
import { ToolPromptCueSource } from './tool-prompt-source';
import { SemanticTipsSource } from './semantic-tips-source';

export interface SessionCueSourceConfig extends SessionContradictionSourceConfig {
  readonly enableContradiction: boolean;
  readonly enableAsk: boolean;
  /** the tips pack matched as a watchlist (`tips-mode: semantic`) — runs
   *  alongside contradiction, before ask; its own call, never folded in. */
  readonly enableSemanticTips?: boolean;
}

export class SessionCueSource implements CueSource {
  readonly id = 'session-cue';
  readonly priority = 88;   // nominal source-order key; emitted results carry their own priority
  readonly isCycleable = true;

  private readonly contradiction?: SessionContradictionSource;
  private readonly ask?: ToolPromptCueSource;
  private readonly tips?: SemanticTipsSource;

  constructor(cfg: SessionCueSourceConfig) {
    if (cfg.enableContradiction) this.contradiction = new SessionContradictionSource(cfg);
    if (cfg.enableAsk) this.ask = new ToolPromptCueSource(cfg);
    if (cfg.enableSemanticTips) this.tips = new SemanticTipsSource(cfg);
  }

  supports(context: CueContext): boolean {
    return (this.contradiction?.supports(context) ?? false) || (this.tips?.supports(context) ?? false) || (this.ask?.supports(context) ?? false);
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    // Contradiction and tips together; contradiction wins if it fires (the
    // more urgent signal), else the tip. A leg that throws is an empty leg —
    // the other still lands.
    const empty: CueSourceResult = { results: [] };
    const [c, t] = await Promise.all([
      this.contradiction?.supports(context) ? this.contradiction.getCues(context).catch(() => empty) : Promise.resolve(empty),
      this.tips?.supports(context) ? this.tips.getCues(context).catch(() => empty) : Promise.resolve(empty),
    ]);
    if (c.results.length > 0) return c;
    if (t.results.length > 0) return t;
    // Neither flagged → the ask cue is free to surface an open question.
    if (this.ask?.supports(context)) return this.ask.getCues(context);
    return empty;
  }
}
