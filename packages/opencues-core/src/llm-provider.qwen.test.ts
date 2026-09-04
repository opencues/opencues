import { describe, expect, it } from 'vitest';
import { getProvider, type ChatRequest } from './llm-provider';
import { resolveReasoningEffort } from './model-thinking';

// Cerebras qwen-3.8-27b integration (Sep 2026). qwen is a HYBRID
// reasoning model: it thinks by DEFAULT when `reasoning_effort` is
// absent (answer still lands in `content`, thinking in a separate
// `reasoning` field), and accepts none|low|medium|high — `'none'`
// cleanly disables thinking. Its wire shape therefore differs from
// BOTH gpt-oss-120b and gemma-4-31b:
//   - reasoning_effort FORWARDED ('low' ceiling via model-thinking.ts —
//     without forwarding, the model burns uncontrolled thinking tokens,
//     same trap as zai-glm-4.7)
//   - NO reasoning_format    (hidden-reasoning is gpt-oss-only)
//   - NO prediction          (qwen 400s on it, same as gemma:
//                             `"prediction" is not currently supported`)
// Live-verified 2026-09-03. Bench: fluid-blank 137/137 at 'low',
// 135/137 at 'none' (~equal latency).

const ctx = { endpoint: undefined, apiKey: 'test-key', maxThinking: true } as any;

function bodyFor(model: string, extra: Partial<ChatRequest> = {}, maxThinking = true): any {
  const provider = getProvider('cerebras')!;
  const req = {
    model,
    system: 's',
    user: 'u',
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    ...extra,
  } as ChatRequest;
  return JSON.parse((provider.buildRequest(req, { ...ctx, maxThinking }) as any).body);
}

describe('cerebras qwen-3.8-27b — hybrid-reasoning wire shape', () => {
  it("forwards reasoning_effort 'low' (the model-thinking ceiling) with max-thinking on", () => {
    expect(bodyFor('qwen-3.8-27b').reasoning_effort).toBe('low');
  });

  it("forwards reasoning_effort 'none' with max-thinking off (thinking cleanly disabled)", () => {
    expect(bodyFor('qwen-3.8-27b', {}, false).reasoning_effort).toBe('none');
  });

  it('omits reasoning_format (hidden reasoning is gpt-oss-only)', () => {
    expect('reasoning_format' in bodyFor('qwen-3.8-27b')).toBe(false);
  });

  it('omits prediction even when one is supplied (qwen 400s on the field)', () => {
    const body = bodyFor('qwen-3.8-27b', { prediction: 'a long predicted body over two hundred characters '.repeat(6) });
    expect('prediction' in body).toBe(false);
  });
});

describe('cerebras qwen-3.8-27b — model-thinking resolution', () => {
  it("explicit per-call effort clamps DOWN to the 'low' ceiling", () => {
    expect(resolveReasoningEffort({ providerId: 'cerebras', model: 'qwen-3.8-27b', explicit: 'high', maxThinking: true })).toBe('low');
  });
});

describe('cerebras knownModels — qwen is first-class, gpt-oss stays default', () => {
  it('lists qwen-3.8-27b in knownModels', () => {
    expect(getProvider('cerebras')!.knownModels).toContain('qwen-3.8-27b');
  });
  it('default model is still gpt-oss-120b (qwen did NOT become the default)', () => {
    expect(getProvider('cerebras')!.defaultModel).toBe('gpt-oss-120b');
  });
});
