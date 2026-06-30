/**
 * Ollama provider — native /api/chat request/response shape.
 *
 * Unlike the OpenAI-compatible providers, ollama targets Ollama's NATIVE
 * endpoint and disables the model's reasoning channel (`think: false`) —
 * the only configuration where a thinking model (Gemma 4, Qwen3, …) returns
 * non-empty `content` under OpenCues' small token budget. These tests pin
 * that contract.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  buildProviderRequest,
  parseProviderResponse,
  getProvider,
  resolveLLM,
  PROVIDER_IDS,
} from './llm-provider';
import { classifyLlmError } from './sources/fluid-blank-source';

describe('ollama provider — native /api/chat (local, think:false)', () => {
  it('is registered', () => {
    assert.ok(PROVIDER_IDS.includes('ollama'));
    assert.strictEqual(getProvider('ollama')?.id, 'ollama');
  });

  it('buildRequest: native /api/chat URL, think:false, num_ctx override, no auth header without key', () => {
    const built = buildProviderRequest(
      'ollama',
      { model: 'gemma4:e2b', messages: [{ role: 'user', content: 'hi' }], maxTokens: 128, temperature: 0 },
      { apiKey: '' },
    );
    assert.strictEqual(built.url, 'http://localhost:11434/api/chat');
    // optionalAuth: no Authorization header when the key is empty.
    assert.deepStrictEqual(built.headers, { 'Content-Type': 'application/json' });
    const body = JSON.parse(built.body);
    assert.strictEqual(body.think, false, 'think MUST be false so the answer budget is not eaten by reasoning');
    assert.strictEqual(body.stream, false);
    assert.strictEqual(body.model, 'gemma4:e2b');
    assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(body.options.num_predict, 128);
    assert.strictEqual(body.options.temperature, 0);
    assert.strictEqual(body.options.num_ctx, 16384, 'override Ollama default ctx so OpenCues prompts are not truncated');
  });

  it('buildRequest: sends Authorization only when a key is present (reverse-proxy case)', () => {
    const built = buildProviderRequest(
      'ollama',
      { model: 'gemma4:e2b', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'proxy-token' },
    );
    assert.strictEqual(built.headers.Authorization, 'Bearer proxy-token');
  });

  it('buildRequest: maps responseFormat.schema → native `format`', () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    const built = buildProviderRequest(
      'ollama',
      { model: 'gemma4:e2b', messages: [{ role: 'user', content: 'x' }], responseFormat: { name: 'v', schema } },
      { apiKey: '' },
    );
    assert.deepStrictEqual(JSON.parse(built.body).format, schema);
  });

  it('parseResponse: reads native message.content (not OpenAI choices[])', () => {
    const raw = JSON.stringify({ message: { role: 'assistant', content: 'the answer' }, done_reason: 'stop' });
    assert.strictEqual(parseProviderResponse('ollama', raw), 'the answer');
  });

  it('parseResponse: throws on a native top-level error string', () => {
    const raw = JSON.stringify({ error: 'model "nope" not found' });
    assert.throws(() => parseProviderResponse('ollama', raw), /model "nope" not found/);
  });

  it('resolveLLM: usable with NO api key (optionalAuth)', () => {
    const resolved = resolveLLM({ globalProvider: 'ollama', apiKeys: {} });
    assert.ok(resolved, 'ollama must resolve to a usable tuple with no key set');
    assert.strictEqual(resolved?.provider.id, 'ollama');
    assert.strictEqual(resolved?.model, 'gemma4:e2b');
    assert.strictEqual(resolved?.endpoint, 'http://localhost:11434/api/chat');
  });

  it('classifyLlmError: Ollama\'s "model \'X\' not found" → model-not-found (not a silent bail)', () => {
    // Regression: the model name sits BETWEEN "model" and "not found", so
    // the adjacent `model not found` literal missed it and the whole
    // classifier fell through to null → no substitute → silent failure
    // when a local model wasn\'t pulled. parseOllamaResponse surfaces this
    // exact string.
    const err = new Error("provider error: model 'gemma4:e2b' not found");
    assert.strictEqual(classifyLlmError(err), 'model-not-found');
  });

  it('classifyLlmError: ECONNREFUSED (ollama server down) → network', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    assert.strictEqual(classifyLlmError(err), 'network');
  });
});
