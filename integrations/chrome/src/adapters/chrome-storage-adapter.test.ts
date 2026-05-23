// Scenario tests pinning the multi-provider key forwarding path.
//
// Regression context (May 2026, two layers):
//
//   Layer 1 (fixed in 008fb06): `HOST_KEY_FIELD_MAP` only projected
//   `GROQ_API_KEY` and `FINNHUB_API_KEY` onto StoredConfig. Every other
//   provider key the native-messaging host pushed was silently dropped.
//
//   Layer 2 (fixed in THIS test's commit): the projection added a
//   `llmApiKeys` field INSIDE `opencues_config`, which was also where
//   `DEFAULT_CONFIG` got persisted on first load. The default carried
//   a bake-time-snapshotted single-groq bag. On every subsequent load
//   `stored.llmApiKeys` (single-groq) overwrote the freshly-merged
//   host bag (multi-provider) via an unconditional spread loop. The
//   moment the shipped default flipped from `llm-provider: groq` to
//   `llm-provider: cerebras` (commit e9f8dcd), every popup-default
//   chrome user silently no-op'd on `_`.
//
// Structural fix: split ownership.
//
//   opencues_config        ← popup-owned settings (NO secrets, NO llmApiKeys)
//   opencues_host_keys     ← native-messaging host's env-var bag
//   opencues_user_keys     ← popup-pasted per-provider keys
//
// `DEFAULT_CONFIG` is in-memory only — never persisted. `llmApiKeys`
// in the merged view is `{...host, ...user}`, with user keys winning
// on collision. The popup writes only to `opencues_user_keys`, so a
// read-modify-write of `opencues_config` cannot clobber the live key
// bags. The merge loop additionally skips `llmApiKeys` as a defence
// in depth.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, loadUserKeys, saveConfig, saveUserKeys, resetConfig } from './chrome-storage-adapter';

interface StorageBag {
  opencues_config?: Record<string, unknown>;
  opencues_host_keys?: Record<string, string>;
  opencues_user_keys?: Record<string, string>;
}

function mockChromeStorage(initial: StorageBag): StorageBag {
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
        remove: vi.fn((keys: string | string[]) => {
          const arr = typeof keys === 'string' ? [keys] : keys;
          for (const k of arr) delete (state as Record<string, unknown>)[k];
          return Promise.resolve();
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
  };
  return state;
}

describe('chrome storage adapter — multi-provider key forwarding', () => {
  beforeEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('forwards every *_API_KEY from the host bag into llmApiKeys', async () => {
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
    expect(config.llmApiKeys.FINNHUB_API_KEY).toBe('finnhub-secret');
    expect(config.finnhubApiKey).toBe('finnhub-secret');
  });

  it('keeps legacy single-field projection working for groq + finnhub', async () => {
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: 'groq-secret',
        FINNHUB_API_KEY: 'finnhub-secret',
      },
    });

    const config = await loadConfig();

    expect(config.apiKey).toBe('groq-secret');
    expect(config.finnhubApiKey).toBe('finnhub-secret');
    expect(config.llmApiKeys.GROQ_API_KEY).toBe('groq-secret');
  });

  it('user-pasted keys win over host-pushed keys on collision', async () => {
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: 'groq-from-host',
        CEREBRAS_API_KEY: 'cerebras-from-host',
      },
      opencues_user_keys: {
        GROQ_API_KEY: 'groq-from-popup',
        OPENAI_API_KEY: 'openai-from-popup',
      },
    });

    const config = await loadConfig();

    expect(config.llmApiKeys).toEqual({
      GROQ_API_KEY: 'groq-from-popup',         // user wins
      CEREBRAS_API_KEY: 'cerebras-from-host',  // host-only, survives
      OPENAI_API_KEY: 'openai-from-popup',     // user-only, surfaces
    });
    // Legacy projection picks the winning groq value.
    expect(config.apiKey).toBe('groq-from-popup');
  });

  it('does not poison llmApiKeys with empty strings', async () => {
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: '',
        GEMINI_API_KEY: 'gemini-secret',
      },
    });

    const config = await loadConfig();

    expect(config.llmApiKeys.GROQ_API_KEY).toBeUndefined();
    expect(config.llmApiKeys.GEMINI_API_KEY).toBe('gemini-secret');
  });

  it('trims whitespace from keys (newlines from .env copy/paste)', async () => {
    mockChromeStorage({
      opencues_host_keys: {
        GROQ_API_KEY: '   ',
        GEMINI_API_KEY: '  gemini-secret\n',
      },
    });

    const config = await loadConfig();

    expect(config.llmApiKeys.GROQ_API_KEY).toBeUndefined();
    expect(config.llmApiKeys.GEMINI_API_KEY).toBe('gemini-secret');
  });

  it('returns empty llmApiKeys when neither host nor popup provided a key', async () => {
    mockChromeStorage({});
    const config = await loadConfig();
    expect(config.llmApiKeys).toEqual({});
  });
});

describe('chrome storage adapter — ownership invariants', () => {
  beforeEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  // The exact failure sequence from the May 2026 cerebras regression.
  // A stale stored `opencues_config.llmApiKeys = {GROQ_API_KEY: ...}`
  // used to clobber the host's freshly-pushed multi-provider bag.
  // Now `loadConfig` ignores `llmApiKeys` inside `opencues_config`
  // AND migrates it out of storage on first load.
  it('stale opencues_config.llmApiKeys does NOT clobber the host bag', async () => {
    const state = mockChromeStorage({
      opencues_config: {
        // Legacy snapshot from before the ownership split — what
        // every existing chrome user with a popup-default install
        // had sitting in storage at the time of the regression.
        llmApiKeys: { GROQ_API_KEY: 'stale-bake-time-groq' },
        targetSelector: '[contenteditable="true"]',
        model: 'openai/gpt-oss-120b',
      },
      opencues_host_keys: {
        GROQ_API_KEY: 'live-groq',
        CEREBRAS_API_KEY: 'live-cerebras',
      },
    });

    const config = await loadConfig();

    expect(config.llmApiKeys).toEqual({
      GROQ_API_KEY: 'live-groq',
      CEREBRAS_API_KEY: 'live-cerebras',
    });
    // Cleanup migration: stale field is stripped from storage so it
    // can't bite again if the merge logic ever changes.
    expect((state.opencues_config as Record<string, unknown>).llmApiKeys).toBeUndefined();
  });

  // Stale `opencues_config.apiKey` (popup-set groq from before the
  // split) gets promoted into `opencues_user_keys.GROQ_API_KEY` so
  // popup-only users with no host don't lose their groq access.
  it('migrates stale opencues_config.apiKey into opencues_user_keys.GROQ_API_KEY', async () => {
    const state = mockChromeStorage({
      opencues_config: {
        apiKey: 'gsk-legacy-popup-groq',
        targetSelector: '[contenteditable="true"]',
      },
    });

    const config = await loadConfig();

    expect(config.llmApiKeys.GROQ_API_KEY).toBe('gsk-legacy-popup-groq');
    expect(config.apiKey).toBe('gsk-legacy-popup-groq');
    expect((state.opencues_config as Record<string, unknown>).apiKey).toBeUndefined();
    expect((state.opencues_user_keys as Record<string, string>).GROQ_API_KEY).toBe('gsk-legacy-popup-groq');
  });

  // Migration must not overwrite a user-keys value that already
  // exists. If the user pasted a NEW groq key after the regression
  // landed and we shipped the fix later, their fresh value wins.
  it('migration preserves an existing opencues_user_keys.GROQ_API_KEY', async () => {
    mockChromeStorage({
      opencues_config: { apiKey: 'gsk-stale-legacy-groq' },
      opencues_user_keys: { GROQ_API_KEY: 'gsk-newly-pasted-groq' },
    });

    const config = await loadConfig();
    expect(config.llmApiKeys.GROQ_API_KEY).toBe('gsk-newly-pasted-groq');
  });

  // saveConfig is read-modify-write for `opencues_config`. If a
  // future bug ever re-introduces `llmApiKeys` into the popup-saved
  // bag, this test guards: the field is stripped on every write.
  it('saveConfig never persists llmApiKeys or apiKey into opencues_config', async () => {
    const state = mockChromeStorage({});

    await saveConfig({
      model: 'openai/gpt-oss-120b',
      // @ts-expect-error - simulating a future regression
      llmApiKeys: { GROQ_API_KEY: 'should-not-persist' },
      // @ts-expect-error - simulating a future regression
      apiKey: 'should-also-not-persist',
    });

    const persisted = state.opencues_config as Record<string, unknown>;
    expect(persisted.llmApiKeys).toBeUndefined();
    expect(persisted.apiKey).toBeUndefined();
    expect(persisted.model).toBe('openai/gpt-oss-120b');
  });

  // saveUserKeys round-trips. Empty values delete the key (so the
  // popup's "clear field + save" actually clears it, instead of
  // persisting an empty string that would mask the host's value).
  it('saveUserKeys round-trips; empty value deletes the entry', async () => {
    mockChromeStorage({
      opencues_user_keys: { GROQ_API_KEY: 'existing-groq' },
    });

    await saveUserKeys({ CEREBRAS_API_KEY: 'new-cerebras', GROQ_API_KEY: '' });

    expect(await loadUserKeys()).toEqual({ CEREBRAS_API_KEY: 'new-cerebras' });
  });

  // saveUserKeys ignores anything that doesn't end in `_API_KEY` so a
  // malformed popup write (or a typo'd dataset attribute) can't
  // pollute the user-keys bag.
  it('saveUserKeys drops entries that do not end in _API_KEY', async () => {
    mockChromeStorage({});
    await saveUserKeys({
      GROQ_API_KEY: 'groq-secret',
      GROQ_KEY: 'missing-_API-suffix',
      malformed: 'no-suffix-at-all',
      apiKey: 'legacy-popup-field-name',
    });

    expect(await loadUserKeys()).toEqual({ GROQ_API_KEY: 'groq-secret' });
  });

  // Reset clears popup settings AND user-pasted keys (clean slate).
  // Host-pushed keys are left alone — they belong to a different
  // owner and reset shouldn't reach across that boundary.
  it('resetConfig clears popup + user keys, leaves host keys intact', async () => {
    const state = mockChromeStorage({
      opencues_config: { model: 'custom-model' },
      opencues_user_keys: { GROQ_API_KEY: 'user-groq' },
      opencues_host_keys: { CEREBRAS_API_KEY: 'host-cerebras' },
    });

    await resetConfig();

    expect(state.opencues_config).toBeUndefined();
    expect(state.opencues_user_keys).toBeUndefined();
    expect(state.opencues_host_keys).toEqual({ CEREBRAS_API_KEY: 'host-cerebras' });
  });

  // Defence in depth: even if a stale `llmApiKeys` field somehow
  // survives migration (e.g. written by a parallel write between the
  // read and the migration set), the merge loop in loadConfig also
  // skips it. This pins the second guard explicitly.
  it('loadConfig ignores opencues_config.llmApiKeys even if migration did not strip it', async () => {
    const state = mockChromeStorage({
      // Pre-seed both the stale snapshot AND the migration's "would
      // have stripped it" target, then race the migration by having
      // the get() return the stale shape every time. The simplest
      // way to test the in-memory guard in isolation: bypass the
      // migration by not setting apiKey AND seeding the stale field
      // back in via a manual storage write after migration.
      opencues_config: {
        llmApiKeys: { GROQ_API_KEY: 'snapshot-groq' },
      },
      opencues_host_keys: {
        CEREBRAS_API_KEY: 'live-cerebras',
      },
    });

    // First load runs migration (strips stale field).
    await loadConfig();
    // Manually re-introduce the stale field to simulate a race or
    // any future bug that re-adds it.
    state.opencues_config = { llmApiKeys: { GROQ_API_KEY: 'snapshot-groq' } };

    const config = await loadConfig();
    expect(config.llmApiKeys).toEqual({ CEREBRAS_API_KEY: 'live-cerebras' });
  });
});
