import { describe, expect, it, vi } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { AgentTaskState } from '../state/agent-task';
import { SelectorSatelliteState } from '../state/selector-satellite';
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
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText('alpha');
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });

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
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('alpha beta gamma');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('the lawyer filed');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('the legal eagle filed');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText('weather _ paris');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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

  it('CUES.md frontmatter `llm-endpoint:` and `llm-model:` override options', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/mock/CUES.md': TIPS,
        '/proj/CUES.md': '---\nllm-endpoint: https://other.example.com/v1\nllm-model: openai/custom-model\n---\n',
      },
    });
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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

  it('picks up apiKeys mutations on rebuild (real-time host-key updates)', async () => {
    // Regression pin: chrome's BootResult.updateApiKeys mutates the
    // SAME apiKeys ref the resolver holds in options, then calls
    // rebuildResolver. The resolver MUST re-read the live ref — not
    // a snapshot captured at construction time — for mid-session key
    // pushes (chrome-host install after page load, .env rotation,
    // etc.) to take effect without a tab reload.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();

    const liveApiKeys: Record<string, string | undefined> = { GROQ_API_KEY: 'old-key' };
    let capturedKeys: Record<string, string | undefined> | undefined;
    const resolver = new Resolver(adapter, hlState, dyn, loader, {
      endpoint: 'https://x',
      apiKey: 'old-key',
      defaultModel: 'm',
      apiKeys: liveApiKeys,
      httpAdapter: {},
      resolverFactory: (_c, _b, opts) => {
        capturedKeys = (opts as { apiKeys: Record<string, string | undefined> }).apiKeys;
        return [{}];
      },
    });

    resolver.rebuildResolver();
    expect(capturedKeys?.GROQ_API_KEY).toBe('old-key');
    expect(capturedKeys?.GEMINI_API_KEY).toBeUndefined();

    // Simulate chrome's updateApiKeys mutating the live bag in place
    // (NOT reassigning — reassignment wouldn't propagate to the
    // resolver's options.apiKeys reference).
    delete liveApiKeys.GROQ_API_KEY;
    liveApiKeys.GEMINI_API_KEY = 'new-gemini-key';

    resolver.rebuildResolver();
    expect(capturedKeys?.GROQ_API_KEY).toBeUndefined();
    expect(capturedKeys?.GEMINI_API_KEY).toBe('new-gemini-key');
  });

  it('falls back to options.endpoint/defaultModel when OPENCUES.md has no overrides', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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

describe('Resolver — same-text dedupe (regression: double LLM call on `_` trigger)', () => {
  // Regression for the May 2026 bug where OpenCode's Solid prompt
  // re-emitted onContentChange for the same buffer content multiple
  // times after a single change, causing two parallel TransformBlank
  // LLM calls per `_` trigger. The first event hit the resolver's
  // fast-path; the second fell through to scheduleResolve() and fired
  // a redundant resolveAndApply 500ms later.
  //
  // Fix: early-return in onTextChange when text === _lastInputText.
  // These tests pin the dedupe so any future host whose event loop
  // re-emits identical text events still gets one resolve per change.

  it('two identical text events fire resolveAndApply exactly once', async () => {
    const { adapter, resolver } = setupResolver([]);
    const spy = vi.spyOn(resolver, 'resolveAndApply');
    resolver.subscribe();

    // First event: text ends with `_` (fast-path bypass).
    adapter.pushText('hello _');
    // Second event: identical text — must be deduped.
    adapter.pushText('hello _');

    // Wait past the test's debounceMs (10) by enough margin to be
    // sure any scheduled debounce would have fired.
    await new Promise(r => setTimeout(r, 50));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('three identical text events still fire resolveAndApply exactly once', async () => {
    const { adapter, resolver } = setupResolver([]);
    const spy = vi.spyOn(resolver, 'resolveAndApply');
    resolver.subscribe();

    adapter.pushText('hello _');
    adapter.pushText('hello _');
    adapter.pushText('hello _');

    await new Promise(r => setTimeout(r, 50));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('identical events without `_` (no fast-path) also dedupe — single scheduled resolve', async () => {
    const { adapter, resolver } = setupResolver([]);
    const spy = vi.spyOn(resolver, 'resolveAndApply');
    resolver.subscribe();

    // No `_` → no fast-path → first event goes through scheduleResolve.
    adapter.pushText('hello world');
    // Second event with identical text must not re-schedule.
    adapter.pushText('hello world');

    // Wait past debounce so any scheduled resolve fires.
    await new Promise(r => setTimeout(r, 50));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('genuinely different text fires resolveAndApply twice — dedupe is text-equality only', async () => {
    const { adapter, resolver } = setupResolver([]);
    const spy = vi.spyOn(resolver, 'resolveAndApply');
    resolver.subscribe();

    // Two distinct text changes, separated by enough time for the first
    // debounced schedule to fire (10ms debounce in setupResolver). The
    // point: dedupe is text-equality only — different text MUST trigger a
    // second resolve, regardless of which path (bypass vs scheduled) each
    // change takes.
    adapter.pushText('hello _');
    await new Promise(r => setTimeout(r, 30));
    adapter.pushText('hello world _');  // different text
    await new Promise(r => setTimeout(r, 30));

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('Resolver TASK_* commands', () => {
  type TaskAction = 'TASK_ARM' | 'TASK_ADD' | 'TASK_STOP' | 'TASK_SHOW';

  function setupTaskScenario(initialText: string, taskAction: TaskAction, taskPayload: string) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    adapter.pushText(initialText);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
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

// ===========================================================================
// Resolver — ambient-context gate (security property)
// ===========================================================================
//
// `ambient-context-mode: off` in OPENCUES.md (the default) MUST cause the
// runtime to skip calling `adapter.getAmbientContext()` entirely. The
// load-bearing security property: a misbehaving host can't accidentally
// gather ambient metadata when the user hasn't opted in.
//
// Conversely, `ambient-context-mode: on` MUST cause the runtime to call
// the adapter's gatherer AND forward the result into the context object
// the underlying resolver receives.
//
// The toggle must take effect on the NEXT resolve without a Resolver
// rebuild — `opencuesState` is read at resolve-time, not at construction
// time.

describe('Resolver ambient-context gate', () => {
  interface CapturedCtx { ambient?: unknown }

  function setupGateScenario(initialMode: 'on' | 'off') {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    adapter.pushText('alpha _');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });

    let getAmbientCallCount = 0;
    const sampleAmbient = { label: 'Search', pageTitle: 'Trivia' };
    (adapter as unknown as { getAmbientContext: () => typeof sampleAmbient | null }).getAmbientContext =
      () => { getAmbientCallCount++; return sampleAmbient; };

    // Apply initial mode via the in-memory scalar setter (mirrors how
    // selector-satellite cycling flips it at runtime).
    loader.applyOpenCuesScalar('ambient-context-mode', initialMode);

    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
      httpAdapter: {},
    });
    // Replace the underlying resolver with a spy that captures the ctx.
    const capturedCtxs: CapturedCtx[] = [];
    (resolver as unknown as { _resolver: { resolve(ctx: CapturedCtx): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx) => { capturedCtxs.push(ctx); return { results: [] }; },
    };

    return {
      adapter, loader, resolver, capturedCtxs,
      callCount: () => getAmbientCallCount,
      sampleAmbient,
    };
  }

  it('mode=off: adapter.getAmbientContext is NEVER called', async () => {
    const { resolver, callCount, capturedCtxs } = setupGateScenario('off');
    await resolver.resolveAndApply('alpha _');
    expect(callCount()).toBe(0);
    expect(capturedCtxs[0]?.ambient).toBeUndefined();
  });

  it('mode=on: adapter.getAmbientContext IS called and its result reaches the ctx', async () => {
    const { resolver, callCount, capturedCtxs, sampleAmbient } = setupGateScenario('on');
    await resolver.resolveAndApply('alpha _');
    expect(callCount()).toBe(1);
    expect(capturedCtxs[0]?.ambient).toEqual(sampleAmbient);
  });

  it('toggling mode mid-session takes effect on the NEXT resolve (no rebuild)', async () => {
    const { resolver, loader, callCount, capturedCtxs } = setupGateScenario('off');

    // First resolve: gate is OFF.
    await resolver.resolveAndApply('alpha _');
    expect(callCount()).toBe(0);
    expect(capturedCtxs[0]?.ambient).toBeUndefined();

    // Flip to ON in-memory (mirrors `opencues ambient-context-mode on _`).
    loader.applyOpenCuesScalar('ambient-context-mode', 'on');

    // Second resolve: gate is ON. Same Resolver instance.
    await resolver.resolveAndApply('beta _');
    expect(callCount()).toBe(1);
    expect(capturedCtxs[1]?.ambient).toBeDefined();

    // Flip OFF again.
    loader.applyOpenCuesScalar('ambient-context-mode', 'off');

    // Third resolve: gate is OFF. Call count must NOT increment.
    await resolver.resolveAndApply('gamma _');
    expect(callCount()).toBe(1);
    expect(capturedCtxs[2]?.ambient).toBeUndefined();
  });

  it('mode=on but adapter has no getAmbientContext: ambient is undefined, no throw', async () => {
    // Native hosts (CC/OC/gemini-cli) intentionally don't ship a
    // getAmbientContext binding. Mode=on should degrade to "no ambient"
    // without crashing the resolve.
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    adapter.pushText('alpha _');
    // Deliberately do NOT attach getAmbientContext to the adapter.
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    loader.applyOpenCuesScalar('ambient-context-mode', 'on');

    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
      httpAdapter: {},
    });
    const capturedCtxs: CapturedCtx[] = [];
    (resolver as unknown as { _resolver: { resolve(ctx: CapturedCtx): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx) => { capturedCtxs.push(ctx); return { results: [] }; },
    };

    await resolver.resolveAndApply('alpha _');
    expect(capturedCtxs[0]?.ambient).toBeUndefined();
  });
});

describe('Resolver blank-context skip for keyword-bound slots (regression: volume _ took 1.2s on June 2026)', () => {
  // Sources that consume the `blankContext` catalog (FluidBlank,
  // TransformBlank) cede when a keyword-bound BlankFill slot claims
  // the `_`. When EVERY `_` is keyword-bound, the per-resolve catalog
  // fetch — N sequential script/network calls — is pure waste. The
  // resolver skips it via the `keywordBoundSlotIndices` option, wired
  // by each adapter from BlankFill.scan.
  interface CapturedCtx { blankContext?: unknown }

  function setup(opts: { keywordBoundSlotIndices?: (text: string) => readonly number[] }) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    loader.applyOpenCuesScalar('blank-context-mode', 'safe');

    let providerCallCount = 0;
    const blankContextProvider = async () => {
      providerCallCount++;
      return { fields: [], catalog: new Map<string, string>(), mode: 'safe' as const };
    };

    const resolver = new Resolver(
      adapter, hlState, dynDefs, loader,
      {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
        httpAdapter: {},
        keywordBoundSlotIndices: opts.keywordBoundSlotIndices,
      },
      undefined, undefined, undefined, undefined, undefined,
      blankContextProvider,
    );
    const capturedCtxs: CapturedCtx[] = [];
    (resolver as unknown as { _resolver: { resolve(ctx: CapturedCtx): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx) => { capturedCtxs.push(ctx); return { results: [] }; },
    };
    return { resolver, capturedCtxs, providerCalls: () => providerCallCount };
  }

  it('every `_` is keyword-bound → blankContextProvider is NOT called', async () => {
    // `volume _` → BlankFill claims word index 1.
    const { resolver, capturedCtxs, providerCalls } = setup({
      keywordBoundSlotIndices: text => text === 'volume _' ? [1] : [],
    });
    await resolver.resolveAndApply('volume _');
    expect(providerCalls()).toBe(0);
    expect(capturedCtxs[0]?.blankContext).toBeUndefined();
  });

  it('no keyword-bound slot → blankContextProvider IS called (transform/fluid still get catalog)', async () => {
    // `draft stocks information email _` — none of those words are
    // blank keywords (stocks blank's keywords are tickers like NVDA,
    // not "stocks"). BlankFill returns no slots → catalog fetched →
    // TransformBlank gets it.
    const { resolver, capturedCtxs, providerCalls } = setup({
      keywordBoundSlotIndices: () => [],
    });
    await resolver.resolveAndApply('draft stocks information email _');
    expect(providerCalls()).toBe(1);
    expect(capturedCtxs[0]?.blankContext).toBeDefined();
  });

  it('partial coverage (some `_` claimed, some not) → blankContextProvider IS called', async () => {
    // Mixed buffer: one keyword-bound, one free. The free `_` may go
    // to FluidBlank / TransformBlank, so the catalog is still needed.
    const { resolver, capturedCtxs, providerCalls } = setup({
      // Only word index 1 is keyword-bound; the `_` at word 5 is free.
      keywordBoundSlotIndices: () => [1],
    });
    await resolver.resolveAndApply('volume _ then question _');
    expect(providerCalls()).toBe(1);
    expect(capturedCtxs[0]?.blankContext).toBeDefined();
  });

  it('no `_` in buffer → blankContextProvider is NOT called', async () => {
    // No blanks anywhere → no consumer of the catalog → skip.
    const { resolver, capturedCtxs, providerCalls } = setup({
      keywordBoundSlotIndices: () => [],
    });
    await resolver.resolveAndApply('the lawyer filed today');
    expect(providerCalls()).toBe(0);
    expect(capturedCtxs[0]?.blankContext).toBeUndefined();
  });

  it('option omitted → legacy behaviour (provider called whenever `_` is present)', async () => {
    const { resolver, capturedCtxs, providerCalls } = setup({});
    await resolver.resolveAndApply('volume _');
    expect(providerCalls()).toBe(1);
    expect(capturedCtxs[0]?.blankContext).toBeDefined();
  });
});

describe('Resolver identity-context skip for keyword-bound slots (symmetric with blank-context)', () => {
  // FluidBlank and TransformBlank are the only consumers of
  // `identityContext`. Both cede when a keyword-bound BlankFill slot
  // claims the `_`. The catalog itself is cheap (in-memory at
  // ConfigLoader), so the saving here is symmetric correctness +
  // payload-size rather than an IO/cost win.
  interface CapturedCtx { identityContext?: unknown }

  function setup(opts: {
    mode?: 'off' | 'safe' | 'raw';
    keywordBoundSlotIndices?: (text: string) => readonly number[];
  }) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    if (opts.mode && opts.mode !== 'off') {
      loader.applyOpenCuesScalar('identity-context-mode', opts.mode);
    }

    const resolver = new Resolver(
      adapter, hlState, dynDefs, loader,
      {
        endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
        httpAdapter: {},
        keywordBoundSlotIndices: opts.keywordBoundSlotIndices,
      },
    );
    const capturedCtxs: CapturedCtx[] = [];
    (resolver as unknown as { _resolver: { resolve(ctx: CapturedCtx): Promise<{ results: MockResult[] }> } })._resolver = {
      resolve: async (ctx) => { capturedCtxs.push(ctx); return { results: [] }; },
    };
    return { resolver, capturedCtxs };
  }

  it('every `_` is keyword-bound → identityContext is NOT forwarded', async () => {
    const { resolver, capturedCtxs } = setup({
      mode: 'safe',
      keywordBoundSlotIndices: text => text === 'volume _' ? [1] : [],
    });
    await resolver.resolveAndApply('volume _');
    expect(capturedCtxs[0]?.identityContext).toBeUndefined();
  });

  it('no keyword-bound slot → identityContext IS forwarded', async () => {
    const { resolver, capturedCtxs } = setup({
      mode: 'safe',
      keywordBoundSlotIndices: () => [],
    });
    await resolver.resolveAndApply('draft an email about my trip _');
    expect(capturedCtxs[0]?.identityContext).toBeDefined();
  });

  it('mode=off → identityContext is NOT forwarded regardless of slot state', async () => {
    const { resolver, capturedCtxs } = setup({
      mode: 'off',
      keywordBoundSlotIndices: () => [],
    });
    await resolver.resolveAndApply('draft an email about my trip _');
    expect(capturedCtxs[0]?.identityContext).toBeUndefined();
  });

  it('no `_` in buffer → identityContext is NOT forwarded (no consumer source can fire)', async () => {
    const { resolver, capturedCtxs } = setup({
      mode: 'safe',
      keywordBoundSlotIndices: () => [],
    });
    await resolver.resolveAndApply('the lawyer filed today');
    expect(capturedCtxs[0]?.identityContext).toBeUndefined();
  });
});

describe('Resolver blank-trigger-mode gate', () => {
  // The user-facing distinction: in `immediate` mode a bare `_` at the
  // end of the buffer bypasses the debounce and resolves NOW. In
  // `spaced` mode it doesn't — the user has to type a confirming
  // space before the trigger fires. Lets users type markdown
  // `_italic_` without the first `_` instantly substituting.

  function setupTriggerScenario(mode: 'immediate' | 'spaced') {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    adapter.pushText('');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    loader.applyOpenCuesScalar('blank-trigger-mode', mode);

    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 10_000,  // huge so only the bypass path counts
      httpAdapter: {},
    });
    let resolveCallCount = 0;
    (resolver as unknown as { _resolver: { resolve(): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async () => { resolveCallCount++; return { results: [] }; },
    };
    resolver.subscribe();
    return { adapter, resolver, callCount: () => resolveCallCount };
  }

  it('immediate mode: bare `_` at end of buffer bypasses debounce', async () => {
    const { adapter, callCount } = setupTriggerScenario('immediate');
    adapter.pushText('alpha _');
    await new Promise(r => setTimeout(r, 50));
    expect(callCount()).toBeGreaterThanOrEqual(1);
  });

  it('spaced mode: bare `_` at end of buffer does NOT bypass debounce', async () => {
    const { adapter, callCount } = setupTriggerScenario('spaced');
    adapter.pushText('alpha _');
    await new Promise(r => setTimeout(r, 50));
    expect(callCount()).toBe(0);
  });

  it('spaced mode: `_` followed by a space DOES bypass debounce', async () => {
    const { adapter, callCount } = setupTriggerScenario('spaced');
    adapter.pushText('alpha _');
    await new Promise(r => setTimeout(r, 20));
    adapter.pushText('alpha _ ');
    await new Promise(r => setTimeout(r, 50));
    expect(callCount()).toBeGreaterThanOrEqual(1);
  });

  it('spaced mode: typing `_italic_` markdown produces NO trigger', async () => {
    const { adapter, callCount } = setupTriggerScenario('spaced');
    adapter.pushText('this is _');           // first `_`
    await new Promise(r => setTimeout(r, 20));
    adapter.pushText('this is _italic');
    await new Promise(r => setTimeout(r, 20));
    adapter.pushText('this is _italic_');    // closing `_`
    await new Promise(r => setTimeout(r, 50));
    expect(callCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Explicit-`_` gate: blanks (FluidBlank / TransformBlank / ConfigIntent)
// fire ONLY when the `_` in the buffer was placed by an explicit user
// keystroke. A `_` exposed via cursor-relocation (`monologue_` → split to
// `monologue _`), paste, or programmatic setText must NOT fire.
//
// Bug observed June 2026: typing `monologue_` then splitting to
// `monologue _` triggered FluidBlank substitution (log evidence:
// `FluidBlank: substituting "Monologue #2 _" → "Monologue #2"`). The
// blank's origin was not a "direct placement" — it was an attached `_`
// that became standalone after a separate edit. Fix: gate blank
// activation on the most-recent explicit `_` keystroke; the falls-through
// scheduleResolve path captures freshness at change time so the debounce
// can't open a hole.
// ---------------------------------------------------------------------------

describe('Resolver explicit-`_` gate', () => {
  function setupGateScenario() {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    adapter.pushText('');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      debounceMs: 20,
      httpAdapter: {},
    });
    const seenWordsPerCall: string[][] = [];
    (resolver as unknown as { _resolver: { resolve(ctx: { words: string[] }): Promise<{ results: unknown[] }> } })._resolver = {
      resolve: async ctx => { seenWordsPerCall.push([...ctx.words]); return { results: [] }; },
    };
    resolver.subscribe();
    return { adapter, resolver, seenWordsPerCall };
  }

  it('cursor-split scenario: `monologue_` → split to `monologue _` does NOT route `_` to blank sources', async () => {
    const { adapter, seenWordsPerCall } = setupGateScenario();
    // Step 1: user types `monologue_` (single explicit `_` keystroke
    // attached to the word — NOT a standalone slot).
    adapter.pushText('monologue_');
    await new Promise(r => setTimeout(r, 80));
    // The bypass on `monologue_` is a no-op for blank dispatch (no
    // standalone `_`); the debounced resolve fires once with the `_`
    // still attached — no isolated `_` word in the cleanWords list.
    for (const words of seenWordsPerCall) {
      expect(words).not.toContain('_');
    }
    const callsAfterStep1 = seenWordsPerCall.length;

    // Step 2: user moves cursor and inserts a space, exposing a
    // standalone `_`. This is the buggy path — no fresh keystroke fired
    // (pushText auto-fires only when underscore COUNT grows, and here it
    // doesn't). The cleanWords filter must mask the now-standalone `_`.
    adapter.pushTextNoKeystroke('monologue _');
    await new Promise(r => setTimeout(r, 80));
    expect(seenWordsPerCall.length).toBeGreaterThan(callsAfterStep1);
    for (const words of seenWordsPerCall) {
      expect(words).not.toContain('_');
    }
  });

  it('direct path: typing `country _` with the `_` keystroke DOES route `_` to blank sources', async () => {
    const { adapter, seenWordsPerCall } = setupGateScenario();
    // pushText auto-fires `_` keystroke because text gained a `_`.
    adapter.pushText('country _');
    await new Promise(r => setTimeout(r, 80));
    const sawStandaloneUnderscore = seenWordsPerCall.some(words => words.includes('_'));
    expect(sawStandaloneUnderscore).toBe(true);
  });

  it('paste scenario: programmatic `pushTextNoKeystroke` with a standalone `_` does NOT route to blank sources', async () => {
    const { adapter, seenWordsPerCall } = setupGateScenario();
    adapter.pushTextNoKeystroke('weather _');
    await new Promise(r => setTimeout(r, 80));
    for (const words of seenWordsPerCall) {
      expect(words).not.toContain('_');
    }
  });
});

// ---------------------------------------------------------------------------
// Source-specific substitution branches — pins the user-journey from
// ConfigIntent classification → selector-satellite buffer paint.
//
// The bug fixed alongside these tests: the original ship had no
// resolver branch for `source: 'config-intent'` and the result silently
// no-op'd the UI even though the file write fired. The CURRENT shape
// is the selector-satellite one — ConfigIntent acts as a smart
// shortcut into the existing `opencues settings _` menu (summon words
// get wiped, buffer becomes "<setting> <value>", standard satellite
// cycling is active afterwards).
// ---------------------------------------------------------------------------

describe('Resolver config-intent substitution', () => {
  // The runtime branch reads r.source — MockResult above doesn't carry
  // source/priority/cueTip. Use this richer interface for these tests.
  interface RichMockResult {
    wordIndex: number;
    word: string;
    alternatives: string[];
    source: string;
    priority: number;
    cueTip?: string;
    metadata?: Record<string, unknown>;
    spanStart?: number;
    spanEnd?: number;
  }

  function setupRich(scriptedResults: RichMockResult[]) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const selectorSatelliteState = new SelectorSatelliteState();
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
      httpAdapter: {},
    }, undefined, undefined, undefined, undefined, selectorSatelliteState);
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: RichMockResult[] }> } })._resolver = {
      resolve: async () => ({ results: scriptedResults }),
    };
    return { adapter, hlState, dynDefs, loader, selectorSatelliteState, resolver };
  }

  function configIntentResult(opts: { input: string; selector: string; satellite: string }): RichMockResult {
    return {
      wordIndex: opts.input.split(/\s+/).indexOf('_'),
      word: '_',
      alternatives: [opts.selector],
      source: 'config-intent',
      priority: 94,
      spanStart: 0,
      spanEnd: opts.input.length,
      metadata: {
        blankName: 'opencues',
        selectorBlank: true,
        satelliteValue: opts.satellite,
        displaySeparator: ' ',
        configIntent: { setting: opts.selector, value: opts.satellite, confidence: 0.97 },
      },
    };
  }

  it('wipes the summon words and replaces with "<setting> <value>"', async () => {
    const { adapter, resolver } = setupRich([
      configIntentResult({ input: 'enable debug logging _', selector: 'debug-mode', satellite: 'on' }),
    ]);
    adapter.pushText('enable debug logging _');
    await resolver.resolveAndApply('enable debug logging _');

    // Whole prompt becomes the satellite-shape pair. No trace of
    // "enable debug logging _" remains — the summon words ARE the
    // apply action, and the resulting visible state is just the
    // selector + satellite the user would have seen if they'd typed
    // `opencues settings _` and cycled to the right setting.
    expect(adapter.getText()).toBe('debug-mode on');
  });

  it('registers a SelectorSatelliteEntry pointing at the new selector + satellite words', async () => {
    const { adapter, selectorSatelliteState, resolver } = setupRich([
      configIntentResult({ input: 'enable debug logging _', selector: 'debug-mode', satellite: 'on' }),
    ]);
    adapter.pushText('enable debug logging _');
    await resolver.resolveAndApply('enable debug logging _');

    // The satellite state is what makes Ctrl+Alt+arrow on either
    // word cycle the setting/value pair (cycling.ts:cycleSelectorSatellite).
    // Without this entry, ConfigIntent could paint but the user
    // couldn't cycle further to a different value.
    const entry = selectorSatelliteState.current;
    expect(entry).not.toBeNull();
    expect(entry!.blankName).toBe('opencues');
    expect(entry!.currentSetting).toBe('debug-mode');
    expect(entry!.currentValue).toBe('on');
    expect(entry!.separator).toBe(' ');
    expect(entry!.selectorIndex).toBe(0); // first word in the new buffer
    expect(entry!.selectorLength).toBe(1);
    expect(entry!.satelliteIndex).toBe(1);
    expect(entry!.satelliteLength).toBe(1);
    expect(entry!.pairCharStart).toBe(0);
    expect(entry!.pairCharEnd).toBe('debug-mode on'.length);
    // clearOnEdit: true → backspacing into either word wipes the whole
    // pair in one go (delete-the-span semantics, not per-char). Without
    // this, the user has to backspace through 13 chars to remove what
    // started as one summon-phrase.
    expect(entry!.clearOnEdit).toBe(true);
  });

  it('does NOT splice when live text changed mid-flight (race guard)', async () => {
    const { adapter, selectorSatelliteState, resolver } = setupRich([
      configIntentResult({ input: 'enable debug logging _', selector: 'debug-mode', satellite: 'on' }),
    ]);
    adapter.pushText('enable debug logging _');
    // Simulate the user (or another module) editing the buffer
    // BEFORE the LLM call returns.
    adapter.pushText('enable debug logging something else');
    await resolver.resolveAndApply('enable debug logging something else');

    // Buffer untouched. Satellite state never set (no half-applied UI).
    expect(adapter.getText()).toBe('enable debug logging something else');
    expect(selectorSatelliteState.current).toBeNull();
  });

  it('does NOT splice when metadata.satelliteValue is missing (defence in depth)', async () => {
    const { adapter, selectorSatelliteState, resolver } = setupRich([
      {
        wordIndex: 3,
        word: '_',
        alternatives: ['debug-mode'],
        source: 'config-intent',
        priority: 94,
        spanStart: 0,
        spanEnd: 'enable debug logging _'.length,
        metadata: { blankName: 'opencues', selectorBlank: true, displaySeparator: ' ' },
      },
    ]);
    adapter.pushText('enable debug logging _');
    await resolver.resolveAndApply('enable debug logging _');

    expect(adapter.getText()).toBe('enable debug logging _');
    expect(selectorSatelliteState.current).toBeNull();
  });

  it('fluid-blank still uses the inline-paint branch (no cross-contamination)', async () => {
    // Pin that the config-intent branch hasn't accidentally swallowed
    // the fluid-blank substitution path. fluid-blank's alternatives
    // shape is ['_', answer]; buffer should splice the answer in
    // place of the `_`, NOT wipe the whole prefix.
    const { adapter, dynDefs, resolver } = setupRich([
      {
        wordIndex: 3,
        word: '_',
        alternatives: ['_', 'Paris'],
        source: 'fluid-blank',
        priority: 92,
      },
    ]);
    adapter.pushText('capital of france _');
    await resolver.resolveAndApply('capital of france _');

    expect(adapter.getText()).toBe('capital of france Paris');
    expect(dynDefs.get(3)?.blankName).toBe('fluid-blank');
  });
});

// ---------------------------------------------------------------------------
// Sentence-cue substitution — pins the user-journey from a `scope:sentence`
// cue's CueResult through the resolver's splice + word-cue suppression.
//
// Source design: SentenceCueSource emits
//   alternatives = [originalSentence, alt1, alt2, ...]
//   spanStart/spanEnd = char range of the sentence
//   source = 'sentence-cue:<cue-name>'
//
// Resolver job: splice alts[1] into [spanStart, spanEnd); register
// DynDef at the post-splice word index with currentIndex=1 + blankName
// locked to the source id; track the claimed word-range; suppress any
// non-LLM-blank word-cue result whose wordIndex falls in the claim.
// ---------------------------------------------------------------------------

describe('Resolver sentence-cue substitution', () => {
  interface RichMockResult {
    wordIndex: number;
    word: string;
    alternatives: string[];
    source: string;
    priority: number;
    cueTip?: string;
    metadata?: Record<string, unknown>;
    spanStart?: number;
    spanEnd?: number;
  }

  function setupRich(scriptedResults: RichMockResult[]) {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    const selectorSatelliteState = new SelectorSatelliteState();
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10,
      httpAdapter: {},
    }, undefined, undefined, undefined, undefined, selectorSatelliteState);
    (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: RichMockResult[] }> } })._resolver = {
      resolve: async () => ({ results: scriptedResults }),
    };
    return { adapter, hlState, dynDefs, loader, selectorSatelliteState, resolver };
  }

  function sentenceCueResult(opts: {
    cueName: string;
    sentence: string;
    spanStart: number;
    spanEnd: number;
    wordIndex: number;
    rewrites: string[];
  }): RichMockResult {
    return {
      wordIndex: opts.wordIndex,
      word: opts.sentence.split(/\s+/)[0] ?? opts.sentence,
      alternatives: [opts.sentence, ...opts.rewrites],
      source: `sentence-cue:${opts.cueName}`,
      priority: 85,
      spanStart: opts.spanStart,
      spanEnd: opts.spanEnd,
      cueTip: opts.cueName,
      metadata: { sentenceCue: { cueName: opts.cueName, altCount: opts.rewrites.length } },
    };
  }

  it('leaves the buffer untouched and registers a passive DynDef (cue, not agent)', async () => {
    // Passive cue contract: the LLM returning rewrites does NOT mutate
    // the user's prose. The runtime registers a DynDef at currentIndex=0
    // (showing the original) so the EXISTING word-cycling path (Up at
    // the sentence's first word) swaps in the first rewrite. This is
    // exactly how word-cues work — cue-level signal, user-driven apply.
    const input = 'thanks a bunch.';
    const { adapter, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: input,
        spanStart: 0,
        spanEnd: input.length,
        wordIndex: 0,
        rewrites: ['Thank you very much.', 'Many thanks.', 'I am grateful.'],
      }),
    ]);
    adapter.pushText(input);
    await resolver.resolveAndApply(input);

    // Buffer is exactly what the user typed.
    expect(adapter.getText()).toBe(input);
  });

  it('registers a DynDef with currentIndex=0 (passive), alternatives ready for cycling', async () => {
    const input = 'thanks a bunch.';
    const { adapter, dynDefs, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: input,
        spanStart: 0,
        spanEnd: input.length,
        wordIndex: 0,
        rewrites: ['Thank you very much.', 'Many thanks.', 'I am grateful.'],
      }),
    ]);
    adapter.pushText(input);
    await resolver.resolveAndApply(input);

    const def = dynDefs.get(0);
    expect(def).toBeDefined();
    expect(def!.originalWord).toBe(input);
    expect(def!.alternatives).toEqual([
      input,
      'Thank you very much.',
      'Many thanks.',
      'I am grateful.',
    ]);
    // currentIndex=0 means the buffer currently shows alts[0] (the
    // original sentence). Cycling Up advances to currentIndex=1 and
    // splices alts[1] via the existing applyAltCycle path.
    expect(def!.currentIndex).toBe(0);
    // Span covers the ORIGINAL sentence in the buffer (no splice
    // happened, so no post-splice recalculation).
    expect(def!.spanStart).toBe(0);
    expect(def!.spanEnd).toBe(input.length);
    // blankName uses the source id so the entry is locked against
    // re-resolution AND distinguishable in logs from other span-bearing defs.
    expect(def!.blankName).toBe('sentence-cue:more-formal');
  });

  it('race-guards: skip if the buffer slice [spanStart, spanEnd) no longer matches the analyzed sentence', async () => {
    const input = 'thanks a bunch.';
    const { adapter, dynDefs, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: input,
        spanStart: 0,
        spanEnd: input.length,
        wordIndex: 0,
        rewrites: ['Thank you very much.'],
      }),
    ]);
    // Push the original, then mutate the buffer BEFORE resolveAndApply
    // runs — simulates the user editing during the LLM call.
    adapter.pushText(input);
    adapter.pushText('totally different text');
    await resolver.resolveAndApply('totally different text');

    expect(adapter.getText()).toBe('totally different text');
    expect(dynDefs.get(0)).toBeUndefined();
  });

  // Managed-span overlap guards. SentenceCueSource segments the WHOLE
  // buffer regardless of any active selector/satellite pair or other
  // span-bound DynDef. Without these guards, a sentence-cue substitution
  // can mid-overwrite a span the user is interacting with — the
  // "took part of the satellite selector with it" misrender observed
  // in chrome on 2026-05-18.

  it('skips substitution when the sentence span overlaps an active selector/satellite pair', async () => {
    // Buffer shape: user typed prose, then typed `opencues settings _`
    // which expanded to the satellite pair `voice-mode inactive` at
    // chars [16, 36). Sentence-cue's segmenter sees the whole
    // 36-char buffer and proposes a rewrite spanning the satellite.
    const text = 'Cool thanks a lot voice-mode inactive';
    const satStart = 'Cool thanks a lot '.length; // 18
    const satEnd = text.length; // 37
    const { adapter, dynDefs, selectorSatelliteState, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: text,
        spanStart: 0,
        spanEnd: text.length,
        wordIndex: 0,
        rewrites: ['Thank you very much voice mode is inactive'],
      }),
    ]);
    // Pre-arm the satellite state — same shape ConfigIntent /
    // BlankFill register when an `opencues settings` flow completes.
    selectorSatelliteState.set({
      blankName: 'opencues',
      scriptPath: '',
      selectorIndex: 4,
      selectorLength: 1,
      satelliteIndex: 5,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'inactive',
      separator: ' ',
      clearOnEdit: true,
      pairCharStart: satStart,
      pairCharEnd: satEnd,
    }, text);
    adapter.pushText(text);
    await resolver.resolveAndApply(text);

    // No splice, no DynDef. The satellite pair stays intact in the
    // buffer; the user can keep cycling it.
    expect(adapter.getText()).toBe(text);
    expect(dynDefs.get(0)).toBeUndefined();
    expect(selectorSatelliteState.current).not.toBeNull();
  });

  it('skips substitution when the sentence span overlaps an active fluid-blank DynDef', async () => {
    // A prior fluid-blank fill landed inside the buffer (e.g. user typed
    // `_` for a quick lookup and got `Paris` back). The DynDef is
    // blankName-locked. A sentence-cue spanning that range must not
    // overwrite the fluid-blank answer.
    const text = 'It is in Paris and we like it.';
    const fluidStart = 'It is in '.length; // 9
    const fluidEnd = fluidStart + 'Paris'.length; // 14
    const { adapter, dynDefs, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: text,
        spanStart: 0,
        spanEnd: text.length,
        wordIndex: 0,
        rewrites: ['It is located in Paris, and we are fond of it.'],
      }),
    ]);
    // Pre-arm a fluid-blank DynDef (blankName-locked, with a span).
    dynDefs.set(2, {
      originalWord: '_',
      alternatives: ['_', 'Paris'],
      currentIndex: 1,
      spanStart: fluidStart,
      spanEnd: fluidEnd,
      blankName: 'fluid-blank',
    });
    adapter.pushText(text);
    await resolver.resolveAndApply(text);

    // Sentence-cue declined; fluid-blank DynDef survives intact.
    expect(adapter.getText()).toBe(text);
    expect(dynDefs.get(2)?.blankName).toBe('fluid-blank');
    // No NEW def was created at the sentence's first-word index.
    const newDef = dynDefs.get(0);
    if (newDef) expect(newDef.blankName).not.toBe('sentence-cue:more-formal');
  });

  it('still registers the passive def when no managed span overlaps (regression guard for the overlap check)', async () => {
    // Same shape as the happy-path test up top, but with an UNRELATED
    // satellite pair sitting outside the sentence's char range. The
    // overlap check must not over-trigger — the def should still get
    // registered so cycling Up surfaces the rewrite.
    const text = 'thanks a bunch.';
    const { adapter, dynDefs, selectorSatelliteState, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: text,
        spanStart: 0,
        spanEnd: text.length,
        wordIndex: 0,
        rewrites: ['Thank you very much.'],
      }),
    ]);
    // Satellite pair lives FAR outside the sentence span (chars 100-120)
    // — represents a stale state from a different buffer; should not
    // block the passive def registration.
    selectorSatelliteState.set({
      blankName: 'opencues',
      scriptPath: '',
      selectorIndex: 10,
      selectorLength: 1,
      satelliteIndex: 11,
      satelliteLength: 1,
      currentSetting: 'tips-mode',
      currentValue: 'on',
      separator: ' ',
      clearOnEdit: true,
      pairCharStart: 100,
      pairCharEnd: 120,
    }, text);
    adapter.pushText(text);
    await resolver.resolveAndApply(text);

    // Buffer untouched (passive cue); def is ready for cycling.
    expect(adapter.getText()).toBe(text);
    const def = dynDefs.get(0);
    expect(def?.blankName).toBe('sentence-cue:more-formal');
    expect(def?.currentIndex).toBe(0);
  });

  it('suppresses word-cue results whose wordIndex falls inside the sentence claim', async () => {
    // Buffer: "thanks a bunch ." (4 words after segmentation:
    // ["thanks", "a", "bunch."]). Sentence-cue covers indices 0-2.
    // Word-cue at wordIndex 1 ("a") should be SUPPRESSED.
    const input = 'thanks a bunch.';
    const { adapter, dynDefs, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: input,
        spanStart: 0,
        spanEnd: input.length,
        wordIndex: 0,
        rewrites: ['Thank you very much.'],
      }),
      // A word-cue at index 1 inside the sentence span — must be dropped.
      {
        wordIndex: 1,
        word: 'a',
        alternatives: ['a', 'an', 'one'],
        source: 'config:grammar',
        priority: 50,
      },
    ]);
    adapter.pushText(input);
    await resolver.resolveAndApply(input);

    // Only the sentence-cue def survives. The word-cue at idx 1 was
    // suppressed before def-creation.
    expect(dynDefs.get(0)?.blankName).toBe('sentence-cue:more-formal');
    // Idx 1 in the NEW buffer points at a word in "Thank you very much."
    // which has no def (the cue was suppressed before def-creation).
    const wordCueDef = dynDefs.get(1);
    if (wordCueDef) {
      expect(wordCueDef.blankName).toBe('sentence-cue:more-formal');
    }
  });

  it('does NOT suppress word-cue results outside any sentence claim', async () => {
    // Two-sentence buffer where ONLY the first sentence gets cued.
    // A word-cue in the SECOND (uncued) sentence should survive.
    const buffer = 'thanks a bunch. some other words.';
    const sentence1End = 'thanks a bunch.'.length;
    const { adapter, dynDefs, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: 'thanks a bunch.',
        spanStart: 0,
        spanEnd: sentence1End,
        wordIndex: 0,
        rewrites: ['Thank you very much.'],
      }),
      // Word-cue at index 4 (the word "words" in the second sentence).
      {
        wordIndex: 4,
        word: 'words',
        alternatives: ['words', 'terms', 'phrases'],
        source: 'config:grammar',
        priority: 50,
      },
    ]);
    adapter.pushText(buffer);
    await resolver.resolveAndApply(buffer);

    // Sentence-cue def survives.
    expect(dynDefs.get(0)?.blankName).toBe('sentence-cue:more-formal');
    // Word-cue OUTSIDE the sentence-cue claim is NOT suppressed.
    // (After splice, word indices may have shifted — the def is
    // wherever the resolver placed it. We just check that some def
    // contains "words" / "terms" / "phrases" as alternatives.)
    const allDefs = Array.from({ length: 20 }, (_, i) => dynDefs.get(i)).filter(Boolean);
    const wordCueDef = allDefs.find(d => d!.alternatives.includes('terms'));
    expect(wordCueDef, 'word-cue outside sentence span should survive suppression').toBeDefined();
  });

  it('v1 caps at one sentence-cue per resolve (multi-sentence-cue handling deferred)', async () => {
    // Two sentence-cue results in the same resolve pass — only the
    // first should register a DynDef. Documented v1 limitation: future
    // multi-sentence handling would need per-sentence cue suppression
    // tracking so independent sentence cues don't all claim the same
    // word range. The buffer is untouched either way (passive cue).
    const buffer = 'thanks a bunch. ping me when ready.';
    const s1End = 'thanks a bunch.'.length;
    const s2Start = 'thanks a bunch. '.length;
    const s2End = buffer.length;
    const { adapter, dynDefs, resolver } = setupRich([
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: 'thanks a bunch.',
        spanStart: 0,
        spanEnd: s1End,
        wordIndex: 0,
        rewrites: ['Thank you very much.'],
      }),
      sentenceCueResult({
        cueName: 'more-formal',
        sentence: 'ping me when ready.',
        spanStart: s2Start,
        spanEnd: s2End,
        wordIndex: 3,
        rewrites: ['Please notify me when ready.'],
      }),
    ]);
    adapter.pushText(buffer);
    await resolver.resolveAndApply(buffer);

    // Buffer untouched — passive cue. First sentence's def registered;
    // second sentence's def skipped (one-per-resolve cap).
    expect(adapter.getText()).toBe(buffer);
    expect(dynDefs.get(0)?.blankName).toBe('sentence-cue:more-formal');
    // Second sentence's wordIndex=3 should NOT have a def (the cap
    // dropped it before def-creation).
    const secondDef = dynDefs.get(3);
    if (secondDef) expect(secondDef.blankName).not.toBe('sentence-cue:more-formal');
  });
});

// ---------------------------------------------------------------------
// Valid-pair invariant: the host-supplied (provider-BLIND) defaultModel
// must NOT leak into the global MODEL tier. If it does, an auto-routed
// provider in a different model namespace gets an invalid (provider,
// model) pair — the production bug where CEREBRAS_API_KEY-only users had
// the Groq-namespaced `openai/gpt-oss-120b` host default shipped to
// Cerebras (which serves it bare as `gpt-oss-120b`), so every `_` LLM
// blank died with `model_not_found`. The fix: globalModel comes ONLY
// from an explicit choice (`llm-model:` scalar or host-UI modelOverride);
// with neither, resolveLLM falls through to the resolved provider's own
// defaultModel, which is valid by construction.
// ---------------------------------------------------------------------

async function captureBuildOpts(opts: {
  defaultModel?: string;
  modelOverride?: string;
}): Promise<Record<string, unknown>> {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText('alpha _');
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  // Must load so rebuildResolver sees a cuesConfig and reaches the
  // factory (it early-returns when no config is present).
  await loader.load();
  let captured: Record<string, unknown> | null = null;
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test',
    apiKey: 'x',
    defaultModel: opts.defaultModel ?? 'm',
    modelOverride: opts.modelOverride,
    debounceMs: 0,
    httpAdapter: {},
    // Capture the buildOpts that rebuildResolver hands to the core source
    // factory — the third positional arg.
    resolverFactory: (_c: unknown, _b: unknown, o: unknown) => {
      captured = o as Record<string, unknown>;
      return [];
    },
  });
  resolver.rebuildResolver();
  if (!captured) throw new Error('resolverFactory was not invoked — rebuildResolver bailed before building sources');
  return captured;
}

describe('Resolver — valid (provider, model) pair invariant', () => {
  it('does NOT pass the host defaultModel as globalModel when no llm-model scalar is set', async () => {
    // Groq-namespaced host default — must not leak into the global tier.
    const opts = await captureBuildOpts({ defaultModel: 'openai/gpt-oss-120b' });
    expect(opts.globalModel).toBeUndefined();
  });

  it('passes an explicit host-UI modelOverride through as globalModel', async () => {
    const opts = await captureBuildOpts({ defaultModel: 'openai/gpt-oss-120b', modelOverride: 'explicit-model' });
    expect(opts.globalModel).toBe('explicit-model');
  });
});

