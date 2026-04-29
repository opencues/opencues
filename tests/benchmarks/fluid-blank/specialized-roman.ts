/**
 * Specialized ROMAN handler — extracted verbatim from defaults/blanks.md.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Convert between Arabic and Roman numerals. Output ONLY: ANSWER=value

Roman numeral rules:
- I=1, V=5, X=10, L=50, C=100, D=500, M=1000
- Subtractive: IV=4, IX=9, XL=40, XC=90, CD=400, CM=900
- Numbers 1-3999 only

Examples:
- 14 in roman numerals is BLANK → ANSWER=XIV
- 2024 in roman numerals is BLANK → ANSWER=MMXXIV
- 99 in roman numerals is BLANK → ANSWER=XCIX
- 1990 in roman numerals is BLANK → ANSWER=MCMXC
- 500 in roman numerals is BLANK → ANSWER=D
- MCMXC in numbers is BLANK → ANSWER=1990
- XIV in numbers is BLANK → ANSWER=14
- XLII in numbers is BLANK → ANSWER=42
- MMXXIV in numbers is BLANK → ANSWER=2024
- IX in numbers is BLANK → ANSWER=9
- CDXLIV in numbers is BLANK → ANSWER=444
- DCCCLXXXVIII in numbers is BLANK → ANSWER=888

Answer:`;

export interface SpecializedAnswerResult {
  answer: string | null;
  raw: string;
  latencyMs: number;
}

export async function runSpecializedRoman(input: string): Promise<SpecializedAnswerResult> {
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });
  const match = result.text.match(/ANSWER\s*=\s*(.+?)$/m);
  const answer = match ? match[1].trim() : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
