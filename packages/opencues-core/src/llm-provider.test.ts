/**
 * Per-provider request/response shape tests.
 *
 * Each provider gets a request-shape test (URL, body, headers) and a
 * response-shape test (extract assistant text from the wire format).
 * The shapes are stable contracts — if a real provider changes its API
 * we'd update the adapter; tests here pin the SHAPE we send/expect.
 */
import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  buildProviderRequest,
  parseProviderResponse,
  getProvider,
  isProviderValueCyclable,
  listProviders,
  resolveLLM,
  withFallback,
  canonicalizeModelForProvider,
  dispatchChat,
  PROVIDER_IDS,
  _resetWarnDedupForTesting,
  setCliAvailabilityForTests,
  SUBSCRIPTION_AUTO_FALLBACK,
} from './llm-provider';

// Every zero-key expectation in this file models a machine WITHOUT the
// claude/codex binaries — otherwise the developer's real PATH decides
// whether pickAutoProvider's subscription-CLI rung fires and the
// zero-key tests flip per machine. The rung itself is tested with
// injected probes in llm-provider.autofallback.test.ts.
beforeEach(() => {
  for (const id of SUBSCRIPTION_AUTO_FALLBACK) setCliAvailabilityForTests(id, false);
});

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

  it('buildRequest: gates `seed` to native providers — omitted for openrouter pass-through, kept for cerebras', () => {
    // Regression twin of the `prediction` 400 bug: an OpenAI-only field
    // (seed) rode a request that got routed to openrouter (proxying
    // anthropic, which has no `seed` param) and 400'd. seed must only go
    // to providers that natively accept it.
    const req = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100, seed: 42 };
    const orBody = JSON.parse(
      buildProviderRequest('openrouter', { ...req, model: 'anthropic/claude-opus-4-7' }, { apiKey: 'k' }).body,
    );
    assert.strictEqual(orBody.seed, undefined, 'openrouter (anthropic pass-through) must not receive seed');
    for (const p of ['cerebras', 'groq', 'openai'] as const) {
      const body = JSON.parse(buildProviderRequest(p, { ...req, model: 'gpt-oss-120b' }, { apiKey: 'k' }).body);
      assert.strictEqual(body.seed, 42, `${p} natively supports seed`);
    }
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
  it('buildRequest: model in URL path, key in x-goog-api-key header (NOT URL — INFOSEC F8)', () => {
    const built = buildProviderRequest(
      'gemini',
      { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'gem_test' },
    );
    assert.strictEqual(
      built.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    );
    // F8: key MUST NOT appear in URL (access logs / browser history / referrer leak).
    assert.ok(!built.url.includes('gem_test'), 'API key leaked into URL');
    assert.ok(!built.url.includes('key='), 'URL still uses ?key= query param');
    assert.strictEqual(built.headers['x-goog-api-key'], 'gem_test');
    assert.strictEqual(built.headers['Content-Type'], 'application/json');
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

describe('kimi provider — Moonshot AI direct API (OpenAI-shape)', () => {
  it('buildRequest: api.moonshot.ai URL + bearer auth; k2.6 gets max_completion_tokens, NO temperature, thinking disabled', () => {
    const built = buildProviderRequest(
      'kimi',
      { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256, temperature: 0 },
      { apiKey: 'sk-moonshot-test' },
    );
    assert.strictEqual(built.url, 'https://api.moonshot.ai/v1/chat/completions');
    assert.strictEqual(built.headers.Authorization, 'Bearer sk-moonshot-test');
    const body = JSON.parse(built.body);
    assert.strictEqual(body.model, 'kimi-k2.6');
    // Modern kimi models renamed the field and reject `temperature`.
    assert.strictEqual(body.max_completion_tokens, 256);
    assert.strictEqual(body.max_tokens, undefined);
    assert.strictEqual(body.temperature, undefined);
    // Answer-latency floor: thinking disabled on k2.5/k2.6.
    assert.deepStrictEqual(body.thinking, { type: 'disabled' });
  });

  it('buildRequest: kimi-k3 coerces reasoning_effort into the legal low|high set (never medium/none/max-by-default)', () => {
    const cases: ReadonlyArray<['low' | 'medium' | 'high' | undefined, string]> =
      [['low', 'low'], ['medium', 'low'], ['high', 'high'], [undefined, 'low']];
    for (const [given, expected] of cases) {
      const built = buildProviderRequest(
        'kimi',
        { model: 'kimi-k3', messages: [{ role: 'user', content: 'x' }], ...(given ? { reasoningEffort: given } : {}) },
        { apiKey: 'k' },
      );
      const body = JSON.parse(built.body);
      assert.strictEqual(body.reasoning_effort, expected, `reasoningEffort ${given} → ${expected}`);
      assert.strictEqual(body.thinking, undefined);
    }
  });

  it('buildRequest: never emits seed (undocumented on Moonshot)', () => {
    const built = buildProviderRequest(
      'kimi',
      { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'x' }], seed: 7 },
      { apiKey: 'k' },
    );
    assert.strictEqual(JSON.parse(built.body).seed, undefined);
  });

  it('buildRequest: legacy moonshot-v1 keeps the plain OpenAI shape (max_tokens + temperature, no thinking field)', () => {
    const built = buildProviderRequest(
      'kimi',
      { model: 'moonshot-v1-8k', messages: [{ role: 'user', content: 'hi' }], maxTokens: 128, temperature: 0 },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    assert.strictEqual(body.max_tokens, 128);
    assert.strictEqual(body.temperature, 0);
    assert.strictEqual(body.thinking, undefined);
    assert.strictEqual(body.reasoning_effort, undefined);
  });

  it('buildRequest: honours endpoint override (mainland .cn platform)', () => {
    const built = buildProviderRequest(
      'kimi',
      { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'k', endpoint: 'https://api.moonshot.cn/v1/chat/completions' },
    );
    assert.strictEqual(built.url, 'https://api.moonshot.cn/v1/chat/completions');
  });

  it('parseResponse: OpenAI-shape (choices[0].message.content)', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: 'moon' } }] });
    assert.strictEqual(parseProviderResponse('kimi', raw), 'moon');
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
    // System is sent as a content-block array carrying a cache_control
    // breakpoint (Anthropic prompt caching). The user message stays in
    // `messages`, AFTER the cached prefix.
    assert.deepStrictEqual(body.system, [
      { type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } },
    ]);
    assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'explain X' }]);
  });

  it('buildRequest: multiple system messages are joined with \\n\\n inside the cached block', () => {
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
    assert.deepStrictEqual(body.system, [
      { type: 'text', text: 'Rule 1\n\nRule 2', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('buildRequest: prompt caching — system carries a single ephemeral cache_control breakpoint; user message is uncached', () => {
    const built = buildProviderRequest(
      'anthropic',
      {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'big stable system prompt' },
          { role: 'user', content: 'per-call input that must NOT be cached' },
        ],
      },
      { apiKey: 'k' },
    );
    const body = JSON.parse(built.body);
    // Exactly one breakpoint, on the system block — everything up to and
    // including it is the cached prefix; the user turn comes after.
    assert.ok(Array.isArray(body.system));
    assert.strictEqual(body.system.length, 1);
    assert.deepStrictEqual(body.system[0].cache_control, { type: 'ephemeral' });
    // The volatile user message is a plain string in messages — never marked.
    assert.deepStrictEqual(body.messages, [
      { role: 'user', content: 'per-call input that must NOT be cached' },
    ]);
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

  it('every HTTP-transport provider has a working defaults round-trip', () => {
    for (const id of PROVIDER_IDS) {
      const p = getProvider(id);
      assert.ok(p, `provider missing: ${id}`);
      // CLI-transport providers (claude-cli) don't have a buildRequest
      // contract — they go through invokeCli instead. Round-trip the
      // CLI path separately.
      if (p!.transport === 'cli') {
        assert.strictEqual(typeof p!.invokeCli, 'function', `${id}: cli transport missing invokeCli`);
        continue;
      }
      const built = p!.buildRequest(
        { model: p!.defaultModel, messages: [{ role: 'user', content: 'x' }] },
        { apiKey: 'test' },
      );
      // Cloud providers are https; local providers (ollama) talk to a
      // loopback http endpoint by design.
      if (p!.optionalAuth && /^http:\/\/(localhost|127\.0\.0\.1)/.test(built.url)) {
        assert.match(built.url, /^http:\/\/(localhost|127\.0\.0\.1):\d+\//);
      } else {
        assert.match(built.url, /^https:\/\//);
      }
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

  it('`inherit` at the feature tier falls through to global (not treated as a literal provider)', () => {
    // Regression: a per-feature scalar of `inherit` (e.g. word-cues-provider:
    // inherit) used to be looked up as a literal provider → unknown → null →
    // the source was silently dropped ("no API key for provider 'inherit'").
    // It must mean "no override here" and fall through to the global.
    const r = resolveLLM({
      featureProvider: 'inherit',
      featureModel: 'inherit',
      globalProvider: 'cerebras',
      globalModel: 'gemma-4-31b',
      apiKeys,
    });
    assert.strictEqual(r?.provider.id, 'cerebras', 'feature `inherit` must fall through to the global provider');
    assert.strictEqual(r?.model, 'gemma-4-31b', 'feature `inherit` model must fall through to the global model');
    assert.strictEqual(r?.apiKey, 'cere_k');
  });

  it('`inherit` at every tier auto-routes over available keys (never a literal provider)', () => {
    // All tiers `inherit` → equivalent to nothing set → auto-pick (cerebras
    // is first in the auto order and has a key here).
    const r = resolveLLM({
      providerOverride: 'inherit', featureProvider: 'inherit', globalProvider: 'inherit',
      apiKeys,
    });
    assert.strictEqual(r?.provider.id, 'cerebras');
    assert.notStrictEqual(r?.provider.id, undefined);
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
    assert.strictEqual(r?.model, 'gemini-3.5-flash-lite');
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
    assert.strictEqual(r?.model, 'gemini-3.5-flash-lite');
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
// Model CANONICALIZATION — always land on a VALID (provider, model) pair.
// A known cross-namespace alias (gpt-oss: Groq/OpenRouter prefix with
// `openai/`, Cerebras serves it bare) is normalised INTO the resolved
// provider's namespace on the primary dispatch path, so a stale/mistyped
// `llm-model` never ships an invalid pair. Unknown models are left
// untouched so the provider can reject them (surfaced inline elsewhere).
// ---------------------------------------------------------------------

describe('canonicalizeModelForProvider — unit', () => {
  it('strips the openai/ prefix from gpt-oss for Cerebras (bare namespace)', () => {
    assert.strictEqual(canonicalizeModelForProvider('cerebras', 'openai/gpt-oss-120b'), 'gpt-oss-120b');
    assert.strictEqual(canonicalizeModelForProvider('cerebras', 'openai/gpt-oss-20b'), 'gpt-oss-20b');
  });
  it('adds the openai/ prefix to bare gpt-oss for Groq / OpenRouter', () => {
    assert.strictEqual(canonicalizeModelForProvider('groq', 'gpt-oss-120b'), 'openai/gpt-oss-120b');
    assert.strictEqual(canonicalizeModelForProvider('openrouter', 'gpt-oss-120b'), 'openai/gpt-oss-120b');
  });
  it('leaves the provider native default and unknown models untouched', () => {
    assert.strictEqual(canonicalizeModelForProvider('cerebras', 'gpt-oss-120b'), 'gpt-oss-120b');
    assert.strictEqual(canonicalizeModelForProvider('groq', 'openai/gpt-oss-120b'), 'openai/gpt-oss-120b');
    assert.strictEqual(canonicalizeModelForProvider('cerebras', 'some-future-model'), 'some-future-model');
    assert.strictEqual(canonicalizeModelForProvider('gemini', 'gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
  });
});

describe('resolveLLM — canonicalizes to a valid pair on the primary path', () => {
  it('heals a stale openai/gpt-oss-120b paired with Cerebras → bare gpt-oss-120b', () => {
    // The exact production footgun: a Groq-namespaced model name carried
    // alongside the Cerebras provider must NOT ship invalid.
    const r = resolveLLM({
      providerOverride: 'cerebras',
      modelOverride: 'openai/gpt-oss-120b',
      apiKeys: { CEREBRAS_API_KEY: 'c' },
    });
    assert.strictEqual(r?.provider.id, 'cerebras');
    assert.strictEqual(r?.model, 'gpt-oss-120b');
  });
  it('heals a bare gpt-oss-120b paired with Groq → openai/gpt-oss-120b', () => {
    const r = resolveLLM({
      providerOverride: 'groq',
      modelOverride: 'gpt-oss-120b',
      apiKeys: { GROQ_API_KEY: 'g' },
    });
    assert.strictEqual(r?.provider.id, 'groq');
    assert.strictEqual(r?.model, 'openai/gpt-oss-120b');
  });
  it('heals a stale globalModel too (no explicit provider tier, auto-route to Cerebras)', () => {
    const r = resolveLLM({
      globalModel: 'openai/gpt-oss-120b',
      apiKeys: { CEREBRAS_API_KEY: 'c' },
    });
    assert.strictEqual(r?.provider.id, 'cerebras');
    assert.strictEqual(r?.model, 'gpt-oss-120b');
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

  it('picks gemini + gemini-3.5-flash-lite when only GEMINI_API_KEY is set', () => {
    const r = resolveLLM({ apiKeys: { GEMINI_API_KEY: 'gm' } });
    assert.strictEqual(r?.provider.id, 'gemini');
    assert.strictEqual(r?.model, 'gemini-3.5-flash-lite');
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
      { keys: { GEMINI_API_KEY: 'gm' },  want: { id: 'gemini',   model: 'gemini-3.5-flash-lite', apiKey: 'gm' } }, // gemini endpoint includes model name — checked separately
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
      { feat: 'gemini',    model: 'gemini-3.5-flash-lite' },
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

describe('resolveLLM — claude-code-cli (CLI-transport, no API key)', () => {
  it('resolves to claude-code-cli with no apiKey + no fallback (auth is external)', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      const result = resolveLLM({
        globalProvider: 'claude-code-cli',
        globalModel: 'haiku',
        apiKeys: {}, // intentionally empty — CLI transport doesn't use apiKeys
      });
      assert.notStrictEqual(result, null);
      assert.strictEqual(result!.provider.id, 'claude-code-cli');
      assert.strictEqual(result!.provider.transport, 'cli');
      assert.strictEqual(result!.model, 'haiku');
      assert.strictEqual(result!.apiKey, '', 'CLI providers carry an empty apiKey');
      assert.strictEqual(result!.fallback, null, 'CLI providers have no HTTP fallback peer');
      assert.strictEqual(warnings.length, 0, 'no warning — CLI auth is intentionally external');
    } finally { restore(); }
  });

  it('per-feature claude-code-cli override resolves without env keys', () => {
    _resetWarnDedupForTesting();
    const result = resolveLLM({
      featureProvider: 'claude-code-cli',
      featureModel: 'sonnet',
      apiKeys: { GROQ_API_KEY: 'unused-here' },
    });
    assert.strictEqual(result?.provider.id, 'claude-code-cli');
    assert.strictEqual(result?.model, 'sonnet');
  });

  it('legacy `claude-cli` id silently resolves to canonical `claude-code-cli`', () => {
    // User configs created before the rename (2026-06-02) keep working.
    _resetWarnDedupForTesting();
    const result = resolveLLM({
      globalProvider: 'claude-cli',  // legacy
      globalModel: 'haiku',
      apiKeys: {},
    });
    assert.strictEqual(result?.provider.id, 'claude-code-cli');
  });

  it('claude-code-cli is NOT auto-picked when only env keys for other providers are set', () => {
    // claude-code-cli is opt-in only — not in PROVIDER_AUTO_ORDER.
    // pickAutoProvider should never return it just because the user has a
    // `claude` install.
    _resetWarnDedupForTesting();
    const result = resolveLLM({
      apiKeys: { CEREBRAS_API_KEY: 'k' }, // cerebras IS in auto-order
    });
    assert.strictEqual(result?.provider.id, 'cerebras', 'auto-route must pick cerebras, not claude-code-cli');
  });
});

describe('resolveLLM — openai-subscription (CLI-transport, no API key)', () => {
  // Separate provider from `openai`. Lets users mix billing paths per
  // feature — `agent-rewrite-provider: openai-subscription` (free, via
  // codex login) alongside `transform-blank-provider: openai` (paid
  // API, full model catalogue).

  it('resolves to openai-subscription with no apiKey + no fallback (auth is external)', () => {
    _resetWarnDedupForTesting();
    const { warnings, restore } = captureWarn();
    try {
      const result = resolveLLM({
        globalProvider: 'openai-subscription',
        apiKeys: {},
      });
      assert.notStrictEqual(result, null);
      assert.strictEqual(result!.provider.id, 'openai-subscription');
      assert.strictEqual(result!.provider.transport, 'cli');
      assert.strictEqual(result!.model, 'gpt-5.4-mini', 'default = fastest subscription-allowed model');
      assert.strictEqual(result!.apiKey, '');
      assert.strictEqual(result!.fallback, null);
      assert.strictEqual(warnings.length, 0);
    } finally { restore(); }
  });

  it('per-feature openai-subscription override resolves without env keys', () => {
    _resetWarnDedupForTesting();
    const result = resolveLLM({
      featureProvider: 'openai-subscription',
      featureModel: 'gpt-5.5',
      apiKeys: { OPENAI_API_KEY: 'sk-unused-here' },
    });
    assert.strictEqual(result?.provider.id, 'openai-subscription');
    assert.strictEqual(result?.model, 'gpt-5.5');
  });

  it('openai-subscription is NOT auto-picked over env-key providers', () => {
    // Subscription auth requires explicit opt-in. A user with codex
    // installed but who set up CEREBRAS_API_KEY should NOT silently get
    // routed to OpenAI's slower subscription path.
    _resetWarnDedupForTesting();
    const result = resolveLLM({ apiKeys: { CEREBRAS_API_KEY: 'k' } });
    assert.strictEqual(result?.provider.id, 'cerebras', 'auto-route picks cerebras, not openai-subscription');
  });
});


describe('isProviderValueCyclable — prevents cycling to a broken (provider, no-key) pair', () => {
  // Pins the "test BEFORE you switch" invariant the user named: the
  // cycling menu must not advertise a provider value the runtime can't
  // actually dispatch with. Mirrors chrome's popup, which already drops
  // un-keyed providers from its dropdown via `isKeyValid()`. The chrome
  // adapter passes `isCliAvailable: undefined` (it can't probe arbitrary
  // binaries), so cli-transport providers are conservatively dropped
  // from its menu — matches its existing behaviour.

  it('inherit is always cyclable (delegates to the global llm-provider with its own auto-route)', () => {
    assert.strictEqual(isProviderValueCyclable('inherit', {}), true);
    assert.strictEqual(isProviderValueCyclable('inherit', { GROQ_API_KEY: 'k' }), true);
  });

  it('http-transport providers require their envKey to be cyclable', () => {
    // groq, cerebras, openai, anthropic, gemini, openrouter — all
    // standard http providers. envKey absent → not cyclable; envKey
    // present → cyclable.
    for (const id of ['groq', 'cerebras', 'openai', 'anthropic', 'gemini', 'openrouter']) {
      const adapter = getProvider(id);
      assert.ok(adapter, `provider missing: ${id}`);
      assert.strictEqual(
        isProviderValueCyclable(id, {}),
        false,
        `${id}: should NOT be cyclable without ${adapter!.envKeyName}`,
      );
      assert.strictEqual(
        isProviderValueCyclable(id, { [adapter!.envKeyName]: 'k' }),
        true,
        `${id}: SHOULD be cyclable with ${adapter!.envKeyName}`,
      );
    }
  });

  it('optionalAuth providers (opencode-zen) are cyclable WITHOUT a key — anonymous free pool', () => {
    assert.strictEqual(isProviderValueCyclable('opencode-zen', {}), true);
    assert.strictEqual(isProviderValueCyclable('opencode-zen', { OPENCODE_ZEN_API_KEY: 'k' }), true);
  });

  it('cli-transport providers cyclable iff isCliAvailable() returns true', () => {
    // No probe supplied → not cyclable (the safe default).
    assert.strictEqual(isProviderValueCyclable('claude-code-cli', {}), false);
    assert.strictEqual(isProviderValueCyclable('openai-subscription', {}), false);
    // Probe says yes → cyclable.
    assert.strictEqual(
      isProviderValueCyclable('claude-code-cli', {}, { isCliAvailable: () => true }),
      true,
    );
    assert.strictEqual(
      isProviderValueCyclable('openai-subscription', {}, { isCliAvailable: () => true }),
      true,
    );
  });

  it('unknown provider id → NOT cyclable', () => {
    // Defensive: if a future PR adds a registry value that doesn't have
    // a corresponding ProviderAdapter, the cycling menu drops it rather
    // than silently committing a broken scalar to OPENCUES.md.
    assert.strictEqual(isProviderValueCyclable('not-a-provider', { GROQ_API_KEY: 'k' }), false);
    assert.strictEqual(isProviderValueCyclable('', {}), false);
  });

  it('legacy provider alias resolves to the canonical id first', () => {
    // `claude-cli` is the only legacy alias today (resolves to
    // `claude-code-cli`). The predicate should canonicalise BEFORE the
    // adapter lookup so cycling-menu values that come in as aliases
    // don't silently drop to "unknown id". Pins the existing
    // LEGACY_PROVIDER_ALIASES wiring as part of the cyclability
    // contract.
    assert.strictEqual(
      isProviderValueCyclable('claude-cli', {}, { isCliAvailable: () => true }),
      true,
      'claude-cli alias should resolve to claude-code-cli and be cyclable when the CLI is on PATH',
    );
    assert.strictEqual(
      isProviderValueCyclable('claude-cli', {}, { isCliAvailable: () => false }),
      false,
      'claude-cli alias resolves; CLI probe says binary missing → not cyclable',
    );
  });
});

describe('dispatchChat — prediction-unsupported fallback', () => {
  const cerebras = getProvider('cerebras')!;
  const baseReq = { model: 'gpt-oss-120b', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('retries WITHOUT prediction when the provider rejects it, and succeeds', async () => {
    let calls = 0;
    let retryHadPrediction: boolean | null = null;
    const http = {
      post: async (_url: string, body: string) => {
        calls++;
        const parsed = JSON.parse(body) as { prediction?: unknown };
        if (calls === 1) {
          assert.ok(parsed.prediction, 'first attempt carries the prediction hint');
          return JSON.stringify({ error: { message: "property 'prediction' is unsupported" } });
        }
        retryHadPrediction = parsed.prediction !== undefined;
        return JSON.stringify({ choices: [{ message: { content: 'appended ok' } }] });
      },
    };
    const out = await dispatchChat(cerebras, http, { ...baseReq, prediction: 'the body being transformed' }, { apiKey: 'k' });
    assert.strictEqual(out, 'appended ok');
    assert.strictEqual(calls, 2, 'exactly one retry');
    assert.strictEqual(retryHadPrediction, false, 'retry must drop the prediction field');
  });

  it('does NOT retry on an unrelated provider error', async () => {
    // NB: must be neither prediction-unsupported NOR rate-limit — both now
    // legitimately retry (prediction-strip fallback; rate-limit backoff).
    // A schema error is the genuine "surface it once" case.
    let calls = 0;
    const http = { post: async () => { calls++; return JSON.stringify({ error: { message: 'invalid request: bad schema' } }); } };
    await assert.rejects(
      () => dispatchChat(cerebras, http, { ...baseReq, prediction: 'x' }, { apiKey: 'k' }),
      /bad schema/,
    );
    assert.strictEqual(calls, 1, 'a non-prediction, non-rate-limit error must not trigger any retry');
  });

  it('does NOT retry when prediction was never sent (single attempt, error surfaces)', async () => {
    let calls = 0;
    const http = { post: async () => { calls++; return JSON.stringify({ error: { message: "property 'prediction' is unsupported" } }); } };
    await assert.rejects(() => dispatchChat(cerebras, http, baseReq, { apiKey: 'k' }));
    assert.strictEqual(calls, 1, 'no prediction was set → no fallback path');
  });
});

describe('provider capability model — default-off param gating', () => {
  const OPENAI_SHAPE = ['groq', 'openrouter', 'openai', 'cerebras', 'opencode-zen'] as const;
  const u = (role: 'user') => ({ role, content: 'x' });

  it('every OpenAI-shape adapter declares a capabilities block (so new params default OFF)', () => {
    for (const id of OPENAI_SHAPE) {
      const p = getProvider(id);
      assert.ok(p, `${id} resolves`);
      assert.ok(p!.capabilities !== undefined, `${id} must declare capabilities — default-off gating depends on it`);
    }
  });

  it('`prediction` is emitted IFF the provider declares it', () => {
    const base = { messages: [u('user')], maxTokens: 50, prediction: 'a body being transformed' };
    const pred = (id: typeof OPENAI_SHAPE[number], model: string) =>
      JSON.parse(buildProviderRequest(id, { ...base, model }, { apiKey: 'k' }).body).prediction;
    assert.ok(pred('cerebras', 'gpt-oss-120b') !== undefined, 'cerebras declares prediction → sent');
    assert.ok(pred('openai', 'gpt-4o') !== undefined, 'openai declares prediction → sent');
    assert.strictEqual(pred('groq', 'openai/gpt-oss-120b'), undefined, 'groq declares seed but NOT prediction → omitted');
    assert.strictEqual(pred('openrouter', 'anthropic/claude-opus-4-7'), undefined, 'openrouter declares nothing → omitted');
    assert.strictEqual(pred('opencode-zen', 'anything'), undefined, 'opencode-zen declares nothing → omitted');
  });

  it('`reasoning_format: hidden` only fires for cerebras gpt-oss models (the model predicate)', () => {
    const rf = (id: typeof OPENAI_SHAPE[number], model: string) =>
      JSON.parse(buildProviderRequest(id, { messages: [u('user')], model, reasoningEffort: 'medium' }, { apiKey: 'k' }).body).reasoning_format;
    assert.strictEqual(rf('cerebras', 'gpt-oss-120b'), 'hidden', 'cerebras gpt-oss → hidden');
    assert.strictEqual(rf('cerebras', 'zai-glm-4.7'), undefined, 'cerebras non-gpt-oss → predicate false → not sent');
    assert.strictEqual(rf('groq', 'openai/gpt-oss-120b'), undefined, 'groq does not declare reasoningFormatHidden → never sent');
  });
});
