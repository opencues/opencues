/**
 * Replace-parse detector — the `replace-parse-mode` feature's LLM half.
 *
 * Detects when an imperative `_` ask is REPLACEMENT-shaped: the answer
 * should replace one exact existing substring of the buffer ("her name
 * is Sarha fix the spelling _" → replace "Sarha" with "Sarah"), rather
 * than needing a whole-buffer rewrite.
 *
 * Runs INSIDE TransformBlankSource, dispatched in PARALLEL with the
 * FUSED call (zero added wall-clock). On a verified detection the
 * source emits `metadata.transformTarget` + `transformInstruction`, so
 * the result rides the resolver's existing bounded-splice branch (the
 * machinery kept from the retired 3-pass pipeline — see
 * docs/architecture/blank-sources.md decision table row 2 and
 * resolver.ts's transformTarget branch). On ANYTHING else — wrong
 * class, unverifiable target, LLM error — the caller falls through to
 * the fused whole-buffer merge exactly as before. The detector can
 * only ever UPGRADE a dispatch to a deterministic splice; it can never
 * degrade or block one.
 *
 * Every acceptance condition here is deterministic and runtime-owned:
 * the LLM proposes strings, the runtime verifies them against the
 * actual buffer before any geometry is derived from them. That is the
 * same trick FluidBlank's SPAN line uses, and it is what keeps the
 * May-2026 duplication bug class (splicing on an LLM-claimed span)
 * structurally impossible here.
 *
 * Detection accuracy: tests/benchmarks/fluid-blank-replace/ — 96-100%
 * class accuracy with ZERO fill→replace false positives across four
 * production-candidate models (2026-08-27).
 */

/** Max tokens for the detector call — output is four short lines. */
export const REPLACE_DETECT_MAX_TOKENS = 300;

export const REPLACE_DETECT_SYSTEM_PROMPT = `You read a short text containing _ and classify what the underscore is asking for.

The user is typing a casual note and has dropped an underscore (_) as a request marker. Classify the request into exactly one of three classes:

FILL — the _ sits next to a TERSE LOOKUP PHRASE (a search-style query: "capital of france", "unicode for ampersand", "100 celsius in fahrenheit"). The answer will be inserted at the lookup phrase. Nothing already in the text is wrong or being edited.

REPLACE — the _ sits next to an IMPERATIVE that points at a specific piece of text ALREADY PRESENT in the input and asks for it to be corrected, converted, reformatted, updated, or swapped ("fix the spelling", "correct the number", "make that celsius", "push it an hour", "uppercase it"). The result replaces that existing text.

NONE — the _ is a template/UI placeholder with no request at all ("click _ to continue", "dear _ ,"), OR the request is anything other than a single-substring replacement (a whole-text rewrite, a translation, a tone change, generating new content).

Output exactly four lines, nothing else:
CLASS: <FILL or REPLACE or NONE>
COMMAND: <only when CLASS=REPLACE: the exact contiguous substring of the input holding the imperative phrase AND the _; otherwise the literal word NONE>
TARGET: <only when CLASS=REPLACE: the exact contiguous substring of the input that the result should replace; otherwise the literal word NONE>
VALUE: <only when CLASS=REPLACE: the corrected/converted value; otherwise empty>

RULES:
1. COMMAND and TARGET must each be copied VERBATIM from the input — exact contiguous substrings, character for character. Never paraphrase either.
2. COMMAND is the imperative phrase together with the _ ("fix the spelling _", "make that celsius _"). It never includes the text being edited.
3. TARGET is the piece being edited (the misspelled word, the wrong number, the value to convert) — NOT the imperative phrase and NOT the _.
4. REPLACE requires BOTH an imperative AND a concrete piece of existing text it points at. A lookup question is never REPLACE, even when the input happens to mention related words elsewhere.
5. Words like "fix", "correct", "update" appearing in unrelated chatter do NOT make the request REPLACE — classify by what the _ is attached to.
6. The input mentioning a name, number, or value in OTHER chatter does not make it a TARGET. Only text the imperative actually points at qualifies.
7. Deictic imperatives ("fix that", "convert it", "make that celsius") point at the nearest preceding candidate value.
8. An edit that cannot be expressed as replacing ONE contiguous substring (rewrite the whole thing, fix ALL the typos, translate this) is NONE — another pipeline owns it.
9. VALUE is just the value — no explanation, no sentence.
10. If genuinely unsure between FILL and REPLACE, prefer FILL (the safe default: nothing already written gets touched).

EXAMPLES:

INPUT: the author is Jane Austin fix the name _
CLASS: REPLACE
COMMAND: fix the name _
TARGET: Austin
VALUE: Austen

INPUT: freezing point is 32C — correct that _
CLASS: REPLACE
COMMAND: correct that _
TARGET: 32C
VALUE: 0C

INPUT: the id is xk42-b lowercase means it failed, uppercase it _
CLASS: REPLACE
COMMAND: uppercase it _
TARGET: xk42-b
VALUE: XK42-B

INPUT: lunch at noon, push it thirty minutes _
CLASS: REPLACE
COMMAND: push it thirty minutes _
TARGET: noon
VALUE: 12:30pm

INPUT: unicode for tilde _ for the regex
CLASS: FILL
COMMAND: NONE
TARGET: NONE
VALUE:

INPUT: fixed the flaky test finally. speed of light in km per second _
CLASS: FILL
COMMAND: NONE
TARGET: NONE
VALUE:

INPUT: austin is lovely in spring. capital of texas _
CLASS: FILL
COMMAND: NONE
TARGET: NONE
VALUE:

INPUT: rewrite this whole paragraph to sound formal _
CLASS: NONE
COMMAND: NONE
TARGET: NONE
VALUE:

INPUT: press _ to skip the intro
CLASS: NONE
COMMAND: NONE
TARGET: NONE
VALUE:`;

export interface ReplaceDetection {
  cls: 'fill' | 'replace' | 'none' | '';
  command: string;
  target: string;
  value: string;
}

/** Parse the detector's four-line output. Tolerant of casing and
 *  surrounding noise; unknown class parses as ''. */
export function parseReplaceDetect(raw: string): ReplaceDetection {
  const grab = (label: string) => {
    const m = raw.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'mi'));
    return m ? m[1].trim() : '';
  };
  const clsRaw = grab('CLASS').toLowerCase();
  const cls = clsRaw === 'fill' || clsRaw === 'replace' || clsRaw === 'none' ? clsRaw : '';
  return { cls, command: grab('COMMAND'), target: grab('TARGET'), value: grab('VALUE') };
}

export interface VerifiedReplace {
  /** Exact substring of the buffer to replace (unique occurrence). */
  target: string;
  /** The imperative phrase with the trailing `_` stripped — the shape
   *  resolver.ts's locateTrigger expects (it re-finds the phrase and
   *  requires a following `_`). */
  instruction: string;
  /** The replacement value (the rewrite of the target span only). */
  value: string;
}

/** Substitute `[TOKEN]`s the detector echoed back with their catalog
 *  values, so verification runs in value space even when the outbound
 *  text was dehydrated. Unknown tokens are left alone (they'll fail
 *  the substring check and the caller falls back to fused — safe). */
function hydrateField(s: string, catalog: ReadonlyMap<string, string> | undefined): string {
  if (!catalog || catalog.size === 0 || !s.includes('[')) return s;
  let out = s;
  for (const [token, value] of catalog) out = out.split(token).join(value);
  return out;
}

/**
 * Deterministic acceptance gate. Returns the verified splice inputs, or
 * null with a logged reason — null ALWAYS means "fall back to the fused
 * whole-buffer path", never an error surfaced to the user.
 *
 * v1 deliberately requires the target to occur EXACTLY ONCE in the
 * buffer: the resolver's splice uses indexOf (first occurrence), so a
 * repeated target would be ambiguous geometry. Ambiguity → fused, which
 * handles it fine.
 */
export function verifyReplaceDetect(
  text: string,
  det: ReplaceDetection,
  opts?: { catalog?: ReadonlyMap<string, string>; log?: (msg: string) => void },
): VerifiedReplace | null {
  const log = opts?.log ?? (() => {});
  if (det.cls !== 'replace') return null;

  const command = hydrateField(det.command, opts?.catalog);
  const target = hydrateField(det.target, opts?.catalog);
  const value = hydrateField(det.value, opts?.catalog);

  if (!target || target.toUpperCase() === 'NONE'
    || !command || command.toUpperCase() === 'NONE' || !value) {
    log('replace-detect: REPLACE class but empty command/target/value — falling back to fused');
    return null;
  }
  if (!command.includes('_')) {
    log('replace-detect: COMMAND lacks the _ — falling back to fused');
    return null;
  }
  const commandIdx = text.indexOf(command);
  if (commandIdx < 0) {
    log('replace-detect: COMMAND is not a verbatim substring — falling back to fused');
    return null;
  }
  const commandEnd = commandIdx + command.length;
  // Occurrence rule. The target must occur exactly ONCE outside the
  // command span — copies INSIDE the command are the user naming the
  // target in the imperative ("swap kids for the formal word _") and
  // don't make the edit ambiguous. Zero outside occurrences means the
  // detector mistook a command word for the operand ("fix the code _"
  // → target "code"); two or more is genuinely ambiguous geometry.
  const outside: number[] = [];
  let scan = text.indexOf(target);
  while (scan >= 0) {
    const end = scan + target.length;
    if (end <= commandIdx || scan >= commandEnd) outside.push(scan);
    scan = text.indexOf(target, scan + 1);
  }
  if (outside.length !== 1) {
    log(`replace-detect: TARGET occurs ${outside.length}× outside the command (need exactly 1 for unambiguous splice) — falling back to fused`);
    return null;
  }
  // The resolver's splice locates the target via indexOf (FIRST
  // occurrence). If a command-internal copy precedes the real one,
  // that splice would land inside the command — reject to fused.
  if (text.indexOf(target) !== outside[0]) {
    log('replace-detect: TARGET first occurrence is inside the command — resolver would splice the wrong copy; falling back to fused');
    return null;
  }
  if (value === target) {
    log('replace-detect: VALUE equals TARGET (no-op) — falling back to fused');
    return null;
  }
  const instruction = command.replace(/\s*_\s*$/, '').trim();
  if (!instruction) {
    log('replace-detect: instruction empty after stripping _ — falling back to fused');
    return null;
  }
  return { target, instruction, value };
}
