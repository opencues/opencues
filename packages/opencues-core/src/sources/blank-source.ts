/**
 * opencues-core/sources/blank-source.ts
 *
 * CueSource that bridges blanks (`_`) with blank configs.
 * When context words match a blank's blankKeywords, the blank is bound
 * to that config — auto-populated with the current value and cycled via
 * the blank's script.
 */

import { CueSource, CueContext, CueSourceResult, CueResult } from '../types';
import { BlankConfig } from '../cues-md';
import { keywordInWindow, lineOfWords } from '../keyword-window';

export interface BlankSourceConfig {
  /** All blanks that have blankKeywords defined */
  blanks: Record<string, BlankConfig>;
  /** I/O adapter: calls blankScript get to read the current live value.
   * May return synchronously or a Promise — async implementations avoid blocking the event loop. */
  readState: (blankName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;
}

/**
 * Pure inference: is this individual blank definition cycleable?
 *
 * Cycleable = user picks between values via Ctrl+Alt+arrow. Hosts
 * without a cycling surface (chrome's normal-`<input>` mode) drop
 * cycleable blanks at registration so they don't silently fill the
 * first value and ignore the rest.
 *
 * A blank is cycleable IFF it declares HOW to cycle. Cyclers self-declare:
 *   - blankSatellite: true            → true  (selector/satellite toggle)
 *   - stepValues.length > 1           → true  (list cycling)
 *   - blankStep present               → true  (numeric step cycling)
 *   - everything else                 → false (fetch blanks, plain scripts,
 *                                              impl blanks — read-only by
 *                                              default)
 *
 * Note: a fetch blank whose script returns MULTIPLE lines still rotates its
 * results via the SpanFillState alternatives path (`hn _` → Up/Down through
 * the titles) — that's independent of this inference, which only governs the
 * get/set/step cycle affordance + the no-cycling-host prune.
 */
export function isBlankConfigCycleable(blk: BlankConfig): boolean {
  if (blk.blankSatellite) return true;
  if (blk.stepValues && blk.stepValues.length > 1) return true;
  if (blk.blankStep !== undefined) return true;
  return false;
}

export class BlankSource implements CueSource {
  readonly id = 'blank';
  readonly priority = 95;
  /** BlankSource dispatches to potentially-many BlankConfig entries.
   *  Cycleability is per-config, not per-source — `buildSourcesFromConfig`
   *  prunes cycleable entries from the blanks map BEFORE constructing
   *  BlankSource when the host advertises `supportsCycling: false`. At
   *  this level the source is treated as not-cycleable; the pruning
   *  upstream is what enforces compatibility. */
  readonly isCycleable = false;

  private blanks: Record<string, BlankConfig>;
  private readState: (blankName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;

  constructor(config: BlankSourceConfig) {
    this.blanks = config.blanks;
    this.readState = config.readState;
  }

  supports(context: CueContext): boolean {
    return context.words.some(w => w === '_');
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const results: CueResult[] = [];

    // Find the blank position(s) — bind the first one
    const blankIndex = context.words.indexOf('_');
    if (blankIndex === -1) {
      return { results };
    }

    // Find which blank matches by scanning context words against blankKeywords
    // Keywords can be multi-word phrases (e.g. "opencues settings") — matched as consecutive words
    const contextLower = context.words.map(w => w.toLowerCase());
    let matched: BlankConfig | undefined;
    let matchedKeyword: string | undefined;
    let matchedKeywordIndex = -1;

    const findPhrase = (phrase: string, from: number): number => {
      const parts = phrase.split(/\s+/);
      if (parts.length === 1) {
        return contextLower.indexOf(parts[0], from);
      }
      for (let i = from; i <= contextLower.length - parts.length; i++) {
        let match = true;
        for (let j = 0; j < parts.length; j++) {
          if (contextLower[i + j] !== parts[j]) { match = false; break; }
        }
        if (match) return i;
      }
      return -1;
    };

    // Window: line-scoped — a keyword claims when it's on the same line as
    // the `_`. Shared with the FluidBlank/Transform/ConfigIntent cede checks
    // + BlankFill (see keyword-window.ts). `gap` still drives the
    // closest-match tie-break (bestGap).
    const lineOf = lineOfWords(context.text);
    let bestGap = Infinity;
    for (const [, blk] of Object.entries(this.blanks)) {
      if (!blk.blankKeywords?.length) continue;

      for (const kw of blk.blankKeywords) {
        const kwParts = kw.split(/\s+/);
        const kwLen = kwParts.length;
        let idx = findPhrase(kw, 0);
        while (idx !== -1) {
          // For multi-word keywords, the window is measured from the last word of the phrase to the blank
          const endIdx = idx + kwLen - 1;
          const gap = Math.abs(endIdx - blankIndex) - 1;
          if (keywordInWindow(endIdx, blankIndex, { lineOf }) && gap < bestGap) {
            matched = blk;
            matchedKeyword = kw;
            matchedKeywordIndex = idx;
            bestGap = gap;
          }
          idx = findPhrase(kw, idx + 1);
        }
      }
    }

    if (!matched) {
      return { results };
    }

    // Collect keyword word positions on the same line as the blank (for
    // blankClearKeywords). Multi-word keywords expand to all their
    // constituent word indices.
    let matchedKeywordIndices: number[] = [];
    if (matched.blankKeywords) {
      for (const kw of matched.blankKeywords) {
        const kwParts = kw.split(/\s+/);
        const kwLen = kwParts.length;
        let idx = findPhrase(kw, 0);
        while (idx !== -1) {
          const endIdx = idx + kwLen - 1;
          if (endIdx !== blankIndex && keywordInWindow(endIdx, blankIndex, { lineOf })) {
            for (let k = 0; k < kwLen; k++) matchedKeywordIndices.push(idx + k);
          }
          idx = findPhrase(kw, idx + 1);
        }
      }
      matchedKeywordIndices = [...new Set(matchedKeywordIndices)].sort((a, b) => b - a);
    }

    // List-based cycling: stepValues provides ordered alternatives directly
    if (matched.stepValues?.length) {
      const alts = matched.blankDismissible ? [...matched.stepValues, '_'] : matched.stepValues;
      results.push({
        wordIndex: blankIndex,
        word: '_',
        alternatives: alts,
        source: 'blank',
        priority: this.priority,
        cueTip: matched.tip,
        metadata: {
          blankName: matched.name,
          listBlank: true,
          blankClearKeywords: matched.blankClearKeywords || false,
          blankClearOnEdit: matched.blankClearOnEdit || false,
          blankKeywordIndices: matchedKeywordIndices,
        },
      });
      return { results };
    }

    // Read current value — validation is format-aware.
    // readState may be sync or async; Promise.resolve normalizes both.
    const rawValue = await Promise.resolve(this.readState(matched.name, matchedKeyword, context.words));
    if (rawValue === null || rawValue === '') {
      return { results };
    }

    // Selector+satellite: script always outputs tab-delimited ("<selector>\t<satellite>").
    // blankSatelliteSeparator affects display only — what appears in the text (default: space).
    if (matched.blankSatellite && rawValue.includes('\t')) {
      const sepIdx = rawValue.indexOf('\t');
      const selectorText = rawValue.slice(0, sepIdx).trim();
      const satelliteText = rawValue.slice(sepIdx + 1).trim();
      const displaySep = matched.blankSatelliteSeparator ?? ' ';
      results.push({
        wordIndex: blankIndex,
        word: '_',
        alternatives: [selectorText],
        source: 'blank',
        priority: this.priority,
        cueTip: matched.tip,
        metadata: {
          blankName: matched.name,
          blankScript: matched.blankScript,
          selectorBlank: true,
          satelliteValue: satelliteText,
          displaySeparator: displaySep,
          blankClearKeywords: matched.blankClearKeywords || false,
          blankClearOnEdit: matched.blankClearOnEdit || false,
          blankKeywordIndices: matchedKeywordIndices,
        },
      });
      return { results };
    }

    // Dynamic list: if script returns multiple lines, treat as list-style blank
    if (rawValue.includes('\n')) {
      const lines = rawValue.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length > 0) {
        const alts = matched.blankDismissible ? [...lines, '_'] : lines;
        results.push({
          wordIndex: blankIndex,
          word: '_',
          alternatives: alts,
          source: 'blank',
          priority: this.priority,
          cueTip: matched.tip,
          metadata: {
            blankName: matched.name,
            listBlank: true,
            blankClearKeywords: matched.blankClearKeywords || false,
            blankClearOnEdit: matched.blankClearOnEdit || false,
            blankKeywordIndices: matchedKeywordIndices,
            },
        });
        return { results };
      }
    }

    // Determine step size: only when explicitly configured
    const step = matched.blankStep;

    // Auto-fill is the default — the blank's value lands on `_`.
    const displayValue = matched.blankSuffix ? rawValue + matched.blankSuffix : rawValue;
    const baseAlts = [displayValue];
    const alternatives = matched.blankDismissible ? [...baseAlts, '_'] : baseAlts;

    results.push({
      wordIndex: blankIndex,
      word: '_',
      alternatives,
      source: 'blank',
      priority: this.priority,
      cueTip: matched.tip,
      metadata: {
        blankName: matched.name,
        blankScript: matched.blankScript,
        ...(step != null ? { blankStep: step } : {}),
        blankSuffix: matched.blankSuffix,
        ...(matched.blankDismissible ? { listBlank: true, blankDismissible: true } : {}),
        blankClearKeywords: matched.blankClearKeywords || false,
        blankClearOnEdit: matched.blankClearOnEdit || false,
        blankKeywordIndices: matchedKeywordIndices,
      },
    });

    return { results };
  }
}

