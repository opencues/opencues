/**
 * Per-provider request/response shape tests.
 *
 * Each provider gets a request-shape test (URL, body, headers) and a
 * response-shape test (extract assistant text from the wire format).
 * The shapes are stable contracts — if a real provider changes its API
 * we'd update the adapter; tests here pin the SHAPE we send/expect.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  buildProviderRequest,
  parseProviderResponse,
  getProvider,
  listProviders,
  resolveLLM,
  withFallback,
  PROVIDER_IDS,
  _resetWarnDedupForTesting,
} from './llm-provider';

describe('groq provider — OpenAI-compatible (the back-compat default)', () => {
  it('buildRequest: chat-completions URL, bearer auth, OpenAI body', () => {
    const built = buildProviderRequest(
      'groq',
      {
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: 'hi' }],
        // Use reasoningEffort='none' so the gpt-oss reasoning-floor
        // doesn't kick in — this test pins the BASE body shape, not the
        // floor behaviour (the dedicated floor test below covers that).
        maxTokens: 100, temperature: 0, seed: 42, reasoningEffort: 'none',
      },
      { apiKey: 'gsk_test' },
    );
    assert.strictEqual(built.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.deepStrictEqual(built.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer gsk_test' });
    const body = JSON.parse(built.body);
    assert.deepStrictEqual(body, {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100, temperature: 0, seed: 42, reasoning_effort: 'none',
    });
  });

  it('buildRequest: floors max_tokens to 2048 on gpt-oss when reasoning is on (any level)', () => {
    // Caught 2026-05-18 via the agentic harness: with the previous
    // narrow floor (`reasoning === 'high'` only), sentence-cues calling
    // cerebras-gpt-oss-120b with reasoning='medium' at maxTokens=768
    // were returning empty content in ~150ms — reasoning ate the
    // budget before output emitted. The floor now fires for any
    // reasoning level that's actually on (medium, low, high — not
    // 'none' or undefined). 2048 matches the proven floor from the
    // thinking-budget bench at high; it's enough headroom for every
    // reasoning level on gpt-oss-120b.
    for (const reasoning of ['low', 'medium', 'high'] as const) {
      const built = buildProviderRequest(
        'groq',
        {
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'user', content: 'x' }],
          maxTokens: 768, reasoningEffort: reasoning,
        },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.max_tokens, 2048, `expected 2048 floor at reasoning=${reasoning}`);
    }
  });

  it('buildRequest: does NOT floor max_tokens when reasoning is none / undefined on gpt-oss', () => {
    // Reasoning explicitly off → caller's budget honoured. Pins the
    // negative side of the floor so the rule doesn't drift into a
    // blanket override.
    const built = buildProviderRequest(
      'groq',
      {
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 256, reasoningEffort: 'none',
      },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.max_tokens, 256);
  });

  it('buildRequest: honours endpoint override', () => {
    const built = buildProviderRequest(
      'groq',
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { apiKey: 'k', endpoint: 'https://custom.example/v1/chat/completions' },
    );
    assert.strictEqual(built.url, 'https://custom.example/v1/chat/completions');
  });

  it('parseResponse: extracts choices[0].message.content', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: 'hello' } }] });
    assert.strictEqual(parseProviderResponse('groq', raw), 'hello');
  });

  it('parseResponse: throws on { error }', () => {
    const raw = JSON.stringify({ error: { message: 'rate limited' } });
    assert.throws(() => parseProviderResponse('groq', raw), /rate limited/);
  });
});

describe('openrouter provider — OpenAI-shape with attribution headers', () => {
  it('buildRequest: openrouter URL + recommended headers', () => {
    const built = buildProviderRequest(
      'openrouter',
      { model: 'deepseek/deepseek-chat-v3.1', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'or_test' },
    );
    assert.strictEqual(built.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(built.headers.Authorization, 'Bearer or_test');
    assert.strictEqual(built.headers['HTTP-Referer'], 'https://opencues.dev');
    assert.strictEqual(built.headers['X-Title'], 'OpenCues');
  });

  it('parseResponse: same OpenAI shape', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: 'open' } }] });
    assert.strictEqual(parseProviderResponse('openrouter', raw), 'open');
  });
});

describe('openai provider — direct OpenAI', () => {
  it('buildRequest: api.openai.com URL, bearer auth', () => {
    const built = buildProviderRequest(
      'openai',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'sk_test' },
    );
    assert.strictEqual(built.url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(built.headers.Authorization, 'Bearer sk_test');
  });

  it('buildRequest: STRIPS reasoning_effort on non-reasoning models (gpt-4o-mini)', () => {
    // OpenAI's chat-completions endpoint 400s on `reasoning_effort`
    // for non-reasoning models. We must not forward it.
    const built = buildProviderRequest(
      'openai',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.reasoning_effort, undefined);
  });

  it('buildRequest: uses `max_completion_tokens` for gpt-5/o-series (legacy `max_tokens` 400s)', () => {
    // o-series and non-nano/mini gpt-5 keep caller-provided max_tokens.
    for (const model of ['o3-mini', 'o1-mini', 'gpt-5.4']) {
      const built = buildProviderRequest(
        'openai',
        { model, messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.max_completion_tokens, 100, `expected max_completion_tokens for ${model}`);
      assert.strictEqual(body.max_tokens, undefined, `legacy max_tokens leaked for ${model}`);
    }
  });

  it('buildRequest: floors max_completion_tokens to 2048 on gpt-5 nano/mini', () => {
    // Even when caller passes a smaller value (100 here), the adapter
    // floors to 2048 because nano/mini reasoning models emit thinking
    // preambles that gobble small budgets — leaving the API to return
    // empty content with finish_reason: length. See May 2026 benchmark
    // sweep: gpt-5.4-mini scored 9.5% on fluid-blank 2-pass because
    // each pass got ~768 tokens and the model emitted nothing.
    for (const model of ['gpt-5.4-nano', 'gpt-5-mini', 'gpt-5.4-mini']) {
      const built = buildProviderRequest(
        'openai',
        { model, messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.max_completion_tokens, 2048, `floored max_completion_tokens for ${model}`);
    }
  });

  it('buildRequest: preserves caller-passed reasoning_effort on gpt-5 nano/mini', () => {
    // Initial design clamped to 'none', but empirical results showed
    // reasoning tokens are doing real work on these models (turning
    // them off dropped transform-blank fused from 85% → 28% on mini).
    // The adapter now passes through whatever the caller sent and only
    // intervenes on max_completion_tokens (floored to 2048).
    for (const model of ['gpt-5.4-nano', 'gpt-5-mini', 'gpt-5.4-mini']) {
      const built = buildProviderRequest(
        'openai',
        { model, messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low', maxTokens: 4096 },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.reasoning_effort, 'low', `preserved reasoning_effort for ${model}`);
    }
  });

  it('buildRequest: full-tier gpt-5/o-series keep caller-passed reasoning_effort', () => {
    // o1/o3 + gpt-5.4 (full) are reasoning-headline models — keep
    // whatever the caller passed so production prompts can still ask
    // for high reasoning when needed.
    for (const model of ['o1-mini', 'o3-mini', 'gpt-5.4']) {
      const built = buildProviderRequest(
        'openai',
        { model, messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low', maxTokens: 4096 },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.reasoning_effort, 'low', `preserved reasoning_effort for ${model}`);
    }
  });

  it('buildRequest: STRIPS `temperature` for gpt-5/o-series (model rejects non-default values)', () => {
    for (const model of ['gpt-5.4-nano', 'o3-mini']) {
      const built = buildProviderRequest(
        'openai',
        { model, messages: [{ role: 'user', content: 'x' }], temperature: 0 },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.temperature, undefined, `temperature leaked for ${model}`);
    }
  });

  it('buildRequest: KEEPS `temperature` for gpt-4o / gpt-4 (model accepts it)', () => {
    const built = buildProviderRequest(
      'openai',
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], temperature: 0.3 },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.temperature, 0.3);
  });

  it('buildRequest: uses legacy `max_tokens` for gpt-4o / gpt-4 (back-compat)', () => {
    for (const model of ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo']) {
      const built = buildProviderRequest(
        'openai',
        { model, messages: [{ role: 'user', content: 'x' }], maxTokens: 100 },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.max_tokens, 100, `expected max_tokens for ${model}`);
      assert.strictEqual(body.max_completion_tokens, undefined, `wrongly upgraded ${model}`);
    }
  });

  it('buildRequest: KEEPS reasoning_effort for OpenAI reasoning models (o1, o3, gpt-5)', () => {
    for (const model of ['o1-mini', 'o3-mini', 'gpt-5-thinking']) {
      const built = buildProviderRequest(
        'openai',
        { model, messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.reasoning_effort, 'low', `expected pass-through for ${model}`);
    }
  });
});

describe('gemini provider — translates to/from Google’s shape', () => {
  it('buildRequest: model in URL path, key in query string, no auth header', () => {
    const built = buildProviderRequest(
      'gemini',
      { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'gem_test' },
    );
    assert.strictEqual(
      built.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=gem_test',
    );
    assert.deepStrictEqual(built.headers, { 'Content-Type': 'application/json' });
  });

  it('buildRequest: maps messages → contents (parts[].text), assistant → model', () => {
    const built = buildProviderRequest(
      'gemini',
      {
        model: 'gemini-3.1-flash-lite',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi back' },
          { role: 'user', content: 'how are you?' },
        ],
      },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.deepStrictEqual(body.contents, [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi back' }] },
      { role: 'user', parts: [{ text: 'how are you?' }] },
    ]);
  });

  it('buildRequest: pulls system message into systemInstruction', () => {
    const built = buildProviderRequest(
      'gemini',
      {
        model: 'gemini-3.1-flash-lite',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'explain X' },
        ],
      },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.deepStrictEqual(body.systemInstruction, { parts: [{ text: 'You are terse.' }] });
    assert.deepStrictEqual(body.contents, [{ role: 'user', parts: [{ text: 'explain X' }] }]);
  });

  it('buildRequest: maxTokens/temperature → generationConfig', () => {
    const built = buildProviderRequest(
      'gemini',
      { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'x' }], maxTokens: 256, temperature: 0.2 },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.deepStrictEqual(body.generationConfig, { maxOutputTokens: 256, temperature: 0.2 });
  });

  it('buildRequest: omits OpenAI-only knobs (seed, reasoningEffort)', () => {
    const built = buildProviderRequest(
      'gemini',
      { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'x' }], seed: 42, reasoningEffort: 'low' },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.seed, undefined);
    assert.strictEqual(body.reasoning_effort, undefined);
  });

  it('parseResponse: extracts candidates[0].content.parts[].text', () => {
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello world' }] } }] });
    assert.strictEqual(parseProviderResponse('gemini', raw), 'hello world');
  });

  it('parseResponse: concatenates multiple parts', () => {
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'one ' }, { text: 'two' }] } }] });
    assert.strictEqual(parseProviderResponse('gemini', raw), 'one two');
  });

  it('parseResponse: throws on { error }', () => {
    const raw = JSON.stringify({ error: { message: 'invalid api key' } });
    assert.throws(() => parseProviderResponse('gemini', raw), /invalid api key/);
  });

  it('parseResponse: throws on safety-blocked output', () => {
    const raw = JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } });
    assert.throws(() => parseProviderResponse('gemini', raw), /SAFETY/);
  });

  it('buildRequest: model name with slash gets URL-encoded', () => {
    const built = buildProviderRequest(
      'gemini',
      { model: 'tunedModels/foo/bar', messages: [{ role: 'user', content: 'x' }] },
      { apiKey: 'k' },
    );
    assert.match(built.url, /tunedModels%2Ffoo%2Fbar/);
  });
});

describe('cerebras provider — OpenAI-shape, low-latency wafer-scale host', () => {
  it('buildRequest: cerebras URL + bearer auth + OpenAI body', () => {
    const built = buildProviderRequest(
      'cerebras',
      { model: 'qwen-3-235b-a22b-instruct-2507', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'csk_test' },
    );
    assert.strictEqual(built.url, 'https://api.cerebras.ai/v1/chat/completions');
    assert.strictEqual(built.headers.Authorization, 'Bearer csk_test');
    const body = JSON.parse(built.body);
    assert.strictEqual(body.model, 'qwen-3-235b-a22b-instruct-2507');
    assert.ok(Array.isArray(body.messages));
  });

  it('buildRequest: forwards reasoning_effort for gpt-oss models', () => {
    const built = buildProviderRequest(
      'cerebras',
      { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'low' },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.reasoning_effort, 'low');
  });

  it('parseResponse: OpenAI-shape (choices[0].message.content)', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: 'fast' } }] });
    assert.strictEqual(parseProviderResponse('cerebras', raw), 'fast');
  });
});

describe('anthropic provider — Messages API (different shape from OpenAI)', () => {
  it('buildRequest: /v1/messages URL, x-api-key header, anthropic-version, browser-access header', () => {
    const built = buildProviderRequest(
      'anthropic',
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'sk-ant-test' },
    );
    assert.strictEqual(built.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(built.headers['x-api-key'], 'sk-ant-test');
    assert.strictEqual(built.headers['anthropic-version'], '2023-06-01');
    // Required for Chrome-extension fetch() — server-side ignores it.
    assert.strictEqual(built.headers['anthropic-dangerous-direct-browser-access'], 'true');
    // No bearer auth — Anthropic uses x-api-key, not Authorization.
    assert.strictEqual(built.headers.Authorization, undefined);
  });

  it('buildRequest: system message goes to top-level `system`, not `messages`', () => {
    const built = buildProviderRequest(
      'anthropic',
      {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'explain X' },
        ],
      },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.system, 'You are terse.');
    assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'explain X' }]);
  });

  it('buildRequest: multiple system messages are joined with \\n\\n', () => {
    const built = buildProviderRequest(
      'anthropic',
      {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'Rule 1' },
          { role: 'system', content: 'Rule 2' },
          { role: 'user', content: 'go' },
        ],
      },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.system, 'Rule 1\n\nRule 2');
  });

  it('buildRequest: max_tokens defaulted to 1024 when caller omits it', () => {
    // Anthropic REQUIRES max_tokens — request fails outright otherwise.
    const built = buildProviderRequest(
      'anthropic',
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.max_tokens, 1024);
  });

  it('buildRequest: caller-provided max_tokens overrides the default', () => {
    const built = buildProviderRequest(
      'anthropic',
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }], maxTokens: 4096 },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.max_tokens, 4096);
  });

  it('buildRequest: omits OpenAI-only knobs (seed, reasoningEffort)', () => {
    const built = buildProviderRequest(
      'anthropic',
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }], seed: 42, reasoningEffort: 'low' },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.seed, undefined);
    assert.strictEqual(body.reasoning_effort, undefined);
  });

  it('parseResponse: extracts content[].text blocks, concatenated', () => {
    const raw = JSON.stringify({
      content: [
        { type: 'text', text: 'Hello, ' },
        { type: 'text', text: 'world!' },
      ],
      stop_reason: 'end_turn',
    });
    assert.strictEqual(parseProviderResponse('anthropic', raw), 'Hello, world!');
  });

  it('parseResponse: ignores non-text blocks (tool_use, thinking)', () => {
    const raw = JSON.stringify({
      content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: 'visible answer' },
        { type: 'tool_use', name: 'foo', input: {} },
      ],
    });
    assert.strictEqual(parseProviderResponse('anthropic', raw), 'visible answer');
  });

  it('parseResponse: throws on { error }', () => {
    const raw = JSON.stringify({ error: { type: 'invalid_request_error', message: 'invalid api key' } });
    assert.throws(() => parseProviderResponse('anthropic', raw), /invalid api key/);
  });

  it('parseResponse: throws on { type: "error" } envelope', () => {
    const raw = JSON.stringify({ type: 'error', error: { message: 'overloaded' } });
    assert.throws(() => parseProviderResponse('anthropic', raw), /overloaded|error/);
  });
});

describe('getProvider / listProviders / PROVIDER_IDS', () => {
  it('getProvider returns null for unknown id', () => {
    assert.strictEqual(getProvider('not-a-provider'), null);
    assert.strictEqual(getProvider(''), null);
    assert.strictEqual(getProvider(null), null);
    assert.strictEqual(getProvider(undefined), null);
  });

  it('listProviders covers every PROVIDER_ID', () => {
    assert.deepStrictEqual(
      listProviders().map((p) => p.id).sort(),
      [...PROVIDER_IDS].sort(),
    );
  });

  it('every provider has a working defaults round-trip', () => {
    for (const id of PROVIDER_IDS) {
      const p = getProvider(id);
      assert.ok(p, `provider missing: ${id}`);
      const built = p!.buildRequest(
        { model: p!.defaultModel, messages: [{ role: 'user', content: 'x' }] },
        { apiKey: 'test' },
      );
      assert.match(built.url, /^https:\/\//);
      assert.ok(built.body.length > 0);
    }
  });
});

describe('resolveLLM — settings-hierarchy precedence', () => {
  const apiKeys = {
    GROQ_API_KEY: 'groq_k',
    OPENROUTER_API_KEY: 'or_k',
    GEMINI_API_KEY: 'gem_k',
    OPENAI_API_KEY: 'oai_k',
    ANTHROPIC_API_KEY: 'ant_k',
    CEREBRAS_API_KEY: 'cere_k',
  };

  it('per-source override wins over feature + global', () => {
    const r = resolveLLM({
      providerOverride: 'gemini',
      modelOverride: 'gemini-3.1-flash-lite',
      featureProvider: 'openrouter',
      featureModel: 'deepseek/deepseek-chat',
      globalProvider: 'groq',
      globalModel: 'openai/gpt-oss-120b',
      apiKeys,
    });
    assert.strictEqual(r?.provider.id, 'gemini');
    assert.strictEqual(r?.model, 'gemini-3.1-flash-lite');
    assert.strictEqual(r?.apiKey, 'gem_k');
  });

  it('feature wins over global when no per-source', () => {
    const r = resolveLLM({
      featureProvider: 'openrouter',
      featureModel: 'deepseek/foo',
      globalProvider: 'groq',
      globalModel: 'openai/gpt-oss-120b',
      apiKeys,
    });
    assert.strictEqual(r?.provider.id, 'openrouter');
    assert.strictEqual(r?.model, 'deepseek/foo');
    assert.strictEqual(r?.apiKey, 'or_k');
  });

  it('global wins when nothing more specific is set', () => {
    const r = resolveLLM({ globalProvider: 'openai', globalModel: 'gpt-4o-mini', apiKeys });
    assert.strictEqual(r?.provider.id, 'openai');
    assert.strictEqual(r?.model, 'gpt-4o-mini');
    assert.strictEqual(r?.apiKey, 'oai_k');
  });

  it('falls through to cerebras + provider default model when nothing set', () => {
    // Default flipped from groq → cerebras after May 2026 benchmark sweep
    // (see resolveLLM's inline note). Same gpt-oss-120b model, faster
    // per-call latency. Override globally with `llm-provider: groq` if
    // you want the old default behaviour.
    const r = resolveLLM({ apiKeys });
    assert.strictEqual(r?.provider.id, 'cerebras');
    assert.strictEqual(r?.model, 'gpt-oss-120b');
  });

  it('per-source provider override pulls THAT provider’s default model', () => {
    const r = resolveLLM({
      providerOverride: 'gemini',
      globalProvider: 'groq',
      globalModel: 'openai/gpt-oss-120b',
      apiKeys,
    });
    assert.strictEqual(r?.provider.id, 'gemini');
    assert.strictEqual(r?.model, 'gemini-3.1-flash-lite');
  });

  it('returns null when the resolved provider has no api key', () => {
    const r = resolveLLM({
      providerOverride: 'gemini',
      apiKeys: { GROQ_API_KEY: 'g' },
    });
    assert.strictEqual(r, null);
  });

  it('returns null on unknown provider id', () => {
    const r = resolveLLM({ providerOverride: 'not-a-real-provider', apiKeys });
    assert.strictEqual(r, null);
  });

  it('per-feature provider override does NOT inherit a less-specific tier’s model', () => {
    const r = resolveLLM({
      featureProvider: 'gemini',
      globalProvider: 'groq',
      globalModel: 'openai/gpt-oss-120b',
      apiKeys,
    });
    assert.strictEqual(r?.provider.id, 'gemini');
    assert.strictEqual(r?.model, 'gemini-3.1-flash-lite');
  });

  it('per-source modelOverride applies to globally-set provider (model-only override)', () => {
    const r = resolveLLM({
      modelOverride: 'openai/gpt-oss-120b',
      globalProvider: 'groq',
      globalModel: 'openai/gpt-oss-20b',
      apiKeys,
    });
    assert.strictEqual(r?.provider.id, 'groq');
    assert.strictEqual(r?.model, 'openai/gpt-oss-120b');
  });

  it('anthropic provider resolves to ANTHROPIC_API_KEY + claude default', () => {
    const r = resolveLLM({ providerOverride: 'anthropic', apiKeys });
    assert.strictEqual(r?.provider.id, 'anthropic');
    assert.strictEqual(r?.apiKey, 'ant_k');
    assert.strictEqual(r?.model, 'claude-haiku-4-5-20251001');
    assert.strictEqual(r?.endpoint, 'https://api.anthropic.com/v1/messages');
  });

  it('endpointOverride passes through; otherwise picks provider default', () => {
    const r1 = resolveLLM({ providerOverride: 'groq', apiKeys });
    assert.strictEqual(r1?.endpoint, 'https://api.groq.com/openai/v1/chat/completions');
    const r2 = resolveLLM({ providerOverride: 'groq', endpointOverride: 'https://custom/v1/chat/completions', apiKeys });
    assert.strictEqual(r2?.endpoint, 'https://custom/v1/chat/completions');
  });
});

// ---------------------------------------------------------------------
// AUTO-ROUTE: when NO tier is set, pick the best provider FROM THE
// KEYS THE USER ACTUALLY HAS. Preference order is PROVIDER_AUTO_ORDER
// (cerebras > groq > gemini > anthropic > openai). Explicit overrides
// at any tier bypass auto-route — those paths are covered by the
// "settings-hierarchy precedence" suite above.
// ---------------------------------------------------------------------

describe('resolveLLM — auto-route over present keys', () => {
  it('picks cerebras when only CEREBRAS_API_KEY is set', () => {
    const r = resolveLLM({ apiKeys: { CEREBRAS_API_KEY: 'c' } });
    assert.strictEqual(r?.provider.id, 'cerebras');
    assert.strictEqual(r?.model, 'gpt-oss-120b');
  });

  it('picks groq when only GROQ_API_KEY is set', () => {
    const r = resolveLLM({ apiKeys: { GROQ_API_KEY: 'g' } });
    assert.strictEqual(r?.provider.id, 'groq');
    assert.strictEqual(r?.model, 'openai/gpt-oss-120b');
  });

  it('picks gemini + gemini-3.1-flash-lite when only GEMINI_API_KEY is set', () => {
    const r = resolveLLM({ apiKeys: { GEMINI_API_KEY: 'gm' } });
    assert.strictEqual(r?.provider.id, 'gemini');
    assert.strictEqual(r?.model, 'gemini-3.1-flash-lite');
  });

  it('picks anthropic + claude-haiku when only ANTHROPIC_API_KEY is set', () => {
    const r = resolveLLM({ apiKeys: { ANTHROPIC_API_KEY: 'a' } });
    assert.strictEqual(r?.provider.id, 'anthropic');
    assert.strictEqual(r?.model, 'claude-haiku-4-5-20251001');
  });

  it('picks openai + gpt-5.4-mini when only OPENAI_API_KEY is set (graceful degradation)', () => {
    const r = resolveLLM({ apiKeys: { OPENAI_API_KEY: 'o' } });
    assert.strictEqual(r?.provider.id, 'openai');
    assert.strictEqual(r?.model, 'gpt-5.4-mini');
  });

  // Each auto-picked provider should also expose its own endpoint + API
  // key. Locks in the wiring between PROVIDER_AUTO_ORDER (preference)
  // and PROVIDERS (adapter metadata) — adding a new provider without
  // updating its adapter would surface here as a test failure rather
  // than a runtime "key not found" silent no-op.
  it('auto-picked provider returns the matching apiKey, endpoint, and defaultModel', () => {
    const cases = [
      { keys: { CEREBRAS_API_KEY: 'c' }, want: { id: 'cerebras', model: 'gpt-oss-120b', endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: 'c' } },
      { keys: { GROQ_API_KEY: 'g' },     want: { id: 'groq',     model: 'openai/gpt-oss-120b', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: 'g' } },
      { keys: { GEMINI_API_KEY: 'gm' },  want: { id: 'gemini',   model: 'gemini-3.1-flash-lite', apiKey: 'gm' } }, // gemini endpoint includes model name — checked separately
      { keys: { ANTHROPIC_API_KEY: 'a' }, want: { id: 'anthropic', model: 'claude-haiku-4-5-20251001', endpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'a' } },
      { keys: { OPENAI_API_KEY: 'o' },   want: { id: 'openai',   model: 'gpt-5.4-mini', endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'o' } },
    ];
    for (const c of cases) {
      const r = resolveLLM({ apiKeys: c.keys });
      assert.ok(r, `auto-route should produce a result for ${JSON.stringify(c.keys)}`);
      assert.strictEqual(r.provider.id, c.want.id);
      assert.strictEqual(r.model, c.want.model);
      assert.strictEqual(r.apiKey, c.want.apiKey);
      if (c.want.endpoint) assert.strictEqual(r.endpoint, c.want.endpoint);
    }
  });

  // Per-feature provider overrides should also pull THAT provider's
  // default model when no per-feature model is set — verifies the
  // auto-route logic respects feature-tier provider picks too.
  it('per-feature provider override pulls THAT provider’s defaultModel', () => {
    const allKeys = { CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'gm', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
    const cases = [
      { feat: 'cerebras',  model: 'gpt-oss-120b' },
      { feat: 'groq',      model: 'openai/gpt-oss-120b' },
      { feat: 'gemini',    model: 'gemini-3.1-flash-lite' },
      { feat: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      { feat: 'openai',    model: 'gpt-5.4-mini' },
    ];
    for (const c of cases) {
      const r = resolveLLM({ featureProvider: c.feat, apiKeys: allKeys });
      assert.strictEqual(r?.provider.id, c.feat, `featureProvider=${c.feat}`);
      assert.strictEqual(r?.model, c.model, `featureProvider=${c.feat} → defaultModel`);
    }
  });

  it('prefers cerebras over groq when both are present (typical setup)', () => {
    const r = resolveLLM({ apiKeys: { CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g' } });
    assert.strictEqual(r?.provider.id, 'cerebras');
  });

  it('prefers cerebras over claude when both are present', () => {
    const r = resolveLLM({ apiKeys: { CEREBRAS_API_KEY: 'c', ANTHROPIC_API_KEY: 'a' } });
    assert.strictEqual(r?.provider.id, 'cerebras');
  });

  it('prefers groq over gemini over claude over openai (full chain, no cerebras key)', () => {
    const r = resolveLLM({
      apiKeys: { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'gm', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
    });
    assert.strictEqual(r?.provider.id, 'groq');
  });

  it('global override beats auto-route — gemini wins even when cerebras key present', () => {
    const r = resolveLLM({
      globalProvider: 'gemini',
      apiKeys: { CEREBRAS_API_KEY: 'c', GEMINI_API_KEY: 'gm' },
    });
    assert.strictEqual(r?.provider.id, 'gemini');
  });

  it('per-feature override beats auto-route', () => {
    const r = resolveLLM({
      featureProvider: 'anthropic',
      apiKeys: { CEREBRAS_API_KEY: 'c', ANTHROPIC_API_KEY: 'a' },
    });
    assert.strictEqual(r?.provider.id, 'anthropic');
  });

  it('returns null when no provider is configured AND no keys are set', () => {
    const r = resolveLLM({ apiKeys: {} });
    assert.strictEqual(r, null);
  });
});

describe('resolveLLM — auto-fallback (groq ↔ cerebras pairing)', () => {
  const apiKeys = {
    GROQ_API_KEY: 'groq_k',
    CEREBRAS_API_KEY: 'cere_k',
    OPENAI_API_KEY: 'oai_k',
    ANTHROPIC_API_KEY: 'ant_k',
  };

  it('resolved groq attaches a cerebras fallback when CEREBRAS_API_KEY is set', () => {
    const r = resolveLLM({ providerOverride: 'groq', apiKeys });
    assert.strictEqual(r?.provider.id, 'groq');
    assert.strictEqual(r?.fallback?.provider.id, 'cerebras');
    assert.strictEqual(r?.fallback?.apiKey, 'cere_k');
    // Model name was translated (groq's "openai/gpt-oss-120b" → cerebras's "gpt-oss-120b").
    assert.strictEqual(r?.fallback?.model, 'gpt-oss-120b');
  });

  it('resolved cerebras attaches a groq fallback when GROQ_API_KEY is set', () => {
    const r = resolveLLM({ providerOverride: 'cerebras', apiKeys });
    assert.strictEqual(r?.provider.id, 'cerebras');
    assert.strictEqual(r?.fallback?.provider.id, 'groq');
    assert.strictEqual(r?.fallback?.apiKey, 'groq_k');
    assert.strictEqual(r?.fallback?.model, 'openai/gpt-oss-120b');
  });

  it('groq with no CEREBRAS_API_KEY → no fallback', () => {
    const r = resolveLLM({ providerOverride: 'groq', apiKeys: { GROQ_API_KEY: 'g' } });
    assert.strictEqual(r?.provider.id, 'groq');
    assert.strictEqual(r?.fallback ?? null, null);
  });

  it('non-paired providers (openai, anthropic, gemini, openrouter) get no fallback', () => {
    for (const id of ['openai', 'anthropic'] as const) {
      const r = resolveLLM({ providerOverride: id, apiKeys });
      assert.ok(r, `expected resolve for ${id}`);
      assert.strictEqual(r?.fallback ?? null, null, `${id} should not auto-pair across wire shapes`);
    }
  });
});

describe('withFallback — HTTP adapter wrapper', () => {
  function makeAdapter(responses: Array<{ url: string; body: string; status?: number }>) {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    let i = 0;
    return {
      adapter: {
        post: async (url: string, body: string, headers: Record<string, string>): Promise<string> => {
          calls.push({ url, body, headers });
          const r = responses[i] ?? responses[responses.length - 1];
          i += 1;
          if (r.status && r.status >= 400) throw new Error(`HTTP ${r.status}`);
          return r.body;
        },
      },
      calls,
    };
  }
  const fallback = {
    provider: getProvider('cerebras')!,
    model: 'gpt-oss-120b',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'cere_k',
  };

  it('passes through when primary returns a healthy body', async () => {
    const { adapter, calls } = makeAdapter([{ url: '', body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }]);
    const wrapped = withFallback(adapter, fallback);
    const result = await wrapped.post('https://groq', '{"model":"openai/gpt-oss-120b"}', { Authorization: 'Bearer groq_k' });
    assert.match(result, /"content":"ok"/);
    assert.strictEqual(calls.length, 1);                          // no fallback retry
  });

  it('retries against fallback on rate-limit body (Cerebras 429 shape)', async () => {
    const { adapter, calls } = makeAdapter([
      { url: '', body: '{"message":"too_many_requests","type":"too_many_requests_error","code":"queue_exceeded"}' },
      { url: '', body: JSON.stringify({ choices: [{ message: { content: 'cerebras-success' } }] }) },
    ]);
    const wrapped = withFallback(adapter, fallback);
    const result = await wrapped.post('https://groq', '{"model":"openai/gpt-oss-120b"}', { Authorization: 'Bearer groq_k' });
    assert.match(result, /cerebras-success/);
    assert.strictEqual(calls.length, 2);
    // Fallback URL hit + bearer rewritten + model rewritten.
    assert.strictEqual(calls[1].url, 'https://api.cerebras.ai/v1/chat/completions');
    assert.strictEqual(calls[1].headers.Authorization, 'Bearer cere_k');
    assert.match(calls[1].body, /"model":"gpt-oss-120b"/);
  });

  it('retries against fallback on 5xx-ish body (e.g. service_unavailable)', async () => {
    const { adapter, calls } = makeAdapter([
      { url: '', body: '{"error":{"code":503,"message":"service_unavailable"}}' },
      { url: '', body: JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }) },
    ]);
    const wrapped = withFallback(adapter, fallback);
    const result = await wrapped.post('https://groq', '{"model":"openai/gpt-oss-120b"}', {});
    assert.match(result, /recovered/);
    assert.strictEqual(calls.length, 2);
  });

  it('retries against fallback on empty body (timeout / EOF)', async () => {
    const { adapter, calls } = makeAdapter([
      { url: '', body: '' },
      { url: '', body: JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }) },
    ]);
    const wrapped = withFallback(adapter, fallback);
    await wrapped.post('https://groq', '{"model":"openai/gpt-oss-120b"}', {});
    assert.strictEqual(calls.length, 2);
  });

  it('retries against fallback on thrown network error', async () => {
    const calls: Array<{ url: string }> = [];
    let i = 0;
    const adapter = {
      post: async (url: string, _b: string, _h: Record<string, string>): Promise<string> => {
        calls.push({ url });
        i += 1;
        if (i === 1) throw new Error('ECONNRESET');
        return JSON.stringify({ choices: [{ message: { content: 'recovered' } }] });
      },
    };
    const wrapped = withFallback(adapter, fallback);
    const result = await wrapped.post('https://groq', '{"model":"openai/gpt-oss-120b"}', {});
    assert.match(result, /recovered/);
    assert.strictEqual(calls.length, 2);
  });

  it('returns primary body when both primary AND fallback fail (no error masking)', async () => {
    const { adapter } = makeAdapter([
      { url: '', body: '{"code":429,"message":"rate_limited"}' },
      { url: '', body: '{"code":429,"message":"also_rate_limited"}' },
    ]);
    const wrapped = withFallback(adapter, fallback);
    const result = await wrapped.post('https://groq', '{"model":"openai/gpt-oss-120b"}', {});
    // Both transient → return primary's body so caller sees the original error.
    assert.match(result, /rate_limited/);
  });

  it('no-op when fallback is null (returns base adapter unchanged)', async () => {
    const { adapter, calls } = makeAdapter([{ url: '', body: 'whatever' }]);
    const wrapped = withFallback(adapter, null);
    assert.strictEqual(wrapped, adapter);                          // identity — no proxy created
    await wrapped.post('https://x', 'b', {});
    assert.strictEqual(calls.length, 1);
  });

  it('does NOT retry when primary returns a non-transient client error (e.g. 400 in body)', async () => {
    // 400 (e.g. invalid_request_error) means the request was malformed —
    // retrying on the fallback would just fail the same way. Don't.
    const { adapter, calls } = makeAdapter([
      { url: '', body: '{"error":{"type":"invalid_request_error","message":"bad input"}}' },
    ]);
    const wrapped = withFallback(adapter, fallback);
    await wrapped.post('https://groq', '{"model":"openai/gpt-oss-120b"}', {});
    assert.strictEqual(calls.length, 1, 'should not retry on 400-class client error');
  });
});

// ---------------------------------------------------------------------
// Misconfiguration warnings — silent-no-op was the failure mode that
// caused the May 2026 chrome regression where `llm-provider: gemini`
// in CUES.md returned null from resolveLLM without any signal. These
// tests pin the warn-once contract on the three failure shapes:
//   1. provider chosen but key missing
//   2. provider name typo'd
//   3. no provider configured (NO warn — that's "no LLM yet" not "broken")
// ---------------------------------------------------------------------

function captureWarn(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
  return { warnings, restore: () => { console.warn = original; } };
}

describe('resolveLLM — misconfiguration warnings (silent-no-op regressors)', () => {
  it('warns once when a chosen provider has no API key', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      const result = resolveLLM({
        globalProvider: 'gemini',
        apiKeys: { GROQ_API_KEY: 'g' }, // gemini key missing
      });
      assert.strictEqual(result, null);
      assert.strictEqual(warnings.length, 1, 'first call should warn');
      assert.match(warnings[0], /gemini/);
      assert.match(warnings[0], /GEMINI_API_KEY/);
      assert.match(warnings[0], /silently do nothing/);

      // Second call same (provider, envvar) → no duplicate warning.
      resolveLLM({ globalProvider: 'gemini', apiKeys: { GROQ_API_KEY: 'g' } });
      assert.strictEqual(warnings.length, 1, 'dedup — second call should not warn');
    } finally { restore(); }
  });

  it('warns once per UNIQUE provider missing-key combo', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      resolveLLM({ globalProvider: 'gemini', apiKeys: {} });
      resolveLLM({ globalProvider: 'anthropic', apiKeys: {} });
      resolveLLM({ globalProvider: 'gemini', apiKeys: {} });    // dedup
      resolveLLM({ globalProvider: 'anthropic', apiKeys: {} }); // dedup
      assert.strictEqual(warnings.length, 2);
      assert.match(warnings[0], /gemini/);
      assert.match(warnings[1], /anthropic/);
    } finally { restore(); }
  });

  it('warns once on unknown provider name (typo path)', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      // getProvider used directly
      const p = getProvider('gimini');
      assert.strictEqual(p, null);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /unknown provider "gimini"/);
      assert.match(warnings[0], /Known providers:/);

      // Second call same typo → no dup
      getProvider('gimini');
      assert.strictEqual(warnings.length, 1);
    } finally { restore(); }
  });

  it('warns via resolveLLM when provider name is unknown', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      const result = resolveLLM({ globalProvider: 'nonsense', apiKeys: {} });
      assert.strictEqual(result, null);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /unknown provider "nonsense"/);
    } finally { restore(); }
  });

  it('does NOT warn when NO provider is configured (defaulted to cerebras, no cerebras key)', () => {
    // "User hasn't configured an LLM yet" is a legitimate state — every
    // LLM-driven cue/blank gracefully no-ops. We don't want to spam
    // warnings on every keystroke in that mode; the boot-time
    // verifyLlmKeyAtBoot (chrome) / doctor (CLI) handle that case once.
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      const result = resolveLLM({ apiKeys: {} });
      assert.strictEqual(result, null);
      assert.strictEqual(warnings.length, 0, 'no provider configured ≠ misconfiguration');
    } finally { restore(); }
  });

  it('does NOT warn when the chosen provider HAS its key (happy path)', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      const result = resolveLLM({
        globalProvider: 'gemini',
        apiKeys: { GEMINI_API_KEY: 'g' },
      });
      assert.notStrictEqual(result, null);
      assert.strictEqual(warnings.length, 0);
    } finally { restore(); }
  });

  it('warns per-tier when per-feature provider override has no key', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      // Global groq works; feature override demands anthropic without a key.
      const result = resolveLLM({
        globalProvider: 'groq',
        featureProvider: 'anthropic',
        apiKeys: { GROQ_API_KEY: 'g' },
      });
      assert.strictEqual(result, null);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /anthropic/);
      assert.match(warnings[0], /ANTHROPIC_API_KEY/);
    } finally { restore(); }
  });
});
