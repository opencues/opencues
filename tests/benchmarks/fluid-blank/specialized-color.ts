/**
 * Specialized COLOR handler — extracted verbatim from defaults/blanks.md.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Answer the color code question. Output ONLY: ANSWER=value

For hex codes, include the # prefix. For RGB, use format "rgb(R,G,B)".

Examples:
- Red in hex is BLANK → ANSWER=#FF0000
- Blue in hex is BLANK → ANSWER=#0000FF
- Green in hex is BLANK → ANSWER=#00FF00
- White in hex is BLANK → ANSWER=#FFFFFF
- Black in hex is BLANK → ANSWER=#000000
- Yellow in hex is BLANK → ANSWER=#FFFF00
- Hex for purple is BLANK → ANSWER=#800080
- Hex for orange is BLANK → ANSWER=#FFA500
- Red in rgb is BLANK → ANSWER=rgb(255,0,0)
- Blue in rgb is BLANK → ANSWER=rgb(0,0,255)
- Hex for cyan is BLANK → ANSWER=#00FFFF
- Hex for pink is BLANK → ANSWER=#FFC0CB

Answer:`;

export interface SpecializedAnswerResult {
  answer: string | null;
  raw: string;
  latencyMs: number;
}

export async function runSpecializedColor(input: string): Promise<SpecializedAnswerResult> {
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });
  const match = result.text.match(/ANSWER\s*=\s*(.+?)$/m);
  const answer = match ? match[1].trim() : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
