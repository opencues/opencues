import { StoredConfig, DEFAULT_CONFIG } from '../types';

const STORAGE_KEY = 'opencues_config';
const HOST_KEYS_STORAGE = 'opencues_host_keys';

// Map from the host's env-var names to StoredConfig field names.
// The host sends raw env keys (GROQ_API_KEY, FINNHUB_API_KEY, …);
// we project them onto the existing StoredConfig shape.
const HOST_KEY_FIELD_MAP: Record<string, keyof StoredConfig> = {
  GROQ_API_KEY: 'apiKey',
  FINNHUB_API_KEY: 'finnhubApiKey',
};

async function readHostKeys(): Promise<Partial<StoredConfig>> {
  try {
    const result = await chrome.storage.local.get(HOST_KEYS_STORAGE);
    const stored = result[HOST_KEYS_STORAGE] as Record<string, string> | undefined;
    if (!stored) return {};
    const out: Partial<StoredConfig> = {};
    for (const [envName, value] of Object.entries(stored)) {
      const field = HOST_KEY_FIELD_MAP[envName];
      if (field && typeof value === 'string' && value.length > 0) {
        (out as Record<string, string>)[field] = value;
      }
    }
    return out;
  } catch { return {}; }
}

/** Load config from chrome.storage.local.
 *
 * Resolution order (low to high priority):
 *   1. DEFAULT_CONFIG               ← compile-time fallback (no secrets)
 *   2. opencues_host_keys           ← pushed by native-messaging host
 *   3. opencues_config (user-set)   ← popup overrides
 *
 * Persists DEFAULT_CONFIG on first load so the popup has a stable
 * starting point to render against.
 */
export async function loadConfig(): Promise<StoredConfig> {
  const [stored, hostKeys] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY).then(r => r[STORAGE_KEY] as Partial<StoredConfig> | undefined),
    readHostKeys(),
  ]);

  if (!stored) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_CONFIG });
  }

  // Build the merged config: defaults → host → user.
  const merged: StoredConfig = { ...DEFAULT_CONFIG, ...hostKeys };
  if (stored) {
    const mergedAny = merged as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(stored)) {
      if (v !== '' && v !== null && v !== undefined) {
        mergedAny[k] = v;
      }
    }
  }
  return merged;
}

/** Save config to chrome.storage.local */
export async function saveConfig(config: Partial<StoredConfig>): Promise<void> {
  const current = await loadConfig();
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...current, ...config },
  });
}

/** Reset config to defaults (clears stored values) */
export async function resetConfig(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/** Listen for config changes. Fires on both opencues_config (popup
 *  edits) and opencues_host_keys (host re-push after a reconnect or
 *  env-var change). Always re-resolves the merged view. */
export function onConfigChange(callback: (config: StoredConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY] || changes[HOST_KEYS_STORAGE]) {
      void loadConfig().then(callback);
    }
  });
}
