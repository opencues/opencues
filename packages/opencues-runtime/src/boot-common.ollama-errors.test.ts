/**
 * nativeHostFormatLLMError — Ollama-aware, provider-specific guidance.
 *
 * Local Ollama fails in ways the cloud-centric hints don't cover: the
 * server may not be running/installed, or the model may not be pulled.
 * These pin that the formatter tells the user the ACTUAL fix (`ollama
 * serve` / `ollama pull <model>`) when the provider is `ollama`, and falls
 * back to the generic text for cloud providers.
 */
import { describe, it, expect } from 'vitest';
import { nativeHostFormatLLMError } from './boot-common';

describe('nativeHostFormatLLMError — ollama provider guidance', () => {
  it('model-not-found → tells the user to `ollama pull <model>` (with the actual model name)', () => {
    const msg = nativeHostFormatLLMError('model-not-found', undefined, { provider: 'ollama', model: 'gemma4:e2b' });
    expect(msg).toContain('ollama pull gemma4:e2b');
    expect(msg).toContain('not installed');
    // Must NOT show the cloud-centric Cerebras/Groq hint.
    expect(msg).not.toContain('Cerebras');
  });

  it('network → tells the user to install Ollama / start `ollama serve`', () => {
    const msg = nativeHostFormatLLMError('network', undefined, { provider: 'ollama', model: 'gemma4:e2b' });
    expect(msg).toContain('ollama serve');
    expect(msg).toContain('ollama.com');
    expect(msg).not.toContain('Check connectivity');
  });

  it('endpoint-not-found (404) on ollama → same not-reachable guidance', () => {
    const msg = nativeHostFormatLLMError('endpoint-not-found', undefined, { provider: 'ollama' });
    expect(msg).toContain('ollama serve');
  });

  it('cloud providers keep the generic messages (no ollama leakage)', () => {
    const net = nativeHostFormatLLMError('network', undefined, { provider: 'cerebras' });
    expect(net).toContain('network error');
    expect(net).not.toContain('ollama');
    const model = nativeHostFormatLLMError('model-not-found', undefined, { provider: 'groq', model: 'openai/gpt-oss-120b' });
    expect(model).toContain('Cerebras');
    expect(model).not.toContain('ollama pull');
  });

  it('no ctx (legacy 1-arg callers) still works — generic text', () => {
    expect(nativeHostFormatLLMError('network')).toContain('network error');
    expect(nativeHostFormatLLMError('invalid-api-key')).toContain('API key');
  });

  it('api-key / rate-limit / credits do not apply to ollama → fall through to generic', () => {
    // A local server has no key/quota; these reasons can still arrive via a
    // fronting proxy, so the generic hint is the right fallback.
    expect(nativeHostFormatLLMError('rate-limit', undefined, { provider: 'ollama' })).toContain('rate-limit');
  });
});
