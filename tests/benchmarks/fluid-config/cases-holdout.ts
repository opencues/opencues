/**
 * Holdout suite for the fluid-config classifier.
 *
 * CRITICAL: no case here may share phrasing with a few-shot in
 * fused.ts. The in-prompt cases.ts file contains rewords that overlap
 * the FEW-SHOT EXAMPLES inside the system prompt (we added examples
 * specifically to fix v1 failures, which inflates v2's recall against
 * cases.ts). This holdout is the honest "will it generalize?" gate.
 *
 * Coverage goals:
 *
 *  1. Every FEATURE in the registry exercised at least once
 *     (each on-direction case + each off-direction case where both
 *     polarities exist). 20 hit cases total.
 *
 *  2. Every reject bucket exercised with NOVEL phrasings (14 cases).
 *
 *  3. Phrasings drift further from the menu-tip / few-shot wording
 *     than cases.ts does — colloquial, action-oriented, occasionally
 *     elliptical. The point is to surface fragility, not to confirm
 *     wins.
 *
 * If holdout precision/recall match the in-prompt numbers within
 * ~5pp, v2 is generalising. Larger gap = the few-shots are doing
 * heavy lifting and we need broader, more abstract examples.
 *
 * Re-uses the FluidConfigCase type from cases.ts.
 */

import type { FluidConfigCase } from './cases';

export const CASES_HOLDOUT: FluidConfigCase[] = [
  // ── HITS — one or two per FEATURE, novel phrasings ──────────────────

  // debug-mode
  {
    id: 'ho-debug-on',
    category: 'hit-fuzzy',
    input: 'I need to debug this, give me more output _',
    expected: { setting: 'debug-mode', value: 'on' },
  },
  {
    id: 'ho-debug-off',
    category: 'hit-fuzzy',
    input: 'kill the verbose console spam _',
    expected: { setting: 'debug-mode', value: 'off' },
  },

  // tips-mode
  {
    id: 'ho-tips-on',
    category: 'hit-fuzzy',
    input: 'I want to see hover hints on words again _',
    expected: { setting: 'tips-mode', value: 'on' },
  },
  {
    id: 'ho-tips-off',
    category: 'hit-fuzzy',
    input: 'no more popup tip boxes on every highlighted word _',
    expected: { setting: 'tips-mode', value: 'off' },
  },

  // voice-mode
  {
    id: 'ho-voice-on',
    category: 'hit-fuzzy',
    input: 'speak the cue suggestions through my speakers _',
    expected: { setting: 'voice-mode', value: 'active' },
  },
  {
    id: 'ho-voice-off',
    category: 'hit-fuzzy',
    input: 'no TTS, keep things silent _',
    expected: { setting: 'voice-mode', value: 'inactive' },
  },

  // fluid-blank-mode
  {
    id: 'ho-fluid-on',
    category: 'hit-fuzzy',
    input: 'I want underscores to do free-form LLM lookups _',
    expected: { setting: 'fluid-blank-mode', value: 'on' },
  },
  {
    id: 'ho-fluid-off',
    category: 'hit-fuzzy',
    input: 'only fire blanks on explicit keywords, no semantic lookups _',
    expected: { setting: 'fluid-blank-mode', value: 'off' },
  },

  // word-cues-mode
  {
    id: 'ho-wordcues-on',
    category: 'hit-fuzzy',
    input: 'show me synonym suggestions for my prose _',
    expected: { setting: 'word-cues-mode', value: 'on' },
  },
  {
    id: 'ho-wordcues-off',
    category: 'hit-fuzzy',
    input: 'no alternatives on every individual word, too noisy _',
    expected: { setting: 'word-cues-mode', value: 'off' },
  },

  // transform-blank-mode
  {
    id: 'ho-transform-on',
    category: 'hit-fuzzy',
    input: 'switch the imperative rewrite slots back on _',
    expected: { setting: 'transform-blank-mode', value: 'on' },
  },
  {
    id: 'ho-transform-off',
    category: 'hit-fuzzy',
    input: 'disable the agentically-X-underscore pipeline _',
    expected: { setting: 'transform-blank-mode', value: 'off' },
  },

  // blank-trigger-mode
  {
    id: 'ho-trigger-spaced',
    category: 'hit-fuzzy',
    input: 'wait for a space before treating my underscore as a blank _',
    expected: { setting: 'blank-trigger-mode', value: 'spaced' },
  },
  {
    id: 'ho-trigger-immediate',
    category: 'hit-fuzzy',
    input: 'fire blanks the second I press the underscore key _',
    expected: { setting: 'blank-trigger-mode', value: 'immediate' },
  },

  // cursor-navigate
  {
    id: 'ho-cursor-on',
    category: 'hit-fuzzy',
    input: 'follow my cursor and pick up whatever word it lands on _',
    expected: { setting: 'cursor-navigate', value: 'active' },
  },
  {
    id: 'ho-cursor-off',
    category: 'hit-fuzzy',
    input: 'when I move around with arrow keys, leave the highlight alone _',
    expected: { setting: 'cursor-navigate', value: 'inactive' },
  },

  // ambient-context-mode
  {
    id: 'ho-ambient-on',
    category: 'hit-fuzzy',
    input: 'tell the LLM what input field I am currently focused on _',
    expected: { setting: 'ambient-context-mode', value: 'on' },
  },
  {
    id: 'ho-ambient-off',
    category: 'hit-fuzzy',
    input: 'keep page titles and field labels out of the prompt _',
    expected: { setting: 'ambient-context-mode', value: 'off' },
  },

  // user-context-mode
  {
    id: 'ho-user-safe',
    category: 'hit-fuzzy',
    input: 'personalize the answers using my saved profile _',
    expected: { setting: 'user-context-mode', value: 'safe' },
  },
  {
    id: 'ho-user-off',
    category: 'hit-fuzzy',
    input: 'forget my saved profile when answering lookups _',
    expected: { setting: 'user-context-mode', value: 'off' },
  },

  // ── REJECT — USER-BLANK (3) ──────────────────────────────────────────
  {
    id: 'ho-r-volume',
    category: 'reject-user-blank',
    input: 'crank the speakers up _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-brightness',
    category: 'reject-user-blank',
    input: 'dim the display a bit _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-media',
    category: 'reject-user-blank',
    input: 'skip to the next track _',
    expected: { setting: null, value: null },
  },

  // ── REJECT — FLUID (4) ───────────────────────────────────────────────
  {
    id: 'ho-r-boiling',
    category: 'reject-fluid',
    input: 'boiling point of water in celsius _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-animal',
    category: 'reject-fluid',
    input: 'fastest land animal _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-css',
    category: 'reject-fluid',
    input: 'css property for vertical centering in flexbox _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-roman',
    category: 'reject-fluid',
    input: 'roman numeral for 49 _',
    expected: { setting: null, value: null },
  },

  // ── REJECT — AMBIGUOUS (3) ───────────────────────────────────────────
  {
    id: 'ho-r-do-thing',
    category: 'reject-ambiguous',
    input: 'do the thing _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-swap',
    category: 'reject-ambiguous',
    input: 'swap them around _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-reset',
    category: 'reject-ambiguous',
    input: 'just reset _',
    expected: { setting: null, value: null },
  },

  // ── REJECT — OUT-OF-SCOPE (4) ────────────────────────────────────────
  // Each picks a real "the user wants to change a setting" intent that
  // has NO corresponding entry in FEATURES. Routing any of these to a
  // looks-similar feature would be wrong.
  {
    id: 'ho-r-shortcut',
    category: 'reject-out-of-scope',
    input: 'bind ctrl-s to save the buffer _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-upgrade',
    category: 'reject-out-of-scope',
    input: 'upgrade me to the next version _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-locale',
    category: 'reject-out-of-scope',
    input: 'show the menu items in chinese _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-r-loading-glyph',
    category: 'reject-out-of-scope',
    // blank-loading-animation is a MENU_TUNABLE, not a FEATURE.
    input: 'use the spinner instead of the bounce glyph at the blank _',
    expected: { setting: null, value: null },
  },

  // ── REJECT: rewrite imperatives (held out — NO overlap with the
  //    prompt's few-shots, which use "sound more corporate" /
  //    "make it more formal") ────────────────────────────────────────
  {
    id: 'ho-rt-live-bug',
    category: 'reject-transform',
    // The exact July 2026 live utterance.
    input: 'congratz make more professional _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-rt-body-professional',
    category: 'reject-transform',
    input: 'thanks for everything make it more professional _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-rt-polished',
    category: 'reject-transform',
    input: 'great job everyone make this more polished _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-rt-emojis',
    category: 'reject-transform',
    input: 'im so happy for you make more formal and add emojis _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ho-rt-shorten',
    category: 'reject-transform',
    input: 'sounds good shorten this _',
    expected: { setting: null, value: null },
  },
  // Held-out recall guard: novel feature-reference phrasing.
  {
    id: 'ho-sentence-cues-on',
    category: 'hit-fuzzy',
    input: 'suggest better versions of my sentences as i write _',
    expected: { setting: 'sentence-cues-mode', value: 'on' },
  },
];
