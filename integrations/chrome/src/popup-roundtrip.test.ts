// Popup → storage → loadConfig roundtrip tests — proves that every
// field the popup writes IS read back faithfully. Catches the
// regression class "popup field is dropped on read" that hid the
// `provider` dropdown's no-op behaviour for weeks.
//
// Wiring chain this pins:
//   1. saveConfig({ field }) writes to chrome.storage.local
//   2. loadConfig() reads it back into config[field]
//   3. content.ts passes config[field] to startOpenCues({ llm<Field> })
//   4. opencues-bootstrap forwards to boot host info
//   5. boot.ts hands it to Resolver / FluidBlankSource
//
// Steps 4-5 are pinned by adapters/chrome/v1/boot.wiring.test.ts.
// This file pins steps 1-3.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, saveConfig, saveUserKeys, loadUserKeys } from './adapters/chrome-storage-adapter';

// Real-shape chrome.storage.local stub backed by an in-memory Map.
// The vitest setup stub returns empty results; this one actually
// persists across reads so the roundtrip test means something.
let store: Map<string, unknown>;
beforeEach(() => {
  store = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (keys?: string | string[] | Record<string, unknown> | null) => {
          const out: Record<string, unknown> = {};
          if (typeof keys === 'string') {
            if (store.has(keys)) out[keys] = store.get(keys);
          } else if (Array.isArray(keys)) {
            for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          } else if (keys === undefined || keys === null) {
            for (const [k, v] of store.entries()) out[k] = v;
          } else {
            for (const [k, v] of Object.entries(keys)) {
              out[k] = store.has(k) ? store.get(k) : v;
            }
          }
          return out;
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) store.delete(k);
        },
        clear: async () => store.clear(),
      },
      onChanged: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    runtime: {
      sendMessage: async () => undefined,
      onMessage: { addListener: () => undefined },
      connect: () => ({ postMessage: () => undefined, onMessage: { addListener: () => undefined }, onDisconnect: { addListener: () => undefined } }),
    },
  };
});

describe('Popup field roundtrip — saveConfig → loadConfig', () => {
  it('model is saved and read back identically', async () => {
    await saveConfig({ model: 'gpt-5-test' });
    const loaded = await loadConfig();
    expect(loaded.model).toBe('gpt-5-test');
  });

  it('apiUrl is saved and read back identically', async () => {
    await saveConfig({ apiUrl: 'https://example.test/v1/chat/completions' });
    const loaded = await loadConfig();
    expect(loaded.apiUrl).toBe('https://example.test/v1/chat/completions');
  });

  it('provider is saved and read back identically (was silently dropped before May 2026 wiring fix)', async () => {
    // The canonical regression: provider lived in DEFAULT_CONFIG +
    // saveConfig but content.ts never forwarded it. Catching it here
    // requires both ends of the chain.
    await saveConfig({ provider: 'cerebras' });
    const loaded = await loadConfig();
    expect(loaded.provider).toBe('cerebras');
  });

  it('targetSelector is saved and read back identically', async () => {
    await saveConfig({ targetSelector: '[data-test="custom"]' });
    const loaded = await loadConfig();
    expect(loaded.targetSelector).toBe('[data-test="custom"]');
  });

  it('Saving { provider, model, apiUrl } all together — all three survive', async () => {
    await saveConfig({
      provider: 'cerebras',
      model: 'gpt-oss-120b',
      apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
    });
    const loaded = await loadConfig();
    expect(loaded.provider).toBe('cerebras');
    expect(loaded.model).toBe('gpt-oss-120b');
    expect(loaded.apiUrl).toBe('https://api.cerebras.ai/v1/chat/completions');
  });

  it('Provider keys roundtrip via saveUserKeys / loadUserKeys', async () => {
    await saveUserKeys({ CEREBRAS_API_KEY: 'csk-test-123' });
    const keys = await loadUserKeys();
    expect(keys.CEREBRAS_API_KEY).toBe('csk-test-123');
  });

  it('User keys appear in loadConfig.llmApiKeys (merged bag)', async () => {
    await saveUserKeys({ CEREBRAS_API_KEY: 'csk-from-popup' });
    const config = await loadConfig();
    expect(config.llmApiKeys?.CEREBRAS_API_KEY).toBe('csk-from-popup');
  });

  it('Switching popup provider Cerebras → Groq saves the new value (no sticky-default bug)', async () => {
    await saveConfig({ provider: 'cerebras' });
    expect((await loadConfig()).provider).toBe('cerebras');
    await saveConfig({ provider: 'groq' });
    expect((await loadConfig()).provider).toBe('groq');
  });

  it('Empty-string provider is saved as empty (back-compat — restore auto-route)', async () => {
    await saveConfig({ provider: 'cerebras' });
    await saveConfig({ provider: '' });
    const loaded = await loadConfig();
    expect(loaded.provider).toBe('');
  });
});
