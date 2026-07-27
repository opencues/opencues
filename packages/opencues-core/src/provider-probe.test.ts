// Tests for probeProviderReachable — the pre-switch provider liveness ping.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { probeProviderReachable } from './provider-probe';
import type { HttpAdapterShape } from './llm-provider';

/** Mock httpAdapter whose post() resolves with an OpenAI-shaped body
 *  (reachable) or throws (unreachable). Records call count. */
function adapter(post: () => Promise<string>): { a: HttpAdapterShape; calls: () => number } {
  let n = 0;
  return {
    a: { post: async () => { n++; return post(); } } as unknown as HttpAdapterShape,
    calls: () => n,
  };
}

const OK_BODY = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });

describe('probeProviderReachable', () => {
  it('reachable provider → ok', async () => {
    const { a } = adapter(async () => OK_BODY);
    const r = await probeProviderReachable('cerebras', 'gemma-4-31b', {
      apiKeys: { CEREBRAS_API_KEY: 'k' }, httpAdapter: a,
    });
    assert.strictEqual(r.ok, true);
  });

  it('unreachable (connection refused) → not ok, reason network', async () => {
    const { a } = adapter(async () => { throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434'); });
    const r = await probeProviderReachable('ollama', 'gemma4:e2b', {
      apiKeys: {}, httpAdapter: a,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'network');
    assert.match(r.err!.message, /11434/); // the concrete cause is preserved for the inline message
  });

  it('ollama is pinged keyless (optionalAuth) — no missing-key fast-fail', async () => {
    const { a, calls } = adapter(async () => OK_BODY);
    const r = await probeProviderReachable('ollama', null, { apiKeys: {}, httpAdapter: a });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls(), 1, 'ollama must actually be pinged, not fast-failed on missing key');
  });

  it('key-required provider with no key → fast-fail, NO network hop', async () => {
    const { a, calls } = adapter(async () => OK_BODY);
    const r = await probeProviderReachable('cerebras', 'gemma-4-31b', { apiKeys: {}, httpAdapter: a });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid-api-key');
    assert.strictEqual(calls(), 0, 'must not ping when a required key is absent');
  });

  it('rate-limit (429) → treated as reachable (provider/key/model valid)', async () => {
    const { a } = adapter(async () => { throw new Error('HTTP 429 Too Many Requests'); });
    const r = await probeProviderReachable('cerebras', 'gemma-4-31b', {
      apiKeys: { CEREBRAS_API_KEY: 'k' }, httpAdapter: a,
    });
    assert.strictEqual(r.ok, true);
  });

  it('model rejected (404 / model-not-found) → not ok', async () => {
    const { a } = adapter(async () => { throw new Error('HTTP 404 model not found'); });
    const r = await probeProviderReachable('cerebras', 'no-such-model', {
      apiKeys: { CEREBRAS_API_KEY: 'k' }, httpAdapter: a,
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason === 'endpoint-not-found' || r.reason === 'model-not-found', `got ${r.reason}`);
  });

  it('CLI provider unavailable → not ok, no network', async () => {
    const { a, calls } = adapter(async () => OK_BODY);
    const r = await probeProviderReachable('claude-code-cli', null, {
      apiKeys: {}, httpAdapter: a, isCliAvailable: () => false,
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(calls(), 0);
  });

  it('CLI provider available → ok, no network', async () => {
    const { a, calls } = adapter(async () => OK_BODY);
    const r = await probeProviderReachable('claude-code-cli', null, {
      apiKeys: {}, httpAdapter: a, isCliAvailable: () => true,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls(), 0);
  });

  it('unknown provider → not ok', async () => {
    const { a } = adapter(async () => OK_BODY);
    const r = await probeProviderReachable('not-a-provider', null, { apiKeys: {}, httpAdapter: a });
    assert.strictEqual(r.ok, false);
  });
});
