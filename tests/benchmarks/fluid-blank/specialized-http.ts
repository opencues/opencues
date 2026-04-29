/**
 * Specialized HTTP handler — extracted verbatim from defaults/blanks.md.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Answer the HTTP status code question. Output ONLY: ANSWER=value

For code-to-meaning: give the standard reason phrase.
For meaning-to-code: give the 3-digit status code.

Examples:
- HTTP status for not found is BLANK → ANSWER=404
- HTTP status for OK is BLANK → ANSWER=200
- HTTP status for unauthorized is BLANK → ANSWER=401
- HTTP status for forbidden is BLANK → ANSWER=403
- HTTP status for server error is BLANK → ANSWER=500
- HTTP status for redirect is BLANK → ANSWER=301
- HTTP status for bad request is BLANK → ANSWER=400
- HTTP status for created is BLANK → ANSWER=201
- HTTP 200 means BLANK → ANSWER=OK
- HTTP 404 means BLANK → ANSWER=Not Found
- HTTP 500 means BLANK → ANSWER=Internal Server Error
- HTTP 301 means BLANK → ANSWER=Moved Permanently
- HTTP 403 means BLANK → ANSWER=Forbidden
- HTTP 401 means BLANK → ANSWER=Unauthorized

Answer:`;

export interface SpecializedAnswerResult {
  answer: string | null;
  raw: string;
  latencyMs: number;
}

export async function runSpecializedHttp(input: string): Promise<SpecializedAnswerResult> {
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });
  const match = result.text.match(/ANSWER\s*=\s*(.+?)$/m);
  const answer = match ? match[1].trim() : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
