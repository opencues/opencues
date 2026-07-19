/**
 * ContradictionCueSource — runs the deterministic contradiction checks over the
 * buffer and emits passive cue results (the same `sentence-cue:*` shape the
 * calendar-conflict cue uses, so the resolver registers them passively and the
 * status bar surfaces the tip without the user cycling).
 *
 * Gated behind `contradiction-cues-mode` (off by default — new + experimental).
 * The checks are pure + synchronous (Tier 0 is buffer + clock only), so getCues
 * does no I/O and never blocks the keystroke path. Later tiers inject cached
 * data into the ContradictionEnv; the source shape is unchanged.
 */

import type { CueContext, CueResult, CueSource, CueSourceResult } from '../types';
import { TIER0_CHECKS, type ContradictionCheck, type ContradictionEnv } from './checks';

export interface ContradictionCueSourceOptions {
  /** Which checks to run. Defaults to the Tier-0 (buffer + clock) set. */
  readonly checks?: readonly ContradictionCheck[];
  /** Injectable clock — tests pin it; production passes `() => new Date()`. */
  readonly now?: () => Date;
  /** Optional logger. */
  readonly log?: (msg: string) => void;
}

export class ContradictionCueSource implements CueSource {
  readonly id = 'contradiction-cues';
  // Above word-cues (60–80), below blanks (93–95) and the calendar sentence-cue
  // (90). A contradiction flag is advisory, not a claim on the word for cycling.
  readonly priority = 87;
  // Emits a cycleable correction (alt[1]) — pruned on no-cycling hosts, but its
  // TIP still surfaces on the status bar (same as the calendar-conflict cue).
  readonly isCycleable = true;
  // Validator class — see CueSource.isValidator + ContradictionLlmSource. Lets a
  // deterministic flag supersede an active more-formal rewrite to fact-check it.
  readonly isValidator = true;

  private readonly checks: readonly ContradictionCheck[];
  private readonly nowFn: () => Date;
  private readonly log: (msg: string) => void;

  constructor(opts: ContradictionCueSourceOptions = {}) {
    this.checks = opts.checks ?? TIER0_CHECKS;
    this.nowFn = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
  }

  supports(context: CueContext): boolean {
    return context.words.length > 0;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const env: ContradictionEnv = { now: this.nowFn() };
    const results: CueResult[] = [];
    // Char offset [start, end) of each word in the ACTUAL buffer text — found by
    // scanning (handles arbitrary spacing/punctuation, unlike a naive join).
    const text = context.text ?? context.words.join(' ');
    const charOffsets: Array<[number, number]> = [];
    { let pos = 0; for (const w of context.words) { const idx = text.indexOf(w, pos); if (idx < 0) { charOffsets.push([pos, pos]); continue; } charOffsets.push([idx, idx + w.length]); pos = idx + w.length; } }
    // De-dupe overlapping flags from different checks: first (highest-listed)
    // check wins a word span, so we never stack two tips on one phrase.
    const claimed: Array<[number, number]> = [];
    const overlaps = (a: number, b: number) => claimed.some(([s, e]) => a < e && s < b);

    for (const check of this.checks) {
      let found;
      try { found = check(context.words, env); }
      catch (e) { this.log(`ContradictionCue: check threw — ${(e as Error).message}`); continue; }
      for (const c of found) {
        if (c.startWord < 0 || c.endWord > context.words.length || c.startWord >= c.endWord) continue;
        if (overlaps(c.startWord, c.endWord)) continue;
        claimed.push([c.startWord, c.endWord]);
        // The resolver registers sentence-cue results by CHAR offset and race-
        // guards `alternatives[0] === liveText.slice(spanStart, spanEnd)`, so we
        // must emit char offsets + the EXACT buffer substring (not the joined
        // words, whose spacing may differ). Compute offsets from context.text.
        const so = charOffsets[c.startWord]?.[0];
        const eo = charOffsets[c.endWord - 1]?.[1];
        if (so === undefined || eo === undefined || eo <= so) continue;
        const exact = text.slice(so, eo);
        results.push({
          wordIndex: c.startWord,
          word: context.words[c.startWord],
          // [original, correction]. Up applies the fix; Down restores. When there
          // is no correction the second alt mirrors the first (cycling is a
          // no-op) — the passive cueTip is the value. Two alts are required for
          // the resolver's passive sentence-cue registration path.
          alternatives: [exact, c.correction ?? exact],
          source: `sentence-cue:contradiction-${c.check}`,
          priority: this.priority,
          validator: true,
          spanStart: so,
          spanEnd: eo,
          cueTip: `⚠ ${c.tip}`,
          metadata: { sentenceCue: { cueName: `contradiction-${c.check}` } },
        });
      }
    }
    if (results.length > 0) this.log(`ContradictionCue: ${results.length} flag(s): ${results.map(r => r.cueTip).join(' · ')}`);
    return { results };
  }
}
