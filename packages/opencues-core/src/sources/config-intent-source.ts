/**
 * opencues-core/sources/config-intent-source.ts
 *
 * Config-intent classifier — when a `_` appears with no keyword match,
 * but the surrounding text semantically asks for a SETTINGS change
 * ("stop showing tips _" → tips-mode=off), this source flips the
 * setting and emits an inline confirmation token at the `_`.
 *
 * Priority 94 — sits BETWEEN BlankSource (95, explicit keyword) and
 * TransformBlankSource (93, imperative rewrite). Runs before
 * TransformBlank so that "change debug mode to on _" routes here as a
 * settings change instead of being mistreated as a generic rewrite. On
 * NONE the source cedes the slot (empty result) and the resolver tries
 * TransformBlank, then FluidBlank.
 *
 * ## Trust boundary
 *
 * The classifier targets ONLY scalars in the FEATURES registry
 * (packages/opencues-core/src/feature-registry.ts) — never user blanks.
 * The codomain is fully bounded (kebab-case scalar from a closed set,
 * enum value from that scalar's `values:` list). User blanks (volume,
 * brightness, weather, stocks, …) can shell out / fetch / exec, so
 * auto-applying them from semantic-only intent (no keyword gate) would
 * widen the prompt-injection blast radius unacceptably. FEATURES
 * scalars can only flip an audited enum — recoverable, visible, no
 * side effects beyond the settings file. See feedback memory
 * "Fluid-config classifier is settings-only".
 *
 * ## Bench provenance
 *
 * Prompt + threshold come from `tests/benchmarks/fluid-config/` —
 * v2.1, 100% precision + 100% in-prompt recall + 90-100% holdout
 * recall across 5 providers. The system prompt below is the version
 * that bench validated. Re-run that bench whenever you edit it.
 *
 * ## Apply path
 *
 * The setting flip happens at emission time — `applyScalar(setting,
 * value)` (injected by the runtime, wraps `ConfigLoader.applyOpenCuesScalar`)
 * writes the file AND updates in-memory state with the existing
 * write-race suppression.
 *
 * The emitted CueResult mirrors the selector-satellite shape that
 * BlankSource produces today when the user types the keyword-bound
 * `opencues settings _`: an `alternatives: [<setting>]` payload with
 * `metadata.selectorBlank: true` and `metadata.satelliteValue: <value>`.
 * The runtime resolver's config-intent branch then wipes the user's
 * summoning words AND `_` from the buffer (via `spanStart=summonPhraseStart(text)`,
 * `spanEnd=text.length` — so any prior user content BEFORE the settings
 * command is preserved, not nuked) and splices in `<setting><sep><value>`
 * at that offset. After that,
 * standard satellite cycling is fully active — the user can cycle the
 * satellite to pick a different value (each cycle calls
 * `applyOpenCuesScalar` via the existing path) or cycle the selector
 * to switch settings. ConfigIntent's role is purely to be a smart
 * shortcut into the existing settings menu — pre-populating the
 * selector + satellite based on the user's natural-language summon.
 */

import { CueSource, CueContext, CueSourceResult, CueResult, HttpAdapter } from '../types';
import { segmentStart } from '../segment';
import { blankClaimsUnderscore } from '../blank-shapes';
import { BlankConfig } from '../cues-md';
import { describeLLMCall, dispatchChat, getProvider, listProviders, type ProviderAdapter } from '../llm-provider';
import { classifyLlmError, type FluidBlankErrorReason } from './fluid-blank-source';
import { getDehydrator, type CompiledDehydrator } from '../dehydrate';
import { postProcessContext } from '../identity-context';
import {
  FEATURES,
  getCyclableValues,
} from '../feature-registry';

/**
 * The three buckets the classifier may route provider/model verdicts
 * to. Mirrors the bucket scalars in OPENCUES.md (`cues-llm-provider`,
 * `auditors-llm-provider`, `blanks-llm-provider`). See
 * docs/architecture/llm-routing.md.
 */
export const BUCKET_SCOPES = ['cues', 'auditors', 'blanks'] as const;
export type BucketScope = typeof BUCKET_SCOPES[number];

// ============================================================================
// System prompt — ported from tests/benchmarks/fluid-config/fused.ts v2.1
// ============================================================================
//
// Built at module-load from FEATURES so adding a scalar to the
// registry automatically extends the classifier's choice space — no
// edit here required. Hidden-from-menu values (exposeInMenu: false,
// today only `identity-context-mode: raw`) are excluded: the classifier
// must never auto-flip a footgun mode on semantic intent alone; that
// stays a deliberate file edit.

function renderFeatureLine(scalar: string, values: { id: string; description: string }[], menuTip: string): string {
  const valueLines = values.map(v => `      - ${v.id}: ${v.description}`).join('\n');
  return `  * ${scalar} (${menuTip})\n${valueLines}`;
}

// Host-scoped features (e.g. chrome's `statusbar-position`) only appear
// in the classifier's choice space on the host that owns them — otherwise
// a CLI host's fluid-config prompt would list a chrome-only setting it
// can't act on. `hostName` undefined = the universal set (host-scoped
// features EXCLUDED), which is what the exported default SYSTEM_PROMPT
// uses; each ConfigIntentSource then swaps in its own host's block.
function buildFeatureBlock(hostName?: string): string {
  return FEATURES
    .filter(f => !f.hostScope || (hostName != null && f.hostScope.includes(hostName)))
    .map(f => renderFeatureLine(f.scalar, [...getCyclableValues(f)], f.menuTip ?? f.description))
    .join('\n');
}

const FEATURE_REGISTRY_BLOCK: string = buildFeatureBlock();

// Build a per-provider listing of canonical model ids (knownModels +
// defaultModel as the first entry) so the classifier knows what model
// names are valid per provider. Providers without knownModels expose
// only their defaultModel — picking a different model for them is a
// power-user file edit, not a NL-reachable action.
function renderProviderLine(p: ProviderAdapter): string {
  const models = p.knownModels && p.knownModels.length > 0
    ? p.knownModels
    : [p.defaultModel];
  return `  * ${p.id} (${p.displayName}) — models: ${models.join(', ')}`;
}

const PROVIDER_REGISTRY_BLOCK: string = listProviders()
  .filter(p => !!p.envKeyName || p.transport === 'cli' || p.optionalAuth)
  .map(renderProviderLine)
  .join('\n');

const BUCKET_LIST: string = BUCKET_SCOPES.join(', ');

// ============================================================================
// Likely-intent gate — pre-filter to skip the LLM round-trip when the
// buffer cannot plausibly carry a settings or provider change.
// ============================================================================
//
// ConfigIntent fires on every `_` keystroke and burns a ~280ms LLM
// classifier call to decide INTENT: SETTING / PROVIDER / NONE. The
// dominant case in production is NONE — prose like `draft an email _`,
// factual lookups like `capital of france _`, transform instructions
// like `make formal _`. The variant cache (June 2026) handles repeat
// triggers at ~0ms; this gate handles the FIRST trigger on any new
// prose buffer by short-circuiting to NONE without an LLM call when
// the buffer has zero plausible settings/provider keywords.
//
// Conservative: false-positive (firing when not needed) is fine
// because the cache absorbs it on T2+. False-negative (skipping a
// real settings command) would silently break the feature, so the
// keyword set is INTENTIONALLY wide — every scalar name, every
// scalar value used by the cycling menu, every provider id, a
// curated list of model/provider alias keys, every bucket scope word,
// and a curated list of action verbs / symptom hints from the SYSTEM_PROMPT.
//
// Language scope: the SETTINGS/PROVIDER intents are inherently
// English-centric (the system prompt and the FEATURES registry are
// English). The pre-filter makes the existing language coverage
// explicit — it doesn't narrow what ConfigIntent recognises, only
// what it dispatches for. Non-English buffers fall through the gate
// and either match the catch-all keywords (provider names are
// language-neutral) or skip the LLM call entirely (which produces
// the same NONE outcome a non-English buffer would have gotten
// anyway). The ACTION intent (undo/redo) is the exception: it is
// language-invariant by design, so the gate carries a curated
// multilingual alias list for it (see undoRedoAliases below) —
// unlisted languages are the residual gap, and extending coverage
// is one alias line, not a prompt change.

const LIKELY_INTENT_KEYWORDS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  const addToken = (s: string): void => {
    const lower = s.toLowerCase().trim();
    if (lower.length === 0) return;
    set.add(lower);
  };

  // FEATURES scalar names (kebab-case) + space-separated variants
  // (users say "voice mode" as often as "voice-mode" in natural prose).
  for (const f of FEATURES) {
    addToken(f.scalar);
    addToken(f.scalar.replace(/-/g, ' '));
    // Per-value tokens. Skip ultra-common values ("on", "off") on their
    // own — they're too noisy as standalone words. Multi-char values
    // ("safe", "raw", "immediate", "spaced", "active", "inactive") are
    // distinctive enough to carry signal.
    for (const v of getCyclableValues(f)) {
      if (v.id.length >= 3 && !['on', 'off', 'auto', 'low', 'high', 'med', 'min', 'max'].includes(v.id.toLowerCase())) {
        addToken(v.id);
      }
    }
  }

  // Provider IDs + their display names ("anthropic" / "Anthropic",
  // "groq" / "Groq", etc.). knownModels caught below via the curated
  // alias-key list.
  for (const p of listProviders()) {
    addToken(p.id);
    if (p.displayName) addToken(p.displayName);
  }

  // Bucket scope words.
  for (const b of BUCKET_SCOPES) addToken(b);

  // Curated keywords pulled from the SYSTEM_PROMPT — these are the
  // action verbs and symptom hints the classifier acts on. Kept
  // explicit (not derived from the prompt) so reviewers can audit the
  // list and add cases when ConfigIntent learns new behaviour.
  const curated = [
    // strong action verbs for settings flips (English)
    'enable', 'disable', 'switch', 'turn', 'route',
    'stop', 'start', 'set', 'use', 'change', 'make',
    'show', 'showing', 'hide', 'flip', 'toggle',
    // scope phrases from the prompt
    'globally', 'everywhere', 'general',
    // symptom hints from SETTING-A guidance (singular + plural variants)
    'hear', 'louder', 'quieter', 'noisy', 'navigate',
    'tip', 'tips', 'popup', 'popups',
    'voice', 'debug', 'cursor', 'thinking',
    'ambient', 'identity', 'sentinel',
    // curated model/provider alias keys — add a new alias here to
    // extend this gate.
    'opus', 'haiku', 'sonnet', 'fable', 'claude',
    'cerebras', 'groq', 'openai', 'anthropic', 'gemini',
    'openrouter', 'nano', 'mini', 'flash', 'llama',
    'gpt-oss', 'gpt-5', 'gemma', 'qwen',
  ];
  for (const k of curated) addToken(k);

  // Undo/redo ACTION aliases — multilingual by necessity. The ACTION
  // intent is language-invariant at the classifier, so this gate must
  // not English-filter it away; a curated alias list is a recall
  // PREFILTER only (the LLM still decides — a false positive costs one
  // classifier call, a miss means undo doesn't fire in that language).
  // Non-ASCII tokens are substring-matched in hasLikelyIntent (`\b` is
  // \w-based and never matches outside [A-Za-z0-9_]); stems are used
  // for inflected forms (元に戻 covers 戻す/戻して; 되돌리 covers
  // 되돌리기/되돌려줘).
  const undoRedoAliases = [
    'undo', 'redo', 'revert',
    'deshacer', 'rehacer',                    // es
    'annuler', 'rétablir',                    // fr
    'rückgängig', 'wiederholen',              // de
    'desfazer', 'refazer',                    // pt
    'annulla', 'ripristina',                  // it
    'ongedaan', 'opnieuw',                    // nl
    'отменить', 'отмени', 'вернуть', 'повторить', // ru
    'скасувати', 'повернути',                 // uk
    '元に戻', '取り消', 'やり直',                 // ja (stems)
    '撤销', '撤消', '复原', '還原', '重做', '恢复',  // zh (simpl + trad)
    '되돌리', '실행 취소', '다시 실행',            // ko
    'เลิกทำ', 'ทำซ้ำ',                          // th
    'تراجع', 'إعادة',                          // ar
    'पूर्ववत', 'फिर से करें',                     // hi
    'geri al', 'yinele',                      // tr
    'cofnij', 'cofnąć', 'ponów',              // pl
    'ångra', 'gör om',                        // sv
    'hoàn tác', 'làm lại',                    // vi
    'urungkan', 'ulangi',                     // id
    'בטל', 'בצע שוב',                          // he
    'αναίρεση', 'επανάληψη',                  // el
  ];
  for (const k of undoRedoAliases) addToken(k);

  return set;
})();

/** Cheap pre-filter: does the buffer contain any token plausibly
 *  carrying settings/provider intent?
 *
 *  Implementation: lowercase the buffer once, then check each keyword.
 *  Multi-word keywords (e.g. "voice mode") use substring match;
 *  single-word keywords use word-boundary regex so "blank" doesn't
 *  match "blanket". O(K) string scans where K = keyword count.
 *  Measured at < 0.5ms on a 32-char buffer with the full keyword set.
 */
export function hasLikelyIntent(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of LIKELY_INTENT_KEYWORDS) {
    if (kw.includes(' ') || kw.includes('-') || !/^[\x00-\x7F]+$/.test(kw)) {
      // Multi-word, hyphenated, or non-ASCII keyword — substring match.
      // Non-ASCII MUST take this branch: JS `\b` is `\w`-based
      // ([A-Za-z0-9_] only), so a boundary regex around a CJK/Cyrillic/
      // Thai token can never match and would silently gate the token
      // out (元に戻す in a Japanese buffer would never pass).
      if (lower.includes(kw)) return true;
    } else {
      // Single ASCII word — require word boundary so "blank" doesn't
      // match "blanket" and "cues" doesn't match "cuesman".
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(lower)) return true;
    }
  }
  return false;
}

/**
 * Deterministic undo/redo command matcher — the Ctrl+Z path.
 *
 * undo/redo has exactly one meaning; routing it through the LLM
 * classifier only introduces latency and a way to cede (a leading
 * factual-lookup query like `capital of france _ redo _` biased the
 * classifier to NONE, dropping the redo). This is a pure string match
 * on the token(s) immediately before the trigger `_`: a bare undo/redo
 * alias, optionally followed by an integer count. No model call, no
 * way to misfire into a task (a `redo <object>` request has a non-alias
 * trailing token and never matches here — it falls through to the LLM).
 *
 * Scope is deliberately the unambiguous space-delimited Latin-script
 * aliases + integer counts. CJK stems (元に戻して), number-words
 * ("undo twice"), and verbose phrasings ("undo the last two changes",
 * "take that back") don't string-match cleanly and remain the LLM
 * classifier's job — see `undoRedoAliases` (the recall prefilter) and
 * INTENT C in SYSTEM_PROMPT.
 */
const DETERMINISTIC_ACTION_ALIASES: Record<string, 'undo' | 'redo'> = {
  undo: 'undo', revert: 'undo',
  redo: 'redo',
  deshacer: 'undo', rehacer: 'redo',           // es
  annuler: 'undo', rétablir: 'redo',           // fr
  rückgängig: 'undo', wiederholen: 'redo',     // de
  desfazer: 'undo', refazer: 'redo',           // pt
  annulla: 'undo', ripristina: 'redo',         // it
  opnieuw: 'redo',                             // nl (undo = "ongedaan maken", multi-word → LLM)
  cofnij: 'undo', ponów: 'redo',               // pl
  yinele: 'redo',                              // tr ("geri al" undo is multi-word → LLM)
  urungkan: 'undo', ulangi: 'redo',            // id
};

export interface DeterministicActionMatch {
  action: 'undo' | 'redo';
  /** Repeat count; 1 when no explicit integer count was given. */
  count: number;
  /** Offset in the ORIGINAL buffer where the command token begins. */
  commandStart: number;
}

/**
 * Match a bare undo/redo command as the trailing token(s) of `before`
 * (the buffer text up to — not including — the trigger `_`). Returns
 * null for anything that isn't an unambiguous deterministic command.
 */
export function matchDeterministicAction(before: string): DeterministicActionMatch | null {
  // Anchored at end: an alias word, then an OPTIONAL integer count.
  // `\p{L}+` stops at the earlier `_` (underscore is not a letter), so a
  // preceding `capital of france _ ` query never bleeds into the match.
  const m = /(?:^|\s)(\p{L}+)(?:[ \t]+(\d+))?[ \t]*$/u.exec(before);
  if (!m) return null;
  const action = DETERMINISTIC_ACTION_ALIASES[m[1].toLowerCase()];
  if (!action) return null;
  const count = m[2] ? parseInt(m[2], 10) : 1;
  if (count < 1) return null;
  // Skip any leading whitespace the `(?:^|\s)` group consumed so the span
  // starts exactly at the alias — wiping the command leaves prior content.
  const leadingWs = m[0].length - m[0].replace(/^\s+/, '').length;
  return { action, count, commandStart: m.index + leadingWs };
}

export const SYSTEM_PROMPT = `You are a CONFIGURATION INTENT CLASSIFIER for the OpenCues runtime.

You read a sentence containing _ and decide which of four intents the user has:

  (A) SETTING change — flip one named OpenCues setting to a specific value.
  (B) PROVIDER routing — switch which LLM provider (and optionally model) runs on one of three buckets (${BUCKET_LIST}).
  (C) ACTION — undo or redo changes the OpenCues runtime itself just made.
  (D) NONE — the request is a factual lookup, a non-config action, or too ambiguous.

═════════════════════════════════════════════════════════════════
INTENT A — SETTING
═════════════════════════════════════════════════════════════════

Settings you may route to (and ONLY these — nothing else exists):

${FEATURE_REGISTRY_BLOCK}

ROUTE TO A SETTING when:
  - The user names a setting either directly ("debug mode", "tips", "voice mode", "cursor navigate") or describes the SYMPTOM/BEHAVIOR clearly enough to identify exactly ONE setting from the list above.
  - The direction is clear from polarity words ("enable", "turn on", "stop", "disable", "quiet down", "noisy") OR from sentence shape ("I want to hear …" → on-flavoured value).

NEVER drop the -mode suffix ('voice-mode' NOT 'voice'; 'debug-mode' NOT 'debug'; etc.). The only setting without '-mode' is 'cursor-navigate'.

NEVER route a provider-or-model change here — those are INTENT B. Example: "use anthropic for cues _" is INTENT B (PROVIDER), not a SETTING change.

═════════════════════════════════════════════════════════════════
INTENT B — PROVIDER routing
═════════════════════════════════════════════════════════════════

Three buckets carry the LLM routing for different surfaces:
  - cues      → word-cues + sentence-cues (prose-bearing)
  - auditors  → auditors + agent-rewrite  (prose-bearing background)
  - blanks    → fluid-blank + transform-blank + fluid-config + keyword blanks (opt-in _ surface)

Providers you may route to (and ONLY these):

${PROVIDER_REGISTRY_BLOCK}

ROUTE TO PROVIDER when:
  - The user names a provider ("anthropic", "groq", "cerebras", "openai", "gemini", "claude") OR a model name from the lists above.
  - AND names a scope ("for cues", "for blanks", "for auditors", "globally"/"everywhere") OR is generic ("switch to X" → MODEL: empty, SCOPE: blanks as the default — blanks is the user-opt-in \`_\` surface that a bare provider switch most likely targets).

SCOPE rules:
  - "for cues" / "word cues" / "sentence cues" / "general" / "everywhere" / "globally" → cues
  - "for blanks" / "blank" / "lookup" / "_ stuff" / "fluid-blank" / "transform-blank" → blanks
  - "for auditors" / "auditor" / "agent" / "rewrites" / "grammar" / "background" → auditors

MODEL rules:
  - When the user names a specific model from the listed catalog → emit MODEL.
  - When the user only says a provider ("use anthropic for cues _") → MODEL empty; the runtime picks that provider's default model.
  - NEVER emit a model that isn't listed under that provider above. If the user names an unrecognised model, emit MODEL empty (the provider switch still applies; user can edit OPENCUES.md for the exact model).

═════════════════════════════════════════════════════════════════
INTENT C — ACTION
═════════════════════════════════════════════════════════════════

Native runtime actions. Exactly two exist:

  - undo : revert the last change(s) the OpenCues runtime itself made — a blank fill, a rewrite, a settings change, a volume/brightness set.
  - redo : re-apply change(s) that were just undone.

ROUTE TO ACTION when:
  - The user asks to undo / revert / take back "that" / "the last change" — in ANY language (undo, deshacer, annuler, rückgängig, desfazer, 元に戻して, 撤销, 실행 취소, отменить, เลิกทำ, تراجع, ...). The bare verb alone ("undo _") is a complete command.
  - An optional count says how many changes to revert ("undo 3 _", "undo the last two _", "3回元に戻して _") → COUNT: <n>. Number words in any language count ("trois", "两次", "twice"). No count given → COUNT: 1.
  - The text BEFORE the verb is often the visible CONFIRMATION of the very change being undone — a settings pair, a filled answer ("debug-mode on undo _", "voice-mode inactive undo _", "Paris undo _"). The trailing undo/redo verb IS the command; do NOT re-read that earlier text as a SETTING command.

DO NOT route to ACTION when:
  - The undo/revert targets something OUTSIDE this text buffer and the OpenCues runtime ("undo my last commit _", "revert the deploy _", "undo the migration _") — that is a task request → NONE.
  - "redo X" names an object and means "do X over / rewrite X" ("redo the report _", "redo my homework _") — that is a task → NONE. Bare "redo" with no object is the ACTION.

═════════════════════════════════════════════════════════════════
INTENT D — NONE
═════════════════════════════════════════════════════════════════

ROUTE TO NONE when:
  - Factual lookup ("capital of france _", "unicode for ampersand _").
  - User-level blank ("make it louder" → volume blank; "what's TSLA at" → stocks blank).
  - Pronoun ambiguous ("turn it off", "switch to the other one", "fix this").
  - Greeting / how-something-works / task request.
  - Setting change for something NOT in INTENT A's list ("change the theme", "use a bigger font") — even if it sounds setting-shaped.
  - REWRITE IMPERATIVE — an instruction to rewrite or restyle the user's own TEXT: "make (it/this/more) professional/formal/polished", "make the tone X", "shorten this", "translate to X", "add emojis", "fix the wording". These are one-off transform requests handled by a different pipeline. They are NEVER a settings change — in particular they are NOT sentence-cues-mode, even though that feature also concerns rewriting. The tell: a rewrite imperative asks to change THE TEXT ONCE; a setting asks to change how OpenCues BEHAVES from now on. Ongoing/habitual phrasings ("as I write", "while I type", "always", "from now on") applied to sentence improvement ARE feature requests → sentence-cues-mode; so is an explicit reference to the feature itself ("sentence cues", "sentence suggestions"). A bare one-off imperative with no ongoing marker is the rewrite case → NONE.

═════════════════════════════════════════════════════════════════
OUTPUT FORMAT
═════════════════════════════════════════════════════════════════

ALWAYS emit ALL lines for the chosen intent. Use empty values for irrelevant lines but always emit them.

When INTENT is SETTING:
INTENT: SETTING
SETTING: <kebab-case scalar from INTENT A list>
VALUE: <one of the listed values for that scalar>
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: <0.0..1.0>

When INTENT is PROVIDER:
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: <one of: ${BUCKET_LIST}>
PROVIDER: <provider id from INTENT B list>
MODEL: <model id from that provider's list, OR empty>
CONFIDENCE: <0.0..1.0>

When INTENT is ACTION:
INTENT: ACTION
ACTION: <undo | redo>
COUNT: <positive integer; 1 when the user gave no count>
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: <0.0..1.0>

When INTENT is NONE:
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: <0.0..1.0>

CONFIDENCE:
  - 0.9-1.0 when the user clearly names BOTH the slot AND its value.
  - 0.7-0.9 when the symptom maps cleanly to one slot.
  - 0.5-0.7 when there's a plausible read but you're inferring.
  - Below 0.5 → emit INTENT: NONE; uncertainty IS the signal to reject.

DO NOT invent a setting / provider / model that isn't listed above.
DO NOT pick a value not listed for its slot.
DO NOT route to the nearest-looking option when the real intent is something else — emit NONE.

═════════════════════════════════════════════════════════════════
EXAMPLES
═════════════════════════════════════════════════════════════════

INPUT: enable debug logging _
INTENT: SETTING
SETTING: debug-mode
VALUE: on
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.97

INPUT: stop reading the tips out loud _
INTENT: SETTING
SETTING: voice-mode
VALUE: inactive
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.92

INPUT: I keep typing _italic_ and the blank fires before the closing one _
INTENT: SETTING
SETTING: blank-trigger-mode
VALUE: spaced
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.85

INPUT: use anthropic for cues _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: cues
PROVIDER: anthropic
MODEL:
CONFIDENCE: 0.92

INPUT: switch the blanks brain to cerebras _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: blanks
PROVIDER: cerebras
MODEL:
CONFIDENCE: 0.93

INPUT: use claude opus for auditors _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: auditors
PROVIDER: anthropic
MODEL: claude-opus-4-7
CONFIDENCE: 0.9

INPUT: use gpt-5.4 for the agent _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: auditors
PROVIDER: openai
MODEL: gpt-5.4
CONFIDENCE: 0.88

INPUT: route everything to gemini _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: blanks
PROVIDER: gemini
MODEL:
CONFIDENCE: 0.8

INPUT: switch model to qwen _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: blanks
PROVIDER: cerebras
MODEL: qwen-3.8-27b
CONFIDENCE: 0.85

INPUT: use gemma for blanks _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: blanks
PROVIDER: cerebras
MODEL: gemma-4-31b
CONFIDENCE: 0.85

INPUT: switch to anthropic _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: blanks
PROVIDER: anthropic
MODEL:
CONFIDENCE: 0.85

INPUT: use cerebras _
INTENT: PROVIDER
SETTING:
VALUE:
SCOPE: blanks
PROVIDER: cerebras
MODEL:
CONFIDENCE: 0.85

INPUT: switch cues to a model that does not exist _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.4

INPUT: capital of france _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.99

INPUT: make it louder _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.95

INPUT: turn it off _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.9

INPUT: let it use my personal info when answering _
INTENT: SETTING
SETTING: identity-context-mode
VALUE: safe
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.88

INPUT: let the model know which website I am on _
INTENT: SETTING
SETTING: ambient-context-mode
VALUE: on
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.88

INPUT: undo _
INTENT: ACTION
ACTION: undo
COUNT: 1
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.97

INPUT: undo 3 _
INTENT: ACTION
ACTION: undo
COUNT: 3
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.96

INPUT: undo the last two changes _
INTENT: ACTION
ACTION: undo
COUNT: 2
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.94

INPUT: 元に戻して _
INTENT: ACTION
ACTION: undo
COUNT: 1
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.95

INPUT: deshacer _
INTENT: ACTION
ACTION: undo
COUNT: 1
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.95

INPUT: redo _
INTENT: ACTION
ACTION: redo
COUNT: 1
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.96

INPUT: debug-mode on undo _
INTENT: ACTION
ACTION: undo
COUNT: 1
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.94

INPUT: undo my last commit _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.9

INPUT: redo the report _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.9

═════════════════════════════════════════════════════════════════
NEGATIVE EXAMPLES — questions about the user's own identity are
LOOKUPS (fluid-blank's job), NOT requests to change identity-context-mode.
The word "identity" in the scalar name refers to whether the FEATURE
is enabled, not to anything the user is asking ABOUT themselves.
═════════════════════════════════════════════════════════════════

INPUT: my mother's maiden name _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.98

INPUT: my email _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.98

INPUT: my name _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.98

INPUT: i work at _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.97

INPUT: who am I _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.95

INPUT: what's my github _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.96

═════════════════════════════════════════════════════════════════
NEGATIVE EXAMPLES — rewrite imperatives are TRANSFORM requests
(another pipeline's job), NOT sentence-cues-mode. "Make my text X"
changes the TEXT once; a setting changes BEHAVIOUR from now on.
═════════════════════════════════════════════════════════════════

INPUT: hey squad make this sound more corporate _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.95

INPUT: thanks so much make it more formal _
INTENT: NONE
SETTING:
VALUE:
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.95

INPUT: turn on sentence rewrite suggestions _
INTENT: SETTING
SETTING: sentence-cues-mode
VALUE: on
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.92

INPUT: give me better phrasings for whole sentences while i write _
INTENT: SETTING
SETTING: sentence-cues-mode
VALUE: on
SCOPE:
PROVIDER:
MODEL:
CONFIDENCE: 0.85`;

// ============================================================================
// SUMMON extraction — a SEPARATE, single-purpose LLM call
// ============================================================================
//
// Why a second call instead of one more line on the classifier above:
// adding a SUMMON field to the (English, heavily-tuned) classifier prompt
// regressed its INTENT recall ~85% → ~60% on the fluid-config bench and the
// model emitted the field on only ~10% of cases — a tuned single-purpose
// classifier can't reliably carry a second job. A dedicated extraction
// prompt does it cleanly: a standalone probe scored 10/10 verbatim-suffix +
// boundary-correct across English / Japanese / Korean / Thai / French /
// Chinese prior content — including Thai, which has NO sentence punctuation
// or spaces and which NO regex floor can segment. This is the
// language-invariant ("feature-agnostic") path the regex `summonPhraseStart`
// only approximates for Latin/CJK scripts.
//
// It runs ONLY after the classifier has confirmed a SETTING/PROVIDER verdict
// (NONE cedes earlier), so the extra call fires only on genuine config
// commands — rare, and a one-shot settings apply isn't latency-sensitive
// the way interactive typing is. `_summonCache` memoises per-buffer so a
// double-fire / repeat trigger doesn't pay for it twice. On any failure
// (network, non-suffix output) it falls back to the regex floor — the model
// proposes the boundary, the runtime validates it, the regex is the safety
// net. The classifier's SYSTEM_PROMPT is UNTOUCHED, so classification
// accuracy is unaffected by definition.

export const SUMMON_PROMPT = `You extract the COMMAND SPAN from a buffer that ends in a settings/config command followed by _.

The buffer may begin with the user's own writing (notes, a sentence — possibly in another language). That prior text is NOT part of the command. Your job: return the EXACT, VERBATIM trailing substring that is the command itself, including the trailing _.

Rules:
- SUMMON must be a VERBATIM suffix of the input — copy it character-for-character; do NOT paraphrase, translate, or normalise spacing.
- It starts at the first word of the trailing command and runs to the end (incl. _).
- If the ENTIRE input is the command (no prior writing), SUMMON is the whole input.
- Output exactly one line, nothing else: SUMMON: <substring>

EXAMPLES:
INPUT: voice mode off _
SUMMON: voice mode off _

INPUT: hii world. voice mode off _
SUMMON: voice mode off _

INPUT: こんにちは世界。voice mode off _
SUMMON: voice mode off _

INPUT: meeting notes from today, lots to do. switch cues to anthropic _
SUMMON: switch cues to anthropic _

INPUT: 日本語のメモです。tips off _
SUMMON: tips off _`;

/** Parse the SUMMON line from a dedicated-extraction response. */
export function parseSummonOutput(raw: string): string | null {
  const m = raw.match(/^SUMMON:[ \t]*(.*?)[ \t]*$/im);
  const s = m ? m[1].trim() : '';
  return s ? s : null;
}

/**
 * Resolve where the settings/provider command starts in the buffer — the
 * wipe span's left edge. The dedicated SUMMON call returns the exact
 * trailing command substring (incl. `_`); when it's a verbatim suffix of
 * the live buffer we trust it, because the model identifies the command
 * boundary language-invariantly (English / CJK / Thai prior content all
 * work). `summonPhraseStart` is the deterministic floor when SUMMON is
 * absent (call failed / disabled) or not a clean suffix.
 *
 * Data-loss guard: if the model's summon spans the WHOLE buffer
 * (`modelStart === 0`) but the regex found a real earlier boundary, the
 * model over-included prior content — trust the boundary instead so we
 * never nuke text the user typed before the command. Mirrors the
 * "model proposes, runtime validates a safety invariant" split FluidBlank's
 * FILL/WIPE floor uses.
 */
export function resolveSummonStart(text: string, summon: string | null): number {
  const regexStart = summonPhraseStart(text);
  const s = summon?.trim();
  if (s && text.endsWith(s)) {
    const modelStart = text.length - s.length;
    if (modelStart === 0 && regexStart > 0) return regexStart;
    return modelStart;
  }
  return regexStart;
}

// ============================================================================
// Parsed verdict — discriminated union
// ============================================================================

export interface SettingVerdict {
  readonly kind: 'setting';
  readonly setting: string;
  readonly value: string;
  readonly confidence: number | null;
}

export interface ProviderVerdict {
  readonly kind: 'provider';
  readonly scope: BucketScope;
  readonly provider: string;
  readonly model: string | null;
  readonly confidence: number | null;
}

export type ConfigIntentAction = 'undo' | 'redo';

export interface ActionVerdict {
  readonly kind: 'action';
  readonly action: ConfigIntentAction;
  /** How many journal transactions to revert/re-apply. Parse floors
   *  this at 1; clamping to the journal's actual depth is the
   *  runtime's job (the classifier can't know the depth). */
  readonly count: number;
  readonly confidence: number | null;
}

export interface NoneVerdict {
  readonly kind: 'none';
  readonly confidence: number | null;
}

export type ConfigIntentVerdict = SettingVerdict | ProviderVerdict | ActionVerdict | NoneVerdict;

/**
 * Parse the classifier's raw text output. Tolerant of:
 *   - Missing `INTENT:` line (legacy v2.1 prompts that pre-date the
 *     three-kind split) — falls back to inferring kind from which
 *     slot the LLM populated.
 *   - Extra whitespace, surrounding prose, leading commentary.
 *   - Empty lines for the slot that doesn't apply.
 *
 * Always returns SOMETHING — uncertain inputs collapse to NoneVerdict
 * rather than throwing, so the caller can cede gracefully.
 */
export function parseConfigIntentOutput(raw: string): ConfigIntentVerdict {
  const intentMatch = raw.match(/^INTENT:[ \t]*(.*?)[ \t]*$/im);
  const settingMatch = raw.match(/^SETTING:[ \t]*(.*?)[ \t]*$/im);
  const valueMatch = raw.match(/^VALUE:[ \t]*(.*?)[ \t]*$/im);
  const scopeMatch = raw.match(/^SCOPE:[ \t]*(.*?)[ \t]*$/im);
  const providerMatch = raw.match(/^PROVIDER:[ \t]*(.*?)[ \t]*$/im);
  const modelMatch = raw.match(/^MODEL:[ \t]*(.*?)[ \t]*$/im);
  const actionMatch = raw.match(/^ACTION:[ \t]*(.*?)[ \t]*$/im);
  const countMatch = raw.match(/^COUNT:[ \t]*([0-9]+)/im);
  const confidenceMatch = raw.match(/^CONFIDENCE:[ \t]*([0-9.]+)/im);

  const intentRaw = intentMatch ? intentMatch[1].trim().toUpperCase() : '';
  const settingRaw = settingMatch ? settingMatch[1].trim() : '';
  const valueRaw = valueMatch ? valueMatch[1].trim() : '';
  const scopeRaw = scopeMatch ? scopeMatch[1].trim().toLowerCase() : '';
  const providerRaw = providerMatch ? providerMatch[1].trim().toLowerCase() : '';
  const modelRaw = modelMatch ? modelMatch[1].trim() : '';
  const actionRaw = actionMatch ? actionMatch[1].trim().toLowerCase() : '';
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) : null;

  // Infer kind. Explicit INTENT line wins; otherwise fall back to
  // slot-populated heuristic for back-compat with the legacy v2.1
  // prompt shape (SETTING line was the only discriminator).
  let kind: ConfigIntentVerdict['kind'];
  if (intentRaw === 'SETTING') kind = 'setting';
  else if (intentRaw === 'PROVIDER') kind = 'provider';
  else if (intentRaw === 'ACTION') kind = 'action';
  else if (intentRaw === 'NONE') kind = 'none';
  else if (actionRaw && actionRaw.toUpperCase() !== 'NONE') kind = 'action';
  else if (providerRaw && scopeRaw) kind = 'provider';
  else if (settingRaw && settingRaw.toUpperCase() !== 'NONE') kind = 'setting';
  else kind = 'none';

  if (kind === 'action') {
    if (actionRaw !== 'undo' && actionRaw !== 'redo') {
      return { kind: 'none', confidence };
    }
    const parsedCount = countMatch ? Number(countMatch[1]) : NaN;
    const count = Number.isInteger(parsedCount) && parsedCount >= 1 ? parsedCount : 1;
    return { kind: 'action', action: actionRaw, count, confidence };
  }
  if (kind === 'setting') {
    if (!settingRaw || settingRaw.toUpperCase() === 'NONE' || !valueRaw) {
      return { kind: 'none', confidence };
    }
    return { kind: 'setting', setting: settingRaw, value: valueRaw, confidence };
  }
  if (kind === 'provider') {
    if (!providerRaw || providerRaw.toUpperCase() === 'NONE') {
      return { kind: 'none', confidence };
    }
    // Normalise scope; default to 'blanks' when the classifier omitted
    // it ("switch to anthropic _" with no explicit scope routes to the
    // user-opt-in `_` surface — that's the most likely target for a
    // bare provider switch). Validator will reject unknown scope literals.
    const scope: BucketScope = (BUCKET_SCOPES as readonly string[]).includes(scopeRaw)
      ? (scopeRaw as BucketScope)
      : 'blanks';
    return {
      kind: 'provider',
      scope,
      provider: providerRaw,
      model: modelRaw || null,
      confidence,
    };
  }
  return { kind: 'none', confidence };
}

/**
 * Validate a parsed verdict against the FEATURES + PROVIDERS
 * registries. Rejects anything the model hallucinated:
 *   - setting kind: unknown setting, unlisted value, hidden value
 *     (e.g. identity-context-mode=raw)
 *   - provider kind: unknown scope, unknown provider, model not in
 *     that provider's knownModels (when knownModels is declared)
 *
 * The classifier prompt instructs the model to stay inside both
 * registries, but defence in depth — runtime never applies a verdict
 * that doesn't pass this check, even if every call passes today's
 * bench. New providers may not follow instructions perfectly.
 *
 * NoneVerdict always validates (caller cedes).
 */
export function validateAgainstRegistry(verdict: ConfigIntentVerdict, hostName?: string): { ok: boolean; reason?: string } {
  if (verdict.kind === 'none') return { ok: true };

  if (verdict.kind === 'action') {
    // Bounded native-action codomain: exactly two verbs, positive
    // integer count. Depth clamping is the runtime's job.
    if (verdict.action !== 'undo' && verdict.action !== 'redo') {
      return { ok: false, reason: `unknown action '${String(verdict.action)}' (allowed: undo, redo)` };
    }
    if (!Number.isInteger(verdict.count) || verdict.count < 1) {
      return { ok: false, reason: `count '${String(verdict.count)}' is not a positive integer` };
    }
    return { ok: true };
  }

  if (verdict.kind === 'setting') {
    const feature = FEATURES.find(f => f.scalar === verdict.setting);
    if (!feature) return { ok: false, reason: `unknown setting '${verdict.setting}'` };
    // Host-scope guard (defense in depth): a host-scoped setting must not
    // be applied on a host outside its scope — the classifier prompt
    // already omits it there, but reject it if the LLM emits it anyway.
    if (feature.hostScope && (hostName == null || !feature.hostScope.includes(hostName))) {
      return { ok: false, reason: `setting '${verdict.setting}' is scoped to [${feature.hostScope.join(', ')}], not host '${hostName ?? '?'}'` };
    }
    const allowed = [...getCyclableValues(feature)].map(v => v.id);
    if (!allowed.includes(verdict.value)) {
      return { ok: false, reason: `value '${verdict.value}' is not cyclable for '${verdict.setting}' (allowed: ${allowed.join(', ')})` };
    }
    return { ok: true };
  }

  // provider kind
  if (!(BUCKET_SCOPES as readonly string[]).includes(verdict.scope)) {
    return { ok: false, reason: `unknown scope '${verdict.scope}' (allowed: ${BUCKET_SCOPES.join(', ')})` };
  }
  const provider = getProvider(verdict.provider);
  if (!provider) {
    return { ok: false, reason: `unknown provider '${verdict.provider}'` };
  }
  // Trust-class guard: prose buckets (cues + auditors) refuse providers
  // that train on input. Mirrors the resolver's build-time guard so
  // fluid-config can't reach what the resolver would reject anyway.
  if (verdict.scope !== 'blanks' && provider.trainsOnInput) {
    return { ok: false, reason: `provider '${verdict.provider}' trains on input — blocked for prose bucket '${verdict.scope}' (only 'blanks' may use it)` };
  }
  if (verdict.model !== null) {
    const allowedModels = provider.knownModels && provider.knownModels.length > 0
      ? provider.knownModels
      : [provider.defaultModel];
    if (!allowedModels.includes(verdict.model)) {
      return { ok: false, reason: `model '${verdict.model}' is not in '${verdict.provider}'s knownModels (allowed: ${allowedModels.join(', ')})` };
    }
  }
  return { ok: true };
}

// ============================================================================
// Source
// ============================================================================

export type ConfigIntentEvent =
  | { type: 'started'; textLen: number; blankIdx: number; llm: string }
  | { type: 'completed'; verdict: ConfigIntentVerdict; applied: boolean; latencyMs: number }
  | { type: 'bailed'; reason: string; latencyMs: number };

export interface ConfigIntentSourceConfig {
  httpAdapter: HttpAdapter;
  provider: ProviderAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Per-feature max-tokens override (`fluid-config-max-tokens:`).
   *  Falls back to 128 (classifier output is tiny) when absent. */
  maxTokens?: number;
  /** Per-feature temperature override (`fluid-config-temperature:`).
   *  Falls back to 0 (classifier must be deterministic) when absent. */
  temperature?: number;
  /**
   * Side-effect callback: write the (setting, value) into OPENCUES.md
   * and refresh in-memory state. Runtime injects
   * `ConfigLoader.applyOpenCuesScalar` here. May be sync or async.
   */
  applyScalar: (setting: string, value: string) => void | Promise<void>;
  /**
   * Pre-switch liveness check for a PROVIDER verdict. When set, the source
   * pings the target (provider, model) BEFORE writing the provider/model
   * scalars; on failure it writes nothing (the current provider stays) and
   * emits the reason inline via `formatErrorAsSubstitute`. Runtime wires
   * this to `probeProviderReachable` with the live key bag + httpAdapter.
   * Absent → provider switches apply unconditionally (prior behaviour).
   */
  probeProvider?: (providerId: string, model: string | null) => Promise<{ ok: boolean; reason?: FluidBlankErrorReason; err?: Error }>;
  /**
   * Registered blanks (so this source can cede the slot when a
   * keyword-bound blank would claim it — mirrors the cede logic in
   * FluidBlankSource and TransformBlankSource).
   */
  blanks?: Record<string, BlankConfig>;
  /** Source priority. Default 94 — between BlankSource (95) and TransformBlank (93). */
  priority?: number;
  log?: (msg: string) => void;
  onEvent?: (event: ConfigIntentEvent) => void;
  /**
   * When set, user-actionable HTTP failures emit an inline `_` → error
   * substitute instead of silently failing. Same wiring as
   * FluidBlankSource + TransformBlankSource so the user always sees
   * WHY a `_` didn't fire. Wire to `nativeHostFormatLLMError` from
   * boot-common.ts in native hosts.
   */
  formatErrorAsSubstitute?: (reason: FluidBlankErrorReason, err?: Error, ctx?: { provider?: string; model?: string; endpoint?: string }) => string;
  /**
   * Host id (chrome / claude-code / opencode / …). When set, host-scoped
   * FEATURES (those with a `hostScope`) are included in the classifier's
   * choice space ONLY on a matching host — a CLI host never sees chrome's
   * `statusbar-position`, etc. Omitted = universal set (host-scoped
   * features excluded). Runtime wires `adapter.hostName` here.
   */
  hostName?: string;
  /**
   * Verdict-level gates. The SYSTEM_PROMPT is ONE byte-stable string
   * that always describes all four intents (cerebras prefix caching —
   * see docs/architecture/cerebras.md); which verdict kinds are ACTED
   * on is decided here, post-classification. A verdict of a disabled
   * kind is treated exactly like NONE (cede, no side effects).
   *
   * allowConfigVerdicts — SETTING + PROVIDER kinds (`fluid-config-mode`).
   * Default true (matches the source's original single-purpose shape).
   */
  allowConfigVerdicts?: boolean;
  /**
   * allowActionVerdicts — ACTION kind, i.e. undo/redo (`undo-mode`).
   * Default false: action verdicts are emitted as results for the
   * RUNTIME to apply (the undo journal lives there), so a consumer
   * that doesn't handle `metadata.undoAction` must not receive them.
   */
  allowActionVerdicts?: boolean;
}

/**
 * Start offset of the trailing "summon phrase" — the settings-intent
 * clause the user typed before `_` (e.g. "voice mode off"). ConfigIntent
 * wipes from here to the end of the buffer and splices in the
 * selector/satellite pair; everything BEFORE this offset is the user's
 * prior content and MUST be preserved. Without this the source wiped
 * `[0, len)` and a buffer like `hii world. voice mode off _` lost
 * "hii world." entirely (the config-intent nuke landmine).
 *
 * Heuristic: the last sentence terminator before `_`. ASCII terminators
 * (`.`/`!`/`?`) require a trailing whitespace via the `(?=\s)` lookahead
 * (so model-version dots like "gpt-5.4" aren't mistaken for sentence
 * ends); CJK/fullwidth terminators (`。`/`！`/`？`/`．`) match directly
 * because those scripts don't put a space after the stop — without them a
 * Japanese buffer like `こんにちは世界。voice mode off _` found no boundary
 * and wiped the user's whole sentence (a language-dependent data-loss bug).
 * A line break is always a boundary. No boundary found → 0.
 *
 * Delegates to the shared `segmentStart` (scanning the whole buffer) so this
 * router and the shaped-blank router (`lineWithBlank`) anchor commands on the
 * exact same sentence/line boundary — they can't drift.
 */
export function summonPhraseStart(text: string): number {
  // Scan only up to the command's `_` (the last one), NOT the whole buffer.
  // A contenteditable commonly keeps trailing newlines after the `_`
  // (`statusbar bottom _\n\n\n\n`); `segmentStart` treats `\n` as a segment
  // boundary, so scanning the whole buffer put the start at the LAST
  // trailing newline = buffer end. That made the wipe span empty, so the
  // selector-satellite confirmation replaced nothing and the raw query was
  // left in the field (live-reported on chrome). Passing the `_`'s index
  // makes boundaries after it invisible — segment.ts § pos.
  const u = text.lastIndexOf('_');
  return segmentStart(text, u >= 0 ? u : text.length);
}

export class ConfigIntentSource implements CueSource {
  readonly id = 'config-intent';
  readonly priority: number;
  /** Single-shot apply — no cycling. */
  readonly isCycleable = false;

  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private maxTokensOverride: number | undefined;
  private temperatureOverride: number | undefined;
  private applyScalar: (setting: string, value: string) => void | Promise<void>;
  private probeProvider: ((providerId: string, model: string | null) => Promise<{ ok: boolean; reason?: FluidBlankErrorReason; err?: Error }>) | undefined;
  private blanks: Record<string, BlankConfig>;
  private log: (msg: string) => void;
  private emit: (event: ConfigIntentEvent) => void;
  private formatErrorAsSubstitute: ((reason: FluidBlankErrorReason, err?: Error, ctx?: { provider?: string; model?: string; endpoint?: string }) => string) | undefined;
  /** Host id (chrome/claude-code/…), used to host-scope the feature list. */
  private hostName: string | undefined;
  /** Verdict-level gates (see ConfigIntentSourceConfig). */
  private allowConfigVerdicts: boolean;
  private allowActionVerdicts: boolean;
  /** System prompt with the host-scoped feature block swapped in. */
  private systemPrompt: string;

  /**
   * Per-input cache of raw LLM responses. ConfigIntent is a
   * CLASSIFIER — same buffer should yield same intent, so we cache
   * the raw response and re-run parse/validate/apply on hit. Same
   * static module-level shape as TransformBlank / FluidBlank pools
   * so the cache survives chrome's resolver rebuild churn.
   *
   * The most common case is "INTENT: NONE" (prose that isn't a config
   * command) — caching that lets prose-`_` paths cede instantly to
   * sibling sources without burning a classifier round-trip every
   * keystroke.
   *
   * Setting-apply side effects (writes to OPENCUES.md via
   * applyScalar) are idempotent — re-applying the same value on
   * cache hit is a no-op write at the scalar level.
   */
  private static _variantPool = new Map<string, { entries: string[]; cyclePos: number }>();
  private static readonly VARIANT_POOL_SIZE = 3;
  private static readonly VARIANT_KEY_CAP = 32;

  /**
   * Per-buffer memo of the dedicated SUMMON extraction (see SUMMON_PROMPT).
   * The summon call only fires on confirmed SETTING/PROVIDER verdicts, but a
   * single `_` trigger can resolve more than once in a burst (apply →
   * setText → re-resolve within the reload-suppression window); this stops
   * the second resolve paying for the extraction again. Keyed by buffer
   * text, value is the resolved spanStart. Bounded like the variant pool.
   */
  private static _summonStartCache = new Map<string, number>();
  private static readonly SUMMON_CACHE_CAP = 32;

  constructor(config: ConfigIntentSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokensOverride = config.maxTokens;
    this.temperatureOverride = config.temperature;
    this.applyScalar = config.applyScalar;
    this.probeProvider = config.probeProvider;
    this.blanks = config.blanks ?? {};
    this.priority = config.priority ?? 94;
    this.log = config.log ?? (() => { /* silent */ });
    this.emit = config.onEvent ?? (() => { /* silent */ });
    this.formatErrorAsSubstitute = config.formatErrorAsSubstitute;
    this.hostName = config.hostName;
    this.allowConfigVerdicts = config.allowConfigVerdicts ?? true;
    this.allowActionVerdicts = config.allowActionVerdicts ?? false;
    // Swap the universal feature block for this host's — includes any
    // host-scoped features (e.g. chrome's statusbar-position) ONLY on the
    // owning host. No hostName → the universal default (host-scoped
    // excluded), byte-identical to the exported SYSTEM_PROMPT.
    this.systemPrompt = config.hostName
      ? SYSTEM_PROMPT.replace(FEATURE_REGISTRY_BLOCK, buildFeatureBlock(config.hostName))
      : SYSTEM_PROMPT;
  }

  supports(context: CueContext): boolean {
    const lower = context.words.map(w => w.toLowerCase());
    const blankIndex = lower.indexOf('_');
    if (blankIndex === -1) return false;

    // ACTION preempts a blank claim. A trailing bare `undo`/`redo` before
    // the `_` is a universal runtime command — do NOT cede it to a blank
    // shape/keyword that happens to also match (`capital of france undo _`
    // matches the `countries` shape, but "undo" is the command, not part of
    // the country). The deterministic gate in getCues then emits the ACTION.
    // BlankFill.scan cedes symmetrically, so exactly one of us claims.
    if (this.allowActionVerdicts) {
      const trigIdx = context.text.lastIndexOf('_');
      if (trigIdx >= 0 && matchDeterministicAction(context.text.slice(0, trigIdx))) return true;
    }

    // Cede when a keyword/shaped blank claims this `_` (shape match, or a
    // non-shaped blank's keyword on the same line). SHARED predicate —
    // identical for FluidBlank / TransformBlank / ConfigIntent so they can't
    // drift. The June 2026 long-buffer bug was ConfigIntent carrying a stale
    // inline copy that didn't skip shaped blanks: an incidental "volume" in a
    // woven `The volume is now 30%` made it cede, so `voice mode off _` fell
    // through to fluid-blank instead of flipping the setting.
    if (blankClaimsUnderscore(context.text, context.words, this.blanks)) return false;

    return true;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const t0 = Date.now();
    const blankIdx = context.words.indexOf('_');
    if (blankIdx === -1) return { results: [] };

    // DETERMINISTIC ACTION gate (the Ctrl+Z path) — before ANY LLM work.
    // A bare undo/redo (+ optional integer count) immediately before the
    // trigger `_` is an unambiguous command: match it by string, emit the
    // ACTION verdict instantly, no classifier round-trip and no way to
    // cede. Keys off the LAST `_` (the just-typed trigger) so a leading
    // `capital of france _ redo _` wipes only `redo _` and leaves the
    // prior query. `redo <object>` and multilingual/verbose phrasings
    // don't match here and fall through to the LLM classifier below.
    if (this.allowActionVerdicts) {
      const triggerCharIdx = context.text.lastIndexOf('_');
      const det = matchDeterministicAction(context.text.slice(0, triggerCharIdx));
      if (det) {
        const detWordIdx = context.words.lastIndexOf('_');
        const verdict: ConfigIntentVerdict = { kind: 'action', action: det.action, count: det.count, confidence: 1 };
        this.log(`ConfigIntent: ACTION ${det.action} ×${det.count} (deterministic, no LLM) — emitting for runtime apply`);
        this.emit({ type: 'started', textLen: context.text.length, blankIdx, llm: 'deterministic (no LLM)' });
        this.emit({ type: 'completed', verdict, applied: false, latencyMs: Date.now() - t0 });
        return {
          results: [{
            wordIndex: detWordIdx,
            word: '_',
            alternatives: [det.action],
            source: this.id,
            priority: this.priority,
            spanStart: det.commandStart,
            spanEnd: context.text.length,
            cueTip: det.count > 1 ? `${det.action} ×${det.count}` : det.action,
            metadata: {
              undoAction: { action: det.action, count: det.count, confidence: 1 },
            },
          }],
          timing: Date.now() - t0,
          model: this.model,
        };
      }
    }

    // Likely-intent gate — skip the LLM dispatch when the buffer has
    // zero settings/provider keywords. Saves ~280ms per cold trigger
    // on prose-only buffers (`draft an email _`, `capital of france _`,
    // `make formal _` — none contain any FEATURES scalar, provider id,
    // or curated action verb). The variant cache (June 2026) handles
    // repeat triggers separately; this gate handles the FIRST trigger
    // on any new prose buffer. See LIKELY_INTENT_KEYWORDS for the
    // exhaustive list + the rationale for the conservative shape.
    if (!hasLikelyIntent(context.text)) {
      this.log(`ConfigIntent: ceding — no likely-intent keyword in buffer (gate-skip, no LLM call)`);
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    const llmDesc = describeLLMCall(this.provider, this.model, undefined, {
      maxTokens: this.maxTokensOverride, temperature: this.temperatureOverride,
    });
    this.log(`ConfigIntent: starting (textLen=${context.text.length}, blankIdx=${blankIdx}, llm=${llmDesc})`);
    this.emit({ type: 'started', textLen: context.text.length, blankIdx, llm: llmDesc });

    // Kick off the wipe-span resolution CONCURRENTLY with the classifier.
    // The command boundary is independent of the verdict (it's a function
    // of the buffer text, not of which setting/provider was named), so the
    // summon call — when one is even needed (see resolveCommandSpanStart's
    // regex-confident short-circuit) — overlaps the classifier's latency
    // instead of stacking after it. We only AWAIT it on a confirmed
    // SETTING/PROVIDER verdict; a NONE verdict cedes without awaiting, so
    // the NONE path is never slowed by it. `.catch` keeps an early-cede /
    // error path from leaving a floating rejection (the method itself
    // never throws — regex floor on any failure).
    // DEHYDRATION (outbound PII scrub) — in identity-context `safe`
    // mode, catalog values in the buffer ship as [TOKEN]s. Input-only:
    // the classifier's output is validated against the FEATURES
    // registry, so no PII-bearing value could validly round-trip; the
    // summon call hydrates its echoed phrase before any offset math
    // (resolveCommandSpanStart). All spans stay computed on the
    // ORIGINAL text.
    const idCtx = context.identityContext;
    const dehydrator = idCtx && idCtx.mode === 'safe' && idCtx.catalog.size > 0
      ? getDehydrator(idCtx.catalog, (m) => this.log(`ConfigIntent: ${m}`))
      : undefined;
    const dText = dehydrator?.dehydrate(context.text);
    const outboundText = dText?.changed ? dText.text : context.text;
    if (dText?.changed) {
      this.log(`ConfigIntent: dehydrated ${dText.spans.length} value(s) → tokens (outbound PII scrub)`);
    }

    const spanStartPromise = this.resolveCommandSpanStart(context.text, context.signal, dehydrator, idCtx?.catalog);
    spanStartPromise.catch(() => {});

    // VARIANT POOL — cache raw LLM response. Re-run parse/validate/
    // apply on hit so the verdict's side effect (applyScalar for
    // SETTING/PROVIDER verdicts) still fires. Idempotent at the
    // scalar level — re-applying the same value is a no-op write.
    const cacheKey = this._computeCacheKey(context);
    const variantChoice = this._selectVariant(cacheKey);

    let raw: string;
    if (variantChoice.kind === 'cache') {
      this.log(`ConfigIntent: variant-cache HIT — serving cached response (pool size ${variantChoice.others.length + 1})`);
      raw = variantChoice.rewrite;
    } else {
      try {
      // Per-feature `fluid-config-max-tokens:` override; 128 default
      // is tight because the classifier output is tiny (VERDICT,
      // SETTING, VALUE, CONFIDENCE) — bumping helps only if the
      // model wraps the output in extra prose.
      raw = await this.callLLM(this.systemPrompt, `INPUT: ${outboundText}`, this.maxTokensOverride ?? 128, context.signal);
      this._recordFreshResponse(cacheKey, raw);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.log(`ConfigIntent: LLM call failed — ${err.message}`);
      this.emit({ type: 'bailed', reason: 'llm-error', latencyMs: Date.now() - t0 });
      // Same inline error substitute the other blank-triggered sources
      // emit — the user sees `_` → `[OpenCues: ...]` instead of silent
      // failure. Classifier failures on user-actionable HTTP errors
      // (401, 404, model-not-found) are exactly when the user most
      // needs the inline signal.
      const reason = classifyLlmError(err);
      if (reason !== null && this.formatErrorAsSubstitute) {
        const text = this.formatErrorAsSubstitute(reason, err, { provider: this.provider.id, model: this.model, endpoint: this.endpoint });
        if (text && text.length > 0) {
          return {
            results: [{
              wordIndex: blankIdx,
              word: '_',
              alternatives: ['_', text],
              source: this.id,
              priority: this.priority,
              cueTip: 'ConfigIntent failed — message describes the cause',
              metadata: { fluidBlankErrorReason: reason },
            }],
            timing: Date.now() - t0,
            model: this.model,
          };
        }
      }
      return { results: [], timing: Date.now() - t0, model: this.model };
    }
    }

    const verdict = parseConfigIntentOutput(raw);
    if (verdict.kind === 'none') {
      this.log(`ConfigIntent: NONE (${Date.now() - t0}ms) — ceding to next source`);
      this.emit({ type: 'completed', verdict, applied: false, latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    // Verdict-level gates — the prompt always classifies all four
    // intents (byte-stable for prefix caching); which kinds are ACTED
    // on is decided here. A disabled kind cedes exactly like NONE.
    if (verdict.kind === 'action' && !this.allowActionVerdicts) {
      this.log(`ConfigIntent: ACTION verdict but undo-mode is off — ceding`);
      this.emit({ type: 'completed', verdict, applied: false, latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }
    if ((verdict.kind === 'setting' || verdict.kind === 'provider') && !this.allowConfigVerdicts) {
      this.log(`ConfigIntent: ${verdict.kind.toUpperCase()} verdict but fluid-config-mode is off — ceding`);
      this.emit({ type: 'completed', verdict, applied: false, latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    const check = validateAgainstRegistry(verdict, this.hostName);
    if (!check.ok) {
      this.log(`ConfigIntent: rejecting invalid verdict — ${check.reason}; raw="${raw.replace(/\n/g, ' / ').slice(0, 200)}"`);
      this.emit({ type: 'bailed', reason: `invalid-verdict: ${check.reason}`, latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    // ACTION verdicts (undo/redo) carry NO emit-time side effect — the
    // undo journal lives in the runtime, so the source only classifies
    // and hands the verdict over via metadata.undoAction. The resolver's
    // ACTION branch splices out the command span and applies the
    // journal transactions. Wipe span = the summon phrase, same
    // machinery as settings verdicts.
    if (verdict.kind === 'action') {
      this.log(`ConfigIntent: ACTION ${verdict.action} ×${verdict.count} (${Date.now() - t0}ms, conf=${verdict.confidence ?? 'n/a'}) — emitting for runtime apply`);
      this.emit({ type: 'completed', verdict, applied: false, latencyMs: Date.now() - t0 });
      const actionSpanStart = await spanStartPromise;
      return {
        results: [{
          wordIndex: blankIdx,
          word: '_',
          // Non-'_' alternative: belt-and-braces against generic
          // alternatives-filter paths; the resolver's ACTION branch
          // consumes this result before any splice logic runs.
          alternatives: [verdict.action],
          source: this.id,
          priority: this.priority,
          spanStart: actionSpanStart,
          spanEnd: context.text.length,
          cueTip: verdict.count > 1 ? `${verdict.action} ×${verdict.count}` : verdict.action,
          metadata: {
            undoAction: { action: verdict.action, count: verdict.count, confidence: verdict.confidence },
          },
        }],
        timing: Date.now() - t0,
        model: this.model,
      };
    }

    // Apply BEFORE building the CueResult. If a write fails, bail
    // rather than show a confirmation marker for a change that didn't
    // happen. Provider verdicts may write TWO scalars (provider + model);
    // run them sequentially — applyOpenCuesScalar's reload-suppression
    // window covers both writes within the 2.5s guard.
    const apply = async (setting: string, value: string): Promise<void> => {
      await Promise.resolve(this.applyScalar(setting, value));
    };
    let displaySelector: string;
    let displayValue: string;
    // Optional separate cycling value — when present, the runtime uses
    // it for `selectorSatelliteState.currentValue` (the value cycling
    // Up/Down advances within), while `displayValue` is what gets
    // spliced into the buffer. This lets a PROVIDER verdict with a
    // model show `anthropic:claude-opus-4-7` in the buffer (pair
    // visible) while satellite-cycling still walks just the provider
    // values (the catalogue of providers, not the cartesian product).
    let cyclingValue: string | undefined;
    let cueTip: string;
    try {
      if (verdict.kind === 'setting') {
        await apply(verdict.setting, verdict.value);
        displaySelector = verdict.setting;
        displayValue = verdict.value;
        cueTip = `${verdict.setting} → ${verdict.value}`;
      } else {
        // provider kind. Always write the bucket's provider scalar;
        // also write the model scalar when the verdict specified one.
        // The buffer satellite displays `provider:model` (one token —
        // splitWords treats `:` as a non-whitespace word char) so the
        // user sees the actual pair they got, not just the provider.
        // The cycling state stores just the provider so cycling Up/Down
        // walks the provider catalogue; cycling.ts's
        // `providerScalarToModelScalar` resets the sibling model on
        // each provider cycle so invalid (provider, model) pairs can
        // never form by cycling alone.
        const providerScalar = `${verdict.scope}-llm-provider`;
        const modelScalar = `${verdict.scope}-llm-model`;
        // PRE-SWITCH LIVENESS GATE — ping the provider we're about to
        // change TO before writing anything. If it can't answer (Ollama not
        // running, missing key, model the provider rejects), write NOTHING —
        // the current provider stays — and surface the reason inline via the
        // SAME error-substitute path every other blank LLM failure uses.
        if (this.probeProvider) {
          const targetModel = verdict.model ?? getProvider(verdict.provider)?.defaultModel ?? null;
          const probe = await this.probeProvider(verdict.provider, targetModel);
          if (!probe.ok) {
            const reason = probe.reason ?? 'network';
            this.log(`ConfigIntent: provider switch to ${verdict.provider}${targetModel ? ` · ${targetModel}` : ''} REFUSED (${reason}: ${probe.err?.message ?? 'unreachable'}) — keeping current provider`);
            this.emit({ type: 'completed', verdict, applied: false, latencyMs: Date.now() - t0 });
            const text = this.formatErrorAsSubstitute?.(reason, probe.err, { provider: verdict.provider, model: targetModel ?? undefined });
            if (text && text.length > 0) {
              return {
                results: [{
                  wordIndex: blankIdx,
                  word: '_',
                  alternatives: ['_', text],
                  source: this.id,
                  priority: this.priority,
                  cueTip: `Kept current provider — ${verdict.provider} is unavailable`,
                  metadata: { fluidBlankErrorReason: reason },
                }],
                // Claim the slot so a lower-priority sibling (FluidBlank) can't
                // ALSO answer this "switch to X" phrase as a lookup and
                // overwrite our tailored message with a generic one. Unlike a
                // successful switch (whole-buffer claim → sibling-abort), the
                // refusal only replaces `_`, so it needs the explicit claim.
                consumedBlankSlots: [blankIdx],
                timing: Date.now() - t0,
                model: this.model,
              };
            }
            // Even with no formatter wired, still claim the slot so FluidBlank
            // doesn't vandalise the refused command.
            return { results: [], consumedBlankSlots: [blankIdx], timing: Date.now() - t0, model: this.model };
          }
        }
        await apply(providerScalar, verdict.provider);
        if (verdict.model !== null) {
          await apply(modelScalar, verdict.model);
        } else {
          // Pair invariant: provider change always resets the sibling
          // model scalar. A user who previously pinned a model for the
          // old provider (e.g. `auditors-llm-model: claude-opus-4-7`)
          // and now says "use cerebras for auditors _" must NOT keep
          // the old model around — the resolver would then dispatch
          // `cerebras + claude-opus-4-7` and 400. Mirrors the
          // providerScalarToModelScalar reset in cycling.ts. Write the
          // NEW provider's defaultModel explicitly (not the literal
          // `default` sentinel) so OPENCUES.md is self-explanatory and
          // doctor's "inert sentinel" warning doesn't fire.
          const providerAdapter = getProvider(verdict.provider);
          await apply(modelScalar, providerAdapter?.defaultModel ?? 'default');
        }
        displaySelector = providerScalar;
        // Always show what model is in use — even when the user didn't
        // name one. Falls back to the provider's defaultModel so the
        // satellite is ALWAYS `provider:model`, never bare `provider`.
        // The model scalar itself is only written when the user named a
        // model (above) — display read-only-resolves the default in
        // every other case so the user knows the effective state.
        const providerAdapter = getProvider(verdict.provider);
        const effectiveModel = verdict.model ?? providerAdapter?.defaultModel ?? null;
        displayValue = effectiveModel !== null
          ? `${verdict.provider}:${effectiveModel}`
          : verdict.provider;
        cyclingValue = verdict.provider;
        cueTip = effectiveModel !== null
          ? `${verdict.scope} → ${verdict.provider} · ${effectiveModel}`
          : `${verdict.scope} → ${verdict.provider}`;
      }
    } catch (e) {
      this.log(`ConfigIntent: applyScalar failed for ${verdict.kind} verdict — ${(e as Error).message}`);
      this.emit({ type: 'bailed', reason: 'apply-failed', latencyMs: Date.now() - t0 });
      return { results: [], timing: Date.now() - t0, model: this.model };
    }

    this.log(`ConfigIntent: applied ${cueTip} (${Date.now() - t0}ms, conf=${verdict.confidence ?? 'n/a'})`);
    this.emit({ type: 'completed', verdict, applied: true, latencyMs: Date.now() - t0 });

    // Await the wipe-span resolution started concurrently above. By now the
    // classifier round-trip has elapsed, so on the common path this promise
    // is already settled (the summon call, if any, overlapped it) — the span
    // adds ~0 to the critical path instead of a second serial round-trip.
    const spanStart = await spanStartPromise;

    // Selector-satellite shape, mirroring the result BlankSource emits
    // for keyword-bound `opencues settings _` (see blank-source.ts
    // selector-satellite branch). The wipe span runs from the start of
    // the trailing summon phrase (NOT [0, len)) to the end, so any prior
    // user content before the settings command is preserved — the
    // resolver keeps liveText.slice(0, spanStart) and splices the pair
    // after it. The summon words AND `_` are replaced by
    // "<scalar><sep><value>" and full satellite cycling is then live.
    // For provider verdicts the bucket scalar (cues-llm-provider, etc.)
    // is itself a FEATURES entry, so satellite cycling enumerates the
    // provider list directly — no extra wiring needed.
    const result: CueResult = {
      wordIndex: blankIdx,
      word: '_',
      alternatives: [displaySelector],
      source: this.id,
      priority: this.priority,
      spanStart,
      spanEnd: context.text.length,
      cueTip,
      metadata: {
        blankName: 'opencues',
        selectorBlank: true,
        satelliteValue: displayValue,
        // satelliteCyclingValue (when set) is what the runtime stores
        // in `selectorSatelliteState.currentValue` for the cycling
        // path; satelliteValue is just for the buffer splice. The two
        // diverge when displaying a `provider:model` pair while
        // cycling-state stores just `provider`.
        ...(cyclingValue !== undefined ? { satelliteCyclingValue: cyclingValue } : {}),
        displaySeparator: ' ',
        configIntent: verdict.kind === 'setting'
          ? { setting: verdict.setting, value: verdict.value, confidence: verdict.confidence }
          : { scope: verdict.scope, provider: verdict.provider, model: verdict.model, confidence: verdict.confidence },
      },
    };

    // Claim the slot for siblings processed after us (belt-and-braces
    // alongside the whole-buffer sibling-abort a spanned result already
    // triggers) — a valid switch must never race a stray FluidBlank fill on
    // the same `_`.
    return { results: [result], consumedBlankSlots: [blankIdx], timing: Date.now() - t0, model: this.model };
  }

  /**
   * Resolve the wipe span's left edge for a config command. Three tiers,
   * cheapest first:
   *
   *   1. PER-BUFFER CACHE — a repeat/double-fire trigger pays nothing.
   *   2. REGEX-CONFIDENT SHORT-CIRCUIT — if `summonPhraseStart` found a
   *      real sentence boundary (start > 0), USE IT and make NO LLM call.
   *      The regex can only ever UNDER-find a boundary (miss one in a
   *      script it can't segment); it never HALLUCINATES one, so any
   *      boundary it does find is a valid command start. This skips the
   *      summon call entirely for the common case (English/CJK prior
   *      content with punctuation) — the optimisation that keeps the
   *      second call off the hot path when the regex already suffices.
   *   3. DEDICATED SUMMON CALL — only when start === 0 (bare command, OR
   *      prior content in a script the regex can't segment, e.g. Thai).
   *      This is the one case the model adds value; in `getCues` it is
   *      kicked off CONCURRENTLY with the classifier so its latency
   *      overlaps rather than stacks. Never throws (regex floor on any
   *      failure), memoised.
   */
  private async resolveCommandSpanStart(
    text: string,
    signal?: AbortSignal,
    dehydrator?: CompiledDehydrator,
    catalog?: ReadonlyMap<string, string>,
  ): Promise<number> {
    const cached = ConfigIntentSource._summonStartCache.get(text);
    if (cached !== undefined) {
      this.log(`ConfigIntent: summon-span cache HIT (start=${cached})`);
      return cached;
    }
    const regexStart = summonPhraseStart(text);
    let start: number;
    if (regexStart > 0) {
      // Regex found a real boundary — authoritative, no LLM call needed.
      start = regexStart;
      this.log(`ConfigIntent: summon-span via regex-confident (start=${start}, no LLM call)`);
    } else {
      // Ambiguous (start === 0): the model disambiguates bare-command vs
      // non-punctuated prior content.
      try {
        // Outbound is dehydrated (PII scrub); the model's echoed summon
        // phrase is then HYDRATED back to value space BEFORE any offset
        // math — resolveSummonStart's `endsWith` runs against the
        // original text. If hydration can't restore exact bytes (the
        // documented case-drift residual), `endsWith` misses and the
        // regex floor takes over — safe degradation, never a wrong span.
        const dOut = dehydrator?.dehydrate(text);
        const raw = await this.callLLM(SUMMON_PROMPT, `INPUT: ${dOut?.changed ? dOut.text : text}`, this.maxTokensOverride ?? 96, signal);
        let summon = parseSummonOutput(raw);
        if (summon && catalog && catalog.size > 0) {
          try {
            summon = postProcessContext(summon, { catalog, preserveUnknown: true }).output;
          } catch { /* keep raw summon — regex floor covers a miss */ }
        }
        start = resolveSummonStart(text, summon);
        const via = summon && text.endsWith(summon.trim()) && start === text.length - summon.trim().length ? 'model' : 'regex-floor';
        this.log(`ConfigIntent: summon-span via ${via} (start=${start}, summon=${JSON.stringify(summon)})`);
      } catch (e) {
        start = summonPhraseStart(text);
        this.log(`ConfigIntent: summon extraction failed (${(e as Error).message}) — regex floor (start=${start})`);
      }
    }
    // Bounded memo — evict oldest on overflow (Map preserves insertion order).
    const cache = ConfigIntentSource._summonStartCache;
    if (cache.size >= ConfigIntentSource.SUMMON_CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(text, start);
    return start;
  }

  private async callLLM(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return dispatchChat(
      this.provider,
      this.httpAdapter,
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
        // Per-feature override; 0 default — classifier must be
        // deterministic. Raising temperature risks the validator
        // flagging unrecognised setting/value pairs.
        temperature: this.temperatureOverride ?? 0,
        seed: 42,
        // Force reasoning to 'low'. The classifier output is tiny
        // (SETTING + VALUE + CONFIDENCE) and the prompt is structured
        // enough that medium/high reasoning adds 700-1500ms without
        // improving accuracy — the fluid-config bench runs at 'low'
        // and held 100% precision / 90-100% holdout recall across
        // 5 providers (see tests/benchmarks/fluid-config/). Mirrors
        // FluidBlank's same-rationale 'low' floor (fluid-blank-source.ts:995).
        reasoningEffort: 'low',
      },
      {
        apiKey: this.apiKey,
        endpoint: this.endpoint,
        signal,
        onUsage: (u) => {
          const hasCacheData = u.cachedTokens > 0 || u.cacheHitRate > 0;
          const hasPredData = u.acceptedPredictionTokens > 0 || u.rejectedPredictionTokens > 0;
          if (hasCacheData || hasPredData) {
            const predPart = hasPredData
              ? ` pred-accepted=${u.acceptedPredictionTokens} pred-rejected=${u.rejectedPredictionTokens} (acc rate ${(u.predictionAcceptRate * 100).toFixed(0)}%)`
              : '';
            this.log(`ConfigIntent: usage prompt=${u.promptTokens} cached=${u.cachedTokens} (${(u.cacheHitRate * 100).toFixed(1)}%) completion=${u.completionTokens}${predPart}`);
          }
        },
      },
    );
  }

  /** Cache key — buffer + provider + model. ConfigIntent has no
   *  mode/maxThinking variations on the prompt shape today. */
  private _computeCacheKey(context: CueContext): string {
    const SEP = '\x1f';
    return [context.text, this.provider.id, this.model].join(SEP);
  }

  private _selectVariant(key: string): { kind: 'cache'; rewrite: string; others: string[] } | { kind: 'fresh'; others: string[] } {
    let entry = ConfigIntentSource._variantPool.get(key);
    if (!entry) {
      entry = { entries: [], cyclePos: 0 };
      ConfigIntentSource._variantPool.set(key, entry);
    } else {
      ConfigIntentSource._variantPool.delete(key);
      ConfigIntentSource._variantPool.set(key, entry);
    }
    if (entry.entries.length < ConfigIntentSource.VARIANT_POOL_SIZE) {
      return { kind: 'fresh', others: entry.entries.slice() };
    }
    if (entry.cyclePos < entry.entries.length) {
      const rewrite = entry.entries[entry.cyclePos];
      entry.cyclePos++;
      const others = entry.entries.filter((_, i) => i !== entry!.cyclePos - 1);
      return { kind: 'cache', rewrite, others };
    }
    return { kind: 'fresh', others: entry.entries.slice() };
  }

  private _recordFreshResponse(key: string, response: string): void {
    let entry = ConfigIntentSource._variantPool.get(key);
    if (!entry) {
      entry = { entries: [], cyclePos: 0 };
      ConfigIntentSource._variantPool.set(key, entry);
    }
    if (entry.entries.length >= ConfigIntentSource.VARIANT_POOL_SIZE) {
      entry.entries.shift();
    }
    entry.entries.push(response);
    entry.cyclePos = 0;
    while (ConfigIntentSource._variantPool.size > ConfigIntentSource.VARIANT_KEY_CAP) {
      const oldest = ConfigIntentSource._variantPool.keys().next().value;
      if (oldest === undefined) break;
      ConfigIntentSource._variantPool.delete(oldest);
    }
  }

  variantPoolSize(key: string): number {
    return ConfigIntentSource._variantPool.get(key)?.entries.length ?? 0;
  }

  cacheKeyForTest(context: CueContext): string {
    return this._computeCacheKey(context);
  }

  static resetVariantPoolForTest(): void {
    ConfigIntentSource._variantPool.clear();
  }
}
