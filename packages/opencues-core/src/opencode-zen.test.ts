/**
 * Pin `dispatchWithFreePool` — the pool-walking dispatcher used by
 * `blank-llm-provider: free` mode. The pool is OPENCODE_ZEN_FREE_POOL
 * (5 free model ids); the dispatcher walks it on transient failure,
 * health-caches dead entries for 30s, and bubbles sticky failures
 * (auth/quota) immediately.
 *
 * These tests pin the contract every blank-class source depends on
 * when the user is in free mode. Drift breaks the free pool silently
 * — a source either calls a dead model and gets nothing, or it bubbles
 * a quota error that should have surfaced via ProviderHealth.
 *
 * Run via: vitest run src/opencode-zen.test.ts  (or `npm run test`)
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  dispatchWithFreePool,
  _resetOpencodeZenHealthForTesting,
  getOpencodeZenHealth,
  OPENCODE_ZEN_FREE_POOL,
  type HttpAdapterShape,
  type ChatRequest,
} from './llm-provider';

function makeReq(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

function makeAdapter(seq: Array<{ status?: number; body: string } | Error>): HttpAdapterShape & { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      const step = seq[i++];
      if (step === undefined) throw new Error(`adapter ran out of scripted responses (call ${i})`);
      if (step instanceof Error) throw step;
      // Simulate the OpenAI-shape parseResponse layer: errors in body bubble as throws.
      const data = JSON.parse(step.body);
      if (data.error || data.code) {
        throw new Error(`provider error: ${data.error?.message ?? data.message ?? 'unknown'} (code=${data.code ?? '?'})`);
      }
      return step.body;
    },
  };
}

describe('dispatchWithFreePool — pool walking', () => {
  it('returns first-model success without walking', async () => {
    _resetOpencodeZenHealthForTesting();
    const adapter = makeAdapter([
      { body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) },
    ]);
    const result = await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(adapter.calls.length, 1);
    const sentBody = JSON.parse(adapter.calls[0].body) as { model: string };
    assert.strictEqual(sentBody.model, OPENCODE_ZEN_FREE_POOL[0]);
  });

  it('skips a model that 429s and succeeds on the next', async () => {
    _resetOpencodeZenHealthForTesting();
    const adapter = makeAdapter([
      new Error('429 too many requests'),
      { body: JSON.stringify({ choices: [{ message: { content: 'rescued' } }] }) },
    ]);
    const result = await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' });
    assert.strictEqual(result, 'rescued');
    assert.strictEqual(adapter.calls.length, 2);
    const secondBody = JSON.parse(adapter.calls[1].body) as { model: string };
    assert.strictEqual(secondBody.model, OPENCODE_ZEN_FREE_POOL[1]);
  });

  it('walks past TWO dead models and succeeds on the third', async () => {
    _resetOpencodeZenHealthForTesting();
    const adapter = makeAdapter([
      new Error('server error 503'),
      new Error('overloaded'),
      { body: JSON.stringify({ choices: [{ message: { content: 'third time' } }] }) },
    ]);
    const result = await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' });
    assert.strictEqual(result, 'third time');
    assert.strictEqual(adapter.calls.length, 3);
  });

  it('treats empty response as a transient failure and walks', async () => {
    _resetOpencodeZenHealthForTesting();
    const adapter = makeAdapter([
      { body: JSON.stringify({ choices: [{ message: { content: '' } }] }) },
      { body: JSON.stringify({ choices: [{ message: { content: 'now we got it' } }] }) },
    ]);
    const result = await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' });
    assert.strictEqual(result, 'now we got it');
    assert.strictEqual(adapter.calls.length, 2);
  });

  it('bubbles 401 immediately (auth = sticky, no other model would help)', async () => {
    _resetOpencodeZenHealthForTesting();
    const adapter = makeAdapter([
      new Error('unauthorized: invalid_api_key'),
    ]);
    await assert.rejects(
      () => dispatchWithFreePool(adapter, makeReq(), { apiKey: 'bad' }),
      /unauthorized/i,
    );
    assert.strictEqual(adapter.calls.length, 1, 'should NOT walk pool on auth failure');
  });

  it('bubbles 402 / payment_required immediately (quota = sticky)', async () => {
    _resetOpencodeZenHealthForTesting();
    const adapter = makeAdapter([
      new Error('payment_required: out of credit'),
    ]);
    await assert.rejects(
      () => dispatchWithFreePool(adapter, makeReq(), { apiKey: '' }),
      /payment_required|credit/i,
    );
    assert.strictEqual(adapter.calls.length, 1);
  });

  it('throws synthesized pool-exhausted error when every model fails transiently', async () => {
    _resetOpencodeZenHealthForTesting();
    const pool = ['a', 'b', 'c'];
    const adapter = makeAdapter([
      new Error('overloaded'),
      new Error('overloaded'),
      new Error('overloaded'),
    ]);
    await assert.rejects(
      () => dispatchWithFreePool(adapter, makeReq(), { apiKey: '' }, { pool }),
      /pool exhausted/i,
    );
    assert.strictEqual(adapter.calls.length, 3);
  });

  it('skips models in health cool-down', async () => {
    _resetOpencodeZenHealthForTesting();
    const pool = ['m1', 'm2', 'm3'];
    const now = (() => {
      let t = 1_000;
      return () => t;
    })();
    // First call: m1 fails. m1 cooled down. m2 succeeds.
    const adapter1 = makeAdapter([
      new Error('overloaded'),
      { body: JSON.stringify({ choices: [{ message: { content: 'first' } }] }) },
    ]);
    const r1 = await dispatchWithFreePool(adapter1, makeReq(), { apiKey: '' }, { pool, now, cooldownMs: 30_000 });
    assert.strictEqual(r1, 'first');
    // Health cache should now contain m1.
    const health = getOpencodeZenHealth(now);
    assert.ok(health.some(h => h.model === 'm1'), 'm1 should be in cool-down');

    // Second call shortly after: m1 should be SKIPPED, request goes to m2 directly.
    const adapter2 = makeAdapter([
      { body: JSON.stringify({ choices: [{ message: { content: 'second' } }] }) },
    ]);
    const r2 = await dispatchWithFreePool(adapter2, makeReq(), { apiKey: '' }, { pool, now, cooldownMs: 30_000 });
    assert.strictEqual(r2, 'second');
    const sentBody = JSON.parse(adapter2.calls[0].body) as { model: string };
    assert.strictEqual(sentBody.model, 'm2', 'should have skipped m1 and gone to m2');
  });

  it('health cool-down expires after cooldownMs', async () => {
    _resetOpencodeZenHealthForTesting();
    const pool = ['m1', 'm2'];
    let t = 1_000;
    const now = () => t;
    const adapter = makeAdapter([
      new Error('overloaded'),
      { body: JSON.stringify({ choices: [{ message: { content: 'a' } }] }) },
    ]);
    await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' }, { pool, now, cooldownMs: 5_000 });
    assert.ok(getOpencodeZenHealth(now).some(h => h.model === 'm1'));
    t += 6_000;
    // After expiry, getOpencodeZenHealth returns empty (filters expired entries).
    assert.strictEqual(getOpencodeZenHealth(now).length, 0);
  });

  it('onFailure callback fires once per failed attempt', async () => {
    _resetOpencodeZenHealthForTesting();
    const failures: Array<{ model: string; cause?: unknown }> = [];
    const adapter = makeAdapter([
      new Error('overloaded'),
      new Error('overloaded'),
      { body: JSON.stringify({ choices: [{ message: { content: 'k' } }] }) },
    ]);
    await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' }, {
      onFailure: info => failures.push({ model: info.model, cause: info.cause }),
    });
    assert.strictEqual(failures.length, 2);
    assert.strictEqual(failures[0].model, OPENCODE_ZEN_FREE_POOL[0]);
    assert.strictEqual(failures[1].model, OPENCODE_ZEN_FREE_POOL[1]);
  });

  it('marks a previously-failed model healthy on success (deletes from cache)', async () => {
    _resetOpencodeZenHealthForTesting();
    const pool = ['m1', 'm2'];
    let t = 1_000;
    const now = () => t;
    // First call: m1 fails, m2 wins.
    const a1 = makeAdapter([
      new Error('overloaded'),
      { body: JSON.stringify({ choices: [{ message: { content: 'a' } }] }) },
    ]);
    await dispatchWithFreePool(a1, makeReq(), { apiKey: '' }, { pool, now, cooldownMs: 30_000 });
    assert.ok(getOpencodeZenHealth(now).some(h => h.model === 'm1'));

    // Wait past cool-down then a successful m1 call should clear its cache entry.
    t += 31_000;
    const a2 = makeAdapter([
      { body: JSON.stringify({ choices: [{ message: { content: 'b' } }] }) },
    ]);
    await dispatchWithFreePool(a2, makeReq(), { apiKey: '' }, { pool, now, cooldownMs: 30_000 });
    assert.strictEqual(getOpencodeZenHealth(now).length, 0);
  });
});

describe('OPENCODE_ZEN provider adapter shape', () => {
  it('omits Authorization header when apiKey is empty (anonymous free-mode)', async () => {
    _resetOpencodeZenHealthForTesting();
    const captured: Array<Record<string, string>> = [];
    const adapter: HttpAdapterShape = {
      post: async (_url, _body, headers) => {
        captured.push(headers);
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
      },
    };
    await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' });
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].Authorization, undefined, 'should NOT send Authorization on empty key');
    assert.strictEqual(captured[0]['Content-Type'], 'application/json');
  });

  it('sends Authorization: Bearer when apiKey is set', async () => {
    _resetOpencodeZenHealthForTesting();
    const captured: Array<Record<string, string>> = [];
    const adapter: HttpAdapterShape = {
      post: async (_url, _body, headers) => {
        captured.push(headers);
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
      },
    };
    await dispatchWithFreePool(adapter, makeReq(), { apiKey: 'sk-zen-xxx' });
    assert.strictEqual(captured[0].Authorization, 'Bearer sk-zen-xxx');
  });

  it('targets the canonical zen endpoint', async () => {
    _resetOpencodeZenHealthForTesting();
    const urls: string[] = [];
    const adapter: HttpAdapterShape = {
      post: async (url) => {
        urls.push(url);
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
      },
    };
    await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' });
    assert.strictEqual(urls[0], 'https://opencode.ai/zen/v1/chat/completions');
  });

  it('uses bare model ids (not opencode/ prefix — verified May 2026 against live endpoint)', async () => {
    _resetOpencodeZenHealthForTesting();
    const bodies: string[] = [];
    const adapter: HttpAdapterShape = {
      post: async (_url, body) => {
        bodies.push(body);
        return JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
      },
    };
    await dispatchWithFreePool(adapter, makeReq(), { apiKey: '' });
    const sent = JSON.parse(bodies[0]) as { model: string };
    assert.ok(!sent.model.includes('/'), `model id should not contain slash; got ${sent.model}`);
  });
});
