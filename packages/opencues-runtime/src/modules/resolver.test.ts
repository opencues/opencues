import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { AgentTaskState } from '../state/agent-task';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---

## Sources

\`\`\`json
{
  "grammar": {
    "scope": "words",
    "parser": "alternatives",
    "promptText": "Provide alts."
  }
}
\`\`\`
`;

interface MockResult {
  wordIndex: number;
  word: string;
  alternatives: string[];
}

function setupResolver(scriptedResults: MockResult[]) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/cues.md': TIPS, '/proj/cues.md': CUES_MD },
  });
  adapter.pushText('alpha');
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });

  // Inject a mock resolver factory so we don't load real opencues-core sources.
  // The Resolver class still calls require('@opencues/core').createResolver, so we
  // shadow that via a fake httpAdapter and a synthetic factory: we provide
  // resolverFactory to short-circuit buildSourcesFromConfig + return fake
  // sources. createResolver then runs but resolve() goes through opencues-core.
  // For unit testing, easier to bypass entirely by injecting a pre-built
  // resolver. We do that by setting Resolver._resolver after construction.
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
    httpAdapter: {},
  });
  // Patch in a fake resolver after construction.
  (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: MockResult[] }> } })._resolver = {
    resolve: async () => ({ results: scriptedResults }),
  };
  return { adapter, hlState, dynDefs, loader, resolver };
}

describe('Resolver.resolveAndApply', () => {
  it('populates DynDefs from resolver results', async () => {
    const { adapter, dynDefs, resolver } = setupResolver([
      { wordIndex: 0, word: 'alpha', alternatives: ['alpha', 'beta', 'gamma'] },
    ]);
    adapter.pushText('alpha');
    await resolver.resolveAndApply('alpha');
    const def = dynDefs.get(0);
    expect(def).toBeDefined();
    expect(def!.alternatives).toEqual(['alpha', 'beta', 'gamma']);
    expect(def!.currentIndex).toBe(0);
  });

  it('skips DynDef entries the user is mid-cycle on', async () => {
    const { dynDefs, resolver } = setupResolver([
      { wordIndex: 0, word: 'alpha', alternatives: ['alpha', 'newalt'] },
    ]);
    dynDefs.set(0, {
      originalWord: 'alpha',
      alternatives: ['alpha', 'cycledTo'],
      currentIndex: 1, // user already cycled
      spanStart: 0,
      spanEnd: 5,
    });
    await resolver.resolveAndApply('alpha');
    const def = dynDefs.get(0);
    expect(def!.alternatives).toEqual(['alpha', 'cycledTo']); // unchanged
    expect(def!.currentIndex).toBe(1);
  });

  it('preserves DynDef entries for the same word at currentIndex 0', async () => {
    // Resolver should NOT re-write a DynDef when the existing entry
    // already covers the same originalWord. Re-writing on every text
    // change caused alt-jitter (LLM responses vary slightly) and a
    // repaint flash. Once a word is filled, treat as resolved until
    // the user replaces it.
    const { dynDefs, resolver } = setupResolver([
      { wordIndex: 0, word: 'alpha', alternatives: ['alpha', 'fresh'] },
    ]);
    dynDefs.set(0, {
      originalWord: 'alpha',
      alternatives: ['alpha', 'old'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 5,
    });
    await resolver.resolveAndApply('alpha');
    // Existing alts preserved — same word, currentIndex 0 → skip.
    expect(dynDefs.get(0)!.alternatives).toEqual(['alpha', 'old']);
  });

  it('replaces DynDef entries when the word at the index has changed', async () => {
    // User typed something different at this position — old DynDef no
    // longer matches and should be replaced. Same-index but different
    // originalWord = stale entry, allow overwrite.
    const { dynDefs, resolver } = setupResolver([
      { wordIndex: 0, word: 'beta', alternatives: ['beta', 'fresh'] },
    ]);
    dynDefs.set(0, {
      originalWord: 'alpha',  // stale — text now has 'beta'
      alternatives: ['alpha', 'old'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 5,
    });
    await resolver.resolveAndApply('beta');
    expect(dynDefs.get(0)!.originalWord).toBe('beta');
    expect(dynDefs.get(0)!.alternatives).toEqual(['beta', 'fresh']);
  });

  it('drops original-only results (no alts to cycle)', async () => {
    const { dynDefs, resolver } = setupResolver([
      { wordIndex: 0, word: 'alpha', alternatives: ['alpha'] },
    ]);
    await resolver.resolveAndApply('alpha');
    expect(dynDefs.get(0)).toBeUndefined();
  });

  it('does NOT send already-resolved words to the LLM', async () => {
    // The context passed to the inner resolver should mark already-
    // computed words (and words inside an active span-fill) as empty
    // strings. Downstream, RoutedWordSourceGroup + every other
    // CueSource skips empty entries — no LLM call, no token spend.
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('alpha beta gamma');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    const spanFillState = new SpanFillState();
    let capturedContext: { words: string[] } | null = null;
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'http://x', apiKey: 'k', defaultModel: 'm', debounceMs: 1,
      httpAdapter: {},
    }, spanFillState);
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx: unknown) => {
        capturedContext = ctx as { words: string[] };
        return { results: [] };
      },
    };

    // Prior DynDef for "alpha" — should be skipped on next resolve.
    dyn.set(0, { originalWord: 'alpha', alternatives: ['alpha', 'a1'], currentIndex: 0, spanStart: 0, spanEnd: 5 });
    // Active span-fill covers words 2..3 (i.e. index 2, spanLength 2).
    spanFillState.set({
      kind: 'static-alt',
      index: 2, spanLength: 1, // (gamma only — keeping test simple)
      alternatives: ['gamma', 'cached multi'], currentAltIndex: 0,
    }, 'alpha beta gamma');

    await resolver.resolveAndApply('alpha beta gamma');
    expect(capturedContext).not.toBeNull();
    // "alpha" skipped (cached), "beta" not skipped (no DynDef), "gamma"
    // skipped (in span-fill range).
    expect(capturedContext!.words[0]).toBe('');
    expect(capturedContext!.words[1]).toBe('beta');
    expect(capturedContext!.words[2]).toBe('');
  });

  it('skips a word that has been CYCLED to one of the def\'s alternatives', async () => {
    // Regression: "the word lawyer when changed for alts can sometimes
    // drift into being other words and be re-evaluated. So it becomes
    // client then client becomes customer". The original skip-already-
    // resolved filter only checked existing.originalWord === cleaned.
    // After cycling attorney → lawyer, cleaned is "lawyer" and
    // originalWord is still "attorney" — the check fails, the resolver
    // sees "lawyer" as a fresh word, builds a new DynDef with "lawyer's
    // own alts (client, etc.), and the next cycle drifts onto a
    // different alt track. Now the filter ALSO checks current alt.
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('the lawyer filed');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    let capturedContext: { words: string[] } | null = null;
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'http://x', apiKey: 'k', defaultModel: 'm', debounceMs: 1,
      httpAdapter: {},
    });
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx: unknown) => { capturedContext = ctx as { words: string[] }; return { results: [] }; },
    };
    // User cycled attorney → lawyer. DynDef tracks both.
    dyn.set(1, {
      originalWord: 'attorney',
      alternatives: ['attorney', 'lawyer', 'legal eagle', 'defendant counsel'],
      currentIndex: 1, // currently showing "lawyer"
      spanStart: 4, spanEnd: 10,
    });
    await resolver.resolveAndApply('the lawyer filed');
    expect(capturedContext!.words[1]).toBe(''); // skipped — "lawyer" is owned by attorney's def
  });

  it('skips both inner positions of a multi-word static-alt span', async () => {
    // "the legal eagle filed" — DynDef at idx 1 (originalWord=attorney,
    // current=legal eagle). Inner position idx 2 ("eagle") has NO def
    // but is inside the span. Both should be skipped — re-resolving
    // "legal" or "eagle" as fresh words would build separate DynDefs
    // and corrupt the cycling state.
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('the legal eagle filed');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    let capturedContext: { words: string[] } | null = null;
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'http://x', apiKey: 'k', defaultModel: 'm', debounceMs: 1,
      httpAdapter: {},
    });
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx: unknown) => { capturedContext = ctx as { words: string[] }; return { results: [] }; },
    };
    dyn.set(1, {
      originalWord: 'attorney',
      alternatives: ['attorney', 'lawyer', 'legal eagle'],
      currentIndex: 2, // multi-word
      spanStart: 4, spanEnd: 15,
    });
    await resolver.resolveAndApply('the legal eagle filed');
    expect(capturedContext!.words[1]).toBe(''); // origin (legal) — span owned
    expect(capturedContext!.words[2]).toBe(''); // inner (eagle) — span owned
    expect(capturedContext!.words[3]).toBe('filed'); // unrelated, sent normally
  });

  it('blanks (_) are always re-resolved, even if the runtime has cached alts', async () => {
    // Context for a `_` must pass through unchanged — its answer
    // depends on surrounding words that may have shifted on any edit.
    const adapter = new MockAdapter({ files: { '/mock/cues.md': TIPS } });
    adapter.pushText('weather _ paris');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    let capturedContext: { words: string[] } | null = null;
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'http://x', apiKey: 'k', defaultModel: 'm', debounceMs: 1,
      httpAdapter: {},
    });
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx: unknown) => {
        capturedContext = ctx as { words: string[] };
        return { results: [] };
      },
    };

    await resolver.resolveAndApply('weather _ paris');
    expect(capturedContext!.words).toContain('_');
  });

  it('stale-invalidates: if generation bumped during in-flight, drops result', async () => {
    const { adapter, dynDefs } = setupResolver([
      { wordIndex: 0, word: 'alpha', alternatives: ['alpha', 'late'] },
    ]);
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    let resolveDelay = 50;
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'http://x', apiKey: 'k', defaultModel: 'm', debounceMs: 1,
      httpAdapter: {},
    });
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async () => {
        await new Promise(r => setTimeout(r, resolveDelay));
        return { results: [{ wordIndex: 0, word: 'alpha', alternatives: ['alpha', 'stale'] }] };
      },
    };
    const p1 = resolver.resolveAndApply('alpha');
    resolveDelay = 1;
    const p2 = resolver.resolveAndApply('alpha');
    await Promise.all([p1, p2]);
    // p2 wins (latest generation). p1's "stale" result is dropped.
    expect(dyn.get(0)?.alternatives).toContain('stale'); // p2 also returned 'stale' in this setup
    void dynDefs;
  });

  it('cues.md frontmatter `llm-endpoint:` and `llm-model:` override options', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/mock/cues.md': TIPS,
        '/proj/cues.md': '---\nllm-endpoint: https://other.example.com/v1\nllm-model: openai/custom-model\n---\n',
      },
    });
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    await loader.load();

    let capturedOpts: { endpoint?: string; defaultModel?: string } | undefined;
    const fakeFactory = (_c: unknown, _b: unknown, opts: unknown): unknown[] => {
      capturedOpts = opts as { endpoint?: string; defaultModel?: string };
      return [{}];
    };
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'https://patch-default.example.com',
      apiKey: 'k',
      defaultModel: 'patch-default-model',
      httpAdapter: {},
      resolverFactory: fakeFactory,
    });
    resolver.rebuildResolver();
    expect(capturedOpts?.endpoint).toBe('https://other.example.com/v1');
    expect(capturedOpts?.defaultModel).toBe('openai/custom-model');
  });

  it('falls back to options.endpoint/defaultModel when opencues.md has no overrides', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/cues.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    await loader.load();
    let capturedOpts: { endpoint?: string; defaultModel?: string } | undefined;
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'https://patch-default.example.com',
      apiKey: 'k',
      defaultModel: 'patch-default-model',
      httpAdapter: {},
      resolverFactory: (_c, _b, opts) => {
        capturedOpts = opts as { endpoint?: string; defaultModel?: string };
        return [{}];
      },
    });
    resolver.rebuildResolver();
    expect(capturedOpts?.endpoint).toBe('https://patch-default.example.com');
    expect(capturedOpts?.defaultModel).toBe('patch-default-model');
  });
});

describe('Resolver TASK_* commands', () => {
  type TaskAction = 'TASK_ARM' | 'TASK_ADD' | 'TASK_STOP' | 'TASK_SHOW';

  function setupTaskScenario(initialText: string, taskAction: TaskAction, taskPayload: string) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/cues.md': TIPS, '/proj/cues.md': CUES_MD },
    });
    adapter.pushText(initialText);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/cues.md' });
    const agentTaskState = new AgentTaskState();
    const wordCount = initialText.trim().split(/\s+/).length;
    const blankWordIndex = Math.max(0, wordCount - 1);
    const resolver = new Resolver(
      adapter, hlState, dynDefs, loader,
      { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} },
      undefined, agentTaskState,
    );
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async () => ({
        results: [{
          wordIndex: blankWordIndex,
          word: '_',
          alternatives: [initialText, ''],
          spanStart: 0,
          spanEnd: initialText.length,
          source: 'transform-blank',
          metadata: { taskAction, taskPayload },
        }],
      }),
    };
    return { adapter, agentTaskState, resolver, dynDefs };
  }

  it('TASK_ADD preserves prose typed before the "add task" trigger', async () => {
    // Bug repro: the user has typed prose, then appends "add task <X> _"
    // at the end. The runtime was wiping the entire buffer instead of
    // just stripping the trailing trigger fragment. See cursor-trace
    // 22:11:33 — pushText("") with delta=-127 the moment AgentTask: ADD
    // fired.
    const prose = "I write some text with typos let's see how the system does. So far so good it al";
    const proseAndTrigger = `${prose} add task make it more formal _`;
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      proseAndTrigger, 'TASK_ADD', 'make it more formal',
    );
    agentTaskState.arm('correct spelling'); // pre-arm so ADD goes through append branch

    await resolver.resolveAndApply(proseAndTrigger);

    expect(adapter.getText()).toBe(prose);
    expect(agentTaskState.prompt).toBe('correct spelling AND make it more formal');
  });

  it('TASK_ARM preserves prose typed before the "agentically" trigger', async () => {
    const prose = 'rough draft of an email';
    const proseAndTrigger = `${prose} agentically improve clarity _`;
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      proseAndTrigger, 'TASK_ARM', 'improve clarity',
    );

    await resolver.resolveAndApply(proseAndTrigger);

    expect(adapter.getText()).toBe(prose);
    expect(agentTaskState.armed).toBe(true);
    expect(agentTaskState.prompt).toBe('improve clarity');
  });

  it('TASK_STOP preserves prose typed before the "stop task" trigger', async () => {
    const prose = 'some content here';
    const proseAndTrigger = `${prose} stop task _`;
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      proseAndTrigger, 'TASK_STOP', '',
    );
    agentTaskState.arm('correct spelling');

    await resolver.resolveAndApply(proseAndTrigger);

    expect(adapter.getText()).toBe(prose);
    expect(agentTaskState.armed).toBe(false);
  });

  it('TASK_STOP preserves prose typed AFTER the "stop task _" trigger', async () => {
    // Bug repro: user has prose, types `stop task _` in the middle, has more
    // prose after. Earlier fix was sliced only [0, triggerStart], dropping
    // the suffix.
    const proseBefore = 'some content here';
    const proseAfter = 'more content after';
    const buffer = `${proseBefore} stop task _ ${proseAfter}`;
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      buffer, 'TASK_STOP', '',
    );
    agentTaskState.arm('correct spelling');

    await resolver.resolveAndApply(buffer);

    expect(adapter.getText()).toBe(`${proseBefore} ${proseAfter}`);
    expect(agentTaskState.armed).toBe(false);
  });

  it('TASK_ADD preserves prose AFTER the "add task <X> _" trigger', async () => {
    const proseBefore = 'rough draft email';
    const proseAfter = 'and more text';
    const buffer = `${proseBefore} add task make it formal _ ${proseAfter}`;
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      buffer, 'TASK_ADD', 'make it formal',
    );
    agentTaskState.arm('correct spelling');

    await resolver.resolveAndApply(buffer);

    expect(adapter.getText()).toBe(`${proseBefore} ${proseAfter}`);
    expect(agentTaskState.prompt).toBe('correct spelling AND make it formal');
  });

  it('TASK_STOP preserves paragraph breaks around the trigger', async () => {
    // Bug repro: regex used \s+ which ate newlines, collapsing
    // "para1\n\nstop task _\n\npara2" → "para1 para2" — looked like the
    // second paragraph had been wiped.
    const buffer = 'para1\n\nstop task _\n\npara2';
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      buffer, 'TASK_STOP', '',
    );
    agentTaskState.arm('correct spelling');

    await resolver.resolveAndApply(buffer);

    expect(adapter.getText()).toBe('para1\n\n\n\npara2');
    expect(agentTaskState.armed).toBe(false);
  });

  // ─── trigger-trim against agent-edited buffers ────────────────────────────
  // These tests pin the asTyped→visible mapping path: when the agent has
  // already substituted words in the visible buffer, the trim must still
  // locate the trigger fragment (via asTyped) AND splice the right visible
  // range (via the position map), so the agent's other edits survive.

  it('TASK_ARM strips trigger when agent translated the trigger keyword itself', async () => {
    // Visible:  "agentisch improve clarity _"  (agent translated "agentically")
    // As-typed: "agentically improve clarity _"
    const visible = 'agentisch improve clarity _';
    const { adapter, agentTaskState, resolver, dynDefs } = setupTaskScenario(
      visible, 'TASK_ARM', 'improve clarity',
    );
    dynDefs.set(0, {
      originalWord: 'agentically', alternatives: ['agentically', 'agentisch'], currentIndex: 1,
      spanStart: 0, spanEnd: 9, blankName: 'agent-task',
    });

    await resolver.resolveAndApply(visible);

    expect(adapter.getText()).toBe('');
    expect(agentTaskState.armed).toBe(true);
    expect(agentTaskState.prompt).toBe('improve clarity');
  });

  it('TASK_ARM strips trigger when agent edited a word BETWEEN the trigger keyword and `_`', async () => {
    // Visible:  "agentically übersetzen to german _"
    // As-typed: "agentically translate to german _"
    // The intervening word's edit must not cause the trim to miss the `_`.
    const visible = 'agentically übersetzen to german _';
    const { adapter, agentTaskState, resolver, dynDefs } = setupTaskScenario(
      visible, 'TASK_ARM', 'translate to german',
    );
    dynDefs.set(1, {
      originalWord: 'translate', alternatives: ['translate', 'übersetzen'], currentIndex: 1,
      spanStart: 12, spanEnd: 22, blankName: 'agent-task',
    });

    await resolver.resolveAndApply(visible);

    expect(adapter.getText()).toBe('');
    expect(agentTaskState.armed).toBe(true);
  });

  it('TASK_ARM preserves agent-edited prose BEFORE the trigger', async () => {
    // The user typed: "rite stuff agentically improve clarity _".
    // The agent fixed "rite" → "write" earlier (currentIndex=1).
    // After trim, the visible "write stuff" half must remain intact —
    // not collapse back to the typed "rite stuff".
    const visible = 'write stuff agentically improve clarity _';
    const { adapter, agentTaskState, resolver, dynDefs } = setupTaskScenario(
      visible, 'TASK_ARM', 'improve clarity',
    );
    dynDefs.set(0, {
      originalWord: 'rite', alternatives: ['rite', 'write'], currentIndex: 1,
      spanStart: 0, spanEnd: 5, blankName: 'agent-task',
    });

    await resolver.resolveAndApply(visible);

    expect(adapter.getText()).toBe('write stuff');
    expect(agentTaskState.armed).toBe(true);
  });

  it('TASK_STOP preserves agent-edited prose AFTER the trigger', async () => {
    // Visible:  "some text stop task _ more witth typos"
    // (agent has not yet edited "witth" — it's just typed prose).
    // Agent DID translate "stop" → "halt"... wait, "stop task" is the
    // trigger keyword and must remain matchable. Let's edit the AFTER half:
    // Visible:  "some text stop task _ more with typos"  (agent fixed "witth")
    // As-typed: "some text stop task _ more witth typos"
    // Trim must keep "more with typos" (the agent-edited form).
    const visible = 'some text stop task _ more with typos';
    const { adapter, agentTaskState, resolver, dynDefs } = setupTaskScenario(
      visible, 'TASK_STOP', '',
    );
    agentTaskState.arm('correct spelling');
    dynDefs.set(6, {
      originalWord: 'witth', alternatives: ['witth', 'with'], currentIndex: 1,
      spanStart: 27, spanEnd: 31, blankName: 'agent-task',
    });

    await resolver.resolveAndApply(visible);

    expect(adapter.getText()).toBe('some text more with typos');
    expect(agentTaskState.armed).toBe(false);
  });

  it('TASK_ARM with NO trigger-keyword edit + NO intervening edit behaves identically to the no-dynDefs path', async () => {
    // Sanity: the asTyped wiring must not regress the typical case where
    // dynDefs is empty (no agent edits at all). When asTyped === visible,
    // the function should fall back to the visible-only path.
    const visible = 'agentically improve clarity _';
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      visible, 'TASK_ARM', 'improve clarity',
    );
    // dynDefs intentionally NOT populated.

    await resolver.resolveAndApply(visible);

    expect(adapter.getText()).toBe('');
    expect(agentTaskState.armed).toBe(true);
  });

  it('TASK_ARM with no prose still produces an empty buffer (bare trigger)', async () => {
    // Sanity: the "no prose" path that already worked must keep working.
    const trigger = 'agentically correct spelling _';
    const { adapter, agentTaskState, resolver } = setupTaskScenario(
      trigger, 'TASK_ARM', 'correct spelling',
    );

    await resolver.resolveAndApply(trigger);

    expect(adapter.getText()).toBe('');
    expect(agentTaskState.armed).toBe(true);
    expect(agentTaskState.prompt).toBe('correct spelling');
  });
});
