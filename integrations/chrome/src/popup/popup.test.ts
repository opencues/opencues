// Tests for popup/popup.ts — the extension popup's settings UI.
//
// popup.ts has TWO kinds of module-level side effects that make it
// tricky to unit test: (1) `init()` is invoked at the bottom of the
// file (not exported, not awaited) and immediately starts reading
// chrome.storage via the adapter + wiring every DOM control by id, and
// (2) the diag-run/diag-probe click listeners are registered
// synchronously right after their handlers are defined. Because of
// this we must have the full popup.html DOM fixture in place AND the
// chrome/adapter/fetch mocks configured *before* each dynamic import,
// then re-import fresh (vi.resetModules) for every test.
//
// `../adapters/chrome-storage-adapter` is mocked wholesale (its own
// behaviour is covered by popup-roundtrip.test.ts and
// chrome-storage-adapter.test.ts) — this file exercises popup.ts's OWN
// DOM wiring/diagnostic logic in isolation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG, type StoredConfig } from '../types';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadUserKeys: vi.fn(),
  saveConfig: vi.fn(),
  saveUserKeys: vi.fn(),
  resetConfig: vi.fn(),
  clearChromeHostState: vi.fn(),
  onConfigChange: vi.fn(),
}));

vi.mock('../adapters/chrome-storage-adapter', () => mocks);

const POPUP_HTML = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');

function installPopupDom(): void {
  const bodyMatch = POPUP_HTML.match(/<body>([\s\S]*)<\/body>/);
  const bodyHtml = bodyMatch ? bodyMatch[1] : '';
  document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
}

interface ChromeMockHandles {
  sendMessage: ReturnType<typeof vi.fn>;
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
  storageGet: ReturnType<typeof vi.fn>;
}

function setupChromeMock(opts: {
  hostConnected?: boolean;
  tabs?: unknown[];
  pingResponse?: unknown | 'timeout' | 'throw';
  storageContents?: Record<string, unknown>;
} = {}): ChromeMockHandles {
  const sendMessage = vi.fn((message: { type?: string }) => {
    if (message?.type === 'opencues:host-status') {
      return Promise.resolve({ connected: opts.hostConnected ?? false });
    }
    return Promise.resolve(undefined);
  });
  const tabsQuery = vi.fn(async () => opts.tabs ?? [{ id: 1, url: 'https://example.com/page' }]);
  const tabsSendMessage = vi.fn(async () => {
    if (opts.pingResponse === 'timeout') return new Promise(() => { /* never resolves */ });
    if (opts.pingResponse === 'throw') throw new Error('no receiving end');
    return opts.pingResponse ?? {
      bootVersion: 'v1', currentTarget: 'div#compose', attachStatus: 'attached',
      trustGateInstalled: true, runtimeProvider: 'cerebras', runtimeModel: 'gpt-oss-120b', runtimeKeys: {},
    };
  });
  const storageGet = vi.fn(async () => opts.storageContents ?? {});
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getManifest: () => ({ version: '0.2.20-test' }),
      sendMessage,
    },
    tabs: { query: tabsQuery, sendMessage: tabsSendMessage },
    storage: { local: { get: storageGet } },
  };
  return { sendMessage, tabsQuery, tabsSendMessage, storageGet };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 15; i++) await Promise.resolve();
  // Real 0ms macrotask when running with real timers; when a test has
  // switched to fake timers (Save/Reset auto-clear tests), advance the
  // fake clock instead — a real setTimeout would never fire.
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await new Promise((r) => setTimeout(r, 0));
  }
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function importPopup(): Promise<void> {
  await import('./popup');
  await flushAsync();
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
  installPopupDom();

  mocks.loadConfig.mockReset().mockResolvedValue({ ...DEFAULT_CONFIG } satisfies StoredConfig);
  mocks.loadUserKeys.mockReset().mockResolvedValue({});
  mocks.saveConfig.mockReset().mockResolvedValue(undefined);
  mocks.saveUserKeys.mockReset().mockResolvedValue(undefined);
  mocks.resetConfig.mockReset().mockResolvedValue(undefined);
  mocks.clearChromeHostState.mockReset().mockResolvedValue(undefined);

  setupChromeMock();

  fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '' }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('init() — happy path', () => {
  it('renders the version banner from chrome.runtime.getManifest()', async () => {
    await importPopup();
    expect(byId<HTMLElement>('version').textContent).toBe('v0.2.20-test');
  });

  it('prefills model/apiUrl/provider/targetSelector fields from loadConfig()', async () => {
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      model: 'gpt-oss-120b',
      apiUrl: 'https://api.cerebras.ai/v1/chat/completions',
      provider: 'cerebras',
      targetSelector: '[data-test="x"]',
    });
    await importPopup();
    expect(byId<HTMLInputElement>('model').value).toBe('gpt-oss-120b');
    expect(byId<HTMLInputElement>('apiUrl').value).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect(byId<HTMLInputElement>('targetSelector').value).toBe('[data-test="x"]');
  });

  it('prefills ttsEnabled/ttsRate/dimMix from loadConfig()', async () => {
    mocks.loadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, ttsEnabled: true, ttsRate: 4, dimMix: 0.6 });
    await importPopup();
    expect(byId<HTMLInputElement>('ttsEnabled').checked).toBe(true);
    expect(byId<HTMLInputElement>('ttsRate').value).toBe('4');
    expect(byId<HTMLInputElement>('dimMix').value).toBe('60');
    expect(byId<HTMLSpanElement>('dimMixValue').textContent).toBe('60%');
  });

  it('prefills provider-key inputs from loadUserKeys() (never from host keys)', async () => {
    mocks.loadUserKeys.mockResolvedValue({ GROQ_API_KEY: 'gsk-from-user-bag' });
    await importPopup();
    expect(byId<HTMLInputElement>('key_GROQ_API_KEY').value).toBe('gsk-from-user-bag');
  });

  it('with no verified keys, Provider dropdown shows the empty-state option', async () => {
    await importPopup();
    const providerEl = byId<HTMLSelectElement>('provider');
    expect(providerEl.value).toBe('');
    expect(providerEl.options.length).toBe(1);
    expect(providerEl.options[0].textContent).toBe('— no verified keys —');
  });

  it('a valid stored key populates the Provider dropdown with that provider', async () => {
    mocks.loadUserKeys.mockResolvedValue({ GROQ_API_KEY: 'gsk-valid' });
    await importPopup();
    const providerEl = byId<HTMLSelectElement>('provider');
    expect(providerEl.value).toBe('groq');
    const modelSelect = byId<HTMLSelectElement>('modelSelect');
    expect(modelSelect.value).toBe('openai/gpt-oss-120b');
    expect(byId<HTMLInputElement>('model').value).toBe('openai/gpt-oss-120b');
  });

  it('defer-to-chrome-host label stays hidden while host-status reports disconnected', async () => {
    setupChromeMock({ hostConnected: false });
    await importPopup();
    const label = document.querySelector('label.defer-toggle') as HTMLLabelElement;
    expect(label.style.display).toBe('none');
  });

  it('defer-to-chrome-host label becomes visible once host-status reports connected', async () => {
    setupChromeMock({ hostConnected: true });
    await importPopup();
    const label = document.querySelector('label.defer-toggle') as HTMLLabelElement;
    expect(label.style.display).toBe('');
    expect(byId<HTMLInputElement>('deferToChromeHost').disabled).toBe(false);
  });

  it('forces the defer toggle OFF and persists it when the host is gone but the toggle was checked', async () => {
    mocks.loadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, deferToChromeHost: true });
    setupChromeMock({ hostConnected: false });
    await importPopup();
    expect(byId<HTMLInputElement>('deferToChromeHost').checked).toBe(false);
    expect(mocks.saveConfig).toHaveBeenCalledWith({ deferToChromeHost: false });
  });
});

describe('DOM wiring — change/input handlers', () => {
  it('changing the provider select repopulates the model dropdown and apiUrl', async () => {
    mocks.loadUserKeys.mockResolvedValue({ GROQ_API_KEY: 'gsk-valid', CEREBRAS_API_KEY: 'csk-valid' });
    await importPopup();
    const providerEl = byId<HTMLSelectElement>('provider');
    // Two verified providers now available.
    expect(Array.from(providerEl.options).map(o => o.value).sort()).toEqual(['cerebras', 'groq']);
    providerEl.value = 'cerebras';
    providerEl.dispatchEvent(new Event('change'));
    expect(byId<HTMLInputElement>('apiUrl').value).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect(byId<HTMLSelectElement>('modelSelect').value).toBe('gpt-oss-120b');
  });

  it('changing modelSelect updates the hidden model input', async () => {
    mocks.loadUserKeys.mockResolvedValue({ ANTHROPIC_API_KEY: 'sk-ant-valid' });
    await importPopup();
    const modelSelect = byId<HTMLSelectElement>('modelSelect');
    modelSelect.value = 'claude-sonnet-4-6-20250514';
    modelSelect.dispatchEvent(new Event('change'));
    expect(byId<HTMLInputElement>('model').value).toBe('claude-sonnet-4-6-20250514');
  });

  it('moving the dimMix slider updates the % label and live-saves', async () => {
    await importPopup();
    const dimMix = byId<HTMLInputElement>('dimMix');
    dimMix.value = '75';
    dimMix.dispatchEvent(new Event('input'));
    expect(byId<HTMLSpanElement>('dimMixValue').textContent).toBe('75%');
    expect(mocks.saveConfig).toHaveBeenCalledWith({ dimMix: 0.75 });
  });
});

describe('Save button', () => {
  it('happy path — persists fields + booleans + keys, re-verifies, and reports status', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await importPopup();
    byId<HTMLSelectElement>('provider').value = '';
    byId<HTMLInputElement>('apiUrl').value = 'https://api.groq.com/openai/v1/chat/completions';
    byId<HTMLInputElement>('targetSelector').value = '[contenteditable="true"]';
    byId<HTMLInputElement>('ttsEnabled').checked = true;
    byId<HTMLInputElement>('ttsRate').value = '3';
    byId<HTMLInputElement>('key_GROQ_API_KEY').value = 'gsk-newly-pasted';

    byId<HTMLButtonElement>('save').click();
    await flushAsync();

    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      targetSelector: '[contenteditable="true"]',
      ttsEnabled: true,
      ttsRate: 3,
      deferToChromeHost: false,
    }));
    expect(mocks.saveUserKeys).toHaveBeenCalledWith(expect.objectContaining({ GROQ_API_KEY: 'gsk-newly-pasted' }));
    // No verified key yet (fetch mock defaults to ok:true, but this test's
    // fetch mock is the default 200-OK stub, so groq IS verified here).
    const status = byId<HTMLElement>('status');
    expect(status.textContent).toMatch(/saved/);

    await vi.advanceTimersByTimeAsync(3000);
    expect(byId<HTMLElement>('status').textContent).toBe('');
  });

  it('toggling deferToChromeHost to false on Save wipes chrome-host state', async () => {
    mocks.loadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, deferToChromeHost: false });
    await importPopup();
    byId<HTMLButtonElement>('save').click();
    await flushAsync();
    expect(mocks.clearChromeHostState).toHaveBeenCalled();
  });

  it('reports "no verified keys yet" when nothing entered/valid', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' });
    await importPopup();
    byId<HTMLInputElement>('key_GROQ_API_KEY').value = 'gsk-bad-key';
    byId<HTMLButtonElement>('save').click();
    await flushAsync();
    expect(byId<HTMLElement>('status').textContent).toMatch(/no verified keys yet/);
  });
});

describe('Reset button', () => {
  it('calls resetConfig, reloads fresh values, and reports "Reset to defaults"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    mocks.loadConfig.mockResolvedValue({ ...DEFAULT_CONFIG, model: 'stale-model' });
    await importPopup();

    // Second call (post-reset) returns fresh defaults.
    mocks.loadConfig.mockResolvedValue({ ...DEFAULT_CONFIG });
    mocks.loadUserKeys.mockResolvedValue({});

    byId<HTMLButtonElement>('reset').click();
    await flushAsync();

    expect(mocks.resetConfig).toHaveBeenCalled();
    expect(byId<HTMLInputElement>('model').value).toBe(DEFAULT_CONFIG.model);
    expect(byId<HTMLElement>('status').textContent).toBe('Reset to defaults');

    await vi.advanceTimersByTimeAsync(2000);
    expect(byId<HTMLElement>('status').textContent).toBe('');
  });
});

describe('diag-run — self-check diagnostics', () => {
  it('restricted tab URL (chrome://) short-circuits with an explicit warning', async () => {
    setupChromeMock({ tabs: [{ id: 1, url: 'chrome://extensions' }] });
    await importPopup();
    byId<HTMLButtonElement>('diag-run').click();
    await flushAsync();
    const out = byId<HTMLElement>('diag-out');
    expect(out.textContent).toMatch(/restricted URL/);
    expect(out.querySelector('.diag-err')).not.toBeNull();
  });

  it('no active tab logs an explicit failure line', async () => {
    setupChromeMock({ tabs: [] });
    await importPopup();
    byId<HTMLButtonElement>('diag-run').click();
    await flushAsync();
    expect(byId<HTMLElement>('diag-out').textContent).toMatch(/no active tab/);
  });

  it('chrome.tabs.query throwing is caught and surfaced, not left to crash', async () => {
    const chromeMock = setupChromeMock();
    chromeMock.tabsQuery.mockRejectedValue(new Error('permission denied'));
    await importPopup();
    byId<HTMLButtonElement>('diag-run').click();
    await flushAsync();
    expect(byId<HTMLElement>('diag-out').textContent).toMatch(/chrome\.tabs\.query failed: permission denied/);
  });

  it('content script not responding (ping throws) is reported with a recovery hint', async () => {
    setupChromeMock({ pingResponse: 'throw' });
    await importPopup();
    byId<HTMLButtonElement>('diag-run').click();
    await flushAsync();
    const text = byId<HTMLElement>('diag-out').textContent ?? '';
    expect(text).toMatch(/content script not responding/);
    expect(text).toMatch(/hard-refresh/);
  });

  it('happy path renders classified diagnostic lines (ok/warn/section) and flags provider mismatch', async () => {
    setupChromeMock({
      pingResponse: {
        bootVersion: 'v3', currentTarget: 'div#compose', attachStatus: 'attached',
        trustGateInstalled: true, runtimeProvider: 'groq', runtimeModel: 'openai/gpt-oss-120b', runtimeKeys: {},
      },
      storageContents: {
        opencues_user_keys: { CEREBRAS_API_KEY: 'csk-popup' },
        opencues_host_keys: { GROQ_API_KEY: 'gsk-host' },
      },
    });
    mocks.loadUserKeys.mockResolvedValue({ CEREBRAS_API_KEY: 'csk-popup' });
    await importPopup();
    // Popup's own provider select ends up on cerebras (its only verified key);
    // the live runtime reports groq — a genuine mismatch to surface.
    byId<HTMLButtonElement>('diag-run').click();
    await flushAsync();
    const out = byId<HTMLElement>('diag-out');
    expect(out.querySelector('.diag-ok')).not.toBeNull();
    expect(out.querySelector('.diag-section')).not.toBeNull();
    expect(out.textContent).toMatch(/provider mismatch/);
  });

  it('reports when no LLM API keys are present in storage at all', async () => {
    setupChromeMock({ storageContents: {} });
    await importPopup();
    byId<HTMLButtonElement>('diag-run').click();
    await flushAsync();
    expect(byId<HTMLElement>('diag-out').textContent).toMatch(/no LLM API keys set/);
  });
});

describe('diag-probe — per-provider key probe', () => {
  it('no keys entered reports an explicit failure', async () => {
    await importPopup();
    byId<HTMLButtonElement>('diag-probe').click();
    await flushAsync();
    expect(byId<HTMLElement>('diag-out').textContent).toMatch(/no API keys entered/);
  });

  it('a key with surrounding whitespace is flagged before probing', async () => {
    await importPopup();
    byId<HTMLInputElement>('key_GROQ_API_KEY').value = '  gsk-with-space  ';
    byId<HTMLButtonElement>('diag-probe').click();
    await flushAsync();
    expect(byId<HTMLElement>('diag-out').textContent).toMatch(/leading\/trailing whitespace/);
  });

  it('a 401 response renders a rejection line with the response body snippet', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '{"error":"invalid_api_key"}' });
    await importPopup();
    byId<HTMLInputElement>('key_GROQ_API_KEY').value = 'gsk-bad';
    byId<HTMLButtonElement>('diag-probe').click();
    await flushAsync();
    const out = byId<HTMLElement>('diag-out');
    expect(out.textContent).toMatch(/REJECTED the key/);
    expect(out.textContent).toMatch(/invalid_api_key/);
    expect(out.querySelector('.diag-err')).not.toBeNull();
  });

  it('a network error (fetch throws) is caught and reported, not left to crash', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await importPopup();
    byId<HTMLInputElement>('key_GROQ_API_KEY').value = 'gsk-any';
    byId<HTMLButtonElement>('diag-probe').click();
    await flushAsync();
    expect(byId<HTMLElement>('diag-out').textContent).toMatch(/network error: ECONNREFUSED/);
  });

  it('a successful 200 probe renders an OK line', async () => {
    await importPopup();
    byId<HTMLInputElement>('key_CEREBRAS_API_KEY').value = 'csk-good';
    byId<HTMLButtonElement>('diag-probe').click();
    await flushAsync();
    const out = byId<HTMLElement>('diag-out');
    expect(out.textContent).toMatch(/CEREBRAS_API_KEY.*OK/);
    expect(out.querySelector('.diag-ok')).not.toBeNull();
  });
});
