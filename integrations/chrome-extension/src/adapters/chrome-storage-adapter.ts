import { StoredConfig, DEFAULT_CONFIG } from '../types';

const STORAGE_KEY = 'opencues_config';

/** Load config from chrome.storage.local. Persists defaults on first load. */
export async function loadConfig(): Promise<StoredConfig> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  if (!stored) {
    // First load — persist defaults (including baked-in API keys from .env)
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_CONFIG });
    return { ...DEFAULT_CONFIG };
  }
  // Merge stored over defaults, but don't let empty stored values override non-empty defaults
  const merged = { ...DEFAULT_CONFIG };
  for (const [k, v] of Object.entries(stored)) {
    if (v !== '' && v !== null && v !== undefined) {
      (merged as any)[k] = v;
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

/** Listen for config changes */
export function onConfigChange(callback: (config: StoredConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      callback({ ...DEFAULT_CONFIG, ...changes[STORAGE_KEY].newValue });
    }
  });
}
