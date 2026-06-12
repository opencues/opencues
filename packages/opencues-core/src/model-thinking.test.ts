import { describe, it, expect } from 'vitest';
import { resolveReasoningEffort, lookupModelThinking } from './model-thinking';

describe('model-thinking: lookupModelThinking', () => {
  it('returns the explicit table entry for a verified model', () => {
    expect(lookupModelThinking('cerebras', 'gpt-oss-120b')).toEqual({ max: 'medium', off: 'low' });
    expect(lookupModelThinking('groq', 'openai/gpt-oss-120b')).toEqual({ max: 'low', off: 'none' });
    expect(lookupModelThinking('openai', 'gpt-5.4-mini')).toEqual({ max: 'low', off: 'none' });
  });

  it('derives from providerDefault for an unknown model (max = default, off one notch below)', () => {
    expect(lookupModelThinking('cerebras', 'some-future-model', 'medium')).toEqual({ max: 'medium', off: 'low' });
    expect(lookupModelThinking('groq', 'custom', 'low')).toEqual({ max: 'low', off: 'none' });
    expect(lookupModelThinking('x', 'y', 'high')).toEqual({ max: 'high', off: 'medium' });
  });

  it('returns none/none for an unknown model with no provider default (non-reasoning provider)', () => {
    expect(lookupModelThinking('anthropic', 'claude-opus-4-7')).toEqual({ max: 'none', off: 'none' });
    expect(lookupModelThinking(undefined, 'whatever')).toEqual({ max: 'none', off: 'none' });
  });
});

describe('model-thinking: resolveReasoningEffort', () => {
  it('max-thinking ON returns the model ceiling (= prior behaviour)', () => {
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'gpt-oss-120b', providerDefault: 'medium', maxThinking: true })).toBe('medium');
    expect(resolveReasoningEffort({ providerId: 'groq', model: 'openai/gpt-oss-120b', providerDefault: 'low', maxThinking: true })).toBe('low');
  });

  it('max-thinking ON is the default when maxThinking omitted', () => {
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'gpt-oss-120b', providerDefault: 'medium' })).toBe('medium');
  });

  it('max-thinking OFF drops to the model reduced level', () => {
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'gpt-oss-120b', providerDefault: 'medium', maxThinking: false })).toBe('low');
    expect(resolveReasoningEffort({ providerId: 'groq', model: 'openai/gpt-oss-120b', providerDefault: 'low', maxThinking: false })).toBe('none');
    expect(resolveReasoningEffort({ providerId: 'openai', model: 'gpt-5.4-mini', providerDefault: 'low', maxThinking: false })).toBe('none');
  });

  it('an explicit per-call value wins over the toggle but is clamped to the ceiling', () => {
    // FluidBlank / ConfigIntent pin 'low'; cerebras ceiling is medium → stays low.
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'gpt-oss-120b', providerDefault: 'medium', explicit: 'low', maxThinking: true })).toBe('low');
    // Explicit 'high' on a medium-ceiling model is capped to medium.
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'gpt-oss-120b', providerDefault: 'medium', explicit: 'high', maxThinking: true })).toBe('medium');
    // Explicit wins even when the toggle is OFF (it's a deliberate floor).
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'gpt-oss-120b', providerDefault: 'medium', explicit: 'low', maxThinking: false })).toBe('low');
  });

  it('returns undefined for non-reasoning providers regardless of toggle', () => {
    expect(resolveReasoningEffort({ providerId: 'anthropic', model: 'claude-opus-4-7', providerDefault: undefined, maxThinking: true })).toBeUndefined();
    expect(resolveReasoningEffort({ providerId: 'gemini', model: 'gemini-3.1-flash-lite', providerDefault: undefined, maxThinking: false })).toBeUndefined();
  });

  it('unknown reasoning model derives ON=default, OFF=notch-below', () => {
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'future', providerDefault: 'medium', maxThinking: true })).toBe('medium');
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'future', providerDefault: 'medium', maxThinking: false })).toBe('low');
  });
});
