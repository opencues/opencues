/**
 * Specialized FACTUAL handler — extracted from defaults/blanks.md.
 *
 * Single-call factual lookup using the existing production prompt.
 * Used to head-to-head against fluid-blank's P1+P3 pipeline on the
 * same input set.
 *
 * Production semantics:
 *   - Input: a sentence with BLANK substituted for _
 *   - Output: ANSWER=<value>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Answer the factual question. Output ONLY: ANSWER=answer

Examples by category:

People:
- The CEO of Apple is BLANK → ANSWER=Tim Cook
- The founder of Microsoft is BLANK → ANSWER=Bill Gates
- The first president of the US was BLANK → ANSWER=George Washington
- The inventor of the telephone is BLANK → ANSWER=Alexander Graham Bell
- The author of Harry Potter is BLANK → ANSWER=J.K. Rowling
- The painter of Mona Lisa is BLANK → ANSWER=Leonardo da Vinci
- The composer of Fur Elise is BLANK → ANSWER=Beethoven
- The sculptor of David is BLANK → ANSWER=Michelangelo
- The architect of the Eiffel Tower is BLANK → ANSWER=Gustave Eiffel
- The first woman in space was BLANK → ANSWER=Valentina Tereshkova

Places:
- The capital of France is BLANK → ANSWER=Paris
- The largest ocean is the BLANK → ANSWER=Pacific
- The tallest mountain is BLANK → ANSWER=Mount Everest
- The longest river is the BLANK → ANSWER=Nile
- The largest desert is the BLANK → ANSWER=Sahara
- The smallest continent is BLANK → ANSWER=Australia

Dates/Years:
- World War 2 ended in BLANK → ANSWER=1945
- The Berlin Wall fell in BLANK → ANSWER=1989
- The Titanic sank in BLANK → ANSWER=1912
- The Soviet Union collapsed in BLANK → ANSWER=1991
- The first Olympics were held in BLANK → ANSWER=1896
- Queen Elizabeth II became queen in BLANK → ANSWER=1952
- The first iPhone was released in BLANK → ANSWER=2007

Science:
- The chemical symbol for gold is BLANK → ANSWER=Au
- The chemical symbol for iron is BLANK → ANSWER=Fe
- The atomic number of carbon is BLANK → ANSWER=6
- Water boils at BLANK degrees Celsius → ANSWER=100
- Water freezes at BLANK degrees Celsius → ANSWER=0
- The speed of light is approximately BLANK km/s → ANSWER=299792
- The closest star to Earth is the BLANK → ANSWER=Sun
- The largest planet is BLANK → ANSWER=Jupiter

Question:`;

export interface SpecializedAnswerResult {
  /** The model's answer, or null if it couldn't parse */
  answer: string | null;
  raw: string;
  latencyMs: number;
}

/**
 * Run the specialized FACTUAL prompt as a single LLM call.
 * Mirrors what production blanks.md → ConfigSource does today.
 */
export async function runSpecializedFactual(input: string): Promise<SpecializedAnswerResult> {
  // Production substitutes BLANK for the literal _
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });

  // Parse "ANSWER=<value>" anywhere in the output
  const match = result.text.match(/ANSWER\s*=\s*(.+?)$/m);
  const answer = match ? match[1].trim() : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
