import { describe, expect, it } from 'vitest';
import { getProvider, isRateLimitError, isPredictionUnsupportedError, type ChatRequest } from './llm-provider';

// Cerebras gemma-4-31b integration (Jun 2026). gemma is a NON-reasoning
// model that ALSO rejects the Predicted-Outputs `prediction` field
// (`"prediction" is not currently supported` → HTTP 400). The wire shape
// it receives must therefore differ from gpt-oss-120b:
//   - NO reasoning_effort   (gemma empties `content` when reasoning is on)
//   - NO reasoning_format    (hidden-reasoning is gpt-oss-only)
//   - NO prediction          (gemma 400s on it)
// These pins guard the three model-name gates that make gemma work; a
// regression on any one silently bails every gemma transform/lookup.
// Live-verified 2026-06-28; see tests/results/gemma-hackathon/FINDINGS.md.

const ctx = { endpoint: undefined, apiKey: 'test-key', maxThinking: true } as any;

function bodyFor(model: string, extra: Partial<ChatRequest> = {}): any {
  const provider = getProvider('cerebras')!;
  const req = {
    model,
    system: 's',
    user: 'u',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    ...extra,
  } as ChatRequest;
  return JSON.parse((provider.buildRequest(req, ctx) as any).body);
}

describe('cerebras gemma-4-31b — non-reasoning wire shape', () => {
  it('omits reasoning_effort (gemma empties content when reasoning is on)', () => {
    expect('reasoning_effort' in bodyFor('gemma-4-31b')).toBe(false);
  });

  it('omits reasoning_format (hidden reasoning is gpt-oss-only)', () => {
    expect('reasoning_format' in bodyFor('gemma-4-31b')).toBe(false);
  });

  it('omits prediction even when one is supplied (gemma 400s on the field)', () => {
    const body = bodyFor('gemma-4-31b', { prediction: 'a long predicted body over two hundred characters '.repeat(6) });
    expect('prediction' in body).toBe(false);
  });
});

describe('cerebras gpt-oss-120b — regression guard (still gets the perf fields)', () => {
  it('forwards reasoning_effort + hidden reasoning_format', () => {
    const body = bodyFor('gpt-oss-120b');
    expect(body.reasoning_effort).toBe('medium');
    expect(body.reasoning_format).toBe('hidden');
  });

  it('forwards prediction when supplied', () => {
    const body = bodyFor('gpt-oss-120b', { prediction: 'a long predicted body over two hundred characters '.repeat(6) });
    expect(body.prediction).toEqual({ type: 'content', content: expect.any(String) });
  });
});

describe('isPredictionUnsupportedError — every "prediction (un)supported" phrasing', () => {
  it('matches openrouter "property \'prediction\' is unsupported"', () => {
    expect(isPredictionUnsupportedError(new Error("property 'prediction' is unsupported"))).toBe(true);
  });
  it('matches cerebras gemma "\\"prediction\\" is not currently supported"', () => {
    expect(isPredictionUnsupportedError(new Error('"prediction" is not currently supported'))).toBe(true);
  });
  it('does NOT match an unrelated error mentioning only one token', () => {
    expect(isPredictionUnsupportedError(new Error('the model prediction was confident'))).toBe(false);
    expect(isPredictionUnsupportedError(new Error('feature unsupported on this plan'))).toBe(false);
  });
});

describe('isRateLimitError — RPM/TPM throttle detection (drives dispatch retry)', () => {
  it('matches cerebras request_quota_exceeded / too_many_requests', () => {
    expect(isRateLimitError(new Error('Requests per minute limit exceeded - too many requests sent. (code=request_quota_exceeded, type=too_many_requests_error)'))).toBe(true);
  });
  it('matches generic 429 / rate limit / queue_exceeded', () => {
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(new Error('rate limit reached'))).toBe(true);
    expect(isRateLimitError(new Error('queue_exceeded: high traffic'))).toBe(true);
  });
  it('does NOT match a normal model error', () => {
    expect(isRateLimitError(new Error('model not found'))).toBe(false);
    expect(isRateLimitError(new Error('invalid api key'))).toBe(false);
  });
});

describe('cerebras knownModels — gemma is first-class, gpt-oss stays default', () => {
  it('lists gemma-4-31b in knownModels', () => {
    expect(getProvider('cerebras')!.knownModels).toContain('gemma-4-31b');
  });
  it('default model is still gpt-oss-120b (gemma did NOT become the default)', () => {
    expect(getProvider('cerebras')!.defaultModel).toBe('gpt-oss-120b');
  });
});
