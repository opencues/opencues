/**
 * LLM-as-judge for agent-task. Modeled on
 * tests/benchmarks/transform-blank/judge.ts.
 *
 * For each (case, appliedEdit) pair the human-authored cases.ts may
 * have a too-narrow "acceptable list" (e.g. `gonna → [going, will]`)
 * that misses semantically-fine LLM picks (`gonna → "going to"`). The
 * judge evaluates whether the applied edit semantically fulfills the
 * prompt.
 *
 * Two short-circuits before the LLM call:
 *   - acceptable-list exact (or substring) match → PASS instantly
 *   - editedWord === originalWord → FAIL (model emitted no-op)
 */

import { chat } from './groq';

function sysUser(system: string, user: string) {
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

const SYSTEM_PROMPT = `You are judging whether a single per-word edit produced by an inline editing agent semantically fulfills the user's task prompt.

You receive:
- TASK: the user's instruction (e.g. "make wording more professional")
- ORIGINAL_WORD: the word in the doc before the edit
- EDITED_WORD: what the agent replaced it with (may be multi-word, may be empty for DELETE)
- ACCEPTABLE_HINTS: human-authored acceptable replacements (may be incomplete)
- CONTEXT: the full doc text (so the judge can see whether the swap reads naturally in context)

Output exactly two lines, nothing else:
VERDICT: PASS | FAIL
RATIONALE: <one short sentence>

PASS when EDITED_WORD is a reasonable application of TASK to ORIGINAL_WORD in CONTEXT. Be generous: stylistic prompts have many valid answers; the human ACCEPTABLE_HINTS are a NON-EXHAUSTIVE starting point.

FAIL when EDITED_WORD:
- Doesn't address the task ("correct spelling" but the edit isn't a spelling fix)
- Introduces an error (typo, grammar break, wrong meaning)
- Strips meaning the original carried that the prompt didn't ask to remove
- Is a no-op (same as ORIGINAL_WORD in any non-trivial way)`;

export interface JudgeAgentInput {
  task: string;
  originalWord: string;
  editedWord: string;
  acceptableHints: readonly string[];
  context: string;
}

export interface JudgeAgentResult {
  verdict: 'PASS' | 'FAIL';
  rationale: string;
  fastPath: 'exact-match' | 'substring-match' | 'no-op-rejected' | null;
  raw: string;
  latencyMs: number;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function judgeAgentEdit(input: JudgeAgentInput): Promise<JudgeAgentResult> {
  // Fast path 1: editedWord matches an acceptable hint exactly (case + whitespace tolerant).
  const editN = normalize(input.editedWord);
  const origN = normalize(input.originalWord);

  if (editN === origN) {
    return {
      verdict: 'FAIL',
      rationale: 'Edit is a no-op (editedWord matches originalWord).',
      fastPath: 'no-op-rejected',
      raw: '', latencyMs: 0,
    };
  }

  for (const hint of input.acceptableHints) {
    if (normalize(hint) === editN) {
      return {
        verdict: 'PASS',
        rationale: `Matches acceptable hint "${hint}" exactly.`,
        fastPath: 'exact-match',
        raw: '', latencyMs: 0,
      };
    }
  }

  // Fast path 2: editedWord contains an acceptable hint as a substring
  // (catches multi-word LLM phrasings like "going to" matching hint "going").
  for (const hint of input.acceptableHints) {
    const hintN = normalize(hint);
    if (hintN.length > 0 && (editN.includes(hintN) || hintN.includes(editN))) {
      return {
        verdict: 'PASS',
        rationale: `Substring match against acceptable hint "${hint}".`,
        fastPath: 'substring-match',
        raw: '', latencyMs: 0,
      };
    }
  }

  // Fall through to LLM judge.
  const hintsBlock = input.acceptableHints.length
    ? `ACCEPTABLE_HINTS: ${input.acceptableHints.join(', ')}`
    : 'ACCEPTABLE_HINTS: (none — judge purely on semantics)';
  const userMsg = [
    `TASK: ${input.task}`,
    `ORIGINAL_WORD: ${input.originalWord}`,
    `EDITED_WORD: ${input.editedWord || '(DELETE)'}`,
    hintsBlock,
    `CONTEXT: ${input.context}`,
  ].join('\n');

  const r = await chat(sysUser(SYSTEM_PROMPT, userMsg), { maxTokens: 200 });
  return parseJudgeAgentOutput(r.text, r.latencyMs);
}

export function parseJudgeAgentOutput(raw: string, latencyMs: number): JudgeAgentResult {
  const verdictMatch = raw.match(/^VERDICT:\s*(PASS|FAIL)\s*$/im);
  const rationaleMatch = raw.match(/^RATIONALE:\s*(.*?)\s*$/im);
  const verdict = (verdictMatch ? verdictMatch[1].toUpperCase() : 'FAIL') as 'PASS' | 'FAIL';
  const rationale = rationaleMatch ? rationaleMatch[1].trim() : '(judge produced no rationale)';
  return { verdict, rationale, fastPath: null, raw, latencyMs };
}
