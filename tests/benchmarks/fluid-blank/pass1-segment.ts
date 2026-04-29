/**
 * Pass 1: SEGMENT
 *
 * Identifies the contiguous substring (including the _) that should be
 * wiped + replaced with an answer. Returns SPAN: NONE when no question
 * is detectable.
 *
 * Output format is a 2-line delimited block (not JSON) — easier for a
 * small model to follow consistently and trivial to parse.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You identify a SPAN of text that will be wiped and replaced with an answer.

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

INPUT: convert 100 celsius to fahrenheit _ wonder if it's hot
SPAN: 100 celsius to fahrenheit _
CONTEXT: convert wonder if it's hot

INPUT: stock price of aapl _ checking my portfolio
SPAN: stock price of aapl _
CONTEXT: checking my portfolio

INPUT: the cube root of 27 is _ that's all i need
SPAN: the cube root of 27 is _
CONTEXT: that's all i need

INPUT: i know hex for red is ff0000 and hex for green is _
SPAN: hex for green is _
CONTEXT: i know hex for red is ff0000 and

INPUT: hmm _ unicode for ampersand
SPAN: _ unicode for ampersand
CONTEXT: hmm

INPUT: the result is _ celsius to kelvin 25
SPAN: _ celsius to kelvin 25
CONTEXT: the result is

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

INPUT: looking up etymology of paradigm and etymology of synergy _
SPAN: etymology of synergy _
CONTEXT: looking up etymology of paradigm and

INPUT: ok so _ — what is the freezing point of mercury
SPAN: _ — what is the freezing point of mercury
CONTEXT: ok so

INPUT: talking about pizza last night unicode for ampersand _ anyway back to pizza
SPAN: unicode for ampersand _
CONTEXT: talking about pizza last night anyway back to pizza

INPUT: great weather today _ ascii code for tab heading out for lunch
SPAN: _ ascii code for tab
CONTEXT: great weather today heading out for lunch

INPUT: spent the morning reviewing client deliverables and finalizing the contract negotiations with the new vendor before lunch break _ atomic number of iron
SPAN: _ atomic number of iron
CONTEXT: spent the morning reviewing client deliverables and finalizing the contract negotiations with the new vendor before lunch break

INPUT: patient came in late afternoon presenting tachycardic and hypertensive with elevated d-dimer suggesting workup for pe ruled out by ctpa _ tallest mountain in europe
SPAN: _ tallest mountain in europe
CONTEXT: patient came in late afternoon presenting tachycardic and hypertensive with elevated d-dimer suggesting workup for pe ruled out by ctpa

INPUT: travel planning chat I wonder what is the mime type for avi _
SPAN: what is the mime type for avi _
CONTEXT: travel planning chat I wonder

INPUT: hey when are you free we can go to what is a good club in central london _
SPAN: what is a good club in central london _
CONTEXT: hey when are you free we can go to

INPUT: music lesson prep i'm arranging tomorrow's rehearsal schedule. can you let me know what is the key signature with 2 sharps _
SPAN: what is the key signature with 2 sharps _
CONTEXT: music lesson prep i'm arranging tomorrow's rehearsal schedule. can you let me know

INPUT: team chat about the upcoming demo let me know who is the inventor of the laser printer _
SPAN: who is the inventor of the laser printer _
CONTEXT: team chat about the upcoming demo let me know

INPUT: Water boils at _ degrees Celsius
SPAN: Water boils at _ degrees Celsius
CONTEXT: none

INPUT: There are _ continents
SPAN: There are _ continents
CONTEXT: none

INPUT: A year has _ days
SPAN: A year has _ days
CONTEXT: none

INPUT: Pi equals approximately _
SPAN: Pi equals approximately _
CONTEXT: none

INPUT: CIA stands for Central _ Agency
SPAN: CIA stands for Central _ Agency
CONTEXT: none

INPUT: click _ to continue and then submit the form
SPAN: NONE
CONTEXT: click _ to continue and then submit the form`;

export interface SegmentResult {
  /** Substring including the _, or null if SPAN: NONE */
  span: string | null;
  /** Surrounding context, or empty string */
  context: string;
  /** Raw model output for debugging */
  raw: string;
  /** P1 latency */
  latencyMs: number;
}

export async function runP1Segment(input: string): Promise<SegmentResult> {
  const result = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens: 256 });
  return parseSegmentOutput(result.text, result.latencyMs);
}

export function parseSegmentOutput(raw: string, latencyMs: number): SegmentResult {
  const spanMatch = raw.match(/^SPAN:\s*(.*?)$/m);
  const contextMatch = raw.match(/^CONTEXT:\s*(.*?)$/m);
  const spanRaw = spanMatch ? spanMatch[1].trim() : '';
  const context = contextMatch ? contextMatch[1].trim() : '';
  const span = (!spanRaw || spanRaw.toUpperCase() === 'NONE') ? null : spanRaw;
  return { span, context, raw, latencyMs };
}
