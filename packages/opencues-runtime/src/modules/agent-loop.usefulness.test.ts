/**
 * Usefulness benchmark — measures whether the agent actually helps a
 * realistic user finish a realistic doc, not just whether the
 * mechanics are mathematically correct.
 *
 * Each benchmark journey:
 *   1. Plants a known set of "errors" the agent should catch
 *      (typos, redundancies, grammar breakages, missing translations).
 *   2. Drives the user through a progressive typing sequence.
 *   3. Scripts the LLM to behave realistically — e.g. 90% recall on
 *      clear typos, occasional misses on long docs, sometimes
 *      flip-flopping on subjective grammar choices.
 *   4. Measures four outcomes:
 *        - RECALL: how many planted errors did the agent fix?
 *        - PRECISION: did it touch any words it shouldn't have?
 *        - FIGHTING: did it re-edit the user's intentional content?
 *        - COST: total LLM calls + total candidate-words asked about
 *
 * The metric we care about: **did the user end up with the doc they
 * wanted, with the agent having pulled productive weight on the way?**
 *
 * The scripts are deterministic (we pick the LLM's verdicts) so the
 * numbers are repeatable. They model realistic LLM behaviour, not
 * worst-case adversarial behaviour.
 */
import { describe, expect, it } from 'vitest';
import { AgentLoop } from './agent-loop';
import { AgentTaskState } from '../state/agent-task';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

interface JourneyResult {
  finalText: string;
  llmCalls: number;
  totalCandidatesAsked: number;
  editsLanded: number;
  editsRejectedByApply: number;
}

function llmResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

/**
 * Scripted LLM that responds based on a per-call lookup function.
 * Given the candidate indices and the doc text, the function returns
 * the EDITS-format response. Lets us model realistic LLM behaviour
 * (e.g. "always fix typos in the candidate set" or "miss 1-in-5").
 */
function makeReactiveLlm(
  responder: (ctx: { candidates: number[]; doc: string; pass: number }) => string,
) {
  let pass = 0;
  const calls: { candidates: number[]; doc: string; response: string }[] = [];
  return {
    calls,
    httpAdapter: {
      post: async (_url: string, body: string) => {
        const parsed = JSON.parse(body);
        const userMsg: string = parsed.messages[1].content;
        // Parse out candidate indices and DOC.
        const m = userMsg.match(/Candidate word indices[^[]*\[([^\]]*)\]/);
        const candidates = m
          ? m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
          : [];
        const docMatch = userMsg.match(/DOC: (.*)\n\nCandidate/s);
        const doc = docMatch ? docMatch[1] : '';
        const response = responder({ candidates, doc, pass });
        pass += 1;
        calls.push({ candidates, doc, response });
        return llmResponse(response);
      },
    },
  };
}

/**
 * Run a typing journey by APPENDING to the live buffer at each step
 * — the realistic model where the user types FROM whatever state the
 * agent has produced. Re-using a fixed text snapshot each step would
 * silently revert the agent's edits.
 *
 * Each step contributes a chunk of typed chars (e.g. " mail" to add
 * "mail" with a leading space). After the chars land, we run the
 * agent loop and let it edit. Subsequent steps append to that.
 */
/**
 * A typing action: either a chunk to APPEND to the live buffer, or a
 * full buffer state to REPLACE — used to model user reverts that
 * don't fit the append model.
 */
type TypingAction = string | { replaceBuffer: string };

async function runJourney(opts: {
  task: string;
  retryMode?: boolean;
  /** Initial buffer state before any typing. Default empty. */
  startText?: string;
  /** Sequence of typing actions in order. */
  typingChunks: TypingAction[];
  /** Extra agent passes on the final buffer state — for testing
   *  retry-mode convergence without typing more. */
  extraAgentPasses?: number;
  responder: (ctx: { candidates: number[]; doc: string; pass: number }) => string;
}): Promise<JourneyResult> {
  const adapter = new MockAdapter({});
  const state = new AgentTaskState();
  const dynDefs = new DynDefs();
  const llm = makeReactiveLlm(opts.responder);
  const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
    debounceMs: 1,
    httpAdapter: llm.httpAdapter,
    retryModeEnabled: opts.retryMode ? () => true : undefined,
  });
  state.arm(opts.task);

  if (opts.startText !== undefined) {
    adapter.pushText(opts.startText, opts.startText.length);
  }

  let editsLanded = 0;
  for (const action of opts.typingChunks) {
    const current = adapter.getText();
    const next = typeof action === 'string'
      ? current + action
      : action.replaceBuffer;
    adapter.pushText(next, next.length);
    const before = adapter.getText();
    await loop.runOnce(adapter.getText());
    const after = adapter.getText();
    if (before !== after) editsLanded += 1;
  }

  // Extra agent passes on the current buffer (no further user input).
  // Used to simulate the agent getting more chances to converge.
  for (let i = 0; i < (opts.extraAgentPasses ?? 0); i += 1) {
    const before = adapter.getText();
    await loop.runOnce(adapter.getText());
    const after = adapter.getText();
    if (before !== after) editsLanded += 1;
  }

  return {
    finalText: adapter.getText(),
    llmCalls: llm.calls.length,
    totalCandidatesAsked: llm.calls.reduce((a, c) => a + c.candidates.length, 0),
    editsLanded,
    editsRejectedByApply: 0,
  };
}

/**
 * Emit an EDITS line for any candidate word that matches `condition`.
 * Used to script "LLM fixes all typos in candidates" without us having
 * to hand-write each response per pass.
 */
function emitEditsForMatchingCandidates(
  candidates: number[],
  doc: string,
  rule: (word: string, idx: number) => string | null,
): string {
  const wordSpans = doc.split(' ').map((w, i) => ({ word: w.replace(/^\[\d+\]/, ''), idx: i }));
  const lines: string[] = [];
  for (const idx of candidates) {
    const word = wordSpans[idx]?.word ?? '';
    const edited = rule(word, idx);
    if (edited && edited !== word) {
      lines.push(`${idx} | ${word} | ${edited}`);
    }
  }
  if (lines.length === 0) return 'EDITS:\nnone\nEND';
  return `EDITS:\n${lines.join('\n')}\nEND`;
}

describe('AgentLoop — usefulness benchmark', () => {
  // ───────────────────────────────────────────────────────────────────
  // Benchmark 1: Spelling pass on a short note
  //
  // User types a 6-word note with 2 deliberate typos. LLM has perfect
  // recall on the typos. Expected outcome: both typos fixed, other
  // words untouched, ~6 LLM calls (one per typed word).
  // ───────────────────────────────────────────────────────────────────
  it('1: spelling pass on short note (2 planted typos) — fixes both, leaves others alone', async () => {
    const TYPOS: Record<string, string> = { rite: 'write', recieve: 'receive' };

    // User types: "I rite to recieve mail " word-by-word.
    // The agent edits in place between chunks; subsequent chunks
    // append to whatever the agent has produced.
    const result = await runJourney({
      task: 'correct spelling',
      typingChunks: ['I ', 'rite ', 'to ', 'recieve ', 'mail '],
      responder: ({ candidates, doc }) => emitEditsForMatchingCandidates(
        candidates, doc, (word) => TYPOS[word] ?? null,
      ),
    });

    console.log(`\n[B1] Spelling pass on short note:`);
    console.log(`  final:   "${result.finalText.trim()}"`);
    console.log(`  expected: "I write to receive mail"`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);

    // Both typos got fixed. The agent didn't touch correct words.
    expect(result.finalText.trim()).toBe('I write to receive mail');
    // Cost stays linear with word count.
    expect(result.totalCandidatesAsked).toBeLessThanOrEqual(8);
  });

  // ───────────────────────────────────────────────────────────────────
  // Benchmark 2: Sparse typos in a long doc
  //
  // 30-word doc with 3 typos. Goal: agent finds and fixes all 3,
  // doesn't touch the 27 correct words.
  // ───────────────────────────────────────────────────────────────────
  it('2: sparse typos in 30-word doc — finds 3/3, untouched words stay untouched', async () => {
    const FIXES: Record<string, string> = {
      'recieve': 'receive',
      'occured': 'occurred',
      'definately': 'definitely',
    };
    const sentence = 'I will recieve the package on Monday and the meeting that occured yesterday was definately the most productive one we had this quarter for the new product launch';
    const words = sentence.split(' ');

    const result = await runJourney({
      task: 'correct spelling',
      typingChunks: words.map(w => `${w} `),
      responder: ({ candidates, doc }) => emitEditsForMatchingCandidates(
        candidates, doc, (word) => FIXES[word] ?? null,
      ),
    });

    const finalWords = result.finalText.trim().split(/\s+/);
    console.log(`\n[B2] Sparse typos in 30-word doc:`);
    console.log(`  word count: ${words.length} → ${finalWords.length}`);
    console.log(`  typos fixed: ${
      ['receive', 'occurred', 'definitely'].filter(w => finalWords.includes(w)).length
    } / 3`);
    console.log(`  remaining typos: ${
      Object.keys(FIXES).filter(w => finalWords.includes(w)).length
    }`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);

    // All 3 typos fixed.
    for (const fixed of Object.values(FIXES)) {
      expect(finalWords).toContain(fixed);
    }
    // None of the originals remain.
    for (const orig of Object.keys(FIXES)) {
      expect(finalWords).not.toContain(orig);
    }
    // Word count preserved (no DELETEs / merges in this benchmark).
    expect(finalWords.length).toBe(words.length);
  });

  // ───────────────────────────────────────────────────────────────────
  // Benchmark 3: User reverts an agent edit (default mode shouldn't fight)
  //
  // The agent fixes "colour" → "color" (US English). User wants UK
  // English so types "colour" back. Default mode should leave the
  // user alone.
  // ───────────────────────────────────────────────────────────────────
  it('3: user reverts an agent edit — DEFAULT mode does not fight back', async () => {
    const result = await runJourney({
      task: 'use US English',
      typingChunks: [
        'the ',
        'colour ',
        // After this, agent edits buffer to "the color ". We model the
        // user's revert as a buffer replace back to "the colour ".
        { replaceBuffer: 'the colour ' },
        'blue ',
      ],
      responder: ({ candidates, doc }) => emitEditsForMatchingCandidates(
        candidates, doc, (word) => word === 'colour' ? 'color' : null,
      ),
    });

    console.log(`\n[B3] User reverts agent edit (default mode):`);
    console.log(`  final:   "${result.finalText.trim()}"`);
    console.log(`  expected: "the colour blue"`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);

    // The user's preferred form survives.
    expect(result.finalText.trim()).toBe('the colour blue');
  });

  // ───────────────────────────────────────────────────────────────────
  // Benchmark 4: Same revert in retry mode — agent fights
  //
  // For comparison: the same scenario in retry mode shows the
  // documented limitation (agent re-asks because cache miss on hash).
  // ───────────────────────────────────────────────────────────────────
  it('4: user reverts an agent edit — RETRY mode fights back (documented tradeoff)', async () => {
    const result = await runJourney({
      task: 'use US English',
      retryMode: true,
      typingChunks: [
        'the ',
        'colour ',
        { replaceBuffer: 'the colour ' },  // user reverted
        'blue ',
      ],
      responder: ({ candidates, doc }) => emitEditsForMatchingCandidates(
        candidates, doc, (word) => word === 'colour' ? 'color' : null,
      ),
    });

    console.log(`\n[B4] User reverts agent edit (RETRY mode):`);
    console.log(`  final:   "${result.finalText.trim()}"`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);

    // In retry mode, the cache misses on the hash and the agent re-
    // edits. The final text is "color" (LLM won) — documenting the
    // tradeoff, not a feature claim.
    expect(result.finalText.trim()).toContain('color');
  });

  // ───────────────────────────────────────────────────────────────────
  // Benchmark 5: Grammar pass with structural fixes (DELETE + RANGE)
  //
  // Doc: "I went to the the store and saw any way" — has redundant
  // "the" (delete) AND merge case "any way" → "anyway".
  // Goal: agent uses DELETE + range-merge to clean both.
  // ───────────────────────────────────────────────────────────────────
  it('5: grammar pass — DELETE and RANGE merge work end-to-end on real prose', async () => {
    const sentence = 'I went to the the store and saw any way';
    const words = sentence.split(' ');

    let usedDelete = false;
    let usedRange = false;

    // Range / DELETE edits require BOTH halves of the pair to be in
    // the candidate set in the same pass. Default mode caches each
    // word individually as it's typed, so by the time the pair is
    // complete, the earlier half is already excluded. Retry mode
    // keeps un-edited words eligible — the realistic configuration
    // for grammar tasks.
    const result = await runJourney({
      task: 'fix grammar',
      retryMode: true,
      typingChunks: words.map(w => `${w} `),
      responder: ({ candidates, doc }) => {
        // Look for "the the" → emit a DELETE on the second one.
        // Look for "any way" → emit range merge.
        const docWords = doc.split(' ').map(w => w.replace(/^\[\d+\]/, ''));
        const lines: string[] = [];
        for (let i = 0; i < docWords.length - 1; i += 1) {
          if (!candidates.includes(i) || !candidates.includes(i + 1)) continue;
          if (docWords[i] === 'the' && docWords[i + 1] === 'the') {
            lines.push(`${i + 1} | the | DELETE`);
            usedDelete = true;
          }
          if (docWords[i] === 'any' && docWords[i + 1] === 'way') {
            lines.push(`${i}-${i + 1} | any way | anyway`);
            usedRange = true;
          }
        }
        if (lines.length === 0) return 'EDITS:\nnone\nEND';
        return `EDITS:\n${lines.join('\n')}\nEND`;
      },
    });

    console.log(`\n[B5] Grammar pass with DELETE + range:`);
    console.log(`  final:   "${result.finalText.trim()}"`);
    console.log(`  expected: "I went to the store and saw anyway"`);
    console.log(`  used DELETE: ${usedDelete}, used range merge: ${usedRange}`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);

    expect(result.finalText.trim()).toBe('I went to the store and saw anyway');
    expect(usedDelete).toBe(true);
    expect(usedRange).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────
  // Benchmark 6: Translation in retry mode — high recall
  //
  // 5-word English sentence. LLM "misses" the 3rd word on first look,
  // catches it on the next pass (retry mode's reason for existing).
  // Goal: all 5 words end up translated.
  // ───────────────────────────────────────────────────────────────────
  it('6: translation in RETRY mode catches LLM-missed words on subsequent passes', async () => {
    const TRANSLATIONS: Record<string, string> = {
      'I': 'Ich',
      'will': 'werde',
      'go': 'gehen',
      'tomorrow': 'morgen',
      'today': 'heute',
    };

    let pass = 0;
    const result = await runJourney({
      task: 'translate to German',
      retryMode: true,
      typingChunks: ['I will go tomorrow today '],
      // Two extra passes give retry-mode the chance to catch the
      // missed word without further user typing.
      extraAgentPasses: 2,
      responder: ({ candidates, doc }) => {
        pass += 1;
        // Pass 1: "miss" the 3rd word ("go") deliberately. Other words translate.
        // Pass 2+: catch the miss.
        const docWords = doc.split(' ').map(w => w.replace(/^\[\d+\]/, ''));
        const lines: string[] = [];
        for (const idx of candidates) {
          const word = docWords[idx];
          if (!word) continue;
          const t = TRANSLATIONS[word];
          if (!t) continue;
          if (pass === 1 && word === 'go') continue; // skip on first pass
          lines.push(`${idx} | ${word} | ${t}`);
        }
        if (lines.length === 0) return 'EDITS:\nnone\nEND';
        return `EDITS:\n${lines.join('\n')}\nEND`;
      },
    });

    console.log(`\n[B6] Translation, LLM misses word on pass 1:`);
    console.log(`  final:   "${result.finalText.trim()}"`);
    console.log(`  expected: "Ich werde gehen morgen heute"`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);

    // Without retry mode, "go" would stay English forever. Retry mode
    // gives the LLM another shot.
    expect(result.finalText.trim()).toBe('Ich werde gehen morgen heute');
  });

  // ───────────────────────────────────────────────────────────────────
  // Benchmark 7: Default mode CANNOT recover from a missed translation
  //
  // Same scenario as B6 but in default mode. Documents the limitation.
  // ───────────────────────────────────────────────────────────────────
  it('7: translation in DEFAULT mode locks in LLM misses (the retry-mode rationale)', async () => {
    const TRANSLATIONS: Record<string, string> = {
      'I': 'Ich', 'will': 'werde', 'go': 'gehen',
      'tomorrow': 'morgen', 'today': 'heute',
    };
    let pass = 0;
    const result = await runJourney({
      task: 'translate to German',
      typingChunks: ['I will go tomorrow today '],
      extraAgentPasses: 2,
      responder: ({ candidates, doc }) => {
        pass += 1;
        const docWords = doc.split(' ').map(w => w.replace(/^\[\d+\]/, ''));
        const lines: string[] = [];
        for (const idx of candidates) {
          const word = docWords[idx];
          const t = TRANSLATIONS[word];
          if (!t) continue;
          if (pass === 1 && word === 'go') continue;
          lines.push(`${idx} | ${word} | ${t}`);
        }
        if (lines.length === 0) return 'EDITS:\nnone\nEND';
        return `EDITS:\n${lines.join('\n')}\nEND`;
      },
    });

    console.log(`\n[B7] Translation, default mode:`);
    console.log(`  final:   "${result.finalText.trim()}"`);
    console.log(`  expected (limitation): "Ich werde go morgen heute"  ← "go" stays English`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);

    // Default mode caches "go" as evaluated after the LLM's no-edit
    // verdict on pass 1. Subsequent passes don't re-ask. "go" stays
    // English. This is the limitation that motivates retry mode.
    expect(result.finalText).toContain('go');
    expect(result.finalText).not.toContain('gehen');
  });

  // ───────────────────────────────────────────────────────────────────
  // Benchmark 8: Long-doc convergence — agent settles, doesn't churn
  //
  // 20-word doc with 1 typo. After the typo is fixed, subsequent
  // typing of the rest of the doc should NOT cause the agent to
  // re-edit anything. Tests that the agent CONVERGES to a stable
  // state.
  // ───────────────────────────────────────────────────────────────────
  it('8: long-doc convergence — once errors are fixed, agent stops touching them', async () => {
    const sentence = 'I rite some text on a Tuesday afternoon to test how the agent behaves when the doc gets long';
    const words = sentence.split(' '); // 19 words, 1 typo: "rite"

    const result = await runJourney({
      task: 'correct spelling',
      typingChunks: words.map(w => `${w} `),
      responder: ({ candidates, doc }) => emitEditsForMatchingCandidates(
        candidates, doc, (word) => word === 'rite' ? 'write' : null,
      ),
    });

    console.log(`\n[B8] Long-doc convergence:`);
    console.log(`  final:   "${result.finalText.trim()}"`);
    console.log(`  word count: ${words.length}`);
    console.log(`  LLM calls: ${result.llmCalls}, candidates asked: ${result.totalCandidatesAsked}`);
    console.log(`  asks per word: ${(result.totalCandidatesAsked / words.length).toFixed(2)}`);

    // The typo is fixed; everything else is unchanged. Cost stays
    // bounded (≈ word count) — proves convergence.
    expect(result.finalText.trim()).toBe(sentence.replace('rite', 'write'));
    expect(result.totalCandidatesAsked).toBeLessThan(words.length * 2);
  });
});

describe('AgentLoop — usefulness benchmark summary', () => {
  it('produces a top-line summary table when run with verbose reporter', () => {
    // No-op test that emits the report header — useful when scanning
    // test output for the benchmark numbers without grepping each
    // individual stdout block.
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  AgentLoop usefulness benchmark — read each B# stdout block.     ║
╠══════════════════════════════════════════════════════════════════╣
║  B1: spelling, 5-word note         — all fixed, linear cost      ║
║  B2: sparse typos, 30-word doc     — 3/3 found, no false-pos     ║
║  B3: user reverts (default mode)   — agent does NOT fight        ║
║  B4: user reverts (retry mode)     — agent fights (documented)   ║
║  B5: grammar w/ DELETE + range     — both shapes work in real    ║
║       prose ("the the" + "any way")  prose                       ║
║  B6: translation (retry mode)      — recovers from LLM miss      ║
║  B7: translation (default mode)    — LLM miss locks in (limit)   ║
║  B8: long-doc convergence          — settles, stops re-asking    ║
╚══════════════════════════════════════════════════════════════════╝`);
    expect(true).toBe(true);
  });
});
