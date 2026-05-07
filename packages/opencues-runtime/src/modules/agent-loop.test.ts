import { describe, expect, it } from 'vitest';
import { AgentLoop, parseEditPassOutput, sentenceContaining, classifyEdit, wouldDuplicateAdjacent } from './agent-loop';
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

describe('AgentLoop tiered debounce (word-complete vs final-pause)', () => {
  // Mirrors CC's `dynamicHighlight.ts` Tier 1 / Tier 2 pattern so the
  // agent fires like the other cues:
  //   Tier 1 — Space / newline typed (word complete) → ~50 ms
  //   Tier 2 — Final pause without word complete → ~300 ms
  //
  // Net effect: mid-word pauses no longer trigger the agent on a partial
  // word; the LLM only sees committed words.

  function setupTimed() {
    const adapter = new MockAdapter({});
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let calls = 0;
    const httpAdapter = {
      post: async () => {
        calls += 1;
        return llmResponse('EDITS:\nnone\nEND');
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 50,
      finalPauseMs: 300,
      httpAdapter,
    });
    state.arm('test');
    loop.subscribe();
    return { adapter, state, loop, getCalls: () => calls };
  }

  it('word-complete (typed a space): fires after Tier 1 delay (~50 ms)', async () => {
    const { adapter, getCalls } = setupTimed();

    // Buffer "hello world " — cursor past the end so word 0 ("hello")
    // is not cursor-adjacent; an LLM call WILL fire when the timer runs.
    adapter.pushText('hello world ', 12);
    await new Promise(r => setTimeout(r, 80));

    expect(getCalls()).toBe(1);
  });

  it('mid-word typing: no fire while typing; final-pause (~300 ms) catches the last word', async () => {
    const { adapter, getCalls } = setupTimed();

    // Type "hello world" without trailing space — last char is 'd',
    // word "world" is cursor-adjacent (cursor=11, word ends at 11),
    // but word "hello" at idx 0 IS a candidate. Tier 2 (300 ms) fires.
    adapter.pushText('hello world', 11);

    // Just past Tier 1 timeout: still 0 calls (mid-word, no space).
    await new Promise(r => setTimeout(r, 100));
    expect(getCalls()).toBe(0);

    // Past Tier 2 timeout: fires.
    await new Promise(r => setTimeout(r, 240));
    expect(getCalls()).toBe(1);
  });

  it('rapid typing followed by space: Tier 1 wins over Tier 2 — single fast call', async () => {
    const { adapter, getCalls } = setupTimed();

    // Each keystroke arms Tier 2 (300ms). When user finally types a
    // space, Tier 1 (50ms) resets the timer and fires fast.
    adapter.pushText('hello', 5);
    await new Promise(r => setTimeout(r, 20));
    adapter.pushText('hello ', 6);

    // After 80ms total, Tier 1 should have fired exactly once.
    await new Promise(r => setTimeout(r, 80));
    expect(getCalls()).toBe(1);
  });

  it('continuous typing: timer resets each keystroke; only fires after final pause', async () => {
    const { adapter, getCalls } = setupTimed();

    // Each append resets Tier 2 timer. Buffer always ends mid-word
    // ('a' / 'aa' / ... — no trailing space) so Tier 2 path is used.
    // At least one earlier word ("hello") is non-cursor-adjacent and
    // serves as a candidate when the timer eventually fires.
    for (let i = 1; i <= 6; i += 1) {
      adapter.pushText('hello ' + 'a'.repeat(i), 6 + i);
      await new Promise(r => setTimeout(r, 60)); // > 50ms, < 300ms
    }
    // ~360 ms of continuous typing — no fires yet (Tier 2 keeps resetting).
    expect(getCalls()).toBe(0);

    // Stop typing — Tier 2 (300ms) finally fires.
    await new Promise(r => setTimeout(r, 320));
    expect(getCalls()).toBe(1);
  });
});

describe('sentenceContaining helper', () => {
  it('returns the full text when there are no terminators', () => {
    expect(sentenceContaining('hello world', 5)).toBe('hello world');
  });
  it('bounded by trailing period followed by space', () => {
    const t = 'First sentence. Second sentence.';
    expect(sentenceContaining(t, 3)).toBe('First sentence.');
    expect(sentenceContaining(t, 20)).toBe('Second sentence.');
  });
  it('bounded by trailing question mark', () => {
    const t = 'How are you? I am fine.';
    expect(sentenceContaining(t, 5)).toBe('How are you?');
    expect(sentenceContaining(t, 15)).toBe('I am fine.');
  });
  it('bounded by trailing exclamation mark', () => {
    const t = 'Wow! That is great.';
    expect(sentenceContaining(t, 1)).toBe('Wow!');
    expect(sentenceContaining(t, 10)).toBe('That is great.');
  });
  it('single newline ends a sentence', () => {
    const t = 'first line\nsecond line';
    expect(sentenceContaining(t, 3)).toBe('first line');
    expect(sentenceContaining(t, 14)).toBe('second line');
  });
  it('paragraph break (double newline) bounds correctly', () => {
    const t = 'Para one.\n\nPara two starts here';
    expect(sentenceContaining(t, 3)).toBe('Para one.');
    expect(sentenceContaining(t, 15)).toBe('Para two starts here');
  });
  it('does NOT split mid-acronym (period followed by letter)', () => {
    // "U.S.A" has periods NOT followed by whitespace — must stay one sentence.
    const t = 'I live in U.S.A and like it';
    expect(sentenceContaining(t, 12)).toBe('I live in U.S.A and like it');
  });
  it('handles charPos at the terminator itself', () => {
    const t = 'hello. world.';
    // pos 5 = the period character; should belong to "hello." sentence.
    expect(sentenceContaining(t, 5)).toBe('hello.');
  });
  it('handles charPos at the very start (0)', () => {
    expect(sentenceContaining('first. second.', 0)).toBe('first.');
  });
  it('handles charPos past EOF (defensive)', () => {
    expect(sentenceContaining('hello world', 100)).toBe('hello world');
  });
  it('trims surrounding whitespace from the returned sentence', () => {
    const t = 'one.   two.   three.';
    // "two" sits between two spaces — sentence text returned without leading space.
    expect(sentenceContaining(t, 7)).toBe('two.');
  });
  it('empty text returns empty', () => {
    expect(sentenceContaining('', 0)).toBe('');
  });
});

describe('AgentLoop sentence-invalidation guard (drop edits computed against stale sentence)', () => {
  // The bug this guards against (May 2026 production log):
  //   User had typed `Hi, how's it going? \n\nSo how are`
  //   Agent computed edit `5 | are | are you?` — autocompletion.
  //   While the LLM call was in flight, user typed ` doing?`.
  //   By apply time the buffer was `... So how are doing?`.
  //   Pre-guard: edit landed → `... So how are you? you doing?` (duplication).
  //   Post-guard: snapshot sentence "So how are" ≠ live sentence
  //   "So how are doing?" → edit dropped, no corruption.

  /**
   * Set up an AgentLoop where the httpAdapter mutates the adapter text
   * mid-call — simulating the user typing during the LLM round-trip.
   * This is the only realistic way to exercise the sentence-fingerprint
   * check: the snapshot is taken before callEditPass, the validation
   * after, so the test must change the buffer between those two points.
   */
  function setupRace(opts: {
    initialText: string;
    typedDuringCall: string;       // appended to initialText AFTER LLM call starts
    llmContent: string;
  }) {
    const adapter = new MockAdapter({});
    adapter.pushText(opts.initialText, opts.initialText.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => {
        // User typed during the LLM call: mutate the adapter buffer.
        const newText = opts.initialText + opts.typedDuringCall;
        adapter.pushText(newText, newText.length);
        return llmResponse(opts.llmContent);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1,
      httpAdapter,
    });
    return { adapter, state, dynDefs, loop };
  }

  it('drops an edit when the user typed into its sentence during the LLM call (the autocompletion-duplication bug)', async () => {
    // Snapshot: "Hi, how's it going? \n\nSo how are"
    // After LLM call returned: "Hi, how's it going? \n\nSo how are doing?"
    // Snapshot sentence for edit at idx 5 ('are'): "So how are"
    // Live sentence at the same word: "So how are doing?"
    // Mismatch → drop.
    const { adapter, state, loop } = setupRace({
      initialText: "Hi, how's it going? \n\nSo how are",
      typedDuringCall: ' doing?',
      llmContent: 'EDITS:\n5 | are | are you?\nEND',
    });
    state.arm('fix grammar');

    await loop.runOnce("Hi, how's it going? \n\nSo how are");

    // Buffer has the user's typed continuation but NOT the autocompletion.
    expect(adapter.getText()).toBe("Hi, how's it going? \n\nSo how are doing?");
    expect(adapter.getText()).not.toContain('are you? you doing');
  });

  it('keeps an edit in an UNTOUCHED sentence even when other sentences changed', async () => {
    // Snapshot: "I rite stuff. So how are"
    // User types " doing?" into the SECOND sentence.
    // Edit on idx 1 ('rite' → 'write') in the FIRST sentence is unaffected.
    const { adapter, state, loop } = setupRace({
      initialText: 'I rite stuff. So how are',
      typedDuringCall: ' doing?',
      llmContent: 'EDITS:\n1 | rite | write\nEND',
    });
    state.arm('fix everything');

    await loop.runOnce('I rite stuff. So how are');

    // The edit landed (rite → write) AND the user's continuation is preserved.
    expect(adapter.getText()).toBe('I write stuff. So how are doing?');
  });

  it('drops MULTIPLE edits in an invalidated sentence; keeps edits in untouched sentences', async () => {
    // Snapshot: "I rite stuff. So how are big"
    // User types " trouble?" into the SECOND sentence.
    // LLM emits 3 edits: idx 1 (rite→write, sentence A), idx 4 (how→how about, sentence B),
    // idx 6 (big→huge, sentence B). Sentence B is invalidated → both B edits dropped.
    // Sentence A's edit survives.
    const { adapter, state, loop } = setupRace({
      initialText: 'I rite stuff. So how are big',
      typedDuringCall: ' trouble?',
      llmContent: 'EDITS:\n1 | rite | write\n4 | how | how about\n6 | big | huge\nEND',
    });
    state.arm('fix everything');

    await loop.runOnce('I rite stuff. So how are big');

    // First sentence's edit lands. Second sentence's edits are dropped.
    expect(adapter.getText()).toBe('I write stuff. So how are big trouble?');
    expect(adapter.getText()).not.toContain('how about');
    expect(adapter.getText()).not.toContain('huge');
  });

  it('drops a RANGE edit when its sentence has been invalidated', async () => {
    // Snapshot: "we went any way we"
    // User types " could." (terminator now exists at end).
    // Range edit "2-3 | any way | anyway" is computed against the sentence
    // "we went any way we" but live sentence is "we went any way we could."
    // → invalidated, dropped.
    const { adapter, state, loop } = setupRace({
      initialText: 'we went any way we',
      typedDuringCall: ' could.',
      llmContent: 'EDITS:\n2-3 | any way | anyway\nEND',
    });
    state.arm('fix grammar');

    await loop.runOnce('we went any way we');

    // Range edit dropped — buffer is just user's typed text.
    expect(adapter.getText()).toBe('we went any way we could.');
    expect(adapter.getText()).not.toContain('anyway');
  });

  it('survives WHITESPACE-only typing (trailing spaces) — the trim makes the fingerprint stable', async () => {
    // User pressed space twice at the end — sentence text proper hasn't
    // changed. Snapshot trim and live trim both yield the same sentence.
    // Edit must NOT be dropped.
    //
    // Note: livespan-vs-originalWord match still has to hold. We pick a
    // sentence whose word geometry is stable under added trailing spaces.
    const { adapter, state, loop } = setupRace({
      initialText: 'I rite stuff',
      typedDuringCall: '   ',           // pure whitespace at the end
      llmContent: 'EDITS:\n1 | rite | write\nEND',
    });
    state.arm('fix typos');

    await loop.runOnce('I rite stuff');

    // The trailing-whitespace mutation should NOT invalidate.
    expect(adapter.getText()).toBe('I write stuff   ');
  });

  it('typing INSIDE a sentence (not at the end) also invalidates', async () => {
    // Snapshot: "I rite stuff and went home."
    // User goes back and inserts "really " before "rite" — the live
    // sentence is now "I really rite stuff and went home."
    // The edit "1 | rite | write" was computed for word index 1 in the
    // OLD frame. The originalWord-match check ALSO fails here (word 1 is
    // now "really" not "rite"), so the edit is rejected by that filter.
    // This test confirms BOTH filters cooperate without crashing.
    const adapter = new MockAdapter({});
    const initial = 'I rite stuff and went home.';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => {
        // User inserts "really " between "I " and "rite"
        const newText = 'I really rite stuff and went home.';
        adapter.pushText(newText, newText.length);
        return llmResponse('EDITS:\n1 | rite | write\nEND');
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });
    state.arm('fix typos');

    await loop.runOnce(initial);

    // Edit dropped — buffer shows user's insertion intact, no fix applied.
    expect(adapter.getText()).toBe('I really rite stuff and went home.');
  });

  it('paragraph-break boundary: adding text in para 2 does NOT invalidate edits in para 1', async () => {
    const { adapter, state, loop } = setupRace({
      initialText: 'I rite stuff.\n\nSecond para starts',
      typedDuringCall: ' here.',
      llmContent: 'EDITS:\n1 | rite | write\nEND',
    });
    state.arm('fix typos');

    await loop.runOnce('I rite stuff.\n\nSecond para starts');

    expect(adapter.getText()).toBe('I write stuff.\n\nSecond para starts here.');
  });

  it('question-mark terminator: typing into sentence A leaves sentence B untouched', async () => {
    // "What is going on? Some other prose"
    // User types "?" into sentence B (turns it into a question).
    // Edit on sentence A (no edit content in this test, just confirm
    // sentence B's edit drops correctly).
    const { adapter, state, loop } = setupRace({
      initialText: 'What is going on? Some other prose',
      typedDuringCall: '?',                                        // makes "Some other prose?"
      llmContent: 'EDITS:\n6 | other | OTHER\nEND',                // edit in sentence B
    });
    state.arm('emphasize');

    await loop.runOnce('What is going on? Some other prose');

    // Sentence B was mutated (added "?"), so the OTHER edit drops.
    expect(adapter.getText()).toBe('What is going on? Some other prose?');
    expect(adapter.getText()).not.toContain('OTHER');
  });

  it('drops an edit when a PRIOR edit in the same batch already mutated the sentence', async () => {
    // Single batch with TWO edits in the SAME sentence:
    //   - edit A:  3 | are | are you?  (autocompletion)
    //   - edit B:  2 | how | how about
    // The fingerprint check is taken from the SNAPSHOT (one sentence
    // text per candidate, captured before the LLM call). Both edits A
    // and B target words in the same sentence, so they share a snapshot.
    //
    // What we ACTUALLY guard against here is the cross-batch case: a
    // PRIOR pass landed an edit in the sentence; this pass's edit was
    // computed against the now-stale pre-prior-edit text. Simulate by
    // having a prior pass mutate the buffer, then a later pass arrive
    // with an edit whose snapshot doesn't match the now-mutated live
    // sentence.
    const adapter = new MockAdapter({});
    const initial = 'I rite some stuff';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let callIdx = 0;
    const httpAdapter = {
      post: async () => {
        const responses = [
          'EDITS:\n1 | rite | write\nEND',                 // pass 1: fix typo
          'EDITS:\n1 | rite | wrote\nEND',                 // pass 2: stale — based on pre-edit 'rite'
        ];
        const out = responses[callIdx] ?? 'EDITS:\nnone\nEND';
        callIdx += 1;
        return llmResponse(out);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    // Pass 1: rite → write applies cleanly.
    await loop.runOnce(initial);
    expect(adapter.getText()).toBe('I write some stuff');

    // Pass 2: simulate a stale snapshot — runOnce called with the OLD text
    // even though the live buffer is the post-pass-1 text. The snapshot
    // sentence "I rite some stuff" won't match the live sentence
    // "I write some stuff" → edit gets dropped.
    await loop.runOnce(initial);
    expect(adapter.getText()).toBe('I write some stuff');
  });
});

describe('AgentLoop shape-based locality guard (SWAP/SHRINK/ADDITION rules)', () => {
  // Production bug: user typed "Cool so " mid-thought; agent fired
  // (debounce settled), saw "so" as filler under "make professional"
  // and emitted DELETE. The user's continuation got mangled. Per shape
  // rules:
  //   SWAP     anywhere
  //   SHRINK   only in TERMINATED sentences
  //   ADDITION only in sentences ending strictly before the cursor

  function setupShape(opts: {
    text: string;
    cursor?: number;
    llmContent: string;
    seedDef?: { idx: number; def: import('../state/dyn-defs').WordDef };
  }) {
    const adapter = new MockAdapter({});
    const cursor = opts.cursor ?? opts.text.length + 1;
    adapter.pushText(opts.text, cursor);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    if (opts.seedDef) dynDefs.set(opts.seedDef.idx, opts.seedDef.def);
    const httpAdapter = { post: async () => llmResponse(opts.llmContent) };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
      // shapeGuardEnabled defaults to ON — these tests rely on that.
    });
    return { adapter, state, dynDefs, loop };
  }

  describe('classifyEdit', () => {
    it('1→1 single word is SWAP', () => {
      expect(classifyEdit({ wordIndex: 0, originalWord: 'rite', editedWord: 'write' })).toBe('swap');
    });
    it('1→0 (DELETE) is SHRINK', () => {
      expect(classifyEdit({ wordIndex: 0, originalWord: 'the', editedWord: '' })).toBe('shrink');
    });
    it('1→2 is ADDITION', () => {
      expect(classifyEdit({ wordIndex: 0, originalWord: 'are', editedWord: 'are you?' })).toBe('addition');
    });
    it('2→1 (range merge) is SHRINK', () => {
      expect(classifyEdit({ wordIndex: 0, endIndex: 1, originalWord: 'any way', editedWord: 'anyway' })).toBe('shrink');
    });
    it('2→2 (range swap) is SWAP', () => {
      expect(classifyEdit({ wordIndex: 0, endIndex: 1, originalWord: 'I went', editedWord: 'We came' })).toBe('swap');
    });
    it('2→3 (range expansion) is ADDITION', () => {
      expect(classifyEdit({ wordIndex: 0, endIndex: 1, originalWord: 'went store', editedWord: 'went to the store' })).toBe('addition');
    });
    it('range DELETE (3→0) is SHRINK', () => {
      expect(classifyEdit({ wordIndex: 0, endIndex: 2, originalWord: 'I went store', editedWord: '' })).toBe('shrink');
    });
  });

  // ─── SWAP: allowed anywhere ───────────────────────────────────────
  it('SWAP in unterminated sentence: APPLIES (the canonical "rite → write" case)', async () => {
    const { adapter, state, loop } = setupShape({
      text: 'I rite stuff ',                                // no terminator
      llmContent: 'EDITS:\n1 | rite | write\nEND',
    });
    state.arm('fix typos');
    await loop.runOnce('I rite stuff ');
    expect(adapter.getText()).toBe('I write stuff ');
  });

  it('SWAP in terminated sentence: APPLIES (control)', async () => {
    const { adapter, state, loop } = setupShape({
      text: 'I rite stuff. ',
      llmContent: 'EDITS:\n1 | rite | write\nEND',
    });
    state.arm('fix typos');
    await loop.runOnce('I rite stuff. ');
    expect(adapter.getText()).toBe('I write stuff. ');
  });

  it('PUNCTUATION-DECORATION (Later → Later,) is gated like ADDITION — DROPPED in unterminated sentence', async () => {
    // Looks like a 1→1 SWAP but adds flank punctuation only — that's
    // the comma-cascade class. Reclassified as ADDITION; only allowed
    // in past sentences. Stays dropped here (cursor's sentence isn't
    // terminated).
    const { adapter, state, loop } = setupShape({
      text: 'See you Later ',
      llmContent: 'EDITS:\n2 | Later | Later,\nEND',
    });
    state.arm('fix punctuation');
    await loop.runOnce('See you Later ');
    expect(adapter.getText()).toBe('See you Later ');
  });

  it('PUNCTUATION-DECORATION lands in a PAST sentence', async () => {
    // First sentence "See you Later" is terminated AND ends before the
    // cursor sitting in the second sentence. Decoration allowed.
    const { adapter, state, loop } = setupShape({
      text: 'See you Later. Now writing more ',
      llmContent: 'EDITS:\n2 | Later. | Later,\nEND',
    });
    state.arm('fix punctuation');
    await loop.runOnce('See you Later. Now writing more ');
    // (Edit's originalWord matches live "Later." with trailing period;
    //  decoration check sees more flank punct in editedWord "Later,"?
    //  Same count of trail chars (1). Not decoration → SWAP → applies.)
    expect(adapter.getText()).toBe('See you Later, Now writing more ');
  });

  it('REAL SWAP (rite → write) still allowed in unterminated sentence', async () => {
    // No flank punctuation change; cores differ. Stays SWAP.
    const { adapter, state, loop } = setupShape({
      text: 'I rite stuff ',
      llmContent: 'EDITS:\n1 | rite | write\nEND',
    });
    state.arm('fix typos');
    await loop.runOnce('I rite stuff ');
    expect(adapter.getText()).toBe('I write stuff ');
  });

  it('CASE-ONLY SWAP (hi → Hi) still allowed in unterminated sentence', async () => {
    // Cores differ (case-sensitive); not decoration. Stays SWAP.
    const { adapter, state, loop } = setupShape({
      text: 'hi there ',
      llmContent: 'EDITS:\n0 | hi | Hi\nEND',
    });
    state.arm('fix capitalisation');
    await loop.runOnce('hi there ');
    expect(adapter.getText()).toBe('Hi there ');
  });

  // ─── SHRINK / DELETE: only in terminated sentences ────────────────
  it('SHRINK (DELETE "so") in unterminated cursor sentence: DROPPED (the "Cool so" bug)', async () => {
    const { adapter, state, loop } = setupShape({
      text: 'Cool so ',                                     // no terminator
      llmContent: 'EDITS:\n1 | so | DELETE\nEND',
    });
    state.arm('make professional');
    await loop.runOnce('Cool so ');
    expect(adapter.getText()).toBe('Cool so ');             // unchanged
  });

  it('SHRINK (DELETE "the") in TERMINATED sentence: APPLIES', async () => {
    const { adapter, state, loop } = setupShape({
      text: 'the the cat sat. ',
      llmContent: 'EDITS:\n1 | the | DELETE\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('the the cat sat. ');
    expect(adapter.getText()).toBe('the cat sat. ');
  });

  it('SHRINK (range merge "any way" → "anyway") in unterminated sentence: DROPPED', async () => {
    const { adapter, state, loop } = setupShape({
      text: 'we went any way ',
      llmContent: 'EDITS:\n2-3 | any way | anyway\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('we went any way ');
    expect(adapter.getText()).toBe('we went any way ');
  });

  it('SHRINK in TERMINATED sentence: APPLIES (range merge)', async () => {
    // Newline terminator avoids the period attaching to "way" (which
    // would make the originalWord "any way" mismatch the live span "any
    // way." for range edits — the punct-rescue only runs single-word).
    const { adapter, state, loop } = setupShape({
      text: 'we went any way \nDone. ',
      llmContent: 'EDITS:\n2-3 | any way | anyway\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('we went any way \nDone. ');
    expect(adapter.getText()).toBe('we went anyway \nDone. ');
  });

  it('SHRINK in a PAST sentence applies even if cursor sentence is unterminated', async () => {
    // Two sentences: first terminated, second still being typed. SHRINK
    // in the first should fire; the cursor's in-flight sentence is
    // untouched.
    const { adapter, state, loop } = setupShape({
      text: 'the the cat sat. Now I am ',
      llmContent: 'EDITS:\n1 | the | DELETE\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('the the cat sat. Now I am ');
    expect(adapter.getText()).toBe('the cat sat. Now I am ');
  });

  it('SHRINK in CURSOR sentence (terminated by trailing period at end-of-buffer) APPLIES', async () => {
    // The single sentence has a terminator, so even though it's the
    // "current" sentence in the geometric sense, it's closed.
    // SHRINK is allowed (it's no longer in flight).
    const { adapter, state, loop } = setupShape({
      text: 'the the cat sat.',                             // cursor at end, just past period
      llmContent: 'EDITS:\n1 | the | DELETE\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('the the cat sat.');
    expect(adapter.getText()).toBe('the cat sat.');
  });

  // ─── ADDITION: only in sentences strictly past the cursor ─────────
  it('ADDITION ("are → are you?") in unterminated cursor sentence: DROPPED (the autocompletion bug)', async () => {
    const { adapter, state, loop } = setupShape({
      text: 'So how are ',                                  // no terminator
      llmContent: 'EDITS:\n2 | are | are you?\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('So how are ');
    expect(adapter.getText()).toBe('So how are ');
  });

  it('ADDITION in PAST sentence (past cursor): APPLIES', async () => {
    // First sentence "I went store." is terminated AND ends before
    // the cursor that sits in the second sentence "Now I am writing".
    const { adapter, state, loop } = setupShape({
      text: 'I went store. Now I am writing ',
      llmContent: 'EDITS:\n2 | store. | to the store.\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('I went store. Now I am writing ');
    expect(adapter.getText()).toBe('I went to the store. Now I am writing ');
  });

  it('ADDITION in CURSOR sentence (terminated, but cursor still inside) DROPPED', async () => {
    // Cursor inside the terminated sentence (between "I went" and "store.").
    // info.end >= cursorPos → not strictly past → DROPPED.
    const { adapter, state, loop } = setupShape({
      text: 'I went store. Now writing ',
      cursor: 6,                                            // cursor between "I" and "went"
      llmContent: 'EDITS:\n2 | store. | to the store.\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('I went store. Now writing ');
    expect(adapter.getText()).toBe('I went store. Now writing ');
  });

  // ─── Mixed shapes in one batch ─────────────────────────────────────
  it('mixed batch: SWAP applies, SHRINK in same unterminated sentence dropped', async () => {
    // 'I rite some stuff' — unterminated.
    // SWAP "rite → write" survives; SHRINK "some → DELETE" drops.
    const { adapter, state, loop } = setupShape({
      text: 'I rite some stuff ',
      llmContent: 'EDITS:\n1 | rite | write\n2 | some | DELETE\nEND',
    });
    state.arm('fix grammar');
    await loop.runOnce('I rite some stuff ');
    expect(adapter.getText()).toBe('I write some stuff ');
  });
});

describe('wouldDuplicateAdjacent helper', () => {
  const W = (...words: string[]) => words.map(word => ({ word }));

  it('flags trailing duplication: edited last token matches next live word', () => {
    // Live: [I, am, considering]; edit [0] "I" → "I am" → "I am am considering"
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, originalWord: 'I', editedWord: 'I am' },
      W('I', 'am', 'considering'),
    )).toBe(true);
  });

  it('flags leading duplication: edited first token matches previous live word', () => {
    // Live: [I, am, considering]; edit [2] "considering" → "am considering"
    expect(wouldDuplicateAdjacent(
      { wordIndex: 2, originalWord: 'considering', editedWord: 'am considering' },
      W('I', 'am', 'considering'),
    )).toBe(true);
  });

  it('does NOT flag a clean addition with no adjacent overlap', () => {
    // Live: [I, went, store]; edit [2] "store" → "to the store"
    expect(wouldDuplicateAdjacent(
      { wordIndex: 2, originalWord: 'store', editedWord: 'to the store' },
      W('I', 'went', 'store'),
    )).toBe(false);
  });

  it('matches case-insensitively (cores compared)', () => {
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, originalWord: 'i', editedWord: 'I AM' },
      W('i', 'am', 'going'),
    )).toBe(true);
  });

  it('matches across punctuation (cores stripped)', () => {
    // Edit's last token "am." vs live "am" — cores match.
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, originalWord: 'I', editedWord: 'I am.' },
      W('I', 'am', 'fine'),
    )).toBe(true);
  });

  it('DELETE never flags as duplication', () => {
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, originalWord: 'the', editedWord: '' },
      W('the', 'the', 'cat'),
    )).toBe(false);
  });

  it('SWAP that genuinely matches an adjacent word IS flagged', () => {
    // Rare: [1] "rite" → "write" with live[2]="write" already.
    expect(wouldDuplicateAdjacent(
      { wordIndex: 1, originalWord: 'rite', editedWord: 'write' },
      W('I', 'rite', 'write'),
    )).toBe(true);
  });

  it('range edit checks AFTER endIdx, not after wordIndex', () => {
    // Range [0-1] "I went" → "I went home" with live[2]="home"
    // Expected: trailing duplication (last token "home" vs live[2] "home")
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, endIndex: 1, originalWord: 'I went', editedWord: 'I went home' },
      W('I', 'went', 'home'),
    )).toBe(true);
  });

  it('edit at end-of-buffer with no next word: only leading checked', () => {
    expect(wouldDuplicateAdjacent(
      { wordIndex: 1, originalWord: 'go', editedWord: 'home go' },        // first token "home" vs live[0]="I" → no match
      W('I', 'go'),
    )).toBe(false);
    expect(wouldDuplicateAdjacent(
      { wordIndex: 1, originalWord: 'go', editedWord: 'I go' },           // first token "I" vs live[0]="I" → match
      W('I', 'go'),
    )).toBe(true);
  });

  it('edit at start-of-buffer with no previous word: only trailing checked', () => {
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, originalWord: 'I', editedWord: 'Hello I' },
      W('I', 'went'),
    )).toBe(false);
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, originalWord: 'I', editedWord: 'I went' },
      W('I', 'went'),
    )).toBe(true);
  });

  it('empty editedWord (post-strip) is treated as DELETE — no duplication', () => {
    expect(wouldDuplicateAdjacent(
      { wordIndex: 0, originalWord: 'x', editedWord: '   ' },             // pure whitespace
      W('x', 'y'),
    )).toBe(false);
  });
});

describe('AgentLoop edge-duplication guard (drop edits that duplicate an adjacent live word)', () => {
  it('drops "I → I am" when next live word is already "am" (the production bug)', async () => {
    // Reproduces the May 2026 log: a prior pass turned "was" → "am" at
    // idx 8. This pass's snapshot text saw "I am" but the LLM still
    // emitted [7] "I" → "I am". Without the guard the buffer becomes
    // "I am am considering". With the guard, the edit is dropped.
    const adapter = new MockAdapter({});
    const initial = 'I am considering asking. ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('EDITS:\n0 | I | I am\nEND'),
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    await loop.runOnce(initial);

    // Buffer unchanged — duplicating edit dropped before splice.
    expect(adapter.getText()).toBe('I am considering asking. ');
  });

  it('drops a leading-duplication edit', async () => {
    // [2] "considering" → "am considering" with live[1]="am" already.
    const adapter = new MockAdapter({});
    const initial = 'I am considering asking. ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('EDITS:\n2 | considering | am considering\nEND'),
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    await loop.runOnce(initial);

    expect(adapter.getText()).toBe('I am considering asking. ');
  });

  it('allows a non-duplicating addition through', async () => {
    // [2] "store" → "to the store" with live[3]="quickly" — no overlap.
    const adapter = new MockAdapter({});
    const initial = 'I went store quickly. ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = {
      post: async () => llmResponse('EDITS:\n2 | store | to the store\nEND'),
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });
    state.arm('fix grammar');

    await loop.runOnce(initial);

    expect(adapter.getText()).toBe('I went to the store quickly. ');
  });
});

describe('AgentLoop anti-oscillation guard (drop edits that would invert a recent one)', () => {
  // Production bug: comma flip-flop on `Later`. Pass 1 added a comma
  // ("Later" → "Later,"). After an `add task` ADD freshened the cache,
  // pass 2 reconsidered the now-cached `Later,` and emitted the inverse
  // ("Later," → "Later"), undoing pass 1. The user sees the buffer
  // change, then change back — pure visible churn for no progress.

  it('drops an edit whose inverse was just applied', async () => {
    const adapter = new MockAdapter({});
    const initial = 'I went home Later please. ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let callIdx = 0;
    const httpAdapter = {
      post: async () => {
        const responses = [
          'EDITS:\n3 | Later | Later,\nEND',     // pass 1: add comma
          'EDITS:\n3 | Later, | Later\nEND',     // pass 2: try to remove it
        ];
        const out = responses[callIdx] ?? 'EDITS:\nnone\nEND';
        callIdx += 1;
        return llmResponse(out);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });
    state.arm('fix punctuation');

    // Pass 1: comma added.
    await loop.runOnce(initial);
    expect(adapter.getText()).toBe('I went home Later, please. ');

    // Pass 2: model wants to undo the comma. Without the guard this
    // would land. With the guard, it's dropped.
    await loop.runOnce(adapter.getText());
    expect(adapter.getText()).toBe('I went home Later, please. ');
  });

  it('survives across appendToPrompt (the realistic ADD-then-flip flow)', async () => {
    const adapter = new MockAdapter({});
    const initial = 'I went home Later please. ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let callIdx = 0;
    const httpAdapter = {
      post: async () => {
        const responses = [
          'EDITS:\n3 | Later | Later,\nEND',
          'EDITS:\n3 | Later, | Later\nEND',
        ];
        const out = responses[callIdx] ?? 'EDITS:\nnone\nEND';
        callIdx += 1;
        return llmResponse(out);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });

    state.arm('correct spelling');
    await loop.runOnce(initial);
    expect(adapter.getText()).toBe('I went home Later, please. ');

    // User issues `add task fix punctuation _` — appendToPrompt freshens
    // the taskId and clears the eval cache. Pass 2's edit would invert
    // pass 1's. The signature-set survives the ADD and catches it.
    state.appendToPrompt('fix punctuation');
    await loop.runOnce(adapter.getText());
    expect(adapter.getText()).toBe('I went home Later, please. ');
  });

  it('does NOT drop an edit on a completely different word', async () => {
    // Use retry mode so words the LLM left alone in pass 1 don't get
    // cached as evaluated — that way pass 2's edit on word 1 hits the
    // oscillation guard (which lets it through), not the cache filter.
    const adapter = new MockAdapter({});
    const initial = 'Later rite stuff. ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let callIdx = 0;
    const httpAdapter = {
      post: async () => {
        const responses = [
          'EDITS:\n0 | Later | Later,\nEND',     // edit word 0
          'EDITS:\n1 | rite | write\nEND',       // edit word 1 — unrelated
        ];
        const out = responses[callIdx] ?? 'EDITS:\nnone\nEND';
        callIdx += 1;
        return llmResponse(out);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
      retryModeEnabled: () => true,
    });
    state.arm('fix everything');

    await loop.runOnce(initial);
    expect(adapter.getText()).toBe('Later, rite stuff. ');

    await loop.runOnce(adapter.getText());
    expect(adapter.getText()).toBe('Later, write stuff. ');
  });

  it('arm() (fresh task) clears signatures and ALLOWS the inverse to apply', async () => {
    const adapter = new MockAdapter({});
    const initial = 'I went home Later please. ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let callIdx = 0;
    const httpAdapter = {
      post: async () => {
        const responses = [
          'EDITS:\n3 | Later | Later,\nEND',
          'EDITS:\n3 | Later, | Later\nEND',
        ];
        const out = responses[callIdx] ?? 'EDITS:\nnone\nEND';
        callIdx += 1;
        return llmResponse(out);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
    });

    state.arm('add commas');
    await loop.runOnce(initial);
    expect(adapter.getText()).toBe('I went home Later, please. ');

    // Fresh ARM (different task). Signatures cleared. Inverse allowed.
    state.arm('remove commas');
    await loop.runOnce(adapter.getText());
    expect(adapter.getText()).toBe('I went home Later please. ');
  });

  it('multi-word (range) edit oscillation is also caught', async () => {
    const adapter = new MockAdapter({});
    const initial = 'we went any way home ';
    adapter.pushText(initial, initial.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    let callIdx = 0;
    const httpAdapter = {
      post: async () => {
        const responses = [
          'EDITS:\n2-3 | any way | anyway\nEND',     // merge
          'EDITS:\n2 | anyway | any way\nEND',       // split back (oscillation)
        ];
        const out = responses[callIdx] ?? 'EDITS:\nnone\nEND';
        callIdx += 1;
        return llmResponse(out);
      },
    };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1, httpAdapter,
      shapeGuardEnabled: () => false,
    });
    state.arm('fix grammar');

    await loop.runOnce(initial);
    expect(adapter.getText()).toBe('we went anyway home ');

    await loop.runOnce(adapter.getText());
    // Inverse range-undo dropped — buffer stays merged.
    expect(adapter.getText()).toBe('we went anyway home ');
  });
});

describe('AgentLoop punctuation-tolerant matching', () => {
  // The LLM commonly emits edits using the bare word (no trailing
  // period/comma/etc.), e.g. `dramaticly | dramatically` even when
  // the live word is `dramaticly.`. Pre-fix, the survival filter
  // rejected these on `liveWord.word !== edit.originalWord` and the
  // missed-recall surfaced as last-word drops in long docs.
  //
  // Post-fix: when exact match fails, the filter strips flanking
  // punctuation from both sides; if cores match, it accepts the edit
  // and re-attaches the live word's flanking punctuation to the
  // LLM's replacement.

  function setupPunct(text: string, llmContent: string) {
    const adapter = new MockAdapter({});
    adapter.pushText(text, text.length + 1);
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

  it('accepts edit emitted without trailing period when live word HAS one', async () => {
    const TEXT = 'I see dramaticly. ok ';  // wordIndex 2 = "dramaticly."
    const LLM_EDITS = 'EDITS:\n2 | dramaticly | dramatically\nEND';
    const { adapter, dynDefs, loop, state } = setupPunct(TEXT, LLM_EDITS);
    state.arm('correct spelling');

    await loop.runOnce(TEXT);

    // Period preserved, replacement applied.
    expect(adapter.getText()).toBe('I see dramatically. ok ');
    expect(dynDefs.get(2)?.alternatives).toEqual(['dramaticly.', 'dramatically.']);
  });

  it('accepts edit emitted with trailing comma when live word has one', async () => {
    const TEXT = 'first, second third ';
    const LLM_EDITS = 'EDITS:\n0 | first | initial\nEND';
    const { adapter, loop, state } = setupPunct(TEXT, LLM_EDITS);
    state.arm('reword');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('initial, second third ');
  });

  it('accepts edit when LLM emitted full punctuation already (exact-match path)', async () => {
    // Make sure adding the rescue fallback didn't regress the exact-
    // match path.
    const TEXT = 'I see dramaticly. ok ';
    const LLM_EDITS = 'EDITS:\n2 | dramaticly. | dramatically.\nEND';
    const { adapter, loop, state } = setupPunct(TEXT, LLM_EDITS);
    state.arm('correct spelling');

    await loop.runOnce(TEXT);

    expect(adapter.getText()).toBe('I see dramatically. ok ');
  });

  it('strips punctuation the LLM included in the replacement and re-uses live trail', async () => {
    // Defensive: if the LLM emits its own trailing punctuation, strip
    // it and use the LIVE word's punctuation. So `dramaticly | dramatically!`
    // on `dramaticly.` produces `dramatically.` (live wins).
    const TEXT = 'enhanced dramaticly. ok ';
    const LLM_EDITS = 'EDITS:\n1 | dramaticly | dramatically!\nEND';
    const { adapter, loop, state } = setupPunct(TEXT, LLM_EDITS);
    state.arm('correct spelling');

    await loop.runOnce(TEXT);

    // The live word's "." is preserved; the LLM's "!" is stripped.
    expect(adapter.getText()).toBe('enhanced dramatically. ok ');
  });

  it('rejects edits whose CORES differ — punctuation rescue is not a free pass', async () => {
    const TEXT = 'see foo. bar ';
    const LLM_EDITS = 'EDITS:\n1 | unrelated | something\nEND';
    const { adapter, loop, state } = setupPunct(TEXT, LLM_EDITS);
    state.arm('test');

    await loop.runOnce(TEXT);

    // Live word "foo." has core "foo"; LLM's "unrelated" has core
    // "unrelated"; cores differ → reject.
    expect(adapter.getText()).toBe('see foo. bar ');
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
      shapeGuardEnabled: () => false,    // mechanical tests pre-date the guard
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
      shapeGuardEnabled: () => false,
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
      shapeGuardEnabled: () => false,
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
      shapeGuardEnabled: () => false,
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
      shapeGuardEnabled: () => false,
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
      shapeGuardEnabled: () => false,
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
      shapeGuardEnabled: () => false,
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

describe('AgentLoop range edits (<startIdx>-<endIdx>)', () => {
  // Range edits cover [startIdx, endIdx] inclusive. They unblock
  // grammar fixes that need to merge / rewrite / delete contiguous
  // multi-word phrases. Single-idx form is preserved as-is.
  //
  // Heavy test coverage because these edits touch every part of the
  // apply pipeline: parser, survival filter, splice math, def
  // placement, cumulative word delta, cursor translation, and the
  // overlap-dedupe guard.

  function setupRange(text: string, llmContent: string, opts?: { cursor?: number; retryMode?: boolean }) {
    const adapter = new MockAdapter({});
    adapter.pushText(text, opts?.cursor ?? text.length + 1);
    const state = new AgentTaskState();
    const dynDefs = new DynDefs();
    const httpAdapter = { post: async () => llmResponse(llmContent) };
    const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 1,
      httpAdapter,
      retryModeEnabled: opts?.retryMode ? () => true : undefined,
      shapeGuardEnabled: () => false,    // mechanical tests pre-date the guard
    });
    return { adapter, state, dynDefs, loop };
  }

  // ── Parser ─────────────────────────────────────────────────────────

  describe('parser', () => {
    it('parses "<n>-<m>" as range with endIndex', () => {
      const out = parseEditPassOutput('EDITS:\n2-4 | foo bar baz | qux\nEND');
      expect(out).toEqual([
        { wordIndex: 2, endIndex: 4, originalWord: 'foo bar baz', editedWord: 'qux' },
      ]);
    });

    it('parses "<n>" as single-idx with endIndex undefined (backward compat)', () => {
      const out = parseEditPassOutput('EDITS:\n3 | hello | hi\nEND');
      expect(out).toEqual([
        { wordIndex: 3, endIndex: undefined, originalWord: 'hello', editedWord: 'hi' },
      ]);
    });

    it('parses "<n>-<m>" with DELETE marker (range delete)', () => {
      const out = parseEditPassOutput('EDITS:\n1-2 | the the | DELETE\nEND');
      expect(out).toEqual([
        { wordIndex: 1, endIndex: 2, originalWord: 'the the', editedWord: '' },
      ]);
    });

    it('parses "<n>-<n>" as single-element range (endIndex = startIndex)', () => {
      const out = parseEditPassOutput('EDITS:\n3-3 | foo | bar\nEND');
      expect(out).toEqual([
        { wordIndex: 3, endIndex: 3, originalWord: 'foo', editedWord: 'bar' },
      ]);
    });

    it('drops malformed ranges where end < start', () => {
      const out = parseEditPassOutput('EDITS:\n5-2 | wrong | order\nEND');
      expect(out).toEqual([]);
    });

    it('drops malformed ranges with non-numeric endIdx', () => {
      const out = parseEditPassOutput('EDITS:\n2-abc | foo | bar\nEND');
      expect(out).toEqual([]);
    });

    it('drops range with negative startIdx', () => {
      const out = parseEditPassOutput('EDITS:\n-1-2 | foo | bar\nEND');
      expect(out).toEqual([]);
    });

    it('mixed single + range in same EDITS block', () => {
      const out = parseEditPassOutput('EDITS:\n0 | a | A\n2-3 | c d | CD\nEND');
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ wordIndex: 0, endIndex: undefined, originalWord: 'a', editedWord: 'A' });
      expect(out[1]).toEqual({ wordIndex: 2, endIndex: 3, originalWord: 'c d', editedWord: 'CD' });
    });
  });

  // ── Apply: merge (N → 1) ───────────────────────────────────────────

  describe('merge (N → 1)', () => {
    it('merges two adjacent words into one ("any way" → "anyway")', async () => {
      const TEXT = 'we went any way home ';
      // wordIndex: 0=we 1=went 2=any 3=way 4=home
      const LLM_EDITS = 'EDITS:\n2-3 | any way | anyway\nEND';
      const { adapter, dynDefs, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('fix grammar');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('we went anyway home ');
      // Def stored at NEW idx 2 (was 2-3, now collapsed to single word)
      const def = dynDefs.get(2);
      expect(def?.originalWord).toBe('any way');
      expect(def?.alternatives).toEqual(['any way', 'anyway']);
    });

    it('merges three words into one', async () => {
      const TEXT = 'he is no body here ';
      // wordIndex: 0=he 1=is 2=no 3=body 4=here
      const LLM_EDITS = 'EDITS:\n2-3 | no body | nobody\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('fix');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('he is nobody here ');
    });

    it('merge collapses word count: dynDefs at higher idx shift LEFT', async () => {
      // Pre-existing def at idx 5. Range edit 2-3 (2→1 word) shifts it to idx 4.
      const TEXT = 'A B C D E F ';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT, TEXT.length + 1);
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      dynDefs.set(5, { originalWord: 'F', alternatives: ['F', 'FF'], currentIndex: 1, spanStart: 10, spanEnd: 12, blankName: 'agent-task' });
      const httpAdapter = { post: async () => llmResponse('EDITS:\n2-3 | C D | CD\nEND') };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('expand');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A B CD E F ');
      expect(dynDefs.get(4)?.originalWord).toBe('F'); // shifted from 5
      expect(dynDefs.get(5)).toBeUndefined();
    });
  });

  // ── Apply: rewrite (N → M) ─────────────────────────────────────────

  describe('rewrite (N → M)', () => {
    it('rewrites 2 words into 3 ("I went store" → "I went to store")', async () => {
      const TEXT = 'so I went store ok ';
      // wordIndex: 0=so 1=I 2=went 3=store 4=ok
      // Range 2-3: "went store" → "went to the store" (2 → 4 words)
      const LLM_EDITS = 'EDITS:\n2-3 | went store | went to the store\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('fix grammar');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('so I went to the store ok ');
    });

    it('rewrites 3 words into 1 (drastic compression)', async () => {
      const TEXT = 'he was very very very tall ';
      // wordIndex: 0=he 1=was 2=very 3=very 4=very 5=tall
      // Range 2-4: "very very very" → "extremely"
      const LLM_EDITS = 'EDITS:\n2-4 | very very very | extremely\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('tighten');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('he was extremely tall ');
    });

    it('span/spanEnd reflect NEW frame for range rewrites', async () => {
      const TEXT = 'A B C D ';
      // Range 1-2 ("B C") → "BCBC" (4 chars, single word)
      const LLM_EDITS = 'EDITS:\n1-2 | B C | BCBC\nEND';
      const { adapter, dynDefs, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A BCBC D ');
      const def = dynDefs.get(1);
      expect(def?.spanStart).toBe(2);   // 'A '.length
      expect(def?.spanEnd).toBe(6);     // 'A BCBC'.length
    });
  });

  // ── Apply: range DELETE ────────────────────────────────────────────

  describe('range DELETE', () => {
    it('deletes a multi-word phrase ("really really" → gone)', async () => {
      const TEXT = 'I really really love it ';
      // wordIndex: 0=I 1=really 2=really 3=love 4=it
      const LLM_EDITS = 'EDITS:\n1-2 | really really | DELETE\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('tighten');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('I love it ');
    });

    it('range DELETE drops every def in the span', async () => {
      const TEXT = 'A B C D ';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT, TEXT.length + 1);
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      // Pre-existing defs at idx 1 and 2 — both should be removed.
      dynDefs.set(1, { originalWord: 'B', alternatives: ['B', 'BB'], currentIndex: 0, spanStart: 2, spanEnd: 3, blankName: 'agent-task' });
      dynDefs.set(2, { originalWord: 'C', alternatives: ['C', 'CC'], currentIndex: 0, spanStart: 4, spanEnd: 5, blankName: 'agent-task' });
      const httpAdapter = { post: async () => llmResponse('EDITS:\n1-2 | B C | DELETE\nEND') };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('tighten');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A D ');
      expect(dynDefs.get(1)).toBeUndefined();
      expect(dynDefs.get(2)).toBeUndefined();
    });
  });

  // ── Survival filter ────────────────────────────────────────────────

  describe('survival filter', () => {
    it('drops range whose originalWord doesn\'t match the live span', async () => {
      const TEXT = 'A B C D ';
      // LLM emits "1-2 | B X | foo" but live words[1..2] = "B C", not "B X".
      const LLM_EDITS = 'EDITS:\n1-2 | B X | foo\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);
      // Buffer unchanged — drift detected, edit dropped.
      expect(adapter.getText()).toBe('A B C D ');
    });

    it('drops range that includes a non-candidate index (e.g., cursor-adjacent)', async () => {
      // Cursor on word 3, so word 3 is excluded from candidates.
      // LLM emits range 2-3 — survival rejects because 3 isn't a candidate.
      const TEXT = 'A B C D ';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT, 6); // cursor at offset 6, inside "D"
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      const httpAdapter = { post: async () => llmResponse('EDITS:\n2-3 | C D | merged\nEND') };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('test');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('A B C D ');
    });

    it('drops range that includes a trigger-word index (agentically)', async () => {
      const TEXT = 'and agentically and more ';
      // wordIndex: 0=and 1=agentically 2=and 3=more
      // "agentically" is excluded as a trigger word; range 0-1 includes it.
      const LLM_EDITS = 'EDITS:\n0-1 | and agentically | combined\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('translate to German');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('and agentically and more ');
    });

    it('drops range whose start is out-of-range in liveWords', async () => {
      const TEXT = 'A B ';
      const LLM_EDITS = 'EDITS:\n5-7 | nope | nope\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('A B ');
    });

    it('drops range when ANY def in the span is owned by another source (transform-blank)', async () => {
      const TEXT = 'A B C D ';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT, TEXT.length + 1);
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      // Def at idx 2 owned by transform-blank → excluded from edits.
      dynDefs.set(2, { originalWord: 'C', alternatives: ['C', 'C-rewrite'], currentIndex: 1, spanStart: 4, spanEnd: 5, blankName: 'transform-blank' });
      const httpAdapter = { post: async () => llmResponse('EDITS:\n1-2 | B C | merged\nEND') };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('test');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('A B C D ');
    });

    it('drops a single-idx edit that overlaps an earlier surviving range', async () => {
      // First edit (range 1-2) claims indices 1 AND 2.
      // Second edit (single-idx 2) overlaps → dropped.
      const TEXT = 'A B C D ';
      const LLM_EDITS = 'EDITS:\n1-2 | B C | merged\n2 | C | clash\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);
      // Range applied; conflicting single-idx dropped.
      expect(adapter.getText()).toBe('A merged D ');
    });

    it('drops a range that overlaps an earlier surviving range', async () => {
      const TEXT = 'A B C D E ';
      // Range 1-3 claims 1,2,3. Range 3-4 overlaps at 3.
      const LLM_EDITS = 'EDITS:\n1-3 | B C D | one\n3-4 | D E | two\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('A one E ');
    });
  });

  // ── Cumulative word delta with mixed edits ─────────────────────────

  describe('cumulative word delta with mixed edit shapes', () => {
    it('range merge upstream + single-idx edit downstream: downstream lands at correct shifted idx', async () => {
      const TEXT = 'A B C D E ';
      // Range 1-2: B C → "BC" (2 → 1 word, delta -1)
      // Single 4: E → "EE" (1 → 1 word, no delta)
      // After merge, NEW idx of E was OLD 4, now NEW idx 3.
      const LLM_EDITS = 'EDITS:\n1-2 | B C | BC\n4 | E | EE\nEND';
      const { adapter, dynDefs, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A BC D EE ');
      expect(dynDefs.get(1)?.originalWord).toBe('B C');
      expect(dynDefs.get(3)?.originalWord).toBe('E');     // shifted from old 4 → new 3
    });

    it('range expansion upstream + range merge downstream', async () => {
      const TEXT = 'A B C D E F ';
      // Range 1-2: "B C" → "B1 C1 D1" (2 → 3, delta +1)
      // Range 4-5: "E F" → "EF" (2 → 1, delta -1)
      // OLD idx 4-5 are now NEW idx 5-6 (after upstream +1).
      const LLM_EDITS = 'EDITS:\n1-2 | B C | B1 C1 D1\n4-5 | E F | EF\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A B1 C1 D1 D EF ');
    });

    it('range delete + multi-word edit: deltas compose correctly', async () => {
      const TEXT = 'A B C D E ';
      // Range 1-2: "B C" → DELETE (delta -2)
      // Single 4: "E" → "E1 E2" (delta +1)
      // OLD idx 4 → NEW idx 2 after the delete.
      const LLM_EDITS = 'EDITS:\n1-2 | B C | DELETE\n4 | E | E1 E2\nEND';
      const { adapter, dynDefs, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A D E1 E2 ');
      expect(dynDefs.get(2)?.originalWord).toBe('E');
    });
  });

  // ── Cursor translation ─────────────────────────────────────────────

  describe('cursor translation', () => {
    it('range merge: cursor past the merge shifts left by char delta', async () => {
      const TEXT = 'A B C D ';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT, TEXT.length); // cursor at end
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      // Range 1-2: "B C" (3 chars + 1 space = old span 4 chars: "B C") → "BC" (2 chars)
      // Char delta = 2 - 4 + 1 (because we re-count word span)... actually:
      //   oldSpanLen = wEnd.end - wStart.start. wStart='B' at [2,3), wEnd='C' at [4,5).
      //   oldSpanLen = 5 - 2 = 3. editedWord.length = 2 ("BC"). Delta = 2 - 3 = -1.
      // Cursor 8 → 7.
      const httpAdapter = { post: async () => llmResponse('EDITS:\n1-2 | B C | BC\nEND') };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A BC D ');
      // textLen 8 → 7; cursor was at 8 (end), now should be at 7 (end).
      expect(adapter.getCursorOffset()).toBe(7);
    });

    it('range DELETE: cursor past delete shifts left by (spanLen + 1)', async () => {
      const TEXT = 'A B C D ';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT, TEXT.length); // cursor 8
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      // Range 1-2 DELETE: span is "B C" (chars 2-5 = 3 chars), plus 1 space.
      // Cursor 8 → 4.
      const httpAdapter = { post: async () => llmResponse('EDITS:\n1-2 | B C | DELETE\nEND') };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('A D ');
      expect(adapter.getCursorOffset()).toBe(4);
    });

    it('range expansion: cursor past expansion shifts right', async () => {
      const TEXT = 'A B ';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT, TEXT.length); // cursor 4
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      // Range 0-1: "A B" (3 chars) → "X1 X2 X3" (8 chars). Delta +5.
      // Cursor 4 → 9.
      const httpAdapter = { post: async () => llmResponse('EDITS:\n0-1 | A B | X1 X2 X3\nEND') };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('X1 X2 X3 ');
      expect(adapter.getCursorOffset()).toBe(9);
    });
  });

  // ── Retry mode ──────────────────────────────────────────────────────

  describe('retry-mode interaction', () => {
    it('records POST-edit hash at NEW startIdx after a range merge', async () => {
      const TEXT = 'A B C D ';
      const LLM_EDITS = 'EDITS:\n1-2 | B C | BC\nEND';
      const { state, loop } = setupRange(TEXT, LLM_EDITS, { retryMode: true });
      state.arm('test');

      await loop.runOnce(TEXT);

      // Edited word lands at NEW idx 1. retry-mode caches with hash of "BC".
      expect(state.isEvaluated(1, hashWordText('BC'))).toBe(true);
      expect(state.evaluationCount()).toBe(1);
    });

    it('range DELETE in retry mode adds NO evaluation', async () => {
      const TEXT = 'I really really love ';
      const LLM_EDITS = 'EDITS:\n1-2 | really really | DELETE\nEND';
      const { adapter, state, loop } = setupRange(TEXT, LLM_EDITS, { retryMode: true });
      state.arm('test');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('I love ');
      expect(state.evaluationCount()).toBe(0);
    });
  });

  // ── End-to-end / regression ────────────────────────────────────────

  describe('regression scenarios', () => {
    it('three-pass progressive: typing → range merge → typing more → no re-merge', async () => {
      // Pass 1: text "any way" (2 words) → LLM emits range 0-1 → "anyway"
      // Pass 2: same buffer → cache + def-presence excludes idx 0
      const TEXT1 = 'any way ';
      let llmResponseContent = 'EDITS:\n0-1 | any way | anyway\nEND';
      const adapter = new MockAdapter({});
      adapter.pushText(TEXT1, TEXT1.length + 1);
      const state = new AgentTaskState();
      const dynDefs = new DynDefs();
      let calls = 0;
      const httpAdapter = {
        post: async () => {
          calls += 1;
          return llmResponse(llmResponseContent);
        },
      };
      const loop = new AgentLoop(adapter, state, dynDefs, undefined, {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 1, httpAdapter,
        shapeGuardEnabled: () => false,
      });
      state.arm('fix grammar');

      await loop.runOnce(TEXT1);
      expect(adapter.getText()).toBe('anyway ');
      expect(calls).toBe(1);

      // Pass 2 on the post-edit buffer ("anyway "). The def at idx 0
      // is agent-task (not "owned by other source"); cache should
      // skip it via hash check.
      llmResponseContent = 'EDITS:\nnone\nEND';
      await loop.runOnce(adapter.getText());
      // No further mutation.
      expect(adapter.getText()).toBe('anyway ');
    });

    it('parser drops malformed range AND surviving valid edits still apply', async () => {
      const TEXT = 'A B C ';
      // First line malformed (5-2 reverse). Second line valid.
      const LLM_EDITS = 'EDITS:\n5-2 | bad | bad\n0 | A | A1\nEND';
      const { adapter, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('test');

      await loop.runOnce(TEXT);
      expect(adapter.getText()).toBe('A1 B C ');
    });

    it('single-idx edits still work end-to-end (regression guard)', async () => {
      // The whole point of making endIndex optional: existing behavior
      // unchanged. Belt-and-braces.
      const TEXT = 'I rite stuff ';
      const LLM_EDITS = 'EDITS:\n1 | rite | write\nEND';
      const { adapter, dynDefs, loop, state } = setupRange(TEXT, LLM_EDITS);
      state.arm('correct spelling');

      await loop.runOnce(TEXT);

      expect(adapter.getText()).toBe('I write stuff ');
      expect(dynDefs.get(1)?.alternatives).toEqual(['rite', 'write']);
    });
  });
});
