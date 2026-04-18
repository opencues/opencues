import { describe, it, expect, vi } from 'vitest';
import { PromptImproverControl } from './prompt-improver';

interface ScriptedResponses { extract: string; transform: string }

function llmFetch(scripted: ScriptedResponses): typeof fetch {
  let calls = 0;
  return vi.fn(async () => {
    const content = calls === 0 ? scripted.extract : scripted.transform;
    calls += 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('PromptImproverControl', () => {
  it('returns "" when context is empty', async () => {
    const ctl = new PromptImproverControl({ apiKey: 'k', fetchFn: llmFetch({ extract: '', transform: '' }) });
    expect(await ctl.get('improve prompt', [])).toBe('');
    expect(await ctl.get('improve prompt', undefined)).toBe('');
  });

  it('returns the original context when apiKey is missing', async () => {
    const ctl = new PromptImproverControl({ fetchFn: llmFetch({ extract: '{}', transform: 'a\nb\nc' }) });
    expect(await ctl.get('improve prompt', ['write', 'a', 'haiku'])).toBe('write a haiku');
  });

  it('two-step pipeline: extract → transform → 3 alts joined by \\n', async () => {
    const fetchFn = llmFetch({
      extract: '{"prompt":"write a haiku","conditions":""}',
      transform: 'Compose a 5-7-5 haiku about autumn\nWrite a haiku capturing one specific moment\nDraft a haiku in classical Japanese form',
    });
    const ctl = new PromptImproverControl({ apiKey: 'k', includeOriginal: false, fetchFn });
    const out = await ctl.get('improve prompt', ['write', 'a', 'haiku']);
    expect(out.split('\n')).toEqual([
      'Compose a 5-7-5 haiku about autumn',
      'Write a haiku capturing one specific moment',
      'Draft a haiku in classical Japanese form',
    ]);
  });

  it('appends the original prompt when includeOriginal=true (default)', async () => {
    const fetchFn = llmFetch({
      extract: '{"prompt":"write code","conditions":""}',
      transform: 'A\nB\nC',
    });
    const ctl = new PromptImproverControl({ apiKey: 'k', fetchFn });
    const out = await ctl.get('improve prompt', ['write', 'code']);
    expect(out.split('\n')).toEqual(['A', 'B', 'C', 'write code']);
  });

  it('strips ```json code fences from the extract response', async () => {
    const fetchFn = llmFetch({
      extract: '```json\n{"prompt":"x","conditions":""}\n```',
      transform: 'a\nb\nc',
    });
    const ctl = new PromptImproverControl({ apiKey: 'k', includeOriginal: false, fetchFn });
    expect((await ctl.get('improve prompt', ['x'])).split('\n')).toEqual(['a', 'b', 'c']);
  });

  it('falls back to keyword-stripped context when extract JSON is malformed', async () => {
    const fetchFn = llmFetch({
      extract: 'not json at all',
      transform: 'A\nB\nC',
    });
    const ctl = new PromptImproverControl({ apiKey: 'k', includeOriginal: false, fetchFn });
    const out = await ctl.get('improve prompt', ['improve', 'prompt', 'write', 'code']);
    // Extract fallback strips activation keywords from "improve prompt write code".
    expect(out.split('\n')).toEqual(['A', 'B', 'C']);
  });

  it('strips numbering / bullet prefixes from transform output', async () => {
    const fetchFn = llmFetch({
      extract: '{"prompt":"x","conditions":""}',
      transform: '1. First\n2) Second\n- Third\n* Fourth',
    });
    const ctl = new PromptImproverControl({ apiKey: 'k', altCount: 4, includeOriginal: false, fetchFn });
    expect((await ctl.get('improve prompt', ['x'])).split('\n')).toEqual([
      'First', 'Second', 'Third', 'Fourth',
    ]);
  });

  it('returns the full context when transform produces fewer than 2 alts', async () => {
    const fetchFn = llmFetch({
      extract: '{"prompt":"x","conditions":""}',
      transform: 'only one line',
    });
    const ctl = new PromptImproverControl({ apiKey: 'k', fetchFn });
    expect(await ctl.get('improve prompt', ['x'])).toBe('x');
  });

  it('returns the full context on LLM throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const ctl = new PromptImproverControl({ apiKey: 'k', fetchFn });
    expect(await ctl.get('improve prompt', ['ctx'])).toBe('ctx');
  });

  it('honours altCount limit in transform parsing', async () => {
    const fetchFn = llmFetch({
      extract: '{"prompt":"x","conditions":""}',
      transform: 'a\nb\nc\nd\ne',
    });
    const ctl = new PromptImproverControl({ apiKey: 'k', altCount: 2, includeOriginal: false, fetchFn });
    expect((await ctl.get('improve prompt', ['x'])).split('\n')).toEqual(['a', 'b']);
  });
});
