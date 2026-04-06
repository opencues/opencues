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
  /** I/O adapter: reads current value from state file (or script fallback) */
  readState: (controlName: string, matchedKeyword?: string) => string | null;
}

export class ControlBlankSource implements CueSource {
  readonly id = 'control-blank';
  readonly priority = 95;

  private controls: Record<string, ControlConfig>;
  private readState: (controlName: string, matchedKeyword?: string) => string | null;

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
        const kwIndex = contextLower.indexOf(kw);
        if (kwIndex === -1) return false;
        const gap = Math.abs(kwIndex - blankIndex) - 1; // words between them
        return gap <= proximity;
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
      results.push({
        wordIndex: blankIndex,
        word: '_',
        alternatives: matched.stepValues,
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
    const rawValue = this.readState(matched.control, matchedKeyword);
    if (rawValue === null || rawValue === '') {
      return { results };
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

    const alternatives = matched.blankAutoPopulate
      ? [rawValue]
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
        stateFile: matched.stateFile,
        blankRange: matched.blankRange ?? [0, 100],
        blankFormat: format,
        blankReadOnly: matched.blankReadOnly,
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
