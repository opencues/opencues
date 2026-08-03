import { describe, it, expect } from 'vitest';
import { ToolPromptCueSource, parseToolQuestion } from './tool-prompt-source';
import { getProvider } from '../llm-provider';
import type { CueContext, HttpAdapter } from '../types';

function mock(content: string): HttpAdapter {
  return { post: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
}
function ctx(text: string): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean), cursor: text.length };
}
const base = { provider: getProvider('groq')!, endpoint: 'https://x.test/v1/chat/completions', apiKey: 'k', model: 'm' };

describe('parseToolQuestion', () => {
  it('parses a well-formed AQT object, tolerating fences', () => {
    const q = parseToolQuestion('```json\n{"header":"Tone","question":"Formal or casual?","options":[{"label":"Formal","description":"stiffer","apply":"We request..."},{"label":"Casual"}]}\n```');
    expect(q?.header).toBe('Tone');
    expect(q?.question).toBe('Formal or casual?');
    expect(q?.options).toHaveLength(2);
    expect(q?.options[0].apply).toBe('We request...');
    expect(q?.options[1].apply).toBeUndefined();
  });
  it('drops options without a label; returns null without a question', () => {
    expect(parseToolQuestion('{"question":"Q?","options":[{"description":"no label"},{"label":"Ok"}]}')?.options).toHaveLength(1);
    expect(parseToolQuestion('{"options":[]}')).toBeNull();
    expect(parseToolQuestion('nope')).toBeNull();
  });
});

describe('ToolPromptCueSource', () => {
  const aqt = JSON.stringify({
    header: 'Evidence',
    question: 'Substantiate the claim or qualify it?',
    options: [
      { label: 'Add data', description: 'back it with numbers', apply: 'The API is 2x faster.' },
      { label: 'Qualify', description: 'soften it', apply: 'The API is generally faster.' },
      { label: 'Keep as is', description: 'no change' },
    ],
  });

  it('maps question → tip and apply-bearing options → cycle alternatives', async () => {
    const src = new ToolPromptCueSource({ ...base, httpAdapter: mock(aqt) });
    const buffer = 'The API is faster.';
    const res = await src.getCues(ctx(buffer));
    expect(res.results).toHaveLength(1);
    const r = res.results[0]!;
    expect(r.source).toBe('sentence-cue:tool-ask');
    expect(r.cueTip).toBe('❓ Evidence: Substantiate the claim or qualify it?');
    // alternatives[0] is the exact span; only the two apply-bearing options cycle.
    expect(r.alternatives[0]).toBe(buffer);
    expect(buffer.slice(r.spanStart!, r.spanEnd!)).toBe(buffer);
    expect(r.alternatives).toEqual([buffer, 'The API is 2x faster.', 'The API is generally faster.']);
    // Full option set (incl. advisory) preserved in metadata for a richer renderer.
    expect((r.metadata?.toolQuestion as { options: unknown[] }).options).toHaveLength(3);
  });

  it('caches per sentence — a second resolve on the same selection makes no new call', async () => {
    let calls = 0;
    const counting: HttpAdapter = { post: async () => { calls++; return JSON.stringify({ choices: [{ message: { content: aqt } }] }); } };
    const src = new ToolPromptCueSource({ ...base, httpAdapter: counting });
    await src.getCues(ctx('The API is faster.'));
    await src.getCues(ctx('The API is faster.'));
    expect(calls).toBe(1);
  });

  it('never throws when the LLM call fails', async () => {
    const src = new ToolPromptCueSource({ ...base, httpAdapter: { post: async () => { throw new Error('down'); } } });
    expect((await src.getCues(ctx('hello world.'))).results).toEqual([]);
  });
});
