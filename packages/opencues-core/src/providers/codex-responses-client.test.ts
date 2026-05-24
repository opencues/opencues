/**
 * codex-responses-client tests — fake fetch driving the SSE protocol.
 *
 * No real HTTPS calls; we inject a fetch that returns a controllable
 * async iterable of SSE chunks. Lets us pin the exact request shape
 * (URL, headers, body) and the SSE-parsing behaviour (delta accumulation,
 * unknown event tolerance, 401/400 surfaces, timeout).
 *
 * Run with: node --test dist/providers/codex-responses-client.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  invokeCodexResponses,
  splitMessagesForResponses,
  type FetchFn,
  type ReadAuthFn,
} from './codex-responses-client';

// ─── Helpers ────────────────────────────────────────────────────────────

const TEST_AUTH: ReadAuthFn = async () => ({
  auth_mode: 'chatgpt',
  tokens: {
    id_token: 'fake-id-token',
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh',
    account_id: 'acct-abc-123',
  },
});

interface FakeFetchOutcome {
  status: number;
  /** SSE chunks (strings) to emit in order. Joined with empty string when read. */
  chunks?: string[];
  /** Non-SSE body when status != 200. */
  text?: string;
}

function makeFakeFetch(outcome: FakeFetchOutcome): { fetch: FetchFn; calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> } {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const status = outcome.status;
    if (status !== 200) {
      return {
        ok: false,
        status,
        body: null,
        async text() { return outcome.text ?? ''; },
      };
    }
    // Build an async iterable from the chunks
    const chunks = outcome.chunks ?? [];
    const iter: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          async next() {
            if (i >= chunks.length) return { value: undefined, done: true };
            const chunk = chunks[i++];
            return { value: new TextEncoder().encode(chunk), done: false };
          },
        } as AsyncIterator<Uint8Array>;
      },
    };
    return {
      ok: true,
      status: 200,
      body: iter,
      async text() { return ''; },
    };
  };
  return { fetch, calls };
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('invokeCodexResponses — request shape', () => {
  it('POSTs to the codex responses endpoint with the correct headers + body', async () => {
    const { fetch, calls } = makeFakeFetch({
      status: 200,
      chunks: [sseEvent('response.output_text.delta', { delta: 'hi' }), sseEvent('response.completed', { response: { status: 'completed' } })],
    });
    const text = await invokeCodexResponses({
      model: 'gpt-5.4-mini',
      systemPrompt: 'You are concise.',
      userPrompt: 'Say only OK.',
      readAuth: TEST_AUTH,
      fetch,
    });
    assert.strictEqual(text, 'hi');
    assert.strictEqual(calls.length, 1);
    const c = calls[0];
    assert.strictEqual(c.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.strictEqual(c.init.method, 'POST');
    assert.strictEqual(c.init.headers['Authorization'], 'Bearer fake-access-token');
    assert.strictEqual(c.init.headers['ChatGPT-Account-Id'], 'acct-abc-123');
    assert.strictEqual(c.init.headers['OpenAI-Beta'], 'responses=experimental');
    assert.strictEqual(c.init.headers['originator'], 'codex_cli_rs');
    assert.strictEqual(c.init.headers['Content-Type'], 'application/json');
    assert.strictEqual(c.init.headers['Accept'], 'text/event-stream');
    const body = JSON.parse(c.init.body);
    assert.strictEqual(body.model, 'gpt-5.4-mini');
    assert.strictEqual(body.instructions, 'You are concise.');
    assert.deepStrictEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'Say only OK.' }] }]);
    assert.strictEqual(body.store, false, 'stateless calls are faster than chained on this endpoint');
    assert.strictEqual(body.stream, true);
  });
});

describe('invokeCodexResponses — SSE accumulation', () => {
  it('concatenates response.output_text.delta events', async () => {
    const { fetch } = makeFakeFetch({
      status: 200,
      chunks: [
        sseEvent('response.created', { response: { id: 'resp_1' } }),
        sseEvent('response.in_progress', {}),
        sseEvent('response.output_text.delta', { delta: 'Hello' }),
        sseEvent('response.output_text.delta', { delta: ', ' }),
        sseEvent('response.output_text.delta', { delta: 'world!' }),
        sseEvent('response.completed', { response: { status: 'completed' } }),
      ],
    });
    const text = await invokeCodexResponses({
      model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi',
      readAuth: TEST_AUTH, fetch,
    });
    assert.strictEqual(text, 'Hello, world!');
  });

  it('handles SSE chunks split mid-event across reads', async () => {
    // Split one event across multiple chunks to test the buf-and-scan parser.
    const ev = sseEvent('response.output_text.delta', { delta: 'split-test' });
    const half = ev.length / 2 | 0;
    const { fetch } = makeFakeFetch({
      status: 200,
      chunks: [ev.slice(0, half), ev.slice(half), sseEvent('response.completed', {})],
    });
    const text = await invokeCodexResponses({
      model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi',
      readAuth: TEST_AUTH, fetch,
    });
    assert.strictEqual(text, 'split-test');
  });

  it('ignores unknown event types (forward-compat with future API)', async () => {
    const { fetch } = makeFakeFetch({
      status: 200,
      chunks: [
        sseEvent('response.new_future_event', { what: 'ever' }),
        sseEvent('response.output_text.delta', { delta: 'kept' }),
        sseEvent('response.another_new_event', {}),
        sseEvent('response.completed', {}),
      ],
    });
    const text = await invokeCodexResponses({
      model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi',
      readAuth: TEST_AUTH, fetch,
    });
    assert.strictEqual(text, 'kept');
  });

  it('throws on response.failed events with the server error message', async () => {
    const { fetch } = makeFakeFetch({
      status: 200,
      chunks: [
        sseEvent('response.created', { response: { id: 'r1' } }),
        sseEvent('response.failed', { response: { error: { message: 'token quota exceeded' } } }),
      ],
    });
    await assert.rejects(
      invokeCodexResponses({ model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi', readAuth: TEST_AUTH, fetch }),
      /response failed.*token quota exceeded/,
    );
  });
});

describe('invokeCodexResponses — HTTP error surfaces', () => {
  it('throws a clear "run codex login" message on 401', async () => {
    const { fetch } = makeFakeFetch({ status: 401, text: '{"detail":"unauthorized"}' });
    await assert.rejects(
      invokeCodexResponses({ model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi', readAuth: TEST_AUTH, fetch }),
      (err: Error) => {
        assert.match(err.message, /401/);
        assert.match(err.message, /codex login/);
        return true;
      },
    );
  });

  it('surfaces 400 errors (e.g. "model not supported")', async () => {
    const { fetch } = makeFakeFetch({
      status: 400,
      text: '{"detail":"The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."}',
    });
    await assert.rejects(
      invokeCodexResponses({ model: 'gpt-5', systemPrompt: '', userPrompt: 'hi', readAuth: TEST_AUTH, fetch }),
      /400.*not supported/,
    );
  });

  it('surfaces other HTTP errors with status code', async () => {
    const { fetch } = makeFakeFetch({ status: 503, text: 'gateway timeout' });
    await assert.rejects(
      invokeCodexResponses({ model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi', readAuth: TEST_AUTH, fetch }),
      /HTTP 503/,
    );
  });
});

describe('invokeCodexResponses — auth state validation', () => {
  it('rejects when auth.json is in apikey mode (not subscription)', async () => {
    const apikeyAuth: ReadAuthFn = async () => ({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-...' });
    const { fetch } = makeFakeFetch({ status: 200, chunks: [] });
    await assert.rejects(
      invokeCodexResponses({ model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi', readAuth: apikeyAuth, fetch }),
      /not in ChatGPT-subscription mode/,
    );
  });

  it('rejects when tokens are missing fields', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const partialAuth: ReadAuthFn = async () => ({ auth_mode: 'chatgpt', tokens: { id_token: '', access_token: '', refresh_token: '', account_id: '' } } as any);
    const { fetch } = makeFakeFetch({ status: 200, chunks: [] });
    await assert.rejects(
      invokeCodexResponses({ model: 'gpt-5.4-mini', systemPrompt: '', userPrompt: 'hi', readAuth: partialAuth, fetch }),
      /access_token or account_id/,
    );
  });
});

describe('splitMessagesForResponses', () => {
  it('separates system from user/assistant', () => {
    const { systemPrompt, userPrompt } = splitMessagesForResponses([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    assert.strictEqual(systemPrompt, 'sys');
    assert.strictEqual(userPrompt, 'usr');
  });

  it('joins multiple system messages with blank-line separators', () => {
    const { systemPrompt } = splitMessagesForResponses([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'q' },
    ]);
    assert.match(systemPrompt, /a\n\nb/);
  });
});
