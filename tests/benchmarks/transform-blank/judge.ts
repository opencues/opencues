/**
 * LLM-as-judge for transform-blank.
 *
 * Compares the actual rewritten text against expected (and any acceptable
 * alternates). Uses semantic equivalence — minor whitespace/punctuation
 * drift is fine; meaning + applied edit must match.
 *
 * Two short-circuits before calling the LLM:
 *   - exact match (case-insensitive, whitespace-collapsed) → PASS instantly
 *   - fail-soft expected + actualBail=true → PASS instantly (model correctly bailed)
 *
 * Output format — two lines:
 *   VERDICT: PASS | FAIL
 *   RATIONALE: <one sentence>
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You are judging whether a text-editing model produced an acceptable rewrite.

You receive:
- INPUT: the user's original text (with _)
- EXPECTED: the canonical correct rewrite
- ALTERNATES: zero or more alternative acceptable rewrites
- ACTUAL: the model's actual rewrite

Output exactly two lines, nothing else:
VERDICT: PASS | FAIL
RATIONALE: <one sentence explaining the verdict>

PASS when ACTUAL matches EXPECTED or any ALTERNATE in meaning AND applied edit. Minor whitespace/punctuation/casing drift is OK if the intended transform was performed correctly on all applicable spans.

FAIL when:
- The rewrite missed an applicable span (e.g. "change boy to girl" only changed one of two boys)
- The rewrite changed something it shouldn't have
- The instruction phrase wasn't deleted from the output
- A different transform was applied`;

// Strip inline markdown markers from `s` before comparing. The runtime
// strips markers before writing to the buffer, so the user-visible
// final text never contains them. Test expectations are written in
// the stripped form too — this lets the model emit `**wilfred**` and
// still match an expectation of plain `wilfred`. Mirrors a subset of
// @opencues/runtime/src/modules/markdown-strip.ts (kept local so the
// benchmark doesn't depend on the runtime's build state).
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // **bold**
    .replace(/~~([^~]+)~~/g, '$1')       // ~~strike~~
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')   // *italic* (not inside **)
    .replace(/`([^`]+)`/g, '$1');        // `code`
}

function normalize(s: string): string {
  return stripInlineMarkdown(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface JudgeResult {
  verdict: 'PASS' | 'FAIL';
  rationale: string;
  raw: string;
  latencyMs: number;
}

export interface JudgeInput {
  input: string;
  expected: string | null;     // null when expected was shouldFailSoft
  alternates: string[];
  actual: string | null;        // null when model bailed
  actualBail: boolean;          // true when model returned VERDICT: NONE
  expectedBail: boolean;        // true when case is shouldFailSoft
}

export async function judge(input: JudgeInput): Promise<JudgeResult> {
  // Short-circuit 1: bail-vs-bail agreement
  if (input.expectedBail) {
    if (input.actualBail) {
      return { verdict: 'PASS', rationale: 'Model correctly bailed (no transform).', raw: '', latencyMs: 0 };
    }
    return {
      verdict: 'FAIL',
      rationale: `Model produced edits when it should have bailed: "${input.actual}".`,
      raw: '',
      latencyMs: 0,
    };
  }
  if (input.actualBail) {
    return { verdict: 'FAIL', rationale: 'Model bailed when a transform was expected.', raw: '', latencyMs: 0 };
  }

  // Short-circuit 2: exact match against expected or any alternate
  const candidates = [input.expected, ...input.alternates].filter(Boolean) as string[];
  const actualNorm = normalize(input.actual ?? '');
  for (const c of candidates) {
    if (normalize(c) === actualNorm) {
      return { verdict: 'PASS', rationale: 'Exact match.', raw: '', latencyMs: 0 };
    }
  }

  // Fall through to LLM judge for fuzzy cases
  const altsBlock = input.alternates.length
    ? input.alternates.map((a, i) => `ALTERNATE ${i + 1}: ${a}`).join('\n')
    : 'ALTERNATES: (none)';
  const userMsg = `INPUT: ${input.input}\nEXPECTED: ${input.expected}\n${altsBlock}\nACTUAL: ${input.actual}`;
  const r = await chat(sysUser(SYSTEM_PROMPT, userMsg), { maxTokens: 200 });
  return parseJudgeOutput(r.text, r.latencyMs);
}

export function parseJudgeOutput(raw: string, latencyMs: number): JudgeResult {
  const verdictMatch = raw.match(/^VERDICT:\s*(PASS|FAIL)\s*$/im);
  const rationaleMatch = raw.match(/^RATIONALE:\s*(.*?)\s*$/im);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'FAIL') as 'PASS' | 'FAIL';
  const rationale = rationaleMatch ? rationaleMatch[1].trim() : '(judge produced no rationale)';
  return { verdict, rationale, raw, latencyMs };
}
