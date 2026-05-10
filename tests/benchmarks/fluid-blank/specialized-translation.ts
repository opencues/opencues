/**
 * Specialized TRANSLATION handler — extracted verbatim from defaults/BLANKS.md.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Translate the word or phrase. Output ONLY: ANSWER=translation

Use the most common/standard translation. For languages with non-Latin scripts,
provide the romanized form (e.g., "arigatou" not "ありがとう").

Examples:
- Hello in French is BLANK → ANSWER=Bonjour
- Thank you in Japanese is BLANK → ANSWER=Arigatou
- Dog in Spanish is BLANK → ANSWER=Perro
- The German word for house is BLANK → ANSWER=Haus
- How do you say goodbye in Italian BLANK → ANSWER=Arrivederci
- Water in Arabic is BLANK → ANSWER=Maa
- Cat in Portuguese is BLANK → ANSWER=Gato
- Love in Latin is BLANK → ANSWER=Amor
- Friend in Korean is BLANK → ANSWER=Chingu
- Good morning in Chinese is BLANK → ANSWER=Zao shang hao
- Beautiful in Russian is BLANK → ANSWER=Krasivyy
- Peace in Hebrew is BLANK → ANSWER=Shalom
- Bread in French is BLANK → ANSWER=Pain
- Book in German is BLANK → ANSWER=Buch
- Red in Spanish is BLANK → ANSWER=Rojo

Translate:`;

export interface SpecializedAnswerResult {
  answer: string | null;
  raw: string;
  latencyMs: number;
}

export async function runSpecializedTranslation(input: string): Promise<SpecializedAnswerResult> {
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });
  const match = result.text.match(/ANSWER\s*=\s*(.+?)$/m);
  const answer = match ? match[1].trim() : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
