/**
 * opencues-core/sources/control-blank-source.ts
 *
 * CueSource that bridges blanks (_) with cue-controls.
 * When context words match a control's blankKeywords, the blank is bound
 * to that control — auto-populated with the current value and cycled via
 * the control's script.
 */

import { CueSource, CueContext, CueSourceResult, CueResult } from '../types';
import { ControlConfig } from '../cues-md';

export interface ControlBlankSourceConfig {
  /** All controls that have blankKeywords defined */
  controls: Record<string, ControlConfig>;
  /** I/O adapter: calls blankScript get to read the current live value.
   * May return synchronously or a Promise — async implementations avoid blocking the event loop. */
  readState: (controlName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;
}

export class ControlBlankSource implements CueSource {
  readonly id = 'control-blank';
  readonly priority = 95;

  private controls: Record<string, ControlConfig>;
  private readState: (controlName: string, matchedKeyword?: string, contextWords?: string[]) => string | null | Promise<string | null>;

  constructor(config: ControlBlankSourceConfig) {
    this.controls = config.controls;
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

    // Find which control matches by scanning context words against blankKeywords
    // Keywords can be multi-word phrases (e.g. "opencues settings") — matched as consecutive words
    const contextLower = context.words.map(w => w.toLowerCase());
    let matched: ControlConfig | undefined;
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

    let bestGap = Infinity;
    for (const [, ctrl] of Object.entries(this.controls)) {
      if (!ctrl.blankKeywords?.length) continue;
      const proximity = ctrl.blankProximity ?? 0;

      for (const kw of ctrl.blankKeywords) {
        const kwParts = kw.split(/\s+/);
        const kwLen = kwParts.length;
        let idx = findPhrase(kw, 0);
        while (idx !== -1) {
          // For multi-word keywords, proximity is measured from the last word of the phrase to the blank
          const endIdx = idx + kwLen - 1;
          const gap = Math.abs(endIdx - blankIndex) - 1;
          if (gap <= proximity && gap < bestGap) {
            matched = ctrl;
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

    // Collect keyword word positions within proximity of the blank (for blankClearKeywords)
    // Multi-word keywords expand to all their constituent word indices
    let matchedKeywordIndices: number[] = [];
    if (matched.blankKeywords) {
      const clearProximity = matched.blankProximity ?? 0;
      for (const kw of matched.blankKeywords) {
        const kwParts = kw.split(/\s+/);
        const kwLen = kwParts.length;
        let idx = findPhrase(kw, 0);
        while (idx !== -1) {
          const endIdx = idx + kwLen - 1;
          if (endIdx !== blankIndex && Math.abs(endIdx - blankIndex) - 1 <= clearProximity) {
            for (let k = 0; k < kwLen; k++) matchedKeywordIndices.push(idx + k);
          }
          idx = findPhrase(kw, idx + 1);
        }
      }
      matchedKeywordIndices = [...new Set(matchedKeywordIndices)].sort((a, b) => b - a);
    }

    // blankConsumeContext: expand keyword indices to include words BETWEEN keyword and blank
    // "I think the word for love in Japanese _ is beautiful" → clears "word for love in Japanese"
    // Surrounding text ("I think the", "is beautiful") is preserved
    if (matched.blankConsumeContext) {
      const kwStart = matchedKeywordIndex;
      const kwEnd = kwStart + (matchedKeyword?.split(/\s+/).length ?? 1);
      const rangeStart = Math.min(kwStart, blankIndex);
      const rangeEnd = Math.max(kwEnd, blankIndex);
      for (let i = rangeStart; i < rangeEnd; i++) {
        if (i !== blankIndex && !matchedKeywordIndices.includes(i)) {
          matchedKeywordIndices.push(i);
        }
      }
      matchedKeywordIndices = [...new Set(matchedKeywordIndices)].sort((a, b) => b - a);
    }

    // blankConsumeAll: expand keyword indices to include ALL non-blank words
    // This causes the entire input to be cleared when the blank auto-populates
    if (matched.blankConsumeAll) {
      for (let i = 0; i < context.words.length; i++) {
        if (i !== blankIndex && !matchedKeywordIndices.includes(i)) {
          matchedKeywordIndices.push(i);
        }
      }
      matchedKeywordIndices = [...new Set(matchedKeywordIndices)].sort((a, b) => b - a);
    }

    // Keyword expansion: if config maps this keyword to a display name, pass it through
    // Computed early so all control paths (list, satellite, dynamic list, generic) can use it
    const expansion = matchedKeyword
      ? matched.blankKeywordExpansions?.[matchedKeyword.toLowerCase()]
      : undefined;
    const keywordExpansion = expansion && matchedKeywordIndex >= 0
      ? { keyword: context.words[matchedKeywordIndex], expansion, wordIndex: matchedKeywordIndex }
      : undefined;

    // List-based cycling: stepValues provides ordered alternatives directly
    if (matched.stepValues?.length) {
      const alts = matched.blankDismissible ? [...matched.stepValues, '_'] : matched.stepValues;
      results.push({
        wordIndex: blankIndex,
        word: '_',
        alternatives: alts,
        source: 'control-blank',
        priority: this.priority,
        cueTip: matched.blankTip ?? matched.tip,
        metadata: {
          controlName: matched.control,
          listControl: true,
          blankClearKeywords: matched.blankClearKeywords || false,
          blankClearOnEdit: matched.blankClearOnEdit || false,
          blankKeywordIndices: matchedKeywordIndices,
          ...(keywordExpansion ? { blankKeywordExpansion: keywordExpansion } : {}),
        },
      });
      return { results };
    }

    // Read current value — validation is format-aware.
    // readState may be sync or async; Promise.resolve normalizes both.
    const rawValue = await Promise.resolve(this.readState(matched.control, matchedKeyword, context.words));
    if (rawValue === null || rawValue === '') {
      return { results };
    }

    // Selector+satellite: script always outputs tab-delimited ("<selector>\t<satellite>").
    // blankSatelliteSeparator controls display only — what appears in the text (default: space).
    if (matched.blankSatellite && rawValue.includes('\t')) {
      const sepIdx = rawValue.indexOf('\t');
      const selectorText = rawValue.slice(0, sepIdx).trim();
      const satelliteText = rawValue.slice(sepIdx + 1).trim();
      const displaySep = matched.blankSatelliteSeparator ?? ' ';
      results.push({
        wordIndex: blankIndex,
        word: '_',
        alternatives: [selectorText],
        source: 'control-blank',
        priority: this.priority,
        cueTip: matched.blankTip ?? matched.tip,
        metadata: {
          controlName: matched.control,
          blankScript: matched.blankScript ?? matched.script,
          selectorControl: true,
          satelliteValue: satelliteText,
          displaySeparator: displaySep,
          blankClearKeywords: matched.blankClearKeywords || false,
          blankClearOnEdit: matched.blankClearOnEdit || false,
          blankKeywordIndices: matchedKeywordIndices,
          ...(keywordExpansion ? { blankKeywordExpansion: keywordExpansion } : {}),
        },
      });
      return { results };
    }

    // Dynamic list: if script returns multiple lines, treat as list control
    if (rawValue.includes('\n')) {
      const lines = rawValue.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length > 0) {
        const alts = matched.blankDismissible ? [...lines, '_'] : lines;
        results.push({
          wordIndex: blankIndex,
          word: '_',
          alternatives: alts,
          source: 'control-blank',
          priority: this.priority,
          cueTip: matched.blankTip ?? matched.tip,
          metadata: {
            controlName: matched.control,
            listControl: true,
            blankClearKeywords: matched.blankClearKeywords || false,
            blankClearOnEdit: matched.blankClearOnEdit || false,
            blankKeywordIndices: matchedKeywordIndices,
            ...(keywordExpansion ? { blankKeywordExpansion: keywordExpansion } : {}),
          },
        });
        return { results };
      }
    }

    const format = matched.blankFormat;

    // Validate based on format — only reject non-numeric values when format is explicitly numeric
    if (format && format !== 'string') {
      const numVal = Number(rawValue);
      if (isNaN(numVal)) {
        return { results };
      }
    }

    // Determine step size: only when explicitly configured
    const step = matched.blankStep
      ?? parseStepFromArgs(matched.upArgs)
      ?? parseStepFromArgs(matched.downArgs);

    const displayValue = matched.blankSuffix ? rawValue + matched.blankSuffix : rawValue;
    const baseAlts = matched.blankAutoPopulate
      ? [displayValue]
      : ['_'];
    const alternatives = matched.blankDismissible ? [...baseAlts, '_'] : baseAlts;

    results.push({
      wordIndex: blankIndex,
      word: '_',
      alternatives,
      source: 'control-blank',
      priority: this.priority,
      cueTip: matched.blankTip ?? matched.tip,
      metadata: {
        controlName: matched.control,
        blankScript: matched.blankScript ?? matched.script,
        ...(step != null ? { blankStep: step } : {}),
        ...(format ? { blankFormat: format } : {}),
        blankReadOnly: matched.blankReadOnly,
        blankSuffix: matched.blankSuffix,
        ...(matched.blankDismissible ? { listControl: true, blankDismissible: true } : {}),
        ...(keywordExpansion ? { blankKeywordExpansion: keywordExpansion } : {}),
        blankClearKeywords: matched.blankClearKeywords || false,
        blankClearOnEdit: matched.blankClearOnEdit || false,
        blankKeywordIndices: matchedKeywordIndices,
      },
    });

    return { results };
  }
}

/** Extract numeric step from args like ["up", "6"] → 6 */
function parseStepFromArgs(args?: string[]): number | undefined {
  if (!args || args.length < 2) return undefined;
  const n = parseInt(args[args.length - 1], 10);
  return isNaN(n) ? undefined : n;
}
