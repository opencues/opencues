// Scenario tests pinning the multi-provider key forwarding path.
//
// Regression context (May 2026): `HOST_KEY_FIELD_MAP` only projected
// `GROQ_API_KEY` and `FINNHUB_API_KEY` onto StoredConfig. Every other
// provider key the native-messaging host pushed (`GEMINI_API_KEY`,
// `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CEREBRAS_API_KEY`,
// `OPENROUTER_API_KEY`) was silently dropped — so flipping
// `llm-provider: gemini` in CUES.md made every chrome LLM call a no-op
// (resolver couldn't find a key for the chosen provider, returned null,
// no error). Opencode read `process.env` directly so all keys were
// present, masking the chrome-only nature of the bug.
//
// These tests pin the contract: every `*_API_KEY` the host pushes must
// surface in StoredConfig.llmApiKeys so the resolver can authenticate
// against any provider the user chose in CUES.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './chrome-storage-adapter';

interface StorageBag {
  opencues_config?: Record<string, unknown>;
  opencues_host_keys?: Record<string, string>;
}

function mockChromeStorage(initial: StorageBag): void {
  const state: StorageBag = { ...initial };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn((key: string | string[]) => {
          if (typeof key === 'string') {
            return Promise.resolve(key in state ? { [key]: (state as Record<string, unknown>)[key] } : {});
          }
          const out: Record<string, unknown> = {};
          for (const k of key) {
            if (k in state) out[k] = (state as Record<string, unknown>)[k];
          }
          return Promise.resolve(out);
        }),
        set: vi.fn((updates: Record<string, unknown>) => {
          Object.assign(state, updates);
          return Promise.resolve();
        }),
        remove: vi.fn(),
      },
      onChanged: { addListener: vi.fn() },
    },
  };
}

describe('chrome storage adapter — multi-provider key forwarding', () => {
  beforeEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('forwards every *_API_KEY from the host bag into llmApiKeys', async () => {
    // Simulate the native-messaging host pushing the user's full env.
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: 'groq-secret',
        GEMINI_API_KEY: 'gemini-secret',
        OPENAI_API_KEY: 'openai-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        CEREBRAS_API_KEY: 'cerebras-secret',
        OPENROUTER_API_KEY: 'openrouter-secret',
        FINNHUB_API_KEY: 'finnhub-secret',
      },
    });

    const config = await loadConfig();

    expect(config.llmApiKeys).toMatchObject({
      GROQ_API_KEY: 'groq-secret',
      GEMINI_API_KEY: 'gemini-secret',
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      CEREBRAS_API_KEY: 'cerebras-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
    });
    // FINNHUB_API_KEY rides along in the bag (every *_API_KEY does) —
    // harmless: the resolver only looks up keys for providers it
    // actually dispatches to. Keeping the forwarder permissive means
    // adding a new LLM provider doesn't require an adapter change.
    expect(config.llmApiKeys.FINNHUB_API_KEY).toBe('finnhub-secret');
    // And the legacy field carries it for the stocks blank.
    expect(config.finnhubApiKey).toBe('finnhub-secret');
  });

  it('keeps legacy single-field projection working for groq + finnhub', async () => {
    // Popup-era contract: `apiKey` and `finnhubApiKey` resolve from the
    // host bag for back-compat with popup-only users.
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: 'groq-secret',
        FINNHUB_API_KEY: 'finnhub-secret',
      },
    });

    const config = await loadConfig();

    expect(config.apiKey).toBe('groq-secret');
    expect(config.finnhubApiKey).toBe('finnhub-secret');
    // And the new bag carries the LLM-side key too.
    expect(config.llmApiKeys.GROQ_API_KEY).toBe('groq-secret');
  });

  it('bridges popup-only apiKey into llmApiKeys.GROQ_API_KEY', async () => {
    // No host running, no popup save yet → the popup user's groq key
    // arrives at startup via the legacy `apiKey` field only. The
    // resolver needs `llmApiKeys.GROQ_API_KEY` to dispatch, so the
    // adapter must bridge between the two without dropping any.
    mockChromeStorage({
      opencues_config: {
        apiKey: 'groq-from-popup',
      },
    });

    const config = await loadConfig();

    expect(config.apiKey).toBe('groq-from-popup');
    expect(config.llmApiKeys.GROQ_API_KEY).toBe('groq-from-popup');
  });

  it('does not poison llmApiKeys with empty strings', async () => {
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: '',
        GEMINI_API_KEY: 'gemini-secret',
      },
    });

    const config = await loadConfig();

    // Empty groq key shouldn't surface — would mask a real value coming
    // from the popup-overlay step later.
    expect(config.llmApiKeys.GROQ_API_KEY).toBeUndefined();
    expect(config.llmApiKeys.GEMINI_API_KEY).toBe('gemini-secret');
  });

  it('trims whitespace from keys (newlines from .env copy/paste)', async () => {
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: '   ',                  // whitespace-only → dropped
        GEMINI_API_KEY: '  gemini-secret\n',  // surrounding whitespace → trimmed
      },
    });

    const config = await loadConfig();

    expect(config.llmApiKeys.GROQ_API_KEY).toBeUndefined();
    expect(config.llmApiKeys.GEMINI_API_KEY).toBe('gemini-secret');
  });

  it('returns empty llmApiKeys when neither host nor popup provided a key', async () => {
    mockChromeStorage({});
    const config = await loadConfig();
    // Bake-time __GROQ_API_KEY__ is intentionally empty in published
    // bundles (secrets policy); a freshly installed extension with no
    // host and no popup save should land here without throwing.
    expect(config.llmApiKeys).toEqual({});
  });
});
