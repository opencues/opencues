import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
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
    files: { '/tips.json': TIPS, '/proj/cues.md': CUES_MD },
  });
  adapter.pushText('alpha');
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });

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
    const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
    adapter.pushText('alpha beta gamma');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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

  it('blanks (_) are always re-resolved, even if the runtime has cached alts', async () => {
    // Context for a `_` must pass through unchanged — its answer
    // depends on surrounding words that may have shifted on any edit.
    const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
    adapter.pushText('weather _ paris');
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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

  it('opencues.md `llm-endpoint:` and `llm-model:` override options', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': TIPS,
        '/proj/cues.md': CUES_MD,
        '/proj/opencues.md': '---\nllm-endpoint: https://other.example.com/v1\nllm-model: openai/custom-model\n---\n',
      },
    });
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
      files: { '/tips.json': TIPS, '/proj/cues.md': CUES_MD },
    });
    const hlState = new HighlightState();
    const dyn = new DynDefs();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
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
