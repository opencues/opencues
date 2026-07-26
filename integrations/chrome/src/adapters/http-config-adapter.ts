// HTTP config adapter — the NON-chrome backing for the shared popup.
//
// Implements the same surface as chrome-storage-adapter, but backed by
// the OpenCues daemon's localhost config API (integrations/windows/src/
// config-server.cjs) instead of chrome.storage. Used when the popup is
// served by a native host (the Windows tray's WebView2 window, or a
// plain browser tab) rather than loaded as a chrome extension page.
//
// All requests are same-origin relative (`/api/...`) — the popup is
// served by the daemon, so no base URL or CORS concerns in practice.
// One component, two backends; picked at runtime by host-port.ts.

import { StoredConfig, DEFAULT_CONFIG } from '../types';

async function getJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) return fallback;
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { /* surfaced by the next load's mismatch, like chrome */ }
}

export async function loadConfig(): Promise<StoredConfig> {
  const cfg = await getJson<Partial<StoredConfig>>('/api/config', {});
  // Keys come through loadUserKeys (real values); config carries settings.
  // llmApiKeys stays empty here — the popup reads keys from loadUserKeys.
  return { ...DEFAULT_CONFIG, ...cfg, llmApiKeys: {} };
}

export async function saveConfig(config: Partial<StoredConfig>): Promise<void> {
  // Only the settings the native config understands; extras are ignored
  // server-side (chrome-only fields have no OPENCUES.md scalar).
  await postJson('/api/config', {
    provider: config.provider,
    model: config.model,
    apiUrl: config.apiUrl,
    ttsRate: config.ttsRate,
    deferToChromeHost: config.deferToChromeHost,
  });
}

export async function loadUserKeys(): Promise<Record<string, string>> {
  return getJson<Record<string, string>>('/api/keys', {});
}

export async function saveUserKeys(keys: Record<string, string>): Promise<void> {
  await postJson('/api/config', { keys });
}

export async function resetConfig(): Promise<void> {
  // No native "reset all" — clearing keys is a per-provider empty write;
  // settings reset would need a scalar delete. A future /api/reset can
  // back this. For now, a no-op keeps the popup's Reset button harmless
  // rather than throwing.
}

export async function clearChromeHostState(): Promise<void> {
  // Chrome-host-specific concept; nothing to clear on a native host.
}

export function onConfigChange(callback: (config: StoredConfig) => void): void {
  // Poll the config endpoint; fire when the serialized value changes.
  // Cheap (localhost, ~2s) and matches chrome.storage.onChanged's
  // "something changed, re-read" contract without a push channel.
  let last = '';
  setInterval(() => {
    void (async () => {
      const cfg = await loadConfig();
      const snap = JSON.stringify(cfg);
      if (snap !== last) { last = snap; callback(cfg); }
    })();
  }, 2000);
}

// ─── Extras the popup calls directly (routed via host-port) ─────────────
export async function getVersion(): Promise<string> {
  const st = await getJson<{ hostVersion?: string }>('/api/status', {});
  return st.hostVersion ?? '?';
}

export async function getHostStatus(): Promise<{ connected: boolean } & Record<string, unknown>> {
  const st = await getJson<Record<string, unknown>>('/api/status', {});
  // The daemon's shim connection stands in for chrome's "host connected".
  return { connected: !!st.shimConnected, ...st };
}
