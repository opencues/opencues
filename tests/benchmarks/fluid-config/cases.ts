/**
 * Cases for the fluid-config classifier benchmark.
 *
 * The classifier reads a sentence containing `_` and decides whether
 * the user is asking to change an OPENCUES.md SETTING (entry in the
 * FEATURES registry at packages/opencues-core/src/feature-registry.ts).
 *
 *  - Hits map to `{ setting: <kebab-case scalar>, value: <allowed id> }`.
 *  - Rejects (anything that's NOT a settings change) map to `setting: null`.
 *
 * Scope (v1): FEATURES only — enum scalars with bounded codomains.
 * MENU_TUNABLES (numeric debounce/interval, animation glyph) and user
 * blanks (volume/brightness/weather/stocks/etc.) are deliberately out
 * of scope; the classifier MUST reject them. See feedback memory
 * "Fluid-config classifier is settings-only" for why.
 *
 * Six buckets, each pinning a different part of the trust boundary:
 *
 *  - hit-clean              — phrasing close to the menu tip
 *  - hit-fuzzy              — paraphrased / colloquial / problem-not-solution
 *  - reject-user-blank      — sounds like config but the target is a USER blank
 *  - reject-fluid           — factual lookup; FluidBlankSource territory
 *  - reject-ambiguous       — vague pronoun; no specific setting nameable
 *  - reject-out-of-scope    — sounds like a setting but no such feature exists
 *
 * Two-metric scoring (see run.ts):
 *
 *  - PRECISION (gate) — among rejects, % correctly returned setting=null.
 *    Routing "what's the weather _" into voice-mode is a trust catastrophe.
 *    Target ≥ 98%.
 *  - RECALL — among hits, % where setting AND value match. Missing
 *    "make it loud _" is fine (FluidBlank still answers). Target ≥ 80%.
 */

export interface FluidConfigCase {
  id: string;
  category:
    | 'hit-clean'
    | 'hit-fuzzy'
    | 'reject-user-blank'
    | 'reject-fluid'
    | 'reject-ambiguous'
    | 'reject-out-of-scope'
    | 'reject-transform';
  input: string;
  expected: {
    /** kebab-case scalar from FEATURES, or null when the case is a reject. */
    setting: string | null;
    /** Allowed value id for `setting`, or null when reject. */
    value: string | null;
    /**
     * Acceptable alternate values when the phrasing is genuinely
     * ambiguous between siblings (e.g. "enable user context" could
     * plausibly land on `safe` or — for footgun-aware classifiers
     * we'd never want — `raw`). Pass = value matches EITHER `value`
     * OR any entry here.
     */
    valueAlternates?: string[];
  };
}

export const CASES: FluidConfigCase[] = [
  // ── HIT — CLEAN (phrasing close to the menu tip) ─────────────────────
  {
    id: 'hc-debug-on',
    category: 'hit-clean',
    input: 'enable debug logging _',
    expected: { setting: 'debug-mode', value: 'on' },
  },
  {
    id: 'hc-debug-off',
    category: 'hit-clean',
    input: 'turn off debug logging _',
    expected: { setting: 'debug-mode', value: 'off' },
  },
  {
    id: 'hc-tips-off',
    category: 'hit-clean',
    input: 'turn off tips _',
    expected: { setting: 'tips-mode', value: 'off' },
  },
  {
    id: 'hc-tips-on',
    category: 'hit-clean',
    input: 'show tips again _',
    expected: { setting: 'tips-mode', value: 'on' },
  },
  {
    id: 'hc-voice-on',
    category: 'hit-clean',
    input: 'turn on voice mode _',
    expected: { setting: 'voice-mode', value: 'active' },
  },
  {
    id: 'hc-voice-off',
    category: 'hit-clean',
    input: 'turn off voice mode _',
    expected: { setting: 'voice-mode', value: 'inactive' },
  },
  {
    id: 'hc-fluid-off',
    category: 'hit-clean',
    input: 'disable fluid blank _',
    expected: { setting: 'fluid-blank-mode', value: 'off' },
  },
  {
    id: 'hc-fluid-on',
    category: 'hit-clean',
    input: 'enable fluid blank lookups _',
    expected: { setting: 'fluid-blank-mode', value: 'on' },
  },
  {
    id: 'hc-trigger-spaced',
    category: 'hit-clean',
    input: 'use spaced blank trigger mode _',
    expected: { setting: 'blank-trigger-mode', value: 'spaced' },
  },
  {
    id: 'hc-trigger-immediate',
    category: 'hit-clean',
    input: 'set blank trigger to immediate _',
    expected: { setting: 'blank-trigger-mode', value: 'immediate' },
  },
  {
    id: 'hc-cursor-on',
    category: 'hit-clean',
    input: 'enable cursor navigate _',
    expected: { setting: 'cursor-navigate', value: 'active' },
  },
  {
    id: 'hc-cursor-off',
    category: 'hit-clean',
    input: 'disable cursor navigate _',
    expected: { setting: 'cursor-navigate', value: 'inactive' },
  },
  {
    id: 'hc-wordcues-off',
    category: 'hit-clean',
    input: 'turn off word cues _',
    expected: { setting: 'word-cues-mode', value: 'off' },
  },
  {
    id: 'hc-wordcues-on',
    category: 'hit-clean',
    input: 'turn word cues back on _',
    expected: { setting: 'word-cues-mode', value: 'on' },
  },
  {
    id: 'hc-ambient-on',
    category: 'hit-clean',
    input: 'enable ambient context _',
    expected: { setting: 'ambient-context-mode', value: 'on' },
  },
  {
    id: 'hc-ambient-off',
    category: 'hit-clean',
    input: 'disable ambient context _',
    expected: { setting: 'ambient-context-mode', value: 'off' },
  },
  {
    id: 'hc-user-safe',
    category: 'hit-clean',
    input: 'enable user context in safe mode _',
    expected: { setting: 'user-context-mode', value: 'safe' },
  },
  {
    id: 'hc-user-off',
    category: 'hit-clean',
    input: 'disable user context _',
    expected: { setting: 'user-context-mode', value: 'off' },
  },
  {
    id: 'hc-transform-off',
    category: 'hit-clean',
    input: 'disable transform blank _',
    expected: { setting: 'transform-blank-mode', value: 'off' },
  },
  {
    id: 'hc-transform-on',
    category: 'hit-clean',
    input: 'turn transform blank back on _',
    expected: { setting: 'transform-blank-mode', value: 'on' },
  },

  // ── HIT — FUZZY (paraphrase / problem-not-solution / colloquial) ─────
  {
    id: 'hf-voice-aloud',
    category: 'hit-fuzzy',
    input: 'I want to hear the tips read aloud _',
    expected: { setting: 'voice-mode', value: 'active' },
  },
  {
    id: 'hf-voice-quiet',
    category: 'hit-fuzzy',
    input: 'stop reading the tips out loud _',
    expected: { setting: 'voice-mode', value: 'inactive' },
  },
  {
    id: 'hf-tips-clutter',
    category: 'hit-fuzzy',
    input: 'stop showing me the little tip boxes _',
    expected: { setting: 'tips-mode', value: 'off' },
  },
  {
    id: 'hf-debug-want-logs',
    category: 'hit-fuzzy',
    input: 'I want to see what the runtime is doing _',
    expected: { setting: 'debug-mode', value: 'on' },
  },
  {
    id: 'hf-debug-too-noisy',
    category: 'hit-fuzzy',
    input: 'too much console output, quiet it down _',
    expected: { setting: 'debug-mode', value: 'off' },
  },
  {
    id: 'hf-trigger-markdown',
    category: 'hit-fuzzy',
    input: "I keep typing _italic_ and the blank fires before the closing one _",
    expected: { setting: 'blank-trigger-mode', value: 'spaced' },
  },
  {
    id: 'hf-cursor-follow',
    category: 'hit-fuzzy',
    input: 'highlight should auto-follow my cursor _',
    expected: { setting: 'cursor-navigate', value: 'active' },
  },
  {
    id: 'hf-cursor-still',
    category: 'hit-fuzzy',
    input: "don't move the highlight as I move around _",
    expected: { setting: 'cursor-navigate', value: 'inactive' },
  },
  {
    id: 'hf-user-personal',
    category: 'hit-fuzzy',
    input: 'let it use my personal info when answering _',
    expected: { setting: 'user-context-mode', value: 'safe' },
  },
  {
    id: 'hf-user-no-pii',
    category: 'hit-fuzzy',
    input: 'stop sharing anything personal with the model _',
    expected: { setting: 'user-context-mode', value: 'off' },
  },
  {
    id: 'hf-ambient-page',
    category: 'hit-fuzzy',
    input: 'let the model know which website I am on _',
    expected: { setting: 'ambient-context-mode', value: 'on' },
  },
  {
    id: 'hf-wordcues-noisy',
    category: 'hit-fuzzy',
    input: "I don't want word alternative suggestions on every word _",
    expected: { setting: 'word-cues-mode', value: 'off' },
  },
  {
    id: 'hf-fluid-off-only-keyword',
    category: 'hit-fuzzy',
    input: "I only want blanks to fire on explicit keywords, no free-form lookups _",
    expected: { setting: 'fluid-blank-mode', value: 'off' },
  },

  // ── REJECT — USER-BLANK TERRITORY (volume/brightness/etc.) ───────────
  // The trust boundary: these are user-shipped blanks that exec/fetch.
  // Auto-routing them on semantic-only intent is the threat we're guarding.
  {
    id: 'ru-volume-louder',
    category: 'reject-user-blank',
    input: 'make it louder _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ru-volume-quieter',
    category: 'reject-user-blank',
    input: 'turn the volume down _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ru-brightness-down',
    category: 'reject-user-blank',
    input: 'screen is too bright, lower it _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ru-brightness-up',
    category: 'reject-user-blank',
    input: 'increase brightness _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ru-stocks',
    category: 'reject-user-blank',
    input: "what's TSLA trading at _",
    expected: { setting: null, value: null },
  },
  {
    id: 'ru-weather',
    category: 'reject-user-blank',
    input: 'is it going to rain today _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ru-media',
    category: 'reject-user-blank',
    input: 'play the next song _',
    expected: { setting: null, value: null },
  },

  // ── REJECT — FLUID TERRITORY (factual lookups) ───────────────────────
  {
    id: 'rf-capital',
    category: 'reject-fluid',
    input: 'capital of france _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rf-atomic',
    category: 'reject-fluid',
    input: 'atomic number of oxygen _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rf-hex',
    category: 'reject-fluid',
    input: 'hex code for blue _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rf-apollo',
    category: 'reject-fluid',
    input: 'what year did apollo 11 land _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rf-convert',
    category: 'reject-fluid',
    input: '100 celsius in fahrenheit _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rf-spelling',
    category: 'reject-fluid',
    input: 'how do you spell accommodate _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rf-unicode',
    category: 'reject-fluid',
    input: 'unicode for em dash _',
    expected: { setting: null, value: null },
  },

  // ── REJECT — AMBIGUOUS (vague pronoun, no nameable setting) ──────────
  {
    id: 'ra-turn-off',
    category: 'reject-ambiguous',
    input: 'turn it off _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ra-better',
    category: 'reject-ambiguous',
    input: 'make it better _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ra-enable',
    category: 'reject-ambiguous',
    input: 'enable that thing _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ra-other',
    category: 'reject-ambiguous',
    input: 'switch to the other one _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ra-fix',
    category: 'reject-ambiguous',
    input: 'fix this _',
    expected: { setting: null, value: null },
  },

  // ── REJECT — OUT-OF-SCOPE (sounds like a setting, no such feature) ───
  // Each one is a real "user wants to flip a setting" but OPENCUES has no
  // such setting. Routing these to ANY existing setting would be wrong.
  {
    id: 'ro-theme',
    category: 'reject-out-of-scope',
    input: 'switch the theme to dark mode _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ro-font-size',
    category: 'reject-out-of-scope',
    input: 'use a bigger font size _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ro-language',
    category: 'reject-out-of-scope',
    input: 'switch the interface language to french _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ro-provider',
    category: 'reject-out-of-scope',
    input: 'use a different llm provider _',
    expected: { setting: null, value: null },
  },
  {
    // Written as out-of-scope BEFORE the nav-keymap feature existed;
    // the registry grew `nav-keymap` (ctrl-alt / ctrl-shift), so a
    // shift-flavoured rebind request now has a real setting to route
    // to. Reclassified July 2026 when the bench was re-pointed at the
    // production prompt (the stale bench prompt predated nav-keymap
    // too, which is why this passed as a reject for so long).
    id: 'hf-keybind',
    category: 'hit-fuzzy',
    input: 'rebind the cycle key to shift-arrow _',
    expected: { setting: 'nav-keymap', value: 'ctrl-shift' },
  },
  {
    id: 'ro-debounce',
    category: 'reject-out-of-scope',
    // agent-debounce-ms is a MENU_TUNABLE, NOT in FEATURES → out of v1 scope.
    input: 'wait longer before the agent fires _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ro-animation',
    category: 'reject-out-of-scope',
    // blank-loading-animation is a MENU_TUNABLE, NOT in FEATURES.
    input: 'use the braille loading animation _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ro-export',
    category: 'reject-out-of-scope',
    input: 'export my config to a file _',
    expected: { setting: null, value: null },
  },
  {
    id: 'ro-reset',
    category: 'reject-out-of-scope',
    input: 'reset all my settings to defaults _',
    expected: { setting: null, value: null },
  },

  // ── REJECT: rewrite imperatives — TransformBlank territory ─────────
  //
  // July 2026 live bug: `congratz make more professional _` routed to
  // `sentence-cues-mode on` (and WROTE the scalar) instead of ceding to
  // TransformBlank. "Make my text X" changes the TEXT once; a setting
  // changes BEHAVIOUR from now on. These must all be NONE — the shipped
  // `more-formal` sentence-cue makes formality words the semantic trap.
  {
    id: 'rt-make-more-professional',
    category: 'reject-transform',
    input: 'make more professional _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rt-make-it-professional',
    category: 'reject-transform',
    input: 'make it professional _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rt-body-formal',
    category: 'reject-transform',
    input: 'hey team make more formal _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rt-translate',
    category: 'reject-transform',
    input: 'this draft is ok translate to spanish _',
    expected: { setting: null, value: null },
  },
  {
    id: 'rt-tone',
    category: 'reject-transform',
    input: 'nice work make the tone friendlier _',
    expected: { setting: null, value: null },
  },

  // The recall guard for the delicate boundary: an explicit reference
  // to the FEATURE still routes.
  {
    id: 'hc-sentence-cues-on',
    category: 'hit-clean',
    input: 'enable sentence cues _',
    expected: { setting: 'sentence-cues-mode', value: 'on' },
  },
  {
    id: 'hc-sentence-cues-off',
    category: 'hit-clean',
    input: 'turn off the sentence cues _',
    expected: { setting: 'sentence-cues-mode', value: 'off' },
  },
];
