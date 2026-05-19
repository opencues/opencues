/**
 * Judge for next-prompt-cues. Pinned to groq-impl (same pattern as
 * the rest of the bench infra — see tests/benchmarks/CLAUDE.md). The
 * judge never goes through the inference provider router so swapping
 * providers under test doesn't self-judge.
 *
 * Score shape (per case):
 *   pass:       boolean — overall verdict (all sub-checks passed)
 *   schema:     boolean — output parses as the expected JSON shape
 *   distinct:   boolean — three cues are semantically different
 *   relevant:   boolean — each cue clearly connects to the answer
 *   advancing:  boolean — each cue would meaningfully advance the conversation
 *                          (not restate, not non-sequitur)
 *   notes:      string  — judge's short rationale on the failures
 */

import * as groqImpl from '../fluid-blank/groq-impl';

const JUDGE_MODEL = 'openai/gpt-oss-120b';

export interface Cue {
  readonly id: string;
  readonly text: string;
}

export interface ModelOutput {
  readonly answer: string;
  readonly cues: readonly Cue[];
}

export interface Score {
  pass: boolean;
  schema: boolean;
  distinct: boolean;
  relevant: boolean;
  advancing: boolean;
  notes: string;
}

export function parseModelOutput(raw: string): ModelOutput | null {
  // Tolerate ```json fences just in case — the prompt forbids them
  // but cheap to handle.
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(stripped);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.answer !== 'string') return null;
    if (!Array.isArray(parsed.cues)) return null;
    for (const c of parsed.cues) {
      if (typeof c !== 'object' || c === null) return null;
      if (typeof c.id !== 'string' || typeof c.text !== 'string') return null;
    }
    return parsed as ModelOutput;
  } catch { return null; }
}

const JUDGE_SYSTEM = `You are an evaluator for predicted next-prompt cues.

Given:
  - the user's original prompt
  - the model's answer
  - the model's 3 predicted next-prompt cues

Decide whether the cues are GOOD. Output a JSON verdict:

{
  "distinct":  true|false,
  "relevant":  true|false,
  "advancing": true|false,
  "notes":     "one-sentence rationale on failures only (blank if all pass)"
}

Definitions:
- **distinct**: the three cues are semantically different directions, not three rephrasings of the same idea.
- **relevant**: each cue clearly connects to the answer (a user reading the answer could plausibly think to ask this).
- **advancing**: each cue would MEANINGFULLY ADVANCE the conversation — go deeper, pivot to a related topic, or propose a concrete action. A cue that restates the original prompt, or asks something a user wouldn't actually type after seeing the answer, is NOT advancing.

A single weak cue is enough to flip the corresponding flag to false. Notes should name which cue (by id) and why.

Output ONLY the JSON object — no markdown, no commentary.`;

interface JudgeResult {
  distinct: boolean;
  relevant: boolean;
  advancing: boolean;
  notes: string;
}

export async function judge(userPrompt: string, output: ModelOutput): Promise<Score> {
  // Trivial fail: schema invalid means there's no judge call needed.
  const cuesBlock = output.cues.map((c, i) => `  [${i}] id=${c.id} text=${JSON.stringify(c.text)}`).join('\n');
  const judgeUser = `USER PROMPT:\n${userPrompt}\n\nMODEL ANSWER:\n${output.answer}\n\nPREDICTED CUES:\n${cuesBlock}`;

  let raw: string;
  try {
    const r = await groqImpl.chat([
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: judgeUser },
    ], { maxTokens: 256, model: JUDGE_MODEL, seed: 7 });
    raw = r.text;
  } catch (e) {
    return { pass: false, schema: true, distinct: false, relevant: false, advancing: false, notes: `judge-error: ${(e as Error).message.slice(0, 200)}` };
  }

  let v: JudgeResult;
  try {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    v = JSON.parse(stripped) as JudgeResult;
  } catch {
    return { pass: false, schema: true, distinct: false, relevant: false, advancing: false, notes: `judge-parse-fail: ${raw.slice(0, 200)}` };
  }

  const pass = v.distinct && v.relevant && v.advancing;
  return {
    pass,
    schema: true,
    distinct: !!v.distinct,
    relevant: !!v.relevant,
    advancing: !!v.advancing,
    notes: pass ? '' : (v.notes ?? ''),
  };
}
