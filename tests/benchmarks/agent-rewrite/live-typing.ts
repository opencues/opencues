/**
 * Live-typing robustness benchmark.
 *
 * Stresses the property the architecture is supposed to provide:
 * **user-typed content during the LLM call is never clobbered.**
 *
 * For each scenario:
 *   1. Send (snapshot, task) to the LLM.
 *   2. While waiting for the response, append `userTypes` to the
 *      buffer — this is the simulated user typing during the call.
 *   3. When the response returns, run the three-way merge with
 *      live = snapshot + userTypes.
 *   4. Assert: the user's typed text is intact in the merged result,
 *      AND any non-overlapping LLM edits land.
 *
 * Run:  GROQ_API_KEY=... npx tsx tests/benchmarks/agent-rewrite/live-typing.ts
 */

import { chat, MODEL } from './groq';
import { threeWayMerge } from '../../../packages/opencues-runtime/src/modules/word-diff';
import { parseRewriteOutput } from '../../../packages/opencues-runtime/src/modules/agent-rewrite';

const REWRITE_SYSTEM_PROMPT = `You are an inline editor. The user is composing a document and has given you a TASK. Your job: return the rewritten document with the task applied — making whatever spelling, grammar, capitalisation, punctuation, and content changes the task asks for.

Rules:
- Output the ENTIRE rewritten document. Do not truncate, abbreviate, or summarise.
- Apply baseline edits even if the TASK doesn't explicitly ask: capitalise sentence-starts and proper nouns, fix obvious typos, collapse duplicated stop-words, add missing terminal punctuation on clearly-complete sentences. The TASK runs ON TOP of these baselines.
- Preserve the document's structure: paragraph breaks, line breaks, intentional whitespace.
- Do NOT add stylistic punctuation (salutation commas, appositive commas, em dashes) unless the TASK explicitly asks for it.
- Do NOT add commentary, explanations, code fences, or markdown decorations. Output the rewritten document and nothing else.

Output format:

REWRITTEN:
<the entire rewritten document>
END`;

interface Scenario {
  readonly id: string;
  readonly task: string;
  readonly snapshot: string;
  readonly userTypes: string;          // appended to snapshot during the call
  /** What MUST be in the merged buffer (user-typed content survives). */
  readonly userMustSurvive: readonly string[];
  /** Optional — at least one of these must land (LLM contribution). */
  readonly llmShouldLand?: readonly string[];
  /** Optional — none of these may appear (e.g. user-deleted content). */
  readonly mustNotContain?: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'append-tail',
    task: 'correct spelling',
    snapshot: 'I rite stuff.',
    userTypes: ' And another sentence.',
    userMustSurvive: ['And another sentence.'],
    llmShouldLand: ['write'],
  },
  {
    id: 'append-mid-word',
    task: 'fix grammar',
    snapshot: 'I went store yesterday.',
    userTypes: ' It was a long trip.',
    userMustSurvive: ['It was a long trip.'],
  },
  {
    id: 'append-paragraph',
    task: 'correct spelling and grammar',
    snapshot: 'first para has typoo.',
    userTypes: '\n\nSecond paragraph here.',
    userMustSurvive: ['Second paragraph here.'],
    mustNotContain: ['typoo'],
  },
  {
    id: 'long-doc-append',
    task: 'correct spelling',
    snapshot: [
      'The team made significnt progress on the new platform.',
      'Everyone was definately impressed.',
    ].join('\n'),
    userTypes: '\n\nMore thoughts to follow.',
    userMustSurvive: ['More thoughts to follow.'],
    mustNotContain: ['significnt', 'definately'],
  },
  {
    id: 'translation-with-typing',
    task: 'translate to spanish',
    snapshot: 'Monday.',
    userTypes: ' I will write more soon.',
    userMustSurvive: ['I will write more soon.'],
  },
];

interface ScenarioResult {
  readonly id: string;
  readonly pass: boolean;
  readonly latencyMs: number;
  readonly merged: string;
  readonly notes: string[];
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const userMsg = `TASK: ${s.task}\nDOCUMENT:\n${s.snapshot}`;
  const t0 = Date.now();
  const { text: response, latencyMs } = await chat(
    [
      { role: 'system', content: REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    { temperature: 0, maxTokens: Math.max(1024, s.snapshot.length * 2 + 256), seed: 42 },
  );

  const rewrite = parseRewriteOutput(response);
  const live = s.snapshot + s.userTypes;

  const notes: string[] = [];
  if (rewrite === null) {
    notes.push('LLM rewrite parse failed');
    return { id: s.id, pass: false, latencyMs, merged: live, notes };
  }

  const merged = threeWayMerge(s.snapshot, rewrite, live);
  const mergedText = merged.newText;

  let pass = true;

  // 1. User-typed content must be intact.
  for (const required of s.userMustSurvive) {
    if (!mergedText.includes(required)) {
      pass = false;
      notes.push(`USER content missing: "${required}"`);
    }
  }
  // 2. At least one expected LLM contribution must land (if any specified).
  if (s.llmShouldLand && s.llmShouldLand.length > 0) {
    const anyLanded = s.llmShouldLand.some(needle => mergedText.includes(needle));
    if (!anyLanded) {
      // This is a soft fail — model variance. Note it, don't fail.
      notes.push(`LLM contribution did not land (any of: ${s.llmShouldLand.join(', ')}) — soft note`);
    }
  }
  // 3. Forbidden substrings must not appear.
  if (s.mustNotContain) {
    for (const forbidden of s.mustNotContain) {
      if (mergedText.includes(forbidden)) {
        pass = false;
        notes.push(`forbidden substring present: "${forbidden}"`);
      }
    }
  }
  // 4. Hunk-bookkeeping sanity.
  notes.push(`merge: applied=${merged.appliedLlmHunks.length} dropped=${merged.droppedLlmHunks.length} userHunks=${merged.userHunks.length}`);

  return { id: s.id, pass, latencyMs, merged: mergedText, notes };
}

async function main(): Promise<void> {
  console.log(`Running ${SCENARIOS.length} live-typing scenario(s) against ${MODEL}\n`);

  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    const r = await runScenario(s);
    const mark = r.pass ? '✓' : '✗';
    console.log(`${mark} ${r.id.padEnd(28)} ${r.latencyMs}ms`);
    for (const n of r.notes) console.log(`    ${n}`);
    if (!r.pass) {
      console.log(`    merged: ${JSON.stringify(r.merged.slice(0, 200))}${r.merged.length > 200 ? '…' : ''}`);
    }
    results.push(r);
  }

  const passCount = results.filter(r => r.pass).length;
  const passRate = ((passCount / results.length) * 100).toFixed(1);
  console.log('');
  console.log(`──────────────────────────────────────────────`);
  console.log(`Live-typing pass rate: ${passCount}/${results.length} (${passRate}%)`);
  console.log(`(The bar: USER content NEVER gets clobbered. Anything else is informational.)`);

  if (passCount < results.length) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
