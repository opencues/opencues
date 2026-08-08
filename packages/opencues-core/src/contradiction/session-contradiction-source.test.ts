import { describe, it, expect } from 'vitest';
import { SessionContradictionSource, parseFlags } from './session-contradiction-source';
import { getProvider } from '../llm-provider';
import type { CueContext, HttpAdapter } from '../types';

function makeMockAdapter(content: string): HttpAdapter {
  return { post: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
}

const WATCHLIST: CueContext['sessionCommitments'] = {
  commitments: [
    { id: 'c1', category: 'stack', statement: 'Runtime is Bun, not Node' },
    { id: 'c2', category: 'constraint', statement: 'Do not add new npm dependencies' },
  ],
  ingestedAt: '2026-08-03T00:00:00Z',
};

function ctx(text: string, snapshot = WATCHLIST): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean), sessionCommitments: snapshot };
}

const baseConfig = {
  provider: getProvider('groq')!,
  endpoint: 'https://example.test/v1/chat/completions',
  apiKey: 'test-key',
  model: 'test-model',
};

describe('SessionContradictionSource.supports', () => {
  it('needs a non-empty buffer AND a non-empty watchlist', () => {
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: makeMockAdapter('[]') });
    expect(src.supports(ctx('add a redis dependency'))).toBe(true);
    expect(src.supports(ctx('   '))).toBe(false);
    expect(src.supports(ctx('add a redis dependency', { commitments: [] }))).toBe(false);
    expect(src.supports({ text: 'x', words: ['x'] })).toBe(false); // no snapshot
  });
});

describe('SessionContradictionSource.getCues', () => {
  it('emits a passive sentence-cue for a grounded, well-cited flag', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: "let's add the redis npm package", commitmentId: 'c2', tip: 'no new npm deps', reconciled: "let's use a built-in instead of the redis npm package" },
      ])),
    });
    const buffer = "let's add the redis npm package for caching";
    const res = await src.getCues(ctx(buffer));
    expect(res.results).toHaveLength(1);
    const r = res.results[0]!;
    expect(r.source).toBe('sentence-cue:session-contradiction');
    expect(r.priority).toBe(88);
    // alternatives[0] is the exact buffer substring (resolver race-guard needs this)
    expect(r.alternatives[0]).toBe("let's add the redis npm package");
    expect(buffer.slice(r.spanStart!, r.spanEnd!)).toBe(r.alternatives[0]);
    expect(r.alternatives[1]).toContain('built-in');
    expect(r.cueTip).toBe('⚠ no new npm deps');
    expect((r.metadata?.sentenceCue as { cueName?: string })?.cueName).toBe('session-contradiction');
  });

  it('DROPS a flag citing an unknown commitment id (grounding 2)', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: 'add the redis package', commitmentId: 'c99', tip: 'x' },
      ])),
    });
    const res = await src.getCues(ctx('add the redis package now'));
    expect(res.results).toHaveLength(0);
  });

  it('DROPS a flag whose quote is not a verbatim substring (grounding 1)', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: 'add the REDIS PACKAGE', commitmentId: 'c2', tip: 'x' }, // case-changed → not a substring
      ])),
    });
    const res = await src.getCues(ctx('add the redis package now'));
    expect(res.results).toHaveLength(0);
  });

  it('returns nothing when the LLM finds no contradiction', async () => {
    const src = new SessionContradictionSource({ ...baseConfig, httpAdapter: makeMockAdapter('[]') });
    const res = await src.getCues(ctx('now write the tests'));
    expect(res.results).toHaveLength(0);
  });

  it('never throws / never wipes the buffer when the LLM call fails', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: { post: async () => { throw new Error('network down'); } },
    });
    const res = await src.getCues(ctx('add the redis package'));
    expect(res.results).toEqual([]);
  });

  it('reconciled falls back to the quote when omitted', async () => {
    const src = new SessionContradictionSource({
      ...baseConfig,
      httpAdapter: makeMockAdapter(JSON.stringify([
        { quote: 'switch to node', commitmentId: 'c1' },
      ])),
    });
    const res = await src.getCues(ctx('please switch to node for this'));
    expect(res.results[0]!.alternatives).toEqual(['switch to node', 'switch to node']);
    expect(res.results[0]!.cueTip).toBe('⚠ contradicts an earlier decision');
  });
});

describe('parseFlags', () => {
  it('tolerates prose / fences around the array', () => {
    expect(parseFlags('here you go:\n```json\n[{"quote":"x","commitmentId":"c1"}]\n```')).toEqual([
      { quote: 'x', commitmentId: 'c1' },
    ]);
    expect(parseFlags('no array here')).toEqual([]);
    expect(parseFlags('')).toEqual([]);
  });
});
