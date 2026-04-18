import { describe, it, expect, vi } from 'vitest';
import { AnswerControl } from './answer';

function llmFetch(content: string, opts: { ok?: boolean; reasoning?: string } = {}): typeof fetch {
  return vi.fn(async () => ({
    ok: opts.ok ?? true,
    json: async () => ({
      choices: [{ message: { content, reasoning: opts.reasoning } }],
    }),
  } as Response)) as unknown as typeof fetch;
}

describe('AnswerControl', () => {
  it('returns "" when no apiKey is supplied', async () => {
    const ctl = new AnswerControl({ fetchFn: llmFetch('ignored') });
    expect(await ctl.get('what is', ['the capital of Japan'])).toBe('');
  });

  it('returns "" when context is empty', async () => {
    const ctl = new AnswerControl({ apiKey: 'k', fetchFn: llmFetch('ignored') });
    expect(await ctl.get('what is', [])).toBe('');
    expect(await ctl.get('what is', undefined)).toBe('');
  });

  it('returns the LLM response trimmed (multi-line for cycling)', async () => {
    const fetchFn = llmFetch('Tokyo\nTōkyō\n東京\n');
    const ctl = new AnswerControl({ apiKey: 'k', fetchFn });
    expect(await ctl.get('what is', ['the capital of Japan'])).toBe('Tokyo\nTōkyō\n東京');
  });

  it("posts a Q: <keyword> <context> user message to the configured endpoint", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'x' } }] }),
    } as Response)) as unknown as typeof fetch;
    const ctl = new AnswerControl({ apiKey: 'kk', apiUrl: 'https://example/v1', model: 'm-1', fetchFn });
    await ctl.get('translate', ['hello', 'to', 'French']);
    const calls = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls[0][0]).toBe('https://example/v1');
    const init = calls[0][1];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('m-1');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Q: translate hello to French' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer kk');
  });

  it('falls back to choice.message.reasoning when content is missing', async () => {
    const fetchFn = llmFetch('', { reasoning: 'fallback answer' });
    const ctl = new AnswerControl({ apiKey: 'k', fetchFn });
    expect(await ctl.get('q', ['ctx'])).toBe('fallback answer');
  });

  it('returns "" on HTTP non-ok', async () => {
    const fetchFn = llmFetch('ignored', { ok: false });
    const ctl = new AnswerControl({ apiKey: 'k', fetchFn });
    expect(await ctl.get('q', ['ctx'])).toBe('');
  });

  it('returns "" on fetch throw', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const ctl = new AnswerControl({ apiKey: 'k', fetchFn });
    expect(await ctl.get('q', ['ctx'])).toBe('');
  });
});
