/**
 * SessionCueSource — the unified "reason over the session watchlist" cue. It
 * composes the two context-aware cues into ONE source so they no longer overlap
 * or evict each other:
 *
 *   1. session-contradiction (⚠) — is the draft going AGAINST a decision?
 *   2. ask-cues (❓)             — is there an open question worth asking?
 *
 * Contradiction is the more urgent signal, so it runs FIRST; if it fires, we
 * short-circuit and DON'T spend the (bigger) ask call — which the priority rail
 * would have evicted anyway. This kills the redundant work the two separate
 * sources did (both firing on a contradiction, the ask result thrown away)
 * while keeping each job on its own proven prompt (no overloaded-prompt risk).
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

export interface SessionCueSourceConfig extends SessionContradictionSourceConfig {
  readonly enableContradiction: boolean;
  readonly enableAsk: boolean;
}

export class SessionCueSource implements CueSource {
  readonly id = 'session-cue';
  readonly priority = 88;   // nominal source-order key; emitted results carry their own priority
  readonly isCycleable = true;

  private readonly contradiction?: SessionContradictionSource;
  private readonly ask?: ToolPromptCueSource;

  constructor(cfg: SessionCueSourceConfig) {
    if (cfg.enableContradiction) this.contradiction = new SessionContradictionSource(cfg);
    if (cfg.enableAsk) this.ask = new ToolPromptCueSource(cfg);
  }

  supports(context: CueContext): boolean {
    return (this.contradiction?.supports(context) ?? false) || (this.ask?.supports(context) ?? false);
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    // Contradiction first (the more urgent signal). If it flags, short-circuit —
    // no ask call, since the ask cue would be evicted by the contradiction anyway.
    if (this.contradiction?.supports(context)) {
      const c = await this.contradiction.getCues(context);
      if (c.results.length > 0) return c;
    }
    // No contradiction → the ask cue is free to surface an open question.
    if (this.ask?.supports(context)) return this.ask.getCues(context);
    return { results: [] };
  }
}
