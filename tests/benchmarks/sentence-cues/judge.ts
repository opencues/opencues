/**
 * Hybrid judge for the sentence-cues `more-formal` bench.
 *
 * For each (original, alt) pair the judge produces one of:
 *   MORE_FORMAL — alt is unambiguously more formal than original.
 *   SAME        — alt preserves meaning but not formality (no useful lift).
 *   LESS_FORMAL — alt is less formal (regression).
 *   BROKEN      — alt is ungrammatical, off-topic, or meaning-shifted.
 *
 * Strategy:
 *
 *  1. FAST-PATH — if alt matches any entry in the case's `acceptableAlts`
 *     (case-insensitive, trimmed-whitespace, punctuation-tolerant),
 *     return MORE_FORMAL without an LLM call. Saves cost + avoids
 *     judge-rate-limit on the typical-shape case.
 *
 *  2. LLM JUDGE — pinned to Groq gpt-oss-120b (same model FluidBlank's
 *     judge uses) so cross-provider sweeps are comparable. Single
 *     call per (original, alt) pair, 3-way classification.
 *
 * Cede cases (expect: CEDE or expect: SAME): we judge the CUE'S
 * VERDICT, not individual alts. Cede is correct when the model emits
 * `ALT: NONE` (block.ceded === true) OR emits zero alts. Hits in those
 * buckets are precision failures — penalised as `FORMAL_HIT_ON_CEDE`.
 */

import { chat as judgeChat, sysUser as judgeSysUser } from '../fluid-blank/groq-impl';

export type AltVerdict = 'MORE_FORMAL' | 'SAME' | 'LESS_FORMAL' | 'BROKEN';

export interface AltJudgement {
  verdict: AltVerdict;
  /** True when verdict came from the acceptable-alts fast path. */
  fastPath: boolean;
  rationale: string;
  latencyMs: number;
}

const JUDGE_SYSTEM = `You compare two English sentences. Decide if the REWRITE is MORE FORMAL than the ORIGINAL.

Output exactly two lines:

VERDICT: MORE_FORMAL | SAME | LESS_FORMAL | BROKEN
RATIONALE: <one short clause>

VERDICT semantics:
  MORE_FORMAL — the rewrite uses more formal register, fewer contractions, fewer colloquialisms, more standard syntax. Meaning is preserved.
  SAME — meaning is preserved but formality is comparable. (Both formal, or both informal, or trivial rewording.)
  LESS_FORMAL — the rewrite is more casual than the original.
  BROKEN — the rewrite is ungrammatical, changes the meaning, drops information, or is not a complete sentence.

Be strict about BROKEN — meaning-shift is the dominant failure mode.

EXAMPLES:

ORIGINAL: thanks a bunch for the help.
REWRITE: Thank you very much for your assistance.
VERDICT: MORE_FORMAL
RATIONALE: removes colloquialism, capitalises, uses formal register

ORIGINAL: I will look into that tomorrow.
REWRITE: I will examine that matter tomorrow.
VERDICT: MORE_FORMAL
RATIONALE: "examine" + "that matter" upgrade register

ORIGINAL: The presentation went well.
REWRITE: The presentation was successful.
VERDICT: SAME
RATIONALE: both formal, equivalent register

ORIGINAL: thanks a bunch for the help.
REWRITE: cheers heaps for the help.
VERDICT: LESS_FORMAL
RATIONALE: "cheers heaps" is colloquial

ORIGINAL: gonna head out early today.
REWRITE: Today.
VERDICT: BROKEN
RATIONALE: drops meaning (heading out early)`;

/** Normalise for fast-path comparison: lower, collapsed-whitespace, trailing-punct-stripped. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();
}

export async function judgeAlt(opts: {
  original: string;
  alt: string;
  acceptableAlts?: string[];
}): Promise<AltJudgement> {
  const altN = normalize(opts.alt);
  for (const acc of opts.acceptableAlts ?? []) {
    if (normalize(acc) === altN) {
      return { verdict: 'MORE_FORMAL', fastPath: true, rationale: 'matched acceptableAlts entry', latencyMs: 0 };
    }
  }
  const t0 = Date.now();
  const r = await judgeChat(judgeSysUser(JUDGE_SYSTEM, `ORIGINAL: ${opts.original}\nREWRITE: ${opts.alt}`), { maxTokens: 64 });
  const latencyMs = Date.now() - t0;
  const verdictMatch = r.text.match(/^VERDICT:\s*(MORE_FORMAL|SAME|LESS_FORMAL|BROKEN)/im);
  const rationaleMatch = r.text.match(/^RATIONALE:\s*(.*?)$/im);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'BROKEN') as AltVerdict;
  const rationale = rationaleMatch ? rationaleMatch[1].trim() : 'judge bailed';
  return { verdict, fastPath: false, rationale, latencyMs };
}
