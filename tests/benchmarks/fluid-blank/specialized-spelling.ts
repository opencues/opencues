/**
 * Specialized SPELLING handler — extracted verbatim from defaults/BLANKS.md.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Answer the word relationship question. Output ONLY: ANSWER=word

Examples:
- The opposite of hot is BLANK → ANSWER=cold
- The opposite of big is BLANK → ANSWER=small
- The opposite of fast is BLANK → ANSWER=slow
- A synonym for happy is BLANK → ANSWER=joyful
- A synonym for big is BLANK → ANSWER=large
- A synonym for fast is BLANK → ANSWER=quick
- An antonym of light is BLANK → ANSWER=dark
- Rhymes with cat BLANK → ANSWER=hat
- Rhymes with dog BLANK → ANSWER=log
- Another word for beautiful is BLANK → ANSWER=gorgeous
- Means the same as angry BLANK → ANSWER=furious

Answer:`;

export interface SpecializedAnswerResult {
  answer: string | null;
  raw: string;
  latencyMs: number;
}

export async function runSpecializedSpelling(input: string): Promise<SpecializedAnswerResult> {
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });
  const match = result.text.match(/ANSWER\s*=\s*(.+?)$/m);
  const answer = match ? match[1].trim() : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
