import { describe, expect, it } from 'vitest';
import { getProvider, type ChatRequest } from './llm-provider';

// Pin the `max-thinking` wire behaviour end-to-end: ctx.maxThinking flows
// through each OpenAI-compatible provider's buildRequest → buildOpenAIBody →
// model-thinking.ts's resolveReasoningEffort and lands as `reasoning_effort`
// in the request body. These guard the contract that:
//   - ON  (default) reproduces each provider's pre-feature default level
//   - OFF drops each model to its reduced level
//   - an explicit per-call value still wins (clamped to the ceiling)
//   - non-reasoning providers never emit the field

function reasoningOf(providerId: string, model: string, opts: { maxThinking?: boolean; explicit?: ChatRequest['reasoningEffort'] }): unknown {
  const provider = getProvider(providerId)!;
  const req: ChatRequest = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 256,
    reasoningEffort: opts.explicit,
  };
  const built = provider.buildRequest(req, { apiKey: 'sk-test', endpoint: undefined, maxThinking: opts.maxThinking });
  return (JSON.parse(built.body) as Record<string, unknown>).reasoning_effort;
}

describe('max-thinking → reasoning_effort wire body', () => {
  describe('cerebras gpt-oss-120b (ceiling medium, reduced low)', () => {
    it('ON → medium (= prior default)', () => {
      expect(reasoningOf('cerebras', 'gpt-oss-120b', { maxThinking: true })).toBe('medium');
    });
    it('omitted toggle defaults to ON → medium', () => {
      expect(reasoningOf('cerebras', 'gpt-oss-120b', {})).toBe('medium');
    });
    it('OFF → low', () => {
      expect(reasoningOf('cerebras', 'gpt-oss-120b', { maxThinking: false })).toBe('low');
    });
    it('explicit low wins under ON (clamped, unchanged)', () => {
      expect(reasoningOf('cerebras', 'gpt-oss-120b', { maxThinking: true, explicit: 'low' })).toBe('low');
    });
    it('explicit high clamps DOWN to the medium ceiling', () => {
      expect(reasoningOf('cerebras', 'gpt-oss-120b', { maxThinking: true, explicit: 'high' })).toBe('medium');
    });
  });

  describe('groq gpt-oss-120b (ceiling low, floor low — wire rejects "none")', () => {
    it('ON → low', () => {
      expect(reasoningOf('groq', 'openai/gpt-oss-120b', { maxThinking: true })).toBe('low');
    });
    // groq returns HTTP 400 ("reasoning_effort must be one of `low`,
    // `medium`, or `high`") when sent 'none'. The table pins both
    // levels at 'low' so the toggle is a no-op — but more importantly
    // never produces a broken request.
    it('OFF → low (groq hard-rejects "none"; floor is the toggle target)', () => {
      expect(reasoningOf('groq', 'openai/gpt-oss-120b', { maxThinking: false })).toBe('low');
    });
  });

  describe('openai gpt-5.4-mini (ceiling low, reduced none)', () => {
    it('ON → low', () => {
      expect(reasoningOf('openai', 'gpt-5.4-mini', { maxThinking: true })).toBe('low');
    });
    it('OFF → none', () => {
      expect(reasoningOf('openai', 'gpt-5.4-mini', { maxThinking: false })).toBe('none');
    });
  });

  describe('non-reasoning providers never emit reasoning_effort', () => {
    it('gemini omits it regardless of toggle', () => {
      // Gemini uses a different wire shape entirely — assert the field is
      // simply absent from the parsed body.
      const provider = getProvider('gemini')!;
      const built = provider.buildRequest(
        { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256 },
        { apiKey: 'sk-test', maxThinking: false },
      );
      expect('reasoning_effort' in (JSON.parse(built.body) as Record<string, unknown>)).toBe(false);
    });
  });
});
