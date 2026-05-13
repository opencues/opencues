// Charset-coverage check for TransformBlank rewrites — detects partial
// translations where the LLM left source-language fragments in the
// output instead of fully translating to the target language.
//
// Background: TransformBlank's existing safety net (target.length > 100
// AND rewrite.length < target.length * 0.10) catches rewrite-collapse
// (LLM returned "OK" for a long buffer) but misses partial translations
// where the output is the right length but mixed-script. The bug arc:
//
//   User had Japanese text in buffer
//   User typed `agentically translate to english _`
//   LLM returned "こんにちは my name is wilfred\n\nHow あなたは今日…"
//                  ^^^^^^^^                       ^^^^^^^^^^^^^
//                  source CJK survives → partial translation
//
// The length guard didn't fire (buffer was 94 chars, below the 100-char
// activation floor). This module exposes a stricter check that fires
// regardless of length — when the input is dominantly one script and
// the task asks to translate to another, the input's dominant script
// should drop to near-zero in the output.

// ─── Unicode block buckets ────────────────────────────────────────────
//
// One-class-per-script for the major writing systems users care about
// for translation. CJK lumps Hiragana / Katakana / Han into one bucket —
// they coexist in Japanese text and we don't distinguish them. The
// 'other' bucket catches scripts we haven't enumerated; partial detection
// gracefully no-ops when the dominant input script is 'other'.

export type Script = 'latin' | 'cjk' | 'cyrillic' | 'devanagari' | 'arabic' | 'hebrew' | 'greek' | 'thai' | 'other';

export interface ScriptBuckets {
  latin: number;
  cjk: number;
  cyrillic: number;
  devanagari: number;
  arabic: number;
  hebrew: number;
  greek: number;
  thai: number;
  /** Whitespace, ASCII punctuation, digits — ignored for partial-detection ratios. */
  neutral: number;
  /** Codepoints we haven't classified (emoji, math symbols, less-common scripts). */
  other: number;
}

/**
 * Bucket every codepoint in `s` by Unicode block. Single pass, O(n).
 * Surrogate pairs are decoded into one codepoint each.
 */
export function bucketByUnicodeBlock(s: string): ScriptBuckets {
  const b: ScriptBuckets = {
    latin: 0, cjk: 0, cyrillic: 0, devanagari: 0, arabic: 0,
    hebrew: 0, greek: 0, thai: 0, neutral: 0, other: 0,
  };
  for (const ch of s) {  // String iterator yields codepoints, not code units
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D) { b.neutral++; continue; }
    if (cp >= 0x21 && cp <= 0x2F) { b.neutral++; continue; }        // ASCII punct
    if (cp >= 0x3A && cp <= 0x40) { b.neutral++; continue; }        // : ; < = > ? @
    if (cp >= 0x5B && cp <= 0x60) { b.neutral++; continue; }        // [ \ ] ^ _ `
    if (cp >= 0x7B && cp <= 0x7E) { b.neutral++; continue; }        // { | } ~
    if (cp >= 0x30 && cp <= 0x39) { b.neutral++; continue; }        // ASCII digits
    if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) { b.latin++; continue; }  // A-Z, a-z
    if (cp >= 0x00C0 && cp <= 0x024F) { b.latin++; continue; }      // Latin Extended-A/B
    if (cp >= 0x1E00 && cp <= 0x1EFF) { b.latin++; continue; }      // Latin Extended Additional
    if (cp >= 0x0370 && cp <= 0x03FF) { b.greek++; continue; }      // Greek
    if (cp >= 0x0400 && cp <= 0x04FF) { b.cyrillic++; continue; }   // Cyrillic
    if (cp >= 0x0500 && cp <= 0x052F) { b.cyrillic++; continue; }   // Cyrillic Supplement
    if (cp >= 0x0590 && cp <= 0x05FF) { b.hebrew++; continue; }     // Hebrew
    if (cp >= 0x0600 && cp <= 0x06FF) { b.arabic++; continue; }     // Arabic
    if (cp >= 0x0900 && cp <= 0x097F) { b.devanagari++; continue; } // Devanagari
    if (cp >= 0x0E00 && cp <= 0x0E7F) { b.thai++; continue; }       // Thai
    if (cp >= 0x3040 && cp <= 0x309F) { b.cjk++; continue; }        // Hiragana
    if (cp >= 0x30A0 && cp <= 0x30FF) { b.cjk++; continue; }        // Katakana
    if (cp >= 0x3400 && cp <= 0x4DBF) { b.cjk++; continue; }        // CJK Extension A
    if (cp >= 0x4E00 && cp <= 0x9FFF) { b.cjk++; continue; }        // CJK Unified Ideographs
    if (cp >= 0xF900 && cp <= 0xFAFF) { b.cjk++; continue; }        // CJK Compatibility Ideographs
    if (cp >= 0xFF00 && cp <= 0xFFEF) {                              // Halfwidth & Fullwidth Forms
      // Fullwidth Latin (FF21-FF5A) maps back to latin; the rest stays neutral-ish.
      if ((cp >= 0xFF21 && cp <= 0xFF3A) || (cp >= 0xFF41 && cp <= 0xFF5A)) { b.latin++; continue; }
      b.neutral++;
      continue;
    }
    b.other++;
  }
  return b;
}

// ─── Task-hint parser ────────────────────────────────────────────────
//
// Extract the target script from a translation prompt. Keyword-based —
// good enough for the common case ("translate to english", "convert to
// japanese", "into spanish please"). Returns null for non-translation
// tasks so the partial detector no-ops.

const LANGUAGE_TO_SCRIPT: ReadonlyArray<[string, Script]> = [
  // Latin-script languages
  ['english', 'latin'], ['spanish', 'latin'], ['french', 'latin'], ['german', 'latin'],
  ['italian', 'latin'], ['portuguese', 'latin'], ['dutch', 'latin'], ['swedish', 'latin'],
  ['norwegian', 'latin'], ['danish', 'latin'], ['polish', 'latin'], ['czech', 'latin'],
  ['turkish', 'latin'], ['indonesian', 'latin'], ['vietnamese', 'latin'], ['latin', 'latin'],
  // CJK-script
  ['japanese', 'cjk'], ['chinese', 'cjk'], ['mandarin', 'cjk'], ['cantonese', 'cjk'],
  // Cyrillic
  ['russian', 'cyrillic'], ['ukrainian', 'cyrillic'], ['bulgarian', 'cyrillic'], ['serbian', 'cyrillic'],
  // Other
  ['greek', 'greek'], ['hebrew', 'hebrew'], ['arabic', 'arabic'],
  ['hindi', 'devanagari'], ['sanskrit', 'devanagari'], ['marathi', 'devanagari'],
  ['thai', 'thai'],
];

/**
 * Returns the expected output script for a translation task, or null if
 * the task isn't recognised as a translation. Case-insensitive; matches
 * on whole-word boundaries inside the task hint.
 */
export function scriptOfRequestedLanguage(taskHint: string | null | undefined): Script | null {
  if (!taskHint) return null;
  const hint = taskHint.toLowerCase();
  // Only fire when the task verb sounds like translation. Avoids
  // matching "english is hard" or random text containing a language
  // name. Whitelist the imperative verbs we expect for translation
  // tasks: translate / convert / rewrite / paraphrase to/into X.
  if (!/\b(translate|convert|rewrite|render|put|paraphrase|express|say|reword)\b/.test(hint)) return null;
  for (const [lang, script] of LANGUAGE_TO_SCRIPT) {
    const re = new RegExp(`\\b${lang}\\b`);
    if (re.test(hint)) return script;
  }
  return null;
}

// ─── The partial-translation detector ────────────────────────────────

export interface PartialDetectionInput {
  readonly input: string;
  readonly output: string;
  readonly taskHint: string | null | undefined;
}

export interface PartialDetectionResult {
  readonly partial: boolean;
  readonly reason: string;
  /** For diagnostics — null when partial=false because the check didn't apply. */
  readonly sourceScript?: Script;
  readonly targetScript?: Script;
  readonly inputSourceCount?: number;
  readonly outputSourceCount?: number;
}

/**
 * Detect whether a TransformBlank rewrite looks like a partial
 * translation. Heuristic: when the task asks to translate to a target
 * script S, and the input has a dominant non-S script X with at least
 * MIN_SOURCE_COUNT characters, the output should retain less than
 * SURVIVAL_THRESHOLD fraction of those X characters.
 *
 *   input = "こんにちは、ウィルフレッド" (12 CJK + 0 Latin)
 *   output = "こんにちは Wilfred"        (5 CJK + 7 Latin)
 *   task = "translate to english"      (target = latin)
 *   → CJK survived 5/12 = 42%, above the 5% threshold → partial=true
 *
 *   input = "こんにちは、ウィルフレッド" (12 CJK + 0 Latin)
 *   output = "Hello Wilfred"            (0 CJK + 12 Latin)
 *   task = "translate to english"
 *   → CJK survived 0/12 = 0%, below threshold → partial=false
 *
 *   input = "Hi there"                 (0 CJK + 7 Latin)
 *   output = "Hello"                   (0 CJK + 5 Latin)
 *   task = "fix typos"                 (not a translation)
 *   → returns partial=false ("task is not a translation")
 *
 * No-ops when: task isn't a translation; input has too few source-
 * script characters; input's dominant script equals the target script
 * (no script-shift expected); or input is 'other'-dominant.
 */
const MIN_SOURCE_COUNT = 5;
const SURVIVAL_THRESHOLD = 0.05;

export function detectPartialTransform(args: PartialDetectionInput): PartialDetectionResult {
  const { input, output, taskHint } = args;
  const targetScript = scriptOfRequestedLanguage(taskHint);
  if (!targetScript) return { partial: false, reason: 'task is not a translation' };

  const inBuckets = bucketByUnicodeBlock(input);
  // Find the dominant non-target script in the INPUT.
  const SCRIPT_KEYS: Script[] = ['latin', 'cjk', 'cyrillic', 'devanagari', 'arabic', 'hebrew', 'greek', 'thai'];
  let sourceScript: Script | null = null;
  let sourceMax = 0;
  for (const k of SCRIPT_KEYS) {
    if (k === targetScript) continue;
    const n = inBuckets[k];
    if (n > sourceMax) { sourceMax = n; sourceScript = k; }
  }
  if (!sourceScript || sourceMax < MIN_SOURCE_COUNT) {
    return { partial: false, reason: 'input has no significant non-target script content' };
  }

  const outBuckets = bucketByUnicodeBlock(output);
  const outputSourceCount = outBuckets[sourceScript];
  const surviving = outputSourceCount / sourceMax;
  if (surviving > SURVIVAL_THRESHOLD) {
    return {
      partial: true,
      reason: `source script "${sourceScript}" survived ${outputSourceCount}/${sourceMax} = ${(surviving * 100).toFixed(0)}% (threshold ${(SURVIVAL_THRESHOLD * 100).toFixed(0)}%)`,
      sourceScript,
      targetScript,
      inputSourceCount: sourceMax,
      outputSourceCount,
    };
  }
  return {
    partial: false,
    reason: `source script "${sourceScript}" dropped to ${outputSourceCount}/${sourceMax} = ${(surviving * 100).toFixed(0)}% (below threshold)`,
    sourceScript,
    targetScript,
    inputSourceCount: sourceMax,
    outputSourceCount,
  };
}
