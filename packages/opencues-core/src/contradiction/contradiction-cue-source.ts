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
        const originalPhrase = context.words.slice(c.startWord, c.endWord).join(' ');
        results.push({
          wordIndex: c.startWord,
          word: context.words[c.startWord],
          // [original, correction]. Down restores; Up applies the fix. The
          // status bar shows the tip passively regardless.
          alternatives: c.correction ? [originalPhrase, c.correction] : [originalPhrase],
          source: `sentence-cue:contradiction-${c.check}`,
          priority: this.priority,
          spanStart: c.startWord,
          spanEnd: c.endWord,
          cueTip: `⚠ ${c.tip}`,
          metadata: { sentenceCue: { cueName: `contradiction-${c.check}` } },
        });
      }
    }
    if (results.length > 0) this.log(`ContradictionCue: ${results.length} flag(s): ${results.map(r => r.cueTip).join(' · ')}`);
    return { results };
  }
}
