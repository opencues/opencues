// Host port — the single import the popup uses for config/keys/status.
//
// Picks its backing at load time:
//   * chrome extension context (chrome.storage present) → chrome-storage-adapter
//   * anything else (native host WebView2 / browser tab served by the
//     OpenCues daemon) → http-config-adapter
//
// Both back the SAME popup component. This is the seam that lets the
// Windows host (and any future native host) reuse the chrome popup UI
// instead of reimplementing a keys/settings surface.

import type { StoredConfig } from '../types';
import * as chromeAdapter from './chrome-storage-adapter';
import * as httpAdapter from './http-config-adapter';

const hasChromeStorage =
  typeof chrome !== 'undefined' &&
  !!(chrome as unknown as { storage?: unknown }).storage &&
  !!(chrome as unknown as { runtime?: unknown }).runtime;

export const PORT_KIND: 'chrome' | 'http' = hasChromeStorage ? 'chrome' : 'http';

const impl = hasChromeStorage ? chromeAdapter : httpAdapter;

// ─── Unified config/keys surface (identical signatures both ways) ───────
export const loadConfig: () => Promise<StoredConfig> = impl.loadConfig;
export const saveConfig: (c: Partial<StoredConfig>) => Promise<void> = impl.saveConfig;
export const loadUserKeys: () => Promise<Record<string, string>> = impl.loadUserKeys;
export const saveUserKeys: (k: Record<string, string>) => Promise<void> = impl.saveUserKeys;
export const resetConfig: () => Promise<void> = impl.resetConfig;
export const clearChromeHostState: () => Promise<void> = impl.clearChromeHostState;
export const onConfigChange: (cb: (c: StoredConfig) => void) => void = impl.onConfigChange;

// ─── Extras the popup used to call on chrome.* directly ─────────────────
export async function getVersion(): Promise<string> {
  if (hasChromeStorage) {
    try { return (chrome as unknown as { runtime: { getManifest(): { version: string } } }).runtime.getManifest().version; }
    catch { return '?'; }
  }
  return httpAdapter.getVersion();
}

export async function getHostStatus(): Promise<({ connected: boolean } & Record<string, unknown>) | null> {
  if (hasChromeStorage) {
    try {
      const reply = await (chrome as unknown as { runtime: { sendMessage(m: unknown): Promise<unknown> } })
        .runtime.sendMessage({ type: 'opencues:host-status' });
      return (reply as { connected: boolean } & Record<string, unknown>) ?? null;
    } catch { return null; }
  }
  return httpAdapter.getHostStatus();
}
