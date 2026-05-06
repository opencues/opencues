import { describe, expect, it } from 'vitest';
import { AgentLoop } from './agent-loop';
import { DimRender } from './dim-render';
import { AgentTaskState, hashWordText } from '../state/agent-task';
import { DynDefs } from '../state/dyn-defs';
import { HighlightState } from '../state/highlight-state';
import { MockAdapter } from '../../testing/mock-adapter';

/** Wrap the EDITS-format payload as an OpenAI-style chat completion JSON. */
function llmResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function setupLoop(text: string, llmContent: string, retryMode: boolean) {
  const adapter = new MockAdapter({});
  // Park the cursor past the end of the text so no word is excluded
  // as cursor-adjacent — keeps the candidate set predictable for the
  // assertions below.
  adapter.pushText(text, text.length + 1);
  const state = new AgentTaskState();
  const dynDefs = new DynDefs();
  const httpAdapter = {
    post: async () => llmResponse(llmContent),
  };
  const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
    debounceMs: 1,
    httpAdapter,
    retryModeEnabled: () => retryMode,
  });
  return { adapter, state, dynDefs, loop };
}

describe('AgentLoop cache policy (agent-retry-mode)', () => {
  // Doc: "Hello world test " (trailing space so the cursor at end isn't
  // adjacent to any word — keeps all three words as candidates).
  // wordIndex: 0=Hello, 1=world, 2=test
  // LLM is told to edit only word 1 (world → Welt). The other two words
  // were sent as candidates but came back without an edit.
  const TEXT = 'Hello world test ';
  const LLM_EDITS = 'EDITS:\n1 | world | Welt\nEND';

  it('default mode: caches every candidate (the historical behaviour)', async () => {
    const { state, loop } = setupLoop(TEXT, LLM_EDITS, /* retry= */ false);
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    // All three candidates were evaluated. None will be reconsidered next pass.
    expect(state.isEvaluated(0, hashWordText('Hello'))).toBe(true);
    expect(state.isEvaluated(1, hashWordText('world'))).toBe(true);
    expect(state.isEvaluated(2, hashWordText('test'))).toBe(true);
    expect(state.evaluationCount()).toBe(3);
  });

  it('retry mode: caches ONLY words the LLM edited, keyed by POST-EDIT hash', async () => {
    // Two-part contract:
    //   (a) un-edited words stay un-cached → reconsidered next pass
    //       (the original retry-mode purpose: catch missed translations).
    //   (b) edited words ARE cached, but at NEW idx with NEW hash so
    //       the next pass — which sees the post-edit word — gets a
    //       cache HIT and doesn't re-ask the LLM. Without (b), the
    //       agent kept "translating earlier text" forever because hash
    //       lookups always missed (cached OLD vs visible NEW).
    const { adapter, state, loop } = setupLoop(TEXT, LLM_EDITS, /* retry= */ true);
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    // (a) un-edited words: not cached.
    expect(state.isEvaluated(0, hashWordText('Hello'))).toBe(false);
    expect(state.isEvaluated(2, hashWordText('test'))).toBe(false);

    // (b) edited word: cached at NEW idx 1 with NEW hash ('Welt'),
    // not OLD hash ('world').
    expect(state.isEvaluated(1, hashWordText('Welt'))).toBe(true);
    expect(state.isEvaluated(1, hashWordText('world'))).toBe(false);
    expect(state.evaluationCount()).toBe(1);

    // Sanity: the buffer reflects the edit.
    expect(adapter.getText()).toBe('Hello Welt test ');
  });

  it('retry mode: a second pass on the post-edit text does NOT re-ask about the edited word', async () => {
    // The user-facing symptom of the missing post-edit cache: the
    // agent kept selecting the just-translated word as a candidate
    // each pass. After the fix, the second pass sees a cache hit and
    // the candidate set excludes the already-edited slot.
    const { adapter, state, loop } = setupLoop(TEXT, LLM_EDITS, /* retry= */ true);
    state.arm('translate to German');

    await loop.runOnce(TEXT);
    expect(adapter.getText()).toBe('Hello Welt test ');

    // Spy on the next pass — capture the candidate indices as they're
    // sent to the LLM.
    let capturedBody: string | null = null;
    const spyAdapter = {
      post: async (_url: string, body: string) => {
        capturedBody = body;
        return llmResponse('EDITS:\nnone\nEND');
      },
    };
    // Replace the loop's httpAdapter for the second pass.
    (loop as unknown as { options: { httpAdapter: typeof spyAdapter } }).options.httpAdapter = spyAdapter;

    await loop.runOnce(adapter.getText());

    expect(capturedBody).not.toBeNull();
    const parsedBody = JSON.parse(capturedBody!);
    const userMsg: string = parsedBody.messages[1].content;
    // The candidate-indices line in the prompt should NOT include idx 1
    // (the just-translated 'Welt' position).
    const candMatch = userMsg.match(/Candidate word indices[^[]*\[([^\]]*)\]/);
    expect(candMatch).not.toBeNull();
    const candidates = candMatch![1].split(',').map(s => parseInt(s.trim(), 10));
    expect(candidates).not.toContain(1);
  });
});

describe('AgentLoop trigger-word protection (only active while armed)', () => {
  // Words that form a TASK_* trigger phrase must not be reachable for
  // edits — otherwise the agent could rename `agentically` → `agentisch`
  // and the user would no longer be able to issue `agentically <X> _`.
  // Protection is automatic when armed (runOnce bails early if not).

  function setupProtect(text: string, llmContent: string) {
    const adapter = new MockAdapter({});
    adapter.pushText(text, text.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let capturedBody: string | null = null;
    const httpAdapter = {
      post: async (_url: string, body: string) => {
        capturedBody = body;
        return llmResponse(llmContent);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1,
      httpAdapter,
    });
    return { adapter, state, dynDefs, loop, getCapturedBody: () => capturedBody };
  }

  function candidatesFromBody(body: string): number[] {
    const parsed = JSON.parse(body);
    const userMsg: string = parsed.messages[1].content;
    const m = userMsg.match(/Candidate word indices[^[]*\[([^\]]*)\]/);
    if (!m) return [];
    return m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
  }

  it('protects single-word triggers (agentically) from being a candidate', async () => {
    const TEXT = 'agentically translate to german ';
    // wordIndex: 0=agentically, 1=translate, 2=to, 3=german
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).not.toContain(0); // agentically — protected
    expect(cands).toContain(1);     // translate — fair game
    expect(cands).toContain(2);     // to
    expect(cands).toContain(3);     // german
  });

  it('protects two-word triggers (add task) only when both halves are adjacent', async () => {
    const TEXT = 'I want to add task fix grammar ';
    // wordIndex: 0=I 1=want 2=to 3=add 4=task 5=fix 6=grammar
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).not.toContain(3); // add (paired with task)
    expect(cands).not.toContain(4); // task (paired with add)
    expect(cands).toContain(0);     // I
    expect(cands).toContain(5);     // fix
    expect(cands).toContain(6);     // grammar
  });

  it('does NOT protect "task" alone in regular prose', async () => {
    // "every task gets translated" — "task" appears without a preceding
    // add/stop/current trigger word. Should remain editable so prose
    // mentioning "task" isn't locked from translation.
    const TEXT = 'every task gets translated ';
    // wordIndex: 0=every 1=task 2=gets 3=translated
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).toContain(1); // task — not part of any trigger pair
    expect(cands).toContain(0);
    expect(cands).toContain(2);
    expect(cands).toContain(3);
  });

  it('protection survives trailing punctuation (stop task,)', async () => {
    // Real prose has commas. The normaliseLower strip should let
    // "stop task," still match the trigger pair.
    const TEXT = 'I want to stop task, please ';
    // wordIndex: 0=I 1=want 2=to 3=stop 4=task, 5=please
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('fix spelling');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).not.toContain(3); // stop
    expect(cands).not.toContain(4); // task,
  });

  it('partial prefix of a trigger is NOT protected (agentic ≠ agentically)', async () => {
    // Prefix matching would silently swallow normal English words.
    // We require the full literal phrase.
    const TEXT = 'agentic stuff here ';
    // wordIndex: 0=agentic 1=stuff 2=here
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).toContain(0); // agentic — editable, only "agentically" exact-match wins
    expect(cands).toContain(1);
    expect(cands).toContain(2);
  });

  it('lonely "add" without "task" after it is NOT protected', async () => {
    // The protection is on the full pair; an "add" by itself in prose
    // (e.g. "please add some code") must stay editable.
    const TEXT = 'please add some code ';
    // wordIndex: 0=please 1=add 2=some 3=code
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).toContain(1); // add — no "task" follows, no pair, editable
  });

  it('case insensitivity: "Add Task" protects same as "add task"', async () => {
    const TEXT = 'I will Add Task fix ';
    // wordIndex: 0=I 1=will 2=Add 3=Task 4=fix
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).not.toContain(2); // Add
    expect(cands).not.toContain(3); // Task
    expect(cands).toContain(4);     // fix
  });

  it('all four trigger families protect their pair', async () => {
    // Sweeps the full set so a future addition to TASK_TRIGGER_KEYWORDS
    // will need a corresponding protection-test entry here.
    const TEXT = 'agentically a stop task b current task c add task d ';
    // wordIndex: 0=agentically 1=a 2=stop 3=task 4=b 5=current 6=task 7=c 8=add 9=task 10=d
    const { state, loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    state.arm('fix spelling');

    await loop.runOnce(TEXT);

    const cands = candidatesFromBody(getCapturedBody()!);
    expect(cands).not.toContain(0);  // agentically
    expect(cands).not.toContain(2);  // stop
    expect(cands).not.toContain(3);  // task (paired with stop)
    expect(cands).not.toContain(5);  // current
    expect(cands).not.toContain(6);  // task (paired with current)
    expect(cands).not.toContain(8);  // add
    expect(cands).not.toContain(9);  // task (paired with add)
    expect(cands).toContain(1);      // a — interspersed prose
    expect(cands).toContain(4);      // b
    expect(cands).toContain(7);      // c
    expect(cands).toContain(10);     // d
  });

  it('protection only fires while a task is armed (no task → no LLM call at all)', async () => {
    // Belt-and-braces: when state.armed is false, runOnce bails before
    // even building candidates. So protection is automatic — there's
    // no path that could ask the LLM about trigger words while
    // un-armed.
    const TEXT = 'agentically and add task here ';
    const { loop, getCapturedBody } = setupProtect(TEXT, 'EDITS:\nnone\nEND');
    // Notice: state.arm() NOT called.

    await loop.runOnce(TEXT);

    expect(getCapturedBody()).toBeNull(); // no LLM call fired
  });
});

describe('AgentLoop multi-word edit: DynDef shift on apply', () => {
  // Bug repro: when a batch of agent edits contains a multi-word edit
  // ("will" → "ich werde"), every downstream word shifts right by N-1
  // positions. The pre-fix code stored each edit's DynDef at the OLD
  // wordIndex, so later defs ended up at indices that had nothing to do
  // with their new visible words — DimRender then lost the dim because
  // the multi-word span at the lower index swallowed the position.
  //
  // The fix: after splicing, store DynDefs at NEW word indices,
  // accumulating word-count deltas left-to-right.

  function setupMultiEdit(text: string, llmContent: string) {
    const adapter = new MockAdapter({});
    adapter.pushText(text, text.length + 1); // cursor past end (no exclusion)
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = { post: async () => llmResponse(llmContent) };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1,
      httpAdapter,
    });
    return { adapter, state, dynDefs, loop };
  }

  it('multi-word edit at idx 1 + single-word at idx 2 places downstream def at NEW idx 3', async () => {
    // text words:    0=I  1=will  2=run  3=today
    // edits:         will → "ich werde" (1→2 words), run → "laufe"
    // post-splice:   0=I  1=ich  2=werde  3=laufe  4=today
    // expected defs: idx 1 (multi-word span), idx 3 (single-word "laufe")
    const TEXT = 'I will run today ';
    const LLM_EDITS = 'EDITS:\n1 | will | ich werde\n2 | run | laufe\nEND';
    const { adapter, state, dynDefs, loop } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('I ich werde laufe today ');

    // Multi-word def at NEW idx 1 covers "ich werde"
    const defAt1 = dynDefs.get(1);
    expect(defAt1).toBeDefined();
    expect(defAt1!.originalWord).toBe('will');
    expect(defAt1!.alternatives).toEqual(['will', 'ich werde']);

    // Single-word def landed at NEW idx 3 (was OLD idx 2 — shifted by +1)
    const defAt3 = dynDefs.get(3);
    expect(defAt3).toBeDefined();
    expect(defAt3!.originalWord).toBe('run');
    expect(defAt3!.alternatives).toEqual(['run', 'laufe']);

    // Crucially: NO def at OLD idx 2 (that's where the bug used to leave it)
    expect(dynDefs.get(2)).toBeUndefined();
  });

  it('two multi-word edits accumulate the shift', async () => {
    // text:        0=A  1=B  2=C  3=D
    // edits:       B → "BB BB" (1→2), C → "CC CC CC" (1→3)
    // post:        0=A  1=BB  2=BB  3=CC  4=CC  5=CC  6=D
    // expected:    def at NEW idx 1 (multi 2), def at NEW idx 3 (multi 3)
    const TEXT = 'A B C D ';
    const LLM_EDITS = 'EDITS:\n1 | B | BB BB\n2 | C | CC CC CC\nEND';
    const { adapter, dynDefs, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('expand');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('A BB BB CC CC CC D ');
    expect(dynDefs.get(1)?.alternatives).toEqual(['B', 'BB BB']);
    expect(dynDefs.get(3)?.alternatives).toEqual(['C', 'CC CC CC']);
    // No stale defs at intermediate slots
    expect(dynDefs.get(2)).toBeUndefined();
    expect(dynDefs.get(4)).toBeUndefined();
  });

  it('single-word edits only — no shift, defs land at original indices', async () => {
    // Regression guard: the simple all-single-word case must keep
    // behaving as before the multi-word fix.
    const TEXT = 'I rite some text ';  // idx 0=I, 1=rite, 2=some, 3=text
    const LLM_EDITS = 'EDITS:\n1 | rite | write\n3 | text | prose\nEND';
    const { adapter, dynDefs, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('correct spelling');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('I write some prose ');
    expect(dynDefs.get(1)?.alternatives).toEqual(['rite', 'write']);
    expect(dynDefs.get(3)?.alternatives).toEqual(['text', 'prose']);
    expect(dynDefs.get(2)).toBeUndefined();
  });

  it('DimRender produces dim ranges for ALL agent edits after a multi-word splice', async () => {
    // End-to-end scenario covering the user-visible bug: with multi-
    // word edits, downstream dims used to vanish because their defs
    // were stranded at OLD indices, swallowed by the multi-word span.
    // After the fix, every edit produces its own dim range at the
    // correct char offsets.
    const TEXT = 'I will run today ';
    const LLM_EDITS = 'EDITS:\n1 | will | ich werde\n2 | run | laufe\nEND';
    const { adapter, dynDefs, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('translate to German');

    await loop.runOnce(TEXT);

    // Wire up a DimRender against the mutated state and pull directives.
    // Stub configLoader: empty navigableWords means dim relies entirely
    // on DynDefs — exactly what we want to test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubConfigLoader = { navigableWords: new Set<string>() } as any;
    const hlState = new HighlightState();
    const dimRender = new DimRender(adapter, hlState, dynDefs, stubConfigLoader);
    const directives = dimRender.compute({
      text: adapter.getText(),
      cursor: adapter.getText().length,
      externalHighlights: [],
    });
    expect(directives).not.toBeNull();
    const ranges = directives!.dimRanges ?? [];

    // Final text: "I ich werde laufe today "
    //              0 2   6     12    17   23
    // - "ich werde" multi-word span: chars [2, 11)
    // - "laufe" single-word: chars [12, 17)
    expect(ranges).toContainEqual({ start: 2, end: 11 });
    expect(ranges).toContainEqual({ start: 12, end: 17 });
  });

  it('dedupes duplicate edits at the same wordIndex (the strongngng bug)', async () => {
    // Bug repro: when the LLM emits two edits for the same slot in
    // one batch, the apply loop's right-to-left splice composes them
    // wrong: edit-2 splices [w.start, w.end) of newText, but newText
    // now holds edit-1's editedWord, whose tail beyond the original
    // word length leaks past edit-2's replacement.
    //
    // User-visible: `stron` → `strongng` (edit-1) + `stron` → `strongng`
    // (edit-2) yielded `strongnggng`. The fix dedupes by wordIndex,
    // keeping the first edit and dropping the rest.
    const TEXT = 'I see stron text ';  // wordIndex: 0=I 1=see 2=stron 3=text
    const LLM_EDITS = 'EDITS:\n2 | stron | strongng\n2 | stron | strongngng\nEND';
    const { adapter, dynDefs, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('expand');

    await loop.runOnce(TEXT);

    // Only the first edit applies; the duplicate is dropped.
    expect(adapter.getText()).toBe('I see strongng text ');
    expect(dynDefs.get(2)?.alternatives).toEqual(['stron', 'strongng']);
  });

  it('prior defs at higher indices shift when a current-batch multi-word edit lands', async () => {
    // User-reported repro: I'd typed paragraph 1, agent translated it
    // (defs at idx 0..K). Then I started paragraph 2; the agent's edit
    // batch on paragraph 2 contained a multi-word edit, which shifted
    // every paragraph-1 def's correct word index. Without shifting
    // prior defs, they ended up off-by-N and either showed dim on the
    // wrong word or got pruned by the next user-source pruneStale.
    const TEXT = 'A B C D E ';  // 5 words
    // Pre-seed: simulate a prior agent pass that translated word D (idx 3)
    // and word E (idx 4) — these are the "old paragraph" defs we want
    // to survive when the next batch includes a multi-word edit upstream.
    const adapter = new MockAdapter({});
    adapter.pushText(TEXT, TEXT.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    dynDefs.set(3, { originalWord: 'D', alternatives: ['D', 'd_translated'], currentIndex: 1, spanStart: 6, spanEnd: 18, blankName: 'agent-task' });
    dynDefs.set(4, { originalWord: 'E', alternatives: ['E', 'e_translated'], currentIndex: 1, spanStart: 19, spanEnd: 31, blankName: 'agent-task' });
    // Now the new batch: edit at idx 1, B → "BB BB" (1→2 words).
    const httpAdapter = { post: async () => llmResponse('EDITS:\n1 | B | BB BB\nEND') };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1,
      httpAdapter,
    });
    state.arm('expand');

    await loop.runOnce(TEXT);

    // After multi-word splice at idx 1: paragraph-1 defs at 3 and 4
    // shift to 4 and 5 (each +1 because of the 1→2 word expansion).
    expect(dynDefs.get(1)?.alternatives).toEqual(['B', 'BB BB']); // new edit
    expect(dynDefs.get(4)?.originalWord).toBe('D');               // shifted from 3
    expect(dynDefs.get(5)?.originalWord).toBe('E');               // shifted from 4
    // Old positions should be vacated (otherwise we'd have duplicate or
    // stale defs).
    expect(dynDefs.get(3)?.originalWord).not.toBe('D');
  });

  it('DELETE marker: removes word + trailing whitespace', async () => {
    // "the the cat sat" → "the cat sat" — drop redundant "the" at idx 1
    const TEXT = 'the the cat sat ';
    const LLM_EDITS = 'EDITS:\n1 | the | DELETE\nEND';
    const { adapter, dynDefs, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('fix grammar');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('the cat sat ');
    // No def stored at the deleted position.
    expect(dynDefs.get(1)).toBeUndefined();
  });

  it('DELETE marker: removes word + leading whitespace when at end of buffer', async () => {
    // No trailing whitespace to consume; fall back to leading.
    // Cursor parked elsewhere so "extra" isn't cursor-adjacent.
    const TEXT = 'the cat extra';  // wordIndex: 0=the 1=cat 2=extra
    const adapter = new MockAdapter({});
    adapter.pushText(TEXT, 0); // cursor at start, "the" is cursor-adjacent (excluded)
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = { post: async () => llmResponse('EDITS:\n2 | extra | DELETE\nEND') };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    await loop.runOnce(TEXT);

    // Leading space before "extra" got consumed.
    expect(adapter.getText()).toBe('the cat');
  });

  it('DELETE marker: shifts prior defs at higher indices left by 1', async () => {
    // Pre-existing def at idx 3. Delete at idx 1 should shift idx 3 → idx 2.
    const TEXT = 'A B C D ';
    const adapter = new MockAdapter({});
    adapter.pushText(TEXT, TEXT.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    dynDefs.set(3, { originalWord: 'D', alternatives: ['D', 'd!'], currentIndex: 1, spanStart: 6, spanEnd: 8, blankName: 'agent-task' });
    const httpAdapter = { post: async () => llmResponse('EDITS:\n1 | B | DELETE\nEND') };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('A C D ');
    expect(dynDefs.get(2)?.originalWord).toBe('D');  // shifted from 3 → 2
    expect(dynDefs.get(3)).toBeUndefined();          // vacated
  });

  it('DELETE marker: drops the existing def at the deleted index', async () => {
    // Prior agent edit at idx 1 (B → BB). Now LLM emits DELETE on the
    // same position — the prior def should be dropped (the word is gone).
    const TEXT = 'A B C ';
    const adapter = new MockAdapter({});
    adapter.pushText(TEXT, TEXT.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    // Pre-existing agent def at idx 1 — but the live word IS still "B"
    // (the def's currentIndex would normally be 1 showing "BB", but for
    // this test we just need a def to verify it gets dropped).
    dynDefs.set(1, { originalWord: 'B', alternatives: ['B', 'BB'], currentIndex: 0, spanStart: 2, spanEnd: 3, blankName: 'agent-task' });
    const httpAdapter = { post: async () => llmResponse('EDITS:\n1 | B | DELETE\nEND') };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('A C ');
    expect(dynDefs.get(1)).toBeUndefined();
  });

  it('DELETE marker: cursor translation accounts for the +1 whitespace removed', async () => {
    // Cursor sits past the deleted word — should shift left by
    // (wordLen + 1) for the consumed whitespace.
    const TEXT = 'the the cat sat ';
    const adapter = new MockAdapter({});
    adapter.pushText(TEXT, TEXT.length); // cursor at end (16)
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = { post: async () => llmResponse('EDITS:\n1 | the | DELETE\nEND') };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    await loop.runOnce(TEXT);

    // "the" (3 chars) + space (1) = 4 chars removed. Cursor 16 → 12.
    expect(adapter.getText()).toBe('the cat sat ');
    expect(adapter.getCursorOffset()).toBe(12);
  });

  it('DELETE + multi-word edit in same batch: cumulative word delta is correct', async () => {
    // text:  0=A 1=B 2=C 3=D 4=E
    // edits: B → DELETE (1→0 words), C → "C1 C2" (1→2 words)
    // post:  0=A 1=C1 2=C2 3=D 4=E (5 words, B gone)
    const TEXT = 'A B C D E ';
    const LLM_EDITS = 'EDITS:\n1 | B | DELETE\n2 | C | C1 C2\nEND';
    const { adapter, dynDefs, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('expand');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('A C1 C2 D E ');
    // C → "C1 C2" lands at NEW idx 1 (was OLD 2, shifted -1 by the delete)
    expect(dynDefs.get(1)?.alternatives).toEqual(['C', 'C1 C2']);
    // No def for the deleted word
    expect(dynDefs.get(2)?.originalWord).not.toBe('B');
  });

  it('DELETE marker in retry mode: does NOT add an evaluation for the deleted slot', async () => {
    // retry mode caches edited words at NEW idx with NEW hash. For a
    // DELETE there's no NEW word at that idx (the next word slid up),
    // so we must not record a stale evaluation that would confuse the
    // next pass.
    const TEXT = 'the the cat ';
    const adapter = new MockAdapter({});
    adapter.pushText(TEXT, TEXT.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = { post: async () => llmResponse('EDITS:\n1 | the | DELETE\nEND') };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
      retryModeEnabled: () => true,
    });
    state.arm('fix grammar');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('the cat ');
    // The agent stored 0 evaluations: the deleted word's slot is gone,
    // and un-edited candidates aren't cached in retry mode.
    expect(state.evaluationCount()).toBe(0);
  });

  it('DELETE marker case-insensitive (Delete / delete / DELETE all parse the same)', async () => {
    const TEXT = 'a b c ';
    const LLM_EDITS = 'EDITS:\n1 | b | Delete\nEND';
    const { adapter, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('test');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('a c ');
  });

  it('parser: empty third column (without DELETE) is treated as malformed and dropped', async () => {
    // "1 | foo |" with empty third column — could be a model artefact
    // (truncation, format glitch). We don't silently DELETE on empty
    // because that would be too easy to trigger by accident; explicit
    // "DELETE" is required.
    const TEXT = 'foo bar baz ';
    const LLM_EDITS = 'EDITS:\n1 | bar | \nEND';
    const { adapter, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('test');

    await loop.runOnce(TEXT);

    // Buffer unchanged — malformed line dropped at parse time.
    expect(adapter.getText()).toBe('foo bar baz ');
  });

  it('two consecutive DELETEs collapse two redundant words', async () => {
    // "I I really really love it" → "I really love it"
    // wordIndex: 0=I 1=I 2=really 3=really 4=love 5=it
    // Delete idx 1 and idx 3.
    const TEXT = 'I I really really love it ';
    const LLM_EDITS = 'EDITS:\n1 | I | DELETE\n3 | really | DELETE\nEND';
    const { adapter, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('fix grammar');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('I really love it ');
  });

  it('DELETE marker: dedupe protects against duplicate DELETEs at same idx', async () => {
    const TEXT = 'a b c ';
    // Two DELETEs at idx 1. Dedupe drops the second; net effect is one delete.
    const LLM_EDITS = 'EDITS:\n1 | b | DELETE\n1 | b | DELETE\nEND';
    const { adapter, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('test');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('a c ');
  });

  it('span/spanStart point at NEW char offsets after splice', async () => {
    // The def's spanStart/spanEnd are read by Cycling when reverting.
    // After multi-word splice, they must reflect the NEW char frame —
    // not the OLD liveWord coords.
    const TEXT = 'A B C ';
    const LLM_EDITS = 'EDITS:\n1 | B | XXX YYY\nEND';  // 1→2 words, len 3+1+3=7
    const { adapter, dynDefs, loop, state } = setupMultiEdit(TEXT, LLM_EDITS);
    state.arm('expand');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('A XXX YYY C ');
    const def = dynDefs.get(1);
    expect(def).toBeDefined();
    // "XXX YYY" sits at chars [2, 9) in the new text.
    expect(def!.spanStart).toBe(2);
    expect(def!.spanEnd).toBe(9);
  });
});
