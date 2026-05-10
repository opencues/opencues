/**
 * AgentRewrite provider-routing scenarios.
 *
 * Pins the provider-thunk integration:
 *   - Without a provider thunk: legacy OpenAI-shaped wire format.
 *   - With a provider thunk: callLLM goes through provider.buildRequest /
 *     parseResponse, so a Gemini-style provider can drive AgentRewrite
 *     end-to-end without touching the merge layer.
 *
 * The provider is mocked locally — these tests don't depend on the real
 * @opencues/core module. The shape we assert against IS the shape
 * that core's GEMINI / OPENROUTER adapters emit.
 */
import { describe, expect, it } from 'vitest';
import { AgentRewrite, type AgentRewriteProviderAdapter } from './agent-rewrite';
import { AgentTaskState } from '../state/agent-task';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function llmResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

describe('AgentRewrite — without provider thunk (legacy Groq-shape)', () => {
  it('posts OpenAI-style body to the configured endpoint', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff', 12);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();
    let lastUrl = '', lastBody = '', lastAuth = '';
    const httpAdapter = {
      post: async (url: string, body: string, headers: Record<string, string>) => {
        lastUrl = url;
        lastBody = body;
        lastAuth = headers.Authorization;
        return llmResponse('REWRITTEN:\nI write stuff\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test.example/v1/chat/completions',
      apiKey: 'sk_legacy', defaultModel: 'm', httpAdapter,
    });
    await r.tick();
    expect(lastUrl).toBe('http://test.example/v1/chat/completions');
    expect(lastAuth).toBe('Bearer sk_legacy');
    const parsed = JSON.parse(lastBody);
    expect(parsed.messages).toBeDefined();
    expect(parsed.messages[0].role).toBe('system');
    expect(parsed.messages[1].role).toBe('user');
    expect(adapter.getText()).toBe('I write stuff');
  });
});

describe('AgentRewrite — with a Gemini-shaped provider thunk', () => {
  it('routes the request through provider.buildRequest and parses Gemini-shaped responses', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite stuff', 12);
    const state = new AgentTaskState();
    state.arm('fix typos');
    const dynDefs = new DynDefs();

    // Gemini-shaped mock provider — model in URL path, key in query
    // string, request body uses `contents`/`parts`, response is under
    // `candidates[].content.parts[].text`.
    const geminiMock: AgentRewriteProviderAdapter = {
      id: 'gemini',
      defaultModel: 'gemini-2.5-flash',
      buildRequest(req, ctx) {
        const url = `https://gen-ai.example/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`;
        const sys = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const nonSys = req.messages.filter((m) => m.role !== 'system');
        return {
          url,
          body: JSON.stringify({
            contents: nonSys.map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
          }),
          headers: { 'Content-Type': 'application/json' },
        };
      },
      parseResponse(rawJson) {
        const data = JSON.parse(rawJson);
        return data.candidates[0].content.parts[0].text;
      },
    };

    let lastUrl = '', lastBody = '', lastAuth = '';
    const httpAdapter = {
      post: async (url: string, body: string, headers: Record<string, string>) => {
        lastUrl = url;
        lastBody = body;
        lastAuth = headers.Authorization ?? '';
        // Gemini-shaped response.
        return JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'REWRITTEN:\nI write stuff\nEND' }] } }],
        });
      },
    };

    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: '',                                     // ignored — provider builds the URL
      apiKey: 'gem_test', defaultModel: 'gemini-2.5-flash', httpAdapter,
      resolveLLM: () => ({ provider: geminiMock, model: 'gemini-2.5-flash', endpoint: '', apiKey: 'gem_test' }),
    });
    await r.tick();
    // URL was built by the provider, key embedded as query param.
    expect(lastUrl).toContain('models/gemini-2.5-flash:generateContent');
    expect(lastUrl).toContain('?key=gem_test');
    // No bearer auth header (Gemini auth is query-param).
    expect(lastAuth).toBe('');
    // Body uses Gemini's `contents` shape.
    const parsed = JSON.parse(lastBody);
    expect(parsed.contents).toBeDefined();
    expect(parsed.contents[0].parts[0].text).toContain('TASK: fix typos');
    expect(parsed.systemInstruction).toBeDefined();
    // The merge layer applied the rewrite: parser stripped REWRITTEN:/END.
    expect(adapter.getText()).toBe('I write stuff');
  });

  it('provider thunk re-evaluated each tick — supports runtime switching', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('hello', 5);
    const state = new AgentTaskState();
    state.arm('test');
    const dynDefs = new DynDefs();

    const groqMock: AgentRewriteProviderAdapter = {
      id: 'groq', defaultModel: 'm',
      buildRequest: () => ({ url: 'https://groq.example', body: '{}', headers: { Authorization: 'Bearer GROQ' } }),
      parseResponse: () => 'REWRITTEN:\nhello\nEND',
    };
    const openrouterMock: AgentRewriteProviderAdapter = {
      id: 'openrouter', defaultModel: 'm',
      buildRequest: () => ({ url: 'https://openrouter.example', body: '{}', headers: { Authorization: 'Bearer OPENROUTER' } }),
      parseResponse: () => 'REWRITTEN:\nhello\nEND',
    };
    let active: AgentRewriteProviderAdapter = groqMock;
    let lastUrl = '';
    const httpAdapter = {
      post: async (url: string) => { lastUrl = url; return 'unused'; },
    };

    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: '', apiKey: 'k', defaultModel: 'm', httpAdapter,
      resolveLLM: () => ({ provider: active, model: active.defaultModel, endpoint: '', apiKey: 'k' }),
    });
    await r.tick();
    expect(lastUrl).toBe('https://groq.example');
    // Switch the active provider between ticks (the runtime equivalent
    // of editing CUES.md `agent-provider:`). Bust the stable marker
    // by re-arming so the next tick actually fires the LLM.
    active = openrouterMock;
    state.arm('test-2');
    await r.tick();
    expect(lastUrl).toBe('https://openrouter.example');
  });

  it('provider thunk returning null falls through to legacy path', async () => {
    const adapter = new MockAdapter({});
    adapter.pushText('I rite', 6);
    const state = new AgentTaskState();
    state.arm('fix');
    const dynDefs = new DynDefs();
    let lastAuth = '';
    const httpAdapter = {
      post: async (_url: string, _body: string, headers: Record<string, string>) => {
        lastAuth = headers.Authorization ?? '';
        return llmResponse('REWRITTEN:\nI write\nEND');
      },
    };
    const r = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://x', apiKey: 'sk', defaultModel: 'm', httpAdapter,
      resolveLLM: () => null,                           // unresolved — fall through
    });
    await r.tick();
    // Legacy path was used: bearer auth from options.apiKey.
    expect(lastAuth).toBe('Bearer sk');
  });
});
