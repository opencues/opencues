// Defensive output sanitizer for user-blank return values. Runs on
// every string the blank's `get`/`set`/`up`/`down` returns before it
// reaches the runtime's text-insertion path. Cheap to apply on every
// invocation and closes a class of editor-context attacks that the
// capability model doesn't otherwise address.
//
// What it catches:
//
//   - **HTML tags** that some contenteditable hosts treat as markup
//     (rare — most editors strip, but Gmail's HTML compose accepts
//     <a href="..."> for instance). Strip everything that looks like
//     a tag.
//   - **Zero-width characters** (U+200B/C/D/FEFF) that can hide
//     content in the text (homoglyph attacks, hidden tracking).
//   - **RTL/LTR overrides** (U+202A-202E, U+2066-2069) that flip
//     visible text direction — used in phishing to make a URL look
//     legitimate.
//   - **Excessive length** — a runaway blank shouldn't be able to
//     inject megabytes of text into the user's editor.
//
// Authors can opt out via `output: rich` in BLANK.md frontmatter
// (passed as `allowRich: true` to sanitizeBlankOutput). Use only when
// the blank's output is genuinely meant to be HTML / contain control
// chars (e.g. emoji selectors that need ZWJ sequences).

const MAX_LENGTH = 8192;

// Zero-width: ZWSP, ZWNJ, ZWJ, BOM
const ZERO_WIDTH = /[\u200B\u200C\u200D\uFEFF]/g;
// Bidi override / isolate: LRE/RLE/PDF/LRO/RLO + isolates
const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/g;
// Tag-like sequences. Conservative: anything that looks like <tag>
// or </tag>, including with attributes. Won't catch every clever
// encoding but blocks the common cases.
const HTML_TAG = /<\/?\s*[a-zA-Z][^>]*>/g;

export interface SanitizeOptions {
  /** When true, skip Unicode/HTML stripping. Length cap still applies.
   *  Use for blanks that intentionally return rich text (emoji
   *  selectors, code samples with `<` literals, etc.). */
  readonly allowRich?: boolean;
}

export function sanitizeBlankOutput(input: unknown, opts: SanitizeOptions = {}): string {
  if (input === null || input === undefined) return '';
  let s = String(input);

  if (!opts.allowRich) {
    s = s.replace(HTML_TAG, '');
    s = s.replace(ZERO_WIDTH, '');
    s = s.replace(BIDI_OVERRIDES, '');
    // NFKC: normalize compatibility (catches visually-similar
    // codepoints like fullwidth Latin → ASCII).
    try { s = s.normalize('NFKC'); } catch { /* very old runtimes */ }
  }

  if (s.length > MAX_LENGTH) {
    s = s.slice(0, MAX_LENGTH);
  }
  return s;
}
