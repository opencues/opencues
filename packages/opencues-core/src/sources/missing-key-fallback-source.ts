// MissingKeyFallbackSource — converts the "user typed `_` but the
// extension is dead because no API key is set" silent failure into a
// visible, in-buffer message. Returns the `_` plus a substitute
// alternative carrying a one-line user-actionable hint.
//
// Wired by buildSourcesFromConfig ONLY when no LLM-backed blank source
// could be built (every provider's key was empty). Priority 1 (lowest
// among shipped sources) so any real source that DOES manage to wire
// up wins ahead of it; this fallback only fires when nothing else
// matched. Cycling back ('_' is alternatives[0]) restores the bare
// blank, so users can dismiss the message with one Ctrl+Alt+Up.

import type { CueSource, CueContext, CueResult, CueSourceResult } from '../types';

export interface MissingKeyFallbackConfig {
  /**
   * Human-readable hint shown in the buffer. Kept short so it doesn't
   * disrupt the user's typing flow. Hosts can override per-integration
   * (chrome says "open the extension popup"; CC/OC mention `~/.cues/`).
   */
  readonly message: string;
}

export class MissingKeyFallbackSource implements CueSource {
  readonly id = 'missing-key-fallback';
  // Priority 1 — strictly lower than every shipped LLM-backed source
  // (FluidBlankSource = 92, TransformBlank = 93, etc.) so it only
  // claims a `_` no real source could resolve.
  readonly priority = 1;
  readonly isCycleable = false;

  constructor(private readonly config: MissingKeyFallbackConfig) {}

  supports(context: CueContext): boolean {
    // Only claim when an unbound `_` is in the buffer. Other word
    // shapes pass through unhandled — this source never interferes
    // with non-blank text.
    return context.words.includes('_');
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const blankIdx = context.words.indexOf('_');
    if (blankIdx === -1) return { results: [] };
    if (context.consumedBlankSlots?.includes(blankIdx)) return { results: [] };

    const result: CueResult = {
      wordIndex: blankIdx,
      word: '_',
      // Two alternatives: original `_` (so cycling restores the bare
      // blank) + the visible hint message. The runtime substitutes
      // alternatives[1] by default.
      alternatives: ['_', this.config.message],
      source: this.id,
      priority: this.priority,
      cueTip: 'OpenCues is not configured — add an API key to use blanks',
    };
    return { results: [result] };
  }
}
