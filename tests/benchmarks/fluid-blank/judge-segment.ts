/**
 * Judge for P1 SEGMENT.
 *
 * Same model as the segmenter (per user constraint: ONLY gpt-oss-120b).
 * Different system prompt — focused on grading, not generating. Boolean
 * verdict + one-line rationale.
 */

// Pin judge to Groq gpt-oss-120b regardless of OPENCUES_BENCH_PROVIDER —
// otherwise each provider self-judges and cross-provider comparisons
// drift by ~5pp (see transform-blank EXPERIMENTS.md § Experiment 6).
import { chat, sysUser } from './groq-impl';

const SYSTEM_PROMPT = `You judge whether an actual span-segmentation matches an expected span.

You will receive:
- INPUT: the original sentence
- EXPECTED_SPAN: the human-authored expected span (or "NONE" for fail-soft cases)
- ACTUAL_SPAN: the model's output (or "NONE")

Output exactly two lines, nothing else:
VERDICT: PASS|FAIL
RATIONALE: <one short sentence>

PASS criteria:
- ACTUAL_SPAN captures the same implicit question as EXPECTED_SPAN.
- Minor wording variations are PASS as long as the answer would substitute grammatically (e.g. including/excluding a leading article like "the", or extending one extra word in the same noun phrase).
- ACTUAL_SPAN must include the underscore.
- For fail-soft cases (EXPECTED_SPAN: NONE), PASS if and only if ACTUAL_SPAN is also NONE.

FAIL criteria:
- ACTUAL_SPAN captures a different question.
- ACTUAL_SPAN omits the underscore (when expected non-NONE).
- Off-by-many-words boundary that breaks grammar on substitution.
- ACTUAL_SPAN is NONE when a question was expected (or vice versa).

EXAMPLES:

INPUT: the unicode for underscore _ in my doc
EXPECTED_SPAN: the unicode for underscore _
ACTUAL_SPAN: unicode for underscore _
VERDICT: PASS
RATIONALE: Drops a leading article but captures the same question and includes the underscore.

INPUT: i'm writing docs. _ is the boiling point of water in celsius. cool right
EXPECTED_SPAN: _ is the boiling point of water in celsius
ACTUAL_SPAN: i'm writing docs. _ is the boiling point of water
VERDICT: FAIL
RATIONALE: Pulls in unrelated leading prose and truncates the question phrase.

INPUT: i just need to fix _ here in this code
EXPECTED_SPAN: NONE
ACTUAL_SPAN: NONE
VERDICT: PASS
RATIONALE: Correctly refused to segment a non-question.`;

export interface JudgeResult {
  verdict: 'PASS' | 'FAIL';
  rationale: string;
  raw: string;
  latencyMs: number;
}

export async function judgeSegment(args: {
  input: string;
  expectedSpan: string | null;
  actualSpan: string | null;
}): Promise<JudgeResult> {
  const userMsg = [
    `INPUT: ${args.input}`,
    `EXPECTED_SPAN: ${args.expectedSpan ?? 'NONE'}`,
    `ACTUAL_SPAN: ${args.actualSpan ?? 'NONE'}`,
  ].join('\n');

  const result = await chat(sysUser(SYSTEM_PROMPT, userMsg), { maxTokens: 200 });

  const verdictMatch = result.text.match(/^VERDICT:\s*(PASS|FAIL)/im);
  const rationaleMatch = result.text.match(/^RATIONALE:\s*(.*?)$/im);
  return {
    verdict: (verdictMatch ? verdictMatch[1].toUpperCase() : 'FAIL') as 'PASS' | 'FAIL',
    rationale: rationaleMatch ? rationaleMatch[1].trim() : '(no rationale)',
    raw: result.text,
    latencyMs: result.latencyMs,
  };
}
