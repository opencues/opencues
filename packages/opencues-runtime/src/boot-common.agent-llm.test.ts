/**
 * buildAgentLLMResolver / buildKataLLMResolver — auditors-bucket
 * collapse through core's shared `collapseBucketTier` walk.
 *
 * Pins the July 2026 alignment fixes on this path:
 *   - model sentinels: cycling `auditors-llm-model` to `default`
 *     previously shipped the literal string "default" as the model
 *     name from these resolvers (build-sources normalized, this path
 *     didn't).
 *   - Case B: a bucket model written while `auditors-llm-provider:
 *     inherit` was silently ignored.
 *   - Case A: the global `llm-model` must not leak into a bucket
 *     pinned to a different provider.
 */
import { describe, it, expect } from 'vitest';
import { buildAgentLLMResolver, buildKataLLMResolver } from './boot-common';
import type { ConfigLoader } from './modules/config-loader';

function fakeLoader(auditorsProvider: string, scalars: Record<string, string>): ConfigLoader {
  return {
    opencuesState: {
      auditorsLlmProvider: auditorsProvider,
      settings: new Map(Object.entries(scalars)),
    },
  } as unknown as ConfigLoader;
}

describe('buildAgentLLMResolver — auditors bucket collapse', () => {
  it('normalizes the `default` model sentinel to the provider default', () => {
    const out = buildAgentLLMResolver(
      fakeLoader('cerebras', { 'auditors-llm-model': 'default' }),
      { CEREBRAS_API_KEY: 'k' },
    );
    expect(out).not.toBeNull();
    expect(out!.provider.id).toBe('cerebras');
    expect(out!.model).toBe('gpt-oss-120b');
  });

  it('Case B: honors auditors-llm-model when the bucket provider is inherit', () => {
    const out = buildAgentLLMResolver(
      fakeLoader('inherit', { 'auditors-llm-model': 'zai-glm-4.7', 'llm-provider': 'cerebras' }),
      { CEREBRAS_API_KEY: 'k' },
    );
    expect(out).not.toBeNull();
    expect(out!.provider.id).toBe('cerebras');
    expect(out!.model).toBe('zai-glm-4.7');
  });

  it('Case A: pinned bucket does not inherit the global llm-model', () => {
    const out = buildAgentLLMResolver(
      fakeLoader('anthropic', { 'llm-model': 'openai/gpt-oss-120b', 'llm-provider': 'groq' }),
      { ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'k' },
    );
    expect(out).not.toBeNull();
    expect(out!.provider.id).toBe('anthropic');
    expect(out!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('per-feature agent-provider/agent-model still wins above the bucket', () => {
    const out = buildAgentLLMResolver(
      fakeLoader('cerebras', {
        'agent-provider': 'groq',
        'agent-model': 'openai/gpt-oss-20b',
        'auditors-llm-model': 'gemma-4-31b',
      }),
      { CEREBRAS_API_KEY: 'k', GROQ_API_KEY: 'k' },
    );
    expect(out).not.toBeNull();
    expect(out!.provider.id).toBe('groq');
    expect(out!.model).toBe('openai/gpt-oss-20b');
  });

  it('threads max-thinking (default on)', () => {
    const on = buildAgentLLMResolver(fakeLoader('cerebras', {}), { CEREBRAS_API_KEY: 'k' });
    expect(on!.maxThinking).toBe(true);
    const off = buildAgentLLMResolver(
      fakeLoader('cerebras', { 'max-thinking': 'off' }),
      { CEREBRAS_API_KEY: 'k' },
    );
    expect(off!.maxThinking).toBe(false);
  });
});

describe('buildKataLLMResolver — same collapse as the agent resolver', () => {
  it('normalizes the `default` model sentinel to the provider default', () => {
    const out = buildKataLLMResolver(
      fakeLoader('cerebras', { 'auditors-llm-model': 'default' }),
      { CEREBRAS_API_KEY: 'k' },
    );
    expect(out).not.toBeNull();
    expect(out!.model).toBe('gpt-oss-120b');
  });

  it('kata per-feature scalars win above the auditors bucket', () => {
    const out = buildKataLLMResolver(
      fakeLoader('cerebras', { 'kata-llm-provider': 'groq' }),
      { CEREBRAS_API_KEY: 'k', GROQ_API_KEY: 'k' },
    );
    expect(out).not.toBeNull();
    expect(out!.provider.id).toBe('groq');
  });
});
