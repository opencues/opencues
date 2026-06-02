import { describe, expect, it } from 'vitest';
import { modelRejectsTemperature, modelRejectsReasoningEffort, getProvider, type ChatRequest } from './llm-provider';

// Anthropic deprecated `temperature` on every Claude 4.x model in June 2026
// (verified live against the user's claude-opus-4-7 key on 2026-06-02:
// "anthropic error: `temperature` is deprecated for this model").
// `modelRejectsTemperature` is the single source of truth. Both the Anthropic
// adapter and `buildOpenAIBody` (used by Groq/OpenAI/OpenRouter/Cerebras)
// consult it. These pins guarantee both call sites stay in agreement and that
// a future provider/model entry covers every wire-shape variant the runtime
// emits.

describe('modelRejectsTemperature — capability matrix', () => {
  describe('rejects (must skip the field)', () => {
    it('anthropic + claude-opus-4-7', () => {
      expect(modelRejectsTemperature('anthropic', 'claude-opus-4-7')).toBe(true);
    });
    it('anthropic + claude-sonnet-4-6', () => {
      expect(modelRejectsTemperature('anthropic', 'claude-sonnet-4-6')).toBe(true);
    });
    it('anthropic + claude-haiku-4-5-20251001 (dated suffix)', () => {
      expect(modelRejectsTemperature('anthropic', 'claude-haiku-4-5-20251001')).toBe(true);
    });
    it('openrouter + anthropic/claude-opus-4-7 (passthrough)', () => {
      expect(modelRejectsTemperature('openrouter', 'anthropic/claude-opus-4-7')).toBe(true);
    });
    it('openrouter + anthropic/claude-haiku-4-5 (passthrough)', () => {
      expect(modelRejectsTemperature('openrouter', 'anthropic/claude-haiku-4-5')).toBe(true);
    });
  });

  describe('accepts (must include the field)', () => {
    it('groq + gpt-oss-120b', () => {
      expect(modelRejectsTemperature('groq', 'openai/gpt-oss-120b')).toBe(false);
    });
    it('cerebras + gpt-oss-120b', () => {
      expect(modelRejectsTemperature('cerebras', 'gpt-oss-120b')).toBe(false);
    });
    it('gemini + gemini-3.1-flash-lite', () => {
      expect(modelRejectsTemperature('gemini', 'gemini-3.1-flash-lite')).toBe(false);
    });
    it('openrouter + openai/gpt-oss-120b:free (NON-anthropic passthrough)', () => {
      expect(modelRejectsTemperature('openrouter', 'openai/gpt-oss-120b:free')).toBe(false);
    });
    it('anthropic + claude-3-opus (legacy 3.x family, pre-deprecation)', () => {
      // Hypothetical regression guard: if a user pins a 3.x model from
      // before June 2026, temperature still works. The pattern is anchored
      // to `4` so 3.x doesn't match.
      expect(modelRejectsTemperature('anthropic', 'claude-3-opus-20240229')).toBe(false);
    });
  });
});

describe('Anthropic buildRequest — temperature omission', () => {
  // The Anthropic adapter rebuilds the body inline (not via buildOpenAIBody).
  // Pin BOTH directions: temperature is included for legacy models, omitted
  // for Claude 4.x. A 400 from the API would silently kill every blank that
  // routes to anthropic; this test catches it before deployment.
  const anthropic = getProvider('anthropic')!;

  function buildAndParse(model: string, temperature: number | undefined): Record<string, unknown> {
    const req: ChatRequest = {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      temperature,
    };
    const built = anthropic.buildRequest(req, { apiKey: 'sk-test', endpoint: undefined });
    return JSON.parse(built.body);
  }

  it('omits temperature for claude-opus-4-7 even when caller passes 0', () => {
    const body = buildAndParse('claude-opus-4-7', 0);
    expect('temperature' in body).toBe(false);
  });

  it('omits temperature for claude-haiku-4-5-20251001', () => {
    const body = buildAndParse('claude-haiku-4-5-20251001', 0.5);
    expect('temperature' in body).toBe(false);
  });

  it('includes temperature for legacy claude-3-opus (regression guard)', () => {
    const body = buildAndParse('claude-3-opus-20240229', 0.3);
    expect(body.temperature).toBe(0.3);
  });

  it('omits temperature when caller passes undefined regardless of model', () => {
    expect('temperature' in buildAndParse('claude-opus-4-7', undefined)).toBe(false);
    expect('temperature' in buildAndParse('claude-3-opus-20240229', undefined)).toBe(false);
  });
});

describe('modelRejectsReasoningEffort — capability matrix', () => {
  describe('rejects (must skip the field)', () => {
    it('groq + llama-3.3-70b-versatile', () => {
      // Live-verified 2026-06-02: Groq returned HTTP 400
      // "`reasoning_effort` is not supported with this model".
      expect(modelRejectsReasoningEffort('groq', 'llama-3.3-70b-versatile')).toBe(true);
    });
    it('groq + llama-3.1-8b-instant (regression guard — other llamas too)', () => {
      expect(modelRejectsReasoningEffort('groq', 'llama-3.1-8b-instant')).toBe(true);
    });
  });

  describe('accepts (must include the field)', () => {
    it('groq + openai/gpt-oss-120b', () => {
      // gpt-oss models REQUIRE reasoning_effort on Groq.
      expect(modelRejectsReasoningEffort('groq', 'openai/gpt-oss-120b')).toBe(false);
    });
    it('cerebras + gpt-oss-120b', () => {
      expect(modelRejectsReasoningEffort('cerebras', 'gpt-oss-120b')).toBe(false);
    });
    it('openai + gpt-5.4-mini', () => {
      expect(modelRejectsReasoningEffort('openai', 'gpt-5.4-mini')).toBe(false);
    });
  });
});

describe('Groq buildRequest — llama models omit reasoning_effort', () => {
  const groq = getProvider('groq')!;

  function buildAndParse(model: string): Record<string, unknown> {
    const req: ChatRequest = {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'low',
    };
    const built = groq.buildRequest(req, { apiKey: 'sk-test', endpoint: undefined });
    return JSON.parse(built.body);
  }

  it('omits reasoning_effort for llama-3.3-70b-versatile', () => {
    const body = buildAndParse('llama-3.3-70b-versatile');
    expect('reasoning_effort' in body).toBe(false);
  });

  it('includes reasoning_effort for openai/gpt-oss-120b', () => {
    const body = buildAndParse('openai/gpt-oss-120b');
    expect(body.reasoning_effort).toBe('low');
  });

  it('includes reasoning_effort for openai/gpt-oss-20b', () => {
    const body = buildAndParse('openai/gpt-oss-20b');
    expect(body.reasoning_effort).toBe('low');
  });
});

describe('OpenRouter buildRequest — Anthropic passthrough temperature omission', () => {
  const openrouter = getProvider('openrouter')!;

  function buildAndParse(model: string, temperature: number | undefined): Record<string, unknown> {
    const req: ChatRequest = {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      temperature,
    };
    const built = openrouter.buildRequest(req, { apiKey: 'sk-test', endpoint: undefined });
    return JSON.parse(built.body);
  }

  it('omits temperature for anthropic/claude-opus-4-7 via OpenRouter', () => {
    const body = buildAndParse('anthropic/claude-opus-4-7', 0);
    expect('temperature' in body).toBe(false);
  });

  it('includes temperature for openai/gpt-oss-120b:free via OpenRouter (non-Anthropic)', () => {
    const body = buildAndParse('openai/gpt-oss-120b:free', 0.7);
    expect(body.temperature).toBe(0.7);
  });
});
