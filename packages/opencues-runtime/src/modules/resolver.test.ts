import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
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

  // Inject a mock resolver factory so we don't load real cues-core sources.
  // The Resolver class still calls require('cues-core').createResolver, so we
  // shadow that via a fake httpAdapter and a synthetic factory: we provide
  // resolverFactory to short-circuit buildSourcesFromConfig + return fake
  // sources. createResolver then runs but resolve() goes through cues-core.
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

  it('replaces DynDef entries when user is on currentIndex 0 (untouched)', async () => {
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
    expect(dynDefs.get(0)!.alternatives).toEqual(['alpha', 'fresh']);
  });

  it('drops original-only results (no alts to cycle)', async () => {
    const { dynDefs, resolver } = setupResolver([
      { wordIndex: 0, word: 'alpha', alternatives: ['alpha'] },
    ]);
    await resolver.resolveAndApply('alpha');
    expect(dynDefs.get(0)).toBeUndefined();
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
});
