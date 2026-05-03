/**
 * 2-PASS pipeline — PASS 2: APPLY
 *
 * Given an INSTRUCTION (verb phrase) and a TARGET (the text it should
 * operate on), produce the rewritten TARGET. Pure rewrite — no decisions
 * about whether the instruction is valid (P1 already gated that).
 *
 * Output format — one line:
 *   REWRITE: <rewritten target>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You receive:
- INSTRUCTION: a short imperative editing command
- TARGET: the text to apply the instruction to

Apply the INSTRUCTION to the TARGET and emit the rewritten TARGET. No commentary.

Output exactly one line, nothing else:
REWRITE: <rewritten target>

RULES:
1. Apply the instruction to ALL applicable spans, not just the first.
2. Preserve everything that wasn't targeted (other words, punctuation, casing).
3. For ambiguous co-reference (e.g. "swap genders" with possessive pronouns), pick one consistent interpretation rather than refusing.
4. Output ONLY the rewritten TARGET. Do not include the instruction.

EXAMPLES:

INSTRUCTION: change boy to girl
TARGET: the boy ran fast
REWRITE: the girl ran fast

INSTRUCTION: change boy to girl
TARGET: the boy and the other boy were friends
REWRITE: the girl and the other girl were friends

INSTRUCTION: he/she swap
TARGET: he gave the book to John
REWRITE: she gave the book to John

INSTRUCTION: make it british english
TARGET: the color of the harbor is gray
REWRITE: the colour of the harbour is grey

INSTRUCTION: make past tense
TARGET: I run to the store every day
REWRITE: I ran to the store every day

INSTRUCTION: capitalize proper nouns
TARGET: i visited paris and london last june
REWRITE: I visited Paris and London last June

INSTRUCTION: pluralize
TARGET: the child found one mouse
REWRITE: the children found mice

INSTRUCTION: rename foo to bar
TARGET: function foo() { return foo + 1 }
REWRITE: function bar() { return bar + 1 }`;

export interface ApplyResult {
  rewrite: string;
  raw: string;
  latencyMs: number;
}

export async function runApply(instruction: string, target: string): Promise<ApplyResult> {
  const r = await chat(
    sysUser(SYSTEM_PROMPT, `INSTRUCTION: ${instruction}\nTARGET: ${target}`),
    { maxTokens: 2048 },
  );
  return parseApplyOutput(r.text, r.latencyMs);
}

export function parseApplyOutput(raw: string, latencyMs: number): ApplyResult {
  const m = raw.match(/^REWRITE:\s*(.*?)\s*$/im);
  return { rewrite: m ? m[1].trim() : '', raw, latencyMs };
}
