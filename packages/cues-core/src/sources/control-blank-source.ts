/**
 * cues-core/sources/control-blank-source.ts
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
  /** I/O adapter: calls blankScript get to read the current live value */
  readState: (controlName: string, matchedKeyword?: string, contextWords?: string[]) => string | null;
}

export class ControlBlankSource implements CueSource {
  readonly id = 'control-blank';
  readonly priority = 95;

  private controls: Record<string, ControlConfig>;
  private readState: (controlName: string, matchedKeyword?: string, contextWords?: string[]) => string | null;

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
    const contextLower = context.words.map(w => w.toLowerCase());
    let matched: ControlConfig | undefined;
    let matchedKeyword: string | undefined;

    for (const [, ctrl] of Object.entries(this.controls)) {
      if (!ctrl.blankKeywords?.length) continue;
      const proximity = ctrl.blankProximity ?? 0; // default: adjacent (0 words between)

      const hitKw = ctrl.blankKeywords.find(kw => {
        // Check all occurrences — the keyword nearest to _ matters, not the first
        let idx = contextLower.indexOf(kw);
        while (idx !== -1) {
          const gap = Math.abs(idx - blankIndex) - 1;
          if (gap <= proximity) return true;
          idx = contextLower.indexOf(kw, idx + 1);
        }
        return false;
      });

      if (hitKw) {
        matched = ctrl;
        matchedKeyword = hitKw;
        break;
      }
    }

    if (!matched) {
      return { results };
    }

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
        },
      });
      return { results };
    }

    // Read current value — validation is format-aware
    const rawValue = this.readState(matched.control, matchedKeyword, context.words);
    if (rawValue === null || rawValue === '') {
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
          },
        });
        return { results };
      }
    }

    const format = matched.blankFormat ?? 'integer';
    const [minVal] = matched.blankRange ?? [0, 100];

    // Validate based on format
    if (format !== 'string') {
      const numVal = Number(rawValue);
      if (isNaN(numVal) || numVal < minVal) {
        return { results };
      }
    }

    // Determine step size: explicit blankStep, or parse from upArgs/downArgs
    const step = matched.blankStep
      ?? parseStepFromArgs(matched.upArgs)
      ?? parseStepFromArgs(matched.downArgs)
      ?? 1;

    const displayValue = matched.blankSuffix ? rawValue + matched.blankSuffix : rawValue;
    const alternatives = matched.blankAutoPopulate
      ? [displayValue]
      : ['_'];

    results.push({
      wordIndex: blankIndex,
      word: '_',
      alternatives,
      source: 'control-blank',
      priority: this.priority,
      cueTip: matched.blankTip,
      metadata: {
        controlName: matched.control,
        blankScript: matched.blankScript ?? matched.script,
        blankStep: step,
        blankRange: matched.blankRange ?? [0, 100],
        blankFormat: format,
        blankReadOnly: matched.blankReadOnly,
        blankSuffix: matched.blankSuffix,
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
