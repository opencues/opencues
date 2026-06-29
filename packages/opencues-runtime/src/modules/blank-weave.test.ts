import { describe, it, expect } from 'vitest';
import { buildBlankWeaver, WEAVE_VALUE_TOKEN } from './blank-weave';
import type { ConfigLoader } from './config-loader';

// Minimal ConfigLoader stub — the weaver only reads opencuesState.settings.get
// + opencuesState.blanksLlmProvider.
function fakeConfigLoader(overrides: Record<string, string> = {}): ConfigLoader {
  const settings = new Map<string, string>([['llm-provider', 'groq'], ...Object.entries(overrides)]);
  return {
    opencuesState: {
      settings: { get: (k: string) => settings.get(k), has: (k: string) => settings.has(k) },
      blanksLlmProvider: 'inherit',
    },
  } as unknown as ConfigLoader;
}

// Fake http adapter returning a canned OpenAI-compat chat response.
function fakeHttp(content: string) {
  return {
    post: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  } as unknown as import('@opencues/core').HttpAdapterShape;
}

const KEYS = () => ({ GROQ_API_KEY: 'test-key' });

describe('blank-weave — runtime contract (value never reaches the LLM)', () => {
  it('returns the woven phrase with the token still present — the value swap is the CALLER\'s job', async () => {
    const weave = buildBlankWeaver(fakeConfigLoader(), KEYS, fakeHttp(`right now it's ${WEAVE_VALUE_TOKEN} out there`));
    const out = await weave({ exemplar: "it's currently {value}", priorContext: 'Planning a trip to Oslo.' });
    expect(out).toBe(`right now it's ${WEAVE_VALUE_TOKEN} out there`);
    // Critical: the woven text still carries the TOKEN, not a value. BlankFill
    // splices the real value in afterward — so the value never went on the wire.
    expect(out).toContain(WEAVE_VALUE_TOKEN);
  });

  it('falls back to static (null) when the model DROPPED the token', async () => {
    const weave = buildBlankWeaver(fakeConfigLoader(), KEYS, fakeHttp("right now it's 22C out there"));
    expect(await weave({ exemplar: "it's currently {value}", priorContext: '' })).toBeNull();
  });

  it('falls back to static (null) when the model DUPLICATED the token', async () => {
    const weave = buildBlankWeaver(fakeConfigLoader(), KEYS, fakeHttp(`${WEAVE_VALUE_TOKEN} and again ${WEAVE_VALUE_TOKEN}`));
    expect(await weave({ exemplar: '{value}', priorContext: '' })).toBeNull();
  });

  it('returns null when the exemplar has no {value} slot — nothing to anchor the swap', async () => {
    const weave = buildBlankWeaver(fakeConfigLoader(), KEYS, fakeHttp(`x ${WEAVE_VALUE_TOKEN}`));
    expect(await weave({ exemplar: 'no slot here', priorContext: '' })).toBeNull();
  });

  it('returns null (static) when no API key resolves — value never at risk', async () => {
    const weave = buildBlankWeaver(fakeConfigLoader(), () => ({}), fakeHttp(`x ${WEAVE_VALUE_TOKEN}`));
    expect(await weave({ exemplar: '{value}', priorContext: '' })).toBeNull();
  });

  it('returns null (static) when the model added no connective text (bare token)', async () => {
    const weave = buildBlankWeaver(fakeConfigLoader(), KEYS, fakeHttp(WEAVE_VALUE_TOKEN));
    expect(await weave({ exemplar: '{value}', priorContext: '' })).toBeNull();
  });

  it('strips a wrapping quote the model may add around the phrase', async () => {
    const weave = buildBlankWeaver(fakeConfigLoader(), KEYS, fakeHttp(`"it's ${WEAVE_VALUE_TOKEN} now"`));
    expect(await weave({ exemplar: '{value}', priorContext: '' })).toBe(`it's ${WEAVE_VALUE_TOKEN} now`);
  });

  it('falls back to static (null) when the http adapter throws — never blocks/corrupts', async () => {
    const throwingHttp = { post: async () => { throw new Error('network down'); } } as unknown as import('@opencues/core').HttpAdapterShape;
    const weave = buildBlankWeaver(fakeConfigLoader(), KEYS, throwingHttp);
    expect(await weave({ exemplar: '{value}', priorContext: '' })).toBeNull();
  });
});
