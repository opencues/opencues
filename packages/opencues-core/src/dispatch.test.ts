/**
 * Pin the `dispatchChat` helper — the single transport gateway every
 * source uses to call an LLM.
 *
 * Until May 2026 the dispatch was inlined at five call sites
 * (ConfigSource, FluidBlankSource, TransformBlankSource,
 * SentenceCueSource, ConfigIntentSource), all doing the same three-step
 * dance:
 *
 *   const built = provider.buildRequest(req, ctx);
 *   const raw   = await httpAdapter.post(built.url, built.body, built.headers);
 *   return provider.parseResponse(raw);
 *
 * Extracting it to one helper means a future transport (e.g. the
 * subprocess-backed `claude-cli` daemon) can fork the dispatch in ONE
 * place instead of editing five sources in lockstep. These tests pin
 * the HTTP behavior so that fork lands without breaking the existing
 * path.
 *
 * Run with: node --test dist/dispatch.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { dispatchChat, type HttpAdapterShape } from './llm-provider';
import type { ProviderAdapter, ChatRequest, BuiltRequest } from './llm-provider';

interface CapturedPost { url: string; body: string; headers: Record<string, string> }

function makeFakeProvider(opts: {
  buildReturn?: BuiltRequest;
  parseReturn?: string;
  onBuild?: (req: ChatRequest, ctx: { apiKey: string; endpoint?: string }) => void;
  onParse?: (raw: string) => void;
}): ProviderAdapter {
  return {
    id: 'groq', // ProviderId enum member — any will do for the test
    displayName: 'fake',
    defaultEndpoint: 'https://fake.example/v1/chat',
    defaultModel: 'fake-model',
    envKeyName: 'FAKE_API_KEY',
    buildRequest(req, ctx) {
      opts.onBuild?.(req, ctx);
      return opts.buildReturn ?? {
        url: 'https://fake.example/v1/chat',
        body: JSON.stringify({ model: req.model, messages: req.messages }),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.apiKey}` },
      };
    },
    parseResponse(raw) {
      opts.onParse?.(raw);
      return opts.parseReturn ?? `parsed:${raw}`;
    },
  };
}

function makeCapture(response = '{"ok":true}'): { adapter: HttpAdapterShape; calls: CapturedPost[] } {
  const calls: CapturedPost[] = [];
  return {
    adapter: { post: async (url, body, headers) => { calls.push({ url, body, headers }); return response; } },
    calls,
  };
}

describe('dispatchChat — HTTP transport contract', () => {
  it('calls provider.buildRequest with (req, ctx) and httpAdapter.post with that built request', async () => {
    let buildArgs: { req: ChatRequest; ctx: { apiKey: string; endpoint?: string } } | null = null;
    const provider = makeFakeProvider({
      onBuild: (req, ctx) => { buildArgs = { req, ctx }; },
      buildReturn: {
        url: 'https://built.example/v1',
        body: '{"built":"body"}',
        headers: { 'X-Built': 'header' },
      },
    });
    const { adapter, calls } = makeCapture();
    const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 };
    const ctx = { apiKey: 'AKEY', endpoint: 'https://override.example' };

    await dispatchChat(provider, adapter, req, ctx);

    // (1) buildRequest received the exact req + ctx (no mutation, no extras)
    assert.deepStrictEqual(buildArgs!.req, req);
    assert.deepStrictEqual(buildArgs!.ctx, ctx);

    // (2) httpAdapter.post called exactly once with buildRequest's output
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://built.example/v1');
    assert.strictEqual(calls[0].body, '{"built":"body"}');
    assert.deepStrictEqual(calls[0].headers, { 'X-Built': 'header' });
  });

  it('returns the result of provider.parseResponse on the raw HTTP response', async () => {
    let parseArg: string | null = null;
    const provider = makeFakeProvider({
      onParse: (raw) => { parseArg = raw; },
      parseReturn: 'final-parsed-text',
    });
    const { adapter } = makeCapture('{"choices":[{"message":{"content":"hello"}}]}');

    const result = await dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' });

    // (3) parseResponse saw the raw HTTP body
    assert.strictEqual(parseArg, '{"choices":[{"message":{"content":"hello"}}]}');
    // (4) dispatchChat returns whatever parseResponse returned
    assert.strictEqual(result, 'final-parsed-text');
  });

  it('passes httpAdapter.post errors through unchanged', async () => {
    const provider = makeFakeProvider({});
    const adapter: HttpAdapterShape = { post: async () => { throw new Error('network bork'); } };

    await assert.rejects(
      dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' }),
      /network bork/,
    );
  });

  it('passes provider.buildRequest errors through unchanged (e.g. unsupported req shape)', async () => {
    const provider: ProviderAdapter = {
      id: 'groq', displayName: 'fake', defaultEndpoint: '', defaultModel: '', envKeyName: '',
      buildRequest() { throw new Error('cannot build'); },
      parseResponse() { return ''; },
    };
    const { adapter } = makeCapture();

    await assert.rejects(
      dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' }),
      /cannot build/,
    );
  });

  it('passes provider.parseResponse errors through unchanged (e.g. malformed JSON)', async () => {
    const provider: ProviderAdapter = {
      id: 'groq', displayName: 'fake', defaultEndpoint: '', defaultModel: '', envKeyName: '',
      buildRequest: (req) => ({ url: 'u', body: 'b', headers: {} }),
      parseResponse() { throw new Error('bad json'); },
    };
    const { adapter } = makeCapture('garbage');

    await assert.rejects(
      dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' }),
      /bad json/,
    );
  });

  it('does not retry on non-rate-limit transient errors (peer-fallback belongs to withFallback)', async () => {
    // Pin that dispatchChat does NOT do peer-fallback retry — that lives in
    // `withFallback` (llm-provider.ts), which wraps the adapter to switch
    // PROVIDERS on failure. The one self-retry dispatchChat owns is the
    // rate-limit backoff (a throttled SAME-provider key degrades to "slower",
    // not "broken"), covered in llm-provider.gemma.test.ts and opt-out-able via
    // `noRateLimitRetry`. A generic 5xx is neither — it surfaces once.
    let calls = 0;
    const provider = makeFakeProvider({});
    const adapter: HttpAdapterShape = {
      post: async () => { calls++; throw new Error('503 service overloaded'); },
    };

    await assert.rejects(
      dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' }),
      /overloaded/,
    );
    assert.strictEqual(calls, 1, 'dispatchChat must not peer-retry a generic transient error');
  });

  // ── Transport-tag dispatch ───────────────────────────────────────────
  // Pin that the `transport?: 'http' | 'cli'` switch on ProviderAdapter
  // routes correctly. Existing providers (no transport field) MUST
  // continue to use the HTTP path; CLI providers MUST bypass the http
  // adapter entirely and call invokeCli instead.

  it('transport omitted → HTTP path (back-compat with all existing providers)', async () => {
    const provider = makeFakeProvider({}); // no transport field
    const { adapter, calls } = makeCapture();

    await dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' });
    assert.strictEqual(calls.length, 1, 'omitted transport must use HTTP');
  });

  it("transport: 'http' explicit → HTTP path", async () => {
    const provider: ProviderAdapter = { ...makeFakeProvider({}), transport: 'http' };
    const { adapter, calls } = makeCapture();

    await dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' });
    assert.strictEqual(calls.length, 1, 'explicit http must use HTTP');
  });

  it("transport: 'cli' → invokeCli is called, httpAdapter.post is NEVER touched", async () => {
    let invokeCalls = 0;
    let receivedReq: ChatRequest | null = null;
    let receivedCtx: { apiKey: string; endpoint?: string } | null = null;
    const provider: ProviderAdapter = {
      id: 'groq', displayName: 'cli-fake', defaultEndpoint: '', defaultModel: '', envKeyName: '',
      transport: 'cli',
      buildRequest() { throw new Error('buildRequest must NOT be called for cli transport'); },
      parseResponse() { throw new Error('parseResponse must NOT be called for cli transport'); },
      invokeCli(req, ctx) {
        invokeCalls++;
        receivedReq = req;
        receivedCtx = ctx;
        return Promise.resolve('cli-result-text');
      },
    };
    const { adapter, calls } = makeCapture();
    const req: ChatRequest = { model: 'haiku', messages: [{ role: 'user', content: 'q' }] };
    const ctx = { apiKey: 'unused-for-cli', endpoint: 'unused' };

    const result = await dispatchChat(provider, adapter, req, ctx);

    assert.strictEqual(result, 'cli-result-text');
    assert.strictEqual(invokeCalls, 1, 'invokeCli must run exactly once');
    assert.strictEqual(calls.length, 0, 'httpAdapter.post must NOT run for cli transport');
    assert.deepStrictEqual(receivedReq, req, 'invokeCli receives the neutral req unchanged');
    assert.deepStrictEqual(receivedCtx, ctx, 'invokeCli receives the ctx unchanged');
  });

  it("transport: 'cli' WITHOUT invokeCli → throws clear error", async () => {
    const provider: ProviderAdapter = {
      id: 'groq', displayName: 'broken-cli', defaultEndpoint: '', defaultModel: '', envKeyName: '',
      transport: 'cli',
      buildRequest: () => ({ url: '', body: '', headers: {} }),
      parseResponse: () => '',
      // invokeCli intentionally missing — misconfiguration check
    };
    const { adapter } = makeCapture();

    await assert.rejects(
      dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' }),
      /transport='cli' but has no invokeCli/,
    );
  });

  it('invokeCli errors propagate through dispatchChat unchanged', async () => {
    const provider: ProviderAdapter = {
      id: 'groq', displayName: 'cli-fake', defaultEndpoint: '', defaultModel: '', envKeyName: '',
      transport: 'cli',
      buildRequest: () => ({ url: '', body: '', headers: {} }),
      parseResponse: () => '',
      invokeCli: async () => { throw new Error('daemon spawn failed'); },
    };
    const { adapter } = makeCapture();

    await assert.rejects(
      dispatchChat(provider, adapter, { model: 'm', messages: [] }, { apiKey: 'k' }),
      /daemon spawn failed/,
    );
  });
});
