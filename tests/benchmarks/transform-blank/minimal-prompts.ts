/**
 * Minimal-prompt variants for ablation testing.
 *
 * Each phase has a "minimal" version stripped down to the essential
 * rules + 2-3 examples. Goal: identify which prompt content is
 * load-bearing vs which is defensive cruft.
 *
 * Hypothesis: shorter prompts → lower latency (smaller token budget,
 * faster inference) AND comparable accuracy on the cases the prompt
 * was actually designed for. Longer prompts win on edge cases, but
 * which edge cases?
 */

import { chat, sysUser } from './groq';
import type { ExtractResult } from './pass1-extract';
import type { ApplyResult } from './pass2-apply';
import type { VerifyResult } from './pass3-verify';
import { parseExtractOutput } from './pass1-extract';
import { parseApplyOutput } from './pass2-apply';
import { parseVerifyOutput } from './pass3-verify';

// ============================================================================
// Minimal EXTRACT — strip layout/composed/ctx examples; keep just the bones
// ============================================================================

const MINIMAL_EXTRACT_SYSTEM = `Read the input and identify whether it carries an IMPERATIVE INSTRUCTION the user wants applied to the surrounding text.

Output exactly three lines:
VERDICT: TRANSFORM | NONE
INSTRUCTION: <the imperative phrase, _ removed; or empty>
TARGET: <the rest of the input after removing instruction + _; or empty>

The instruction can sit BEFORE _ at the start (<INSTRUCTION> _ <TARGET>) OR right BEFORE _ at the end (<TARGET> <INSTRUCTION> _).

For composed instructions joined by "and" ("make past tense and remove pronouns"), output them pipe-joined: "make past tense | remove pronouns".

Bail to NONE for: UI placeholders, pure lookups (no instruction), instructions with no target, idioms.

EXAMPLES:

INPUT: change boy to girl _ the boy ran fast
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast

INPUT: the boy ran fast change boy to girl _
VERDICT: TRANSFORM
INSTRUCTION: change boy to girl
TARGET: the boy ran fast

INPUT: pluralize and make past tense _ the child runs to the park
VERDICT: TRANSFORM
INSTRUCTION: pluralize | make past tense
TARGET: the child runs to the park

INPUT: capital of france _
VERDICT: NONE
INSTRUCTION:
TARGET:`;

export async function runMinimalExtract(input: string): Promise<ExtractResult> {
  const r = await chat(sysUser(MINIMAL_EXTRACT_SYSTEM, `INPUT: ${input}`), { maxTokens: 2048 });
  return parseExtractOutput(r.text, r.latencyMs);
}

// ============================================================================
// Minimal APPLY — strip CONCEPT-SWAP / ROLE / COMPOSED / paragraph rules;
// keep just "apply the instruction, output the rewrite"
// ============================================================================

const MINIMAL_APPLY_SYSTEM = `You receive INSTRUCTION + TARGET. Apply the instruction to the target and output the rewritten target.

Output exactly one line:
REWRITE: <rewritten target>

Rules:
- Apply to ALL applicable spans, not just the first
- Preserve everything not targeted (other words, punctuation, paragraph breaks)
- Output ONLY the rewritten target — no instruction, no commentary

EXAMPLES:

INSTRUCTION: change boy to girl
TARGET: the boy ran fast
REWRITE: the girl ran fast

INSTRUCTION: he/she swap
TARGET: he gave the book to John
REWRITE: she gave the book to John

INSTRUCTION: pluralize
TARGET: the child found one mouse
REWRITE: the children found mice

INSTRUCTION: make past tense
TARGET: I run to the store every day
REWRITE: I ran to the store every day

INSTRUCTION: capitalize proper nouns
TARGET: i visited paris and london last june
REWRITE: I visited Paris and London last June`;

export async function runMinimalApply(instruction: string, target: string): Promise<ApplyResult> {
  const r = await chat(
    sysUser(MINIMAL_APPLY_SYSTEM, `INSTRUCTION: ${instruction}\nTARGET: ${target}`),
    { maxTokens: 2048 },
  );
  return parseApplyOutput(r.text, r.latencyMs);
}

// ============================================================================
// Minimal VERIFY — strip the AMBIGUOUS / WORKED-EXAMPLE sections; keep just
// "is this a clear defect? if yes repair, else OK"
// ============================================================================

const MINIMAL_VERIFY_SYSTEM = `You're reviewing a text-edit. Check whether the DRAFT correctly applied the INSTRUCTION to the TARGET.

Output exactly two lines:
VERDICT: OK | REPAIR
REWRITE: <DRAFT verbatim when OK; corrected rewrite when REPAIR>

DEFAULT TO OK. Only REPAIR when there's a clear, specific defect:
- Agreement broken (e.g. "they is" — verbs don't agree)
- Coverage incomplete (e.g. only first occurrence changed)
- Quantifier mismatch (e.g. "one mice")

Don't second-guess valid interpretations. Don't add stylistic tweaks. Your REWRITE must be the FULL output, no abbreviation/ellipsis.

EXAMPLES:

INSTRUCTION: change boy to girl
TARGET: the boy and the other boy were friends
DRAFT: the girl and the other boy were friends
VERDICT: REPAIR
REWRITE: the girl and the other girl were friends

INSTRUCTION: pluralize
TARGET: the child found one mouse
DRAFT: the children found one mice
VERDICT: REPAIR
REWRITE: the children found mice

INSTRUCTION: make past tense
TARGET: I run to the store
DRAFT: I ran to the store
VERDICT: OK
REWRITE: I ran to the store`;

export async function runMinimalVerify(instruction: string, target: string, draft: string): Promise<VerifyResult> {
  const r = await chat(
    sysUser(MINIMAL_VERIFY_SYSTEM, `INSTRUCTION: ${instruction}\nTARGET: ${target}\nDRAFT: ${draft}`),
    { maxTokens: 2048 },
  );
  return parseVerifyOutput(r.text, r.latencyMs);
}
