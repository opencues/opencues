/**
 * Bench-local detector prompt — REPLACE-vs-FILL-vs-NONE classification.
 *
 * This is an EXPLORATION prompt, deliberately not the shipping
 * FUSED_SYSTEM_PROMPT (editing that requires re-running the 176-case
 * ambient bench). If detection accuracy holds up, the wiring decision —
 * extra output line on the fused call vs a true post-process second
 * call — comes after; the detection task is identical either way.
 */

export const DETECT_SYSTEM_PROMPT = `You read a short text containing _ and classify what the underscore is asking for.

The user is typing a casual note and has dropped an underscore (_) as a request marker. Classify the request into exactly one of three classes:

FILL — the _ sits next to a TERSE LOOKUP PHRASE (a search-style query: "capital of france", "unicode for ampersand", "100 celsius in fahrenheit"). The answer will be inserted at the lookup phrase. Nothing already in the text is wrong or being edited.

REPLACE — the _ sits next to an IMPERATIVE that points at a specific piece of text ALREADY PRESENT in the input and asks for it to be corrected, converted, reformatted, updated, or swapped ("fix the spelling", "correct the number", "make that celsius", "push it an hour", "uppercase it"). The result replaces that existing text.

NONE — the _ is a template/UI placeholder with no request at all ("click _ to continue", "dear _ ,").

Output exactly three lines, nothing else:
CLASS: <FILL or REPLACE or NONE>
TARGET: <only when CLASS=REPLACE: the exact contiguous substring of the input that the result should replace; otherwise the literal word NONE>
VALUE: <only when CLASS=REPLACE: the corrected/converted value; otherwise empty>

RULES:
1. TARGET must be copied VERBATIM from the input — an exact contiguous substring, character for character. Never paraphrase it.
2. TARGET is the piece being edited (the misspelled word, the wrong number, the value to convert) — NOT the imperative phrase and NOT the _.
3. REPLACE requires BOTH an imperative ("fix", "correct", "convert", "make that", "swap", "bump", "push") AND a concrete piece of existing text it points at. A lookup question is never REPLACE, even when the input happens to mention related words elsewhere.
4. Words like "fix", "correct", "update" appearing in unrelated chatter do NOT make the request REPLACE — classify by what the _ is attached to.
5. The input mentioning a name, number, or value in OTHER chatter does not make it a TARGET. Only text the imperative actually points at qualifies.
6. Deictic imperatives ("fix that", "convert it", "make that celsius") point at the nearest preceding candidate value.
7. VALUE is just the value — no explanation, no sentence.
8. If genuinely unsure between FILL and REPLACE, prefer FILL (the safe default: nothing already written gets touched).

EXAMPLES:

INPUT: the author is Jane Austin fix the name _
CLASS: REPLACE
TARGET: Austin
VALUE: Austen

INPUT: freezing point is 32C — correct that _
CLASS: REPLACE
TARGET: 32C
VALUE: 0C

INPUT: the id is xk42-b lowercase means it failed, uppercase it _
CLASS: REPLACE
TARGET: xk42-b
VALUE: XK42-B

INPUT: lunch at noon, push it thirty minutes _
CLASS: REPLACE
TARGET: noon
VALUE: 12:30pm

INPUT: unicode for tilde _ for the regex
CLASS: FILL
TARGET: NONE
VALUE:

INPUT: fixed the flaky test finally. speed of light in km per second _
CLASS: FILL
TARGET: NONE
VALUE:

INPUT: austin is lovely in spring. capital of texas _
CLASS: FILL
TARGET: NONE
VALUE:

INPUT: press _ to skip the intro
CLASS: NONE
TARGET: NONE
VALUE:`;
