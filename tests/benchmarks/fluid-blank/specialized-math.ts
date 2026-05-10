/**
 * Specialized MATH handler — extracted verbatim from defaults/BLANKS.md.
 *
 * Production parser is 'math': output is "COMPUTE=expression" which then
 * gets evaluated. We replicate that here so the benchmark mirrors prod.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Solve the math. Output ONLY: COMPUTE=expression

Examples:
- 4 * 12 = BLANK → COMPUTE=4*12
- 100 / 4 = BLANK → COMPUTE=100/4
- half of 16 = BLANK → COMPUTE=16/2
- double 25 = BLANK → COMPUTE=25*2
- triple 7 = BLANK → COMPUTE=7*3
- 5 factorial = BLANK → COMPUTE=1*2*3*4*5
- 3! = BLANK → COMPUTE=1*2*3
- 50 plus 20% tax = BLANK → COMPUTE=50*1.20
- 80 with 25% off = BLANK → COMPUTE=80*0.75
- 15% of 200 = BLANK → COMPUTE=0.15*200
- tip 18% on 85 = BLANK → COMPUTE=0.18*85
- 2 to the power of 8 = BLANK → COMPUTE=2**8
- square root of 144 = BLANK → COMPUTE=12
- celsius to fahrenheit 100C = BLANK → COMPUTE=(100*9/5)+32
- distance at 60 mph for 2.5 hours = BLANK → COMPUTE=60*2.5
- split 150 between 3 people = BLANK → COMPUTE=150/3
- average of 80, 90, 100 = BLANK → COMPUTE=(80+90+100)/3
- sum of 1 to 10 = BLANK → COMPUTE=1+2+3+4+5+6+7+8+9+10
- 3 items at 4.99 each = BLANK → COMPUTE=3*4.99
- permutations 5 choose 2 = BLANK → COMPUTE=(1*2*3*4*5)/(1*2*3)
- combinations 5 choose 2 = BLANK → COMPUTE=(1*2*3*4*5)/((1*2)*(1*2*3))
- negative 5 times negative 3 = BLANK → COMPUTE=-5*-3
- absolute value of -42 = BLANK → COMPUTE=42
- 17 mod 5 = BLANK → COMPUTE=17%5
- 7 remainder 3 = BLANK → COMPUTE=7%3
- log base 10 of 1000 = BLANK → COMPUTE=3
- sine of 90 degrees = BLANK → COMPUTE=1
- cosine of 0 degrees = BLANK → COMPUTE=1
- gcd of 48 and 18 = BLANK → COMPUTE=6
- lcm of 12 and 18 = BLANK → COMPUTE=36
- floor of 3.7 = BLANK → COMPUTE=3
- ceiling of 2.1 = BLANK → COMPUTE=3
- round 3.5 = BLANK → COMPUTE=4

Solve:`;

export interface SpecializedAnswerResult {
  answer: string | null;
  raw: string;
  latencyMs: number;
}

function evaluateExpression(expr: string): string | null {
  try {
    // Sanitize: numbers, operators (incl. **), decimal, parens
    if (!/^[\d\s+\-*/().%]+$/.test(expr)) return null;
    const result = new Function(`return ${expr}`)();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return Number.isInteger(result) ? String(result) : result.toFixed(4).replace(/\.?0+$/, '');
  } catch {
    return null;
  }
}

export async function runSpecializedMath(input: string): Promise<SpecializedAnswerResult> {
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });
  const match = result.text.match(/COMPUTE\s*=\s*(.+?)$/m);
  const expr = match ? match[1].trim() : null;
  const answer = expr ? evaluateExpression(expr) : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
