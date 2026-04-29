/**
 * Specialized UNIT handler — extracted verbatim from defaults/blanks.md.
 *
 * Production parser is 'math': output is "COMPUTE=expression" → evaluated.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `Convert between units. Output ONLY: COMPUTE=expression

Use these conversion formulas:
- Celsius to Fahrenheit: COMPUTE=(C*9/5)+32
- Fahrenheit to Celsius: COMPUTE=(F-32)*5/9
- Miles to Kilometers: COMPUTE=miles*1.60934
- Kilometers to Miles: COMPUTE=km*0.621371
- Kilograms to Pounds: COMPUTE=kg*2.20462
- Pounds to Kilograms: COMPUTE=lbs*0.453592
- Liters to Gallons: COMPUTE=liters*0.264172
- Gallons to Liters: COMPUTE=gallons*3.78541
- Meters to Feet: COMPUTE=meters*3.28084
- Feet to Meters: COMPUTE=feet*0.3048
- Inches to Centimeters: COMPUTE=inches*2.54
- Centimeters to Inches: COMPUTE=cm*0.393701
- Yards to Meters: COMPUTE=yards*0.9144
- Ounces to Grams: COMPUTE=oz*28.3495

Examples:
- 100 celsius in fahrenheit = BLANK → COMPUTE=(100*9/5)+32
- 32 fahrenheit in celsius = BLANK → COMPUTE=(32-32)*5/9
- 5 miles in km = BLANK → COMPUTE=5*1.60934
- 10 km in miles = BLANK → COMPUTE=10*0.621371
- 70 kg in pounds = BLANK → COMPUTE=70*2.20462
- 150 pounds in kg = BLANK → COMPUTE=150*0.453592
- 10 meters in feet = BLANK → COMPUTE=10*3.28084
- 6 feet in meters = BLANK → COMPUTE=6*0.3048
- 12 inches in cm = BLANK → COMPUTE=12*2.54

Convert:`;

export interface SpecializedAnswerResult {
  answer: string | null;
  raw: string;
  latencyMs: number;
}

function evaluateExpression(expr: string): string | null {
  try {
    if (!/^[\d\s+\-*/().%]+$/.test(expr)) return null;
    const result = new Function(`return ${expr}`)();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return Number.isInteger(result) ? String(result) : result.toFixed(4).replace(/\.?0+$/, '');
  } catch {
    return null;
  }
}

export async function runSpecializedUnit(input: string): Promise<SpecializedAnswerResult> {
  const transformed = input.replace(/_/g, 'BLANK');
  const result = await chat(sysUser(SYSTEM_PROMPT, transformed), { maxTokens: 200 });
  const match = result.text.match(/COMPUTE\s*=\s*(.+?)$/m);
  const expr = match ? match[1].trim() : null;
  const answer = expr ? evaluateExpression(expr) : null;
  return { answer, raw: result.text, latencyMs: result.latencyMs };
}
