/**
 * opencues-core/sources/fluid-blank-source.ts
 *
 * Fluid blank — handles arbitrary natural-language lookup queries embedded
 * in casual prose. Two-pass pipeline:
 *
 *   P1 SEGMENT  →  identifies the lookup span (incl. `_`) within the input
 *   P3 ANSWER   →  produces the canonical short answer for the span
 *
 * Replacement mode (FILL vs WIPE) is decided deterministically from the
 * input shape — no extra LLM call:
 *
 *   FILL:  input ends with copula/equation/question marker before `_`
 *          ("the capital of france is _", "4 * 12 = _", "X? _")
 *          → substitute only `_`, preserve surrounding sentence
 *
 *   WIPE:  input ends with `_` after a bare lookup phrase
 *          ("capital of france _", "trivia tonight founder of microsoft _")
 *          → substitute the whole span, the lookup phrase disappears
 *
 * History: developed via the tests/benchmarks/fluid-blank/ benchmark
 * harness. See BUILD-LOG.md in that directory for the iteration journal
 * and the empirical case for why this exists.
 */

import { CueSource, CueContext, CueSourceResult, CueResult, HttpAdapter } from '../types';
import { BlankConfig } from '../cues-md';
import { getProvider, type ProviderAdapter } from '../llm-provider';

export const P1_SYSTEM_PROMPT = `You identify a SPAN of text that will be wiped and replaced with an answer.

The user is typing a casual note/sentence and has dropped an underscore (_) next to a TERSE LOOKUP PHRASE — something they want looked up, like a search query. Examples of lookup phrases: "unicode for ampersand", "ascii code for tab", "synonyms for happy", "hex for blue", "100 celsius in fahrenheit", "stock price of aapl", "etymology of paradigm", "capital of france", "atomic number of oxygen", "year apollo 11 landed on moon", "author of pride and prejudice". The SPAN is the lookup phrase together with the underscore — the chunk that should be wiped and replaced with the answer alone.

The lookup phrase does NOT need to flow grammatically with — or even be semantically related to — the surrounding text. It can be a complete NON-SEQUITUR the user has dropped into the middle of unrelated chatter (e.g. "talking about pizza unicode for ampersand _ anyway back to pizza"). Find the lookup phrase by its SHAPE, not by how it fits the sentence.

Output exactly two lines, nothing else:
SPAN: <exact contiguous substring of the input, including the _>
CONTEXT: <words from the input that fall OUTSIDE the span, joined verbatim; or "none" if the span covers everything>

RULES:
1. The SPAN must be an exact CONTIGUOUS substring of the input. Do not paraphrase, do not add words, and DO NOT skip any words. If the input has "X is _ Y", the SPAN must keep "is" if you include both X and the _: write "X is _", never "X _".
2. The SPAN MUST contain the underscore (_).
3. The SPAN should be the LOOKUP PHRASE plus the _ — typically 2–10 words. NEVER output just "_" alone. Always extend to include the lookup-phrase words next to it.
4. Output SPAN: NONE only when the underscore is a TYPING/UI PLACEHOLDER with no associated lookup query (e.g. "fix _ here", "click _ to continue"). Even when the surrounding sentence is casual chatter, OR when an earlier clause is a complete fact-statement with its answer already baked in, if a recognisable lookup phrase sits next to _, extract it — do NOT bail to NONE.

HOW TO PICK THE SPAN — try in order:

A. Look at what's IMMEDIATELY ADJACENT to _ on either side. The lookup phrase is whichever side reads like a search query ("X for Y", "X of Y", "X to Y", "X in Y", "what is X", "how many X").
B. If the lookup phrase comes BEFORE _: SPAN starts at the first lookup-phrase word, ends at _. Trim leading filler ("ok so", "hmm", "i need", "i was thinking", "i'm writing docs", "the answer is", "i think it's", "physics class today").
C. If the lookup phrase comes AFTER _: SPAN starts at _, ends at the last lookup-phrase word. Trim leading filler before _ and trailing filler after.
D. After picking the side, trim trailing filler clauses ("for my parser", "thx", "in css", "of course", "interesting day", "wonder if it's hot") so the SPAN is the minimal lookup query.

E. AMBIENT PATTERN — when the input has the shape "[bookend phrase]. [middle clause containing _]. [other bookend]." (period-separated bookends bracketing a clause containing _), the SPAN is the middle clause itself. The _ may sit at the START ("_ is X"), MIDDLE ("X is _ Y"), or END ("X is _" / "X _") of the middle clause — all three are valid. The bookend phrases are always filler. ALWAYS extract the middle clause — NEVER bail to NONE for this shape.

F. PERIOD-SPLIT HEURISTIC: if the input contains one or more periods ('.'), split on '.' to get sentences. Find the sentence that contains the _. That sentence (with leading/trailing filler trimmed inside it via rules B/C/D) IS your SPAN. Sentences that do NOT contain the _ are filler regardless of their content — they go in CONTEXT verbatim with their periods preserved.

G. EMBEDDED-WH PATTERN: when the input is a chat or text message (possibly multi-sentence, possibly addressed to another person) and the lookup phrase begins with a wh-word ("what is", "what's", "where is", "where's", "name of", "who is", "who's", "when did", "how many", "how do you"), the SPAN starts AT the wh-word and extends through the end of the lookup phrase including the _. Everything before the wh-word — even if multi-sentence — is filler, regardless of how conversational/long the preamble is. NEVER bail to NONE on this shape: the wh-word IS your anchor.

H. COMPACT FACTUAL PATTERN: when the input is a SHORT factual sentence (under 10 words, no preamble framing, no chatter) containing a _, the SPAN is the ENTIRE input. Examples: "Water boils at _ degrees Celsius", "There are _ continents", "A year has _ days", "Pi equals approximately _", "CIA stands for Central _ Agency". No preamble to strip — output the whole sentence as SPAN. NEVER bail to NONE on a short factual claim that contains _.

EXAMPLES:

INPUT: unicode for ampersand _ where do i put it
SPAN: unicode for ampersand _
CONTEXT: where do i put it

INPUT: ascii code for tab _ for my parser
SPAN: ascii code for tab _
CONTEXT: for my parser

INPUT: i need synonyms for happy _ thx
SPAN: synonyms for happy _
CONTEXT: i need thx

INPUT: stock price of aapl _ checking my portfolio
SPAN: stock price of aapl _
CONTEXT: checking my portfolio

INPUT: the cube root of 27 is _ that's all i need
SPAN: the cube root of 27 is _
CONTEXT: that's all i need

INPUT: i know hex for red is ff0000 and hex for green is _
SPAN: hex for green is _
CONTEXT: i know hex for red is ff0000 and

INPUT: writing some css. _ hex for blue. neat.
SPAN: _ hex for blue
CONTEXT: writing some css. neat.

INPUT: lemme check this. _ http status for not found. ok cool.
SPAN: _ http status for not found
CONTEXT: lemme check this. ok cool.

INPUT: writing a book. better word for tired _ for chapter 3.
SPAN: better word for tired _
CONTEXT: writing a book. for chapter 3.

INPUT: art project. 8 in roman numerals _ for the title page.
SPAN: 8 in roman numerals _
CONTEXT: art project. for the title page.

INPUT: i'm working on this thing. _ is the diameter of jupiter in km. neat.
SPAN: _ is the diameter of jupiter in km
CONTEXT: i'm working on this thing. neat.

INPUT: looking up etymology of paradigm and etymology of synergy _
SPAN: etymology of synergy _
CONTEXT: looking up etymology of paradigm and

INPUT: spent the morning reviewing client deliverables and finalizing the contract negotiations with the new vendor before lunch break _ atomic number of iron
SPAN: _ atomic number of iron
CONTEXT: spent the morning reviewing client deliverables and finalizing the contract negotiations with the new vendor before lunch break

INPUT: travel planning chat I wonder what is the mime type for avi _
SPAN: what is the mime type for avi _
CONTEXT: travel planning chat I wonder

INPUT: hey when are you free we can go to what is a good club in central london _
SPAN: what is a good club in central london _
CONTEXT: hey when are you free we can go to

INPUT: Water boils at _ degrees Celsius
SPAN: Water boils at _ degrees Celsius
CONTEXT: none

INPUT: There are _ continents
SPAN: There are _ continents
CONTEXT: none

INPUT: A year has _ days
SPAN: A year has _ days
CONTEXT: none

INPUT: click _ to continue and then submit the form
SPAN: NONE
CONTEXT: click _ to continue and then submit the form`;

export const P3_SYSTEM_PROMPT = `You answer a lookup query and produce the canonical SHORT answer that would substitute for the SPAN when it gets wiped.

You receive:
- SPAN: the lookup query (contains a literal _ where the answer goes)
- CONTEXT: text surrounding the span. Most of the time CONTEXT is unrelated chatter and should be IGNORED. Rarely CONTEXT contains disambiguating info (e.g. naming a country whose river/capital the span asks about).

Output exactly one line, nothing else:
ANSWER: <the answer>

RULES:
1. Be TERSE. One value. No "The capital of France is Paris" — just "Paris".
2. For numbers/codes, use the most common form: "404" not "HTTP 404 Not Found"; "Paris" not "Paris, France"; "U+2014" not "U+2014 (em dash)".
3. Use CONTEXT ONLY when SPAN is genuinely ambiguous on its own (e.g. "the largest river is _" without specifying a country). Otherwise IGNORE CONTEXT — it's chatter.
4. When SPAN already names units ("100 celsius in fahrenheit _"), output the bare number ("212") — the unit is implied by the question.
5. If you don't know with certainty, output your best guess. Do NOT refuse, do NOT say "I'm not sure", do NOT explain.
6. For numeric answers, round to at most 4 decimal places unless the answer is naturally exact.
7. Strip surrounding markdown/quotes from the answer.

EXAMPLES:

SPAN: capital of france _
CONTEXT: trivia tonight
ANSWER: Paris

SPAN: unicode for em dash _
CONTEXT: writing docs
ANSWER: U+2014

SPAN: 100 celsius in fahrenheit _
CONTEXT: recipe testing
ANSWER: 212

SPAN: atomic number of gold _
CONTEXT: chem homework
ANSWER: 79

SPAN: default port for postgres _
CONTEXT: config review
ANSWER: 5432

SPAN: the largest river is _
CONTEXT: the capital of france is paris and
ANSWER: Loire

SPAN: hex for purple? _
CONTEXT: css palette
ANSWER: #800080

SPAN: how many planets in our solar system? _
CONTEXT: astronomy worksheet
ANSWER: 8

SPAN: french word for love _
CONTEXT: anniversary card
ANSWER: amour

SPAN: regex for matching a single digit _
CONTEXT: form validation
ANSWER: \\d

SPAN: 14 in roman numerals _
CONTEXT: art project
ANSWER: XIV

SPAN: currency code for switzerland _
CONTEXT: trip planning
ANSWER: CHF`;

/**
 * Decide whether the user wants the answer to FILL the `_` (preserve the
 * surrounding sentence) or WIPE the entire lookup phrase.
 *
 * Heuristic — purely deterministic, no LLM call:
 *   - input ends with copula/equation/question marker before `_` → FILL
 *     ("...is _", "...are _", "...= _", "...? _", "...: _")
 *   - else → WIPE
 *
 * `_` mid-sentence is treated as FILL by default (the only realistic way
 * `_` appears mid-sentence is in textbook-style fill-in-the-blank inputs
 * like "Water boils at _ degrees Celsius"). In live typing flow, `_` is
 * always at the trailing edge of what the user has typed.
 */
export function determineReplaceMode(input: string): 'FILL' | 'WIPE' {
  const s = input.trim();
  if (!s.endsWith('_')) return 'FILL';
  if (/(?:\b(?:is|are|was|were|am|be|equals)|=|:|\?)\s+_$/i.test(s)) return 'FILL';
  return 'WIPE';
}

/**
 * Locate `span` inside `text` and return its character [start, end) offsets.
 * Returns null if the span isn't found verbatim.
 *
 * The runtime uses character offsets in WordDef.spanStart/spanEnd (not word
 * indices), so CueResult.spanStart/spanEnd must also be characters.
 */
function findSpanCharRange(span: string, text: string): [number, number] | null {
  const trimmed = span.trim();
  if (!trimmed) return null;
  const idx = text.indexOf(trimmed);
  if (idx === -1) return null;
  return [idx, idx + trimmed.length];
}

export interface FluidBlankSourceConfig {
  httpAdapter: HttpAdapter;
  /** Defaults to the Groq adapter when omitted (legacy single-provider wiring). */
  provider?: ProviderAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Source priority. Default 92 — sits below keyword-bound BlankSource
   * (95) so a blank claims a slot whose keyword is in proximity, fluid
   * handles everything else. */
  priority?: number;
  /** All registered keyword-bound blanks. fluid-blank cedes the slot when a
   * blank would actually claim the `_` (its keyword matches AND fits within
   * `blankProximity`). Earlier we ceded on any keyword match anywhere in the
   * input — that left a dead zone for inputs like `what is git as in github
   * _` where dictionary's `what is` was present but too far from `_` to
   * claim. Now fluid mirrors BlankSource's claim rules so the dead zone is
   * gone. */
  blanks?: Record<string, BlankConfig>;
}

export class FluidBlankSource implements CueSource {
  readonly id = 'fluid-blank';
  readonly priority: number;

  private httpAdapter: HttpAdapter;
  private provider: ProviderAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private blanks: Record<string, BlankConfig>;

  constructor(config: FluidBlankSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.provider = config.provider ?? getProvider('groq')!;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.priority = config.priority ?? 92;
    this.blanks = config.blanks ?? {};
  }

  supports(context: CueContext): boolean {
    const lower = context.words.map(w => w.toLowerCase());
    const blankIndex = lower.indexOf('_');
    if (blankIndex === -1) return false;
    // Cede the slot to BlankFill if any registered blank would actually
    // claim it. Mirror BlankSource's claim rules: keyword present AND
    // within `blankProximity` words of the `_`. Loose-match (keyword
    // present anywhere) leaves a dead zone for inputs like `what is git
    // as in github _` where the keyword is too far to claim.
    for (const blk of Object.values(this.blanks)) {
      if (!blk.blankKeywords?.length) continue;
      const proximity = blk.blankProximity ?? 0;
      for (const phrase of blk.blankKeywords) {
        const parts = phrase.toLowerCase().split(/\s+/);
        for (let i = 0; i <= lower.length - parts.length; i++) {
          let ok = true;
          for (let j = 0; j < parts.length; j++) {
            if (lower[i + j] !== parts[j]) { ok = false; break; }
          }
          if (!ok) continue;
          const endIdx = i + parts.length - 1;
          const gap = Math.abs(endIdx - blankIndex) - 1;
          if (gap <= proximity) return false;   // BlankSource will claim
        }
      }
    }
    return true;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    try {
      const blankIdx = context.words.indexOf('_');
      if (blankIdx === -1) return { results: [] };

      // P1 SEGMENT
      const segOut = await this.callLLM(P1_SYSTEM_PROMPT, `INPUT: ${context.text}`, 256);
      const span = parseSpan(segOut);
      const ctx = parseContext(segOut);
      if (!span) return { results: [], timing: Date.now() - startTime, model: this.model };

      // P3 ANSWER
      const ansOut = await this.callLLM(P3_SYSTEM_PROMPT, `SPAN: ${span}\nCONTEXT: ${ctx || 'none'}`, 200);
      const answer = parseAnswer(ansOut);
      if (!answer) return { results: [], timing: Date.now() - startTime, model: this.model };

      // Replacement mode
      const mode = determineReplaceMode(context.text);

      const result: CueResult = {
        wordIndex: blankIdx,
        word: '_',
        alternatives: ['_', answer],
        source: this.id,
        priority: this.priority,
        metadata: { fluidBlankMode: mode, span, context: ctx },
      };

      // For WIPE mode: mark the multi-word span so the runtime knows to
      // wipe the lookup phrase, not just the `_` token. spanStart/spanEnd
      // are CHARACTER offsets (matching WordDef in the runtime).
      // Alternatives stay ['_', answer] — cycling back to `_` clears the
      // lookup phrase to a bare blank rather than restoring the full
      // queried text. The lookup phrase is consumed by the substitution.
      if (mode === 'WIPE') {
        const range = findSpanCharRange(span, context.text);
        if (range) {
          result.spanStart = range[0];
          result.spanEnd = range[1];
        }
      }

      return { results: [result], timing: Date.now() - startTime, model: this.model };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  private async callLLM(system: string, user: string, maxTokens: number): Promise<string> {
    const built = this.provider.buildRequest(
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens,
        temperature: 0,
        reasoningEffort: 'low',
        seed: 42,
      },
      { apiKey: this.apiKey, endpoint: this.endpoint },
    );
    const response = await this.httpAdapter.post(built.url, built.body, built.headers);
    return this.provider.parseResponse(response);
  }
}

function parseSpan(raw: string): string | null {
  const m = raw.match(/^SPAN:\s*(.*?)$/m);
  if (!m) return null;
  const v = m[1].trim();
  if (!v || v.toUpperCase() === 'NONE') return null;
  return v;
}

function parseContext(raw: string): string {
  const m = raw.match(/^CONTEXT:\s*(.*?)$/m);
  return m ? m[1].trim() : '';
}

function parseAnswer(raw: string): string | null {
  const m = raw.match(/^ANSWER:\s*(.+?)$/m);
  if (!m) return null;
  const v = m[1].trim();
  return v.length > 0 ? v : null;
}
