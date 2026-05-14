import { StoredConfig, DEFAULT_CONFIG } from '../types';

const STORAGE_KEY = 'opencues_config';
const HOST_KEYS_STORAGE = 'opencues_host_keys';

// Map from the host's env-var names to legacy single-field
// StoredConfig slots that the popup still reads. The general bag
// (`llmApiKeys`) below carries EVERY env-key the host pushes, regardless
// of whether it has a legacy slot — that's what the resolver actually
// reads at runtime, and what makes `llm-provider: gemini` etc. work on
// chrome. Previously this map was the only path, so non-groq keys were
// silently dropped and switching providers in CUES.md silently no-op'd.
const HOST_KEY_LEGACY_FIELD_MAP: Record<string, keyof StoredConfig> = {
  GROQ_API_KEY: 'apiKey',
  FINNHUB_API_KEY: 'finnhubApiKey',
};

async function readHostKeys(): Promise<Partial<StoredConfig>> {
  try {
    const result = await chrome.storage.local.get(HOST_KEYS_STORAGE);
    const stored = result[HOST_KEYS_STORAGE] as Record<string, string> | undefined;
    if (!stored) return {};
    const out: Partial<StoredConfig> = {};
    // Forward EVERY *_API_KEY into the multi-provider bag. The runtime
    // resolver keys directly off env-var names (`GROQ_API_KEY`,
    // `GEMINI_API_KEY`, …) so this is the path that makes non-groq
    // providers actually work.
    const llmApiKeys: Record<string, string> = {};
    for (const [envName, raw] of Object.entries(stored)) {
      if (typeof raw !== 'string') continue;
      // Trim — whitespace-only keys would otherwise pass length checks
      // and 401 at the provider with a confusing error. Trailing
      // newlines also slip in when a user copies a key from a multi-
      // line .env file.
      const value = raw.trim();
      if (value.length === 0) continue;
      if (envName.endsWith('_API_KEY')) llmApiKeys[envName] = value;
      const legacyField = HOST_KEY_LEGACY_FIELD_MAP[envName];
      if (legacyField) (out as Record<string, string>)[legacyField] = value;
    }
    if (Object.keys(llmApiKeys).length > 0) {
      (out as { llmApiKeys?: Record<string, string> }).llmApiKeys = llmApiKeys;
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
  // Bridge: when the popup-only user has only the legacy `apiKey` field
  // set (no native host pushing a full multi-provider bag), promote it
  // into `llmApiKeys` so the runtime resolver sees `GROQ_API_KEY`.
  // Without this, popup users who never ran `opencues install
  // chrome-host` would have an empty resolver bag and every LLM call
  // would no-op — the bake-time DEFAULT_CONFIG.llmApiKeys is `{}`
  // because `__GROQ_API_KEY__` is intentionally not baked into the
  // published bundle (secrets policy).
  if (merged.apiKey && !merged.llmApiKeys.GROQ_API_KEY) {
    merged.llmApiKeys = { ...merged.llmApiKeys, GROQ_API_KEY: merged.apiKey };
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
 *  env-var change). Always re-resolves the merged view.
 *
 *  Real-time key updates: the chrome bootstrap subscribes here AND
 *  forwards the new `llmApiKeys` bag into the runtime's
 *  `bootResult.updateApiKeys(...)`. The resolver mutates its live
 *  apiKeys ref + rebuilds sources on the next dispatch — no tab
 *  reload required when a host pushes new keys or the user edits the
 *  popup. */
export function onConfigChange(callback: (config: StoredConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(changes[STORAGE_KEY] || changes[HOST_KEYS_STORAGE])) return;
    void loadConfig().then(callback);
  });
}
