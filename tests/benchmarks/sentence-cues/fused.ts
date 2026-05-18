/**
 * Batch system prompt for the `more-formal` sentence cue.
 *
 * One LLM call per buffer. Input is the full text the user has typed.
 * Output enumerates each detected sentence with ≥3 alternative
 * rewrites OR the literal token NONE when the sentence is too short /
 * already formal / not prose.
 *
 * Output shape (line-delimited, regex-parsed):
 *
 *   SENTENCE: <verbatim sentence text>
 *   ALT: <rewrite 1>
 *   ALT: <rewrite 2>
 *   ALT: <rewrite 3>
 *   ---
 *   SENTENCE: <next sentence>
 *   ALT: ...
 *
 * NONE marker:
 *
 *   SENTENCE: <verbatim>
 *   ALT: NONE
 *   ---
 *
 * Why batch (one call) vs per-sentence (N calls):
 *  - Cheaper on multi-sentence buffers.
 *  - LLM has whole-buffer context for tone consistency across alts.
 *  - Single error path (parse failure aborts the buffer's whole cue
 *    pass rather than leaving N partially-cued sentences).
 */

import { chat, sysUser } from './groq';

export const SYSTEM_PROMPT = `You rewrite SENTENCES to be more FORMAL.

You receive a buffer of plain text the user has typed. Split it into sentences and, for EACH sentence, output either three more-formal rewrites OR the literal token NONE.

OUTPUT FORMAT (exact, line-delimited):

  SENTENCE: <verbatim sentence as it appears in the input>
  ALT: <rewrite 1>
  ALT: <rewrite 2>
  ALT: <rewrite 3>
  ---
  SENTENCE: <next sentence>
  ALT: ...
  ---

The trailing "---" separator is required after every sentence block, including the last.

WHEN TO EMIT ALTS:
  - The sentence is INFORMAL / CASUAL / colloquial and a useful formal rewrite exists.
  - The sentence is PROSE — not code, not a command, not an identifier.
  - The sentence is long enough to carry meaning — at least a subject + verb (i.e. not just "ok." or "hi.").

WHEN TO EMIT "ALT: NONE":
  - The sentence is ALREADY FORMAL — no useful lift is possible. Emit NONE rather than producing a near-identical rewrite.
  - The sentence is a fragment, a one-word greeting/acknowledgement ("ok.", "hi.", "yes."), or an interjection.
  - The sentence is TECHNICAL: code, shell commands, URLs, identifiers. Anything where formality doesn't apply.
  - The sentence is a list item, header, or markup — non-prose surface.

RULES FOR EACH ALT:
  1. Preserve MEANING — the rewrite must be semantically equivalent. Don't add information; don't remove it.
  2. Preserve PUNCTUATION shape (question marks → questions, exclamations → emphatic; you may downgrade exclamation marks to periods for formality).
  3. Each ALT must be a COMPLETE sentence. No fragments.
  4. ALTS should be DISTINCT — three near-identical rewrites is worse than two distinct ones. (If you can't produce 3 distinct alts, emit fewer; minimum 1 for a hit.)
  5. Match the user's POINT-OF-VIEW: first-person input stays first-person, etc.

DO NOT:
  - Output anything outside the SENTENCE/ALT/--- structure.
  - Include the original sentence in the ALT list.
  - Merge or split sentences across blocks — one block per detected sentence.
  - Add commentary, headers, markdown, code fences, JSON.

EXAMPLES:

INPUT: thanks a bunch for the help.
SENTENCE: thanks a bunch for the help.
ALT: Thank you very much for your assistance.
ALT: I am grateful for your help.
ALT: Many thanks for your assistance.
---

INPUT: gonna head out early today. The presentation went well.
SENTENCE: gonna head out early today.
ALT: I will be leaving early today.
ALT: I plan to leave early today.
ALT: I will depart early today.
---
SENTENCE: The presentation went well.
ALT: NONE
---

INPUT: ok.
SENTENCE: ok.
ALT: NONE
---

INPUT: const x = 42;
SENTENCE: const x = 42;
ALT: NONE
---

INPUT: I respectfully request your review of the attached document.
SENTENCE: I respectfully request your review of the attached document.
ALT: NONE
---`;

export interface SentenceAltBlock {
  sentence: string;
  alts: string[];
  /** True when the model emitted ALT: NONE (no useful rewrite) — caller treats as cede. */
  ceded: boolean;
}

export interface FusedSentenceResult {
  blocks: SentenceAltBlock[];
  raw: string;
  latencyMs: number;
}

export async function runFused(buffer: string): Promise<FusedSentenceResult> {
  // Token budget — sentence rewrites are short, but multi-sentence
  // buffers compound. 256 is enough for ~3 sentences × 3 alts.
  // Bump if real-world buffers cause truncation.
  const r = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${buffer}`), { maxTokens: 768 });
  return parseFusedOutput(r.text, r.latencyMs);
}

export function parseFusedOutput(raw: string, latencyMs: number): FusedSentenceResult {
  const blocks: SentenceAltBlock[] = [];
  // Split on the --- separator (allows trailing/leading whitespace).
  const rawBlocks = raw.split(/^\s*-{3,}\s*$/m);
  for (const rawBlock of rawBlocks) {
    const text = rawBlock.trim();
    if (!text) continue;
    const sentenceMatch = text.match(/^SENTENCE:\s*(.*?)(?:\n|$)/);
    if (!sentenceMatch) continue;
    const sentence = sentenceMatch[1].trim();
    if (!sentence) continue;
    const alts: string[] = [];
    let ceded = false;
    const altLines = text.match(/^ALT:\s*(.*?)$/gm) ?? [];
    for (const line of altLines) {
      const value = line.replace(/^ALT:\s*/, '').trim();
      if (!value) continue;
      if (value.toUpperCase() === 'NONE') {
        ceded = true;
        continue;
      }
      // De-duplicate within a block (model sometimes regurgitates).
      if (!alts.includes(value)) alts.push(value);
    }
    blocks.push({ sentence, alts, ceded });
  }
  return { blocks, raw, latencyMs };
}
