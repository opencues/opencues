import { describe, expect, it } from 'vitest';
import { normalizeUsage } from './llm-provider';

describe('normalizeUsage — one shape from the three wire formats that carry usage', () => {
  it('openai-compatible: usage.prompt_tokens (+ cached prefix + prediction details)', () => {
    expect(normalizeUsage({ usage: { prompt_tokens: 2984, completion_tokens: 148, prompt_tokens_details: { cached_tokens: 2560 }, completion_tokens_details: { accepted_prediction_tokens: 3, rejected_prediction_tokens: 1 } } }))
      .toEqual({ promptTokens: 2984, completionTokens: 148, cachedTokens: 2560, acceptedPredictionTokens: 3, rejectedPredictionTokens: 1 });
  });
  it('gemini: usageMetadata, thoughts billed as output, cachedContent as the cache read', () => {
    expect(normalizeUsage({ usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 40, thoughtsTokenCount: 200, cachedContentTokenCount: 2500 } }))
      .toEqual({ promptTokens: 3000, completionTokens: 240, cachedTokens: 2500, acceptedPredictionTokens: 0, rejectedPredictionTokens: 0 });
    expect(normalizeUsage({ usageMetadata: { promptTokenCount: 10 } })).toMatchObject({ promptTokens: 10, completionTokens: 0, cachedTokens: 0 });
  });
  it('anthropic: input_tokens excludes the cache read, so the meter adds it back', () => {
    expect(normalizeUsage({ usage: { input_tokens: 400, output_tokens: 60, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 } }))
      .toEqual({ promptTokens: 2900, completionTokens: 60, cachedTokens: 2500, acceptedPredictionTokens: 0, rejectedPredictionTokens: 0 });
  });
  it('no usage block → undefined (never a zero row)', () => {
    expect(normalizeUsage({ choices: [] })).toBeUndefined();
    expect(normalizeUsage(null)).toBeUndefined();
    expect(normalizeUsage({ usage: {} })).toBeUndefined();
  });
});
