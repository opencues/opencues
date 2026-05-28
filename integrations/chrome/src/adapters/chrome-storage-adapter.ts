import { StoredConfig, DEFAULT_CONFIG } from '../types';

const STORAGE_KEY = 'opencues_config';
const HOST_KEYS_STORAGE = 'opencues_host_keys';
const USER_KEYS_STORAGE = 'opencues_user_keys';

// Map from the host's env-var names to legacy single-field
// StoredConfig slots that the popup still reads. `llmApiKeys` is no
// longer projected through StoredConfig — it lives in its own
// dedicated storage key (USER_KEYS_STORAGE / HOST_KEYS_STORAGE) so
// the popup's read-modify-write of `opencues_config` can never
// clobber the multi-provider bag. That clobber was the May 2026
// regression: DEFAULT_CONFIG snapshotted a single-groq llmApiKeys
// into `opencues_config` on first load, then on every subsequent
// load the stored single-groq bag overwrote the host's full bag.
const HOST_KEY_LEGACY_FIELD_MAP: Record<string, keyof StoredConfig> = {
  GROQ_API_KEY: 'apiKey',
};

interface KeyBags {
  /** Pushed by the native-messaging host's `sendHostConfig`. */
  host: Record<string, string>;
  /** Pasted by the user into the popup. Overrides host on key collision. */
  user: Record<string, string>;
  /** Legacy single-field projection (apiKey) for popup back-compat. */
  legacy: Partial<StoredConfig>;
}

function sanitiseKeyBag(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [envName, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue;
    // Trim — whitespace-only keys would otherwise pass length checks
    // and 401 at the provider with a confusing error. Trailing
    // newlines also slip in when a user copies a key from a multi-
    // line .env file.
    const value = raw.trim();
    if (value.length === 0) continue;
    if (!envName.endsWith('_API_KEY')) continue;
    out[envName] = value;
  }
  return out;
}

async function readKeyBags(): Promise<KeyBags> {
  try {
    const result = await chrome.storage.local.get([HOST_KEYS_STORAGE, USER_KEYS_STORAGE]);
    const host = sanitiseKeyBag(result[HOST_KEYS_STORAGE]);
    const user = sanitiseKeyBag(result[USER_KEYS_STORAGE]);
    // Legacy single-field projection — derived from whichever bag
    // has the env-key (user wins). Popup back-compat only.
    const legacy: Partial<StoredConfig> = {};
    for (const [envName, field] of Object.entries(HOST_KEY_LEGACY_FIELD_MAP)) {
      const value = user[envName] ?? host[envName];
      if (value) (legacy as Record<string, string>)[field] = value;
    }
    return { host, user, legacy };
  } catch { return { host: {}, user: {}, legacy: {} }; }
}

/** One-time cleanup: older bundle versions persisted a snapshot of
 *  `DEFAULT_CONFIG` (including a bake-time groq `llmApiKeys`) into
 *  `opencues_config` on first load. That snapshot then clobbered the
 *  host's multi-provider bag on every subsequent merge — the May 2026
 *  "cerebras silently no-ops on chrome" bug. Strip `llmApiKeys` and
 *  `apiKey` from any stored `opencues_config` we encounter so the new
 *  ownership model (host bag + user bag, never popup-bag) can't be
 *  fooled by leftover state from the old layout.
 *
 *  Idempotent — safe to run on every load. Fires only when the stale
 *  fields are actually present, so steady-state is a single read with
 *  no write. */
async function migrateStaleConfig(stored: Record<string, unknown> | undefined): Promise<void> {
  if (!stored) return;
  const hasStaleLlmKeys = stored.llmApiKeys !== undefined;
  const hasStaleApiKey = typeof stored.apiKey === 'string' && stored.apiKey.length > 0;
  if (!hasStaleLlmKeys && !hasStaleApiKey) return;
  const cleaned: Record<string, unknown> = { ...stored };
  delete cleaned.llmApiKeys;
  // Promote stale `apiKey` (popup-set groq) into `opencues_user_keys`
  // if there's nothing there yet, then strip from `opencues_config`.
  if (hasStaleApiKey) {
    const existing = await chrome.storage.local.get(USER_KEYS_STORAGE);
    const userKeys = sanitiseKeyBag(existing[USER_KEYS_STORAGE]);
    if (!userKeys.GROQ_API_KEY) {
      userKeys.GROQ_API_KEY = (stored.apiKey as string).trim();
      await chrome.storage.local.set({ [USER_KEYS_STORAGE]: userKeys });
    }
    delete cleaned.apiKey;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: cleaned });
}

/** Load config from chrome.storage.local.
 *
 * Three independent storage areas with strict ownership:
 *
 *   opencues_config        ← popup-owned settings (no secrets, no llmApiKeys)
 *   opencues_host_keys     ← native-messaging host's env-var bag
 *   opencues_user_keys     ← popup-pasted per-provider keys
 *
 * `DEFAULT_CONFIG` is an in-memory fallback only; it is never
 * persisted. The final `llmApiKeys` bag is `{...host, ...user}` —
 * user-set keys win on collision (explicit intent beats env). The
 * legacy `apiKey` field is derived from whichever bag carries
 * `GROQ_API_KEY` for popup back-compat.
 *
 * This is the structural fix for the May 2026 "cerebras silently
 * no-ops on chrome" regression. The old layout had `llmApiKeys`
 * inside `opencues_config`, so a read-modify-write from the popup
 * could re-persist a stale groq-only bag and clobber the host's
 * multi-provider push on the next load.
 */
export async function loadConfig(): Promise<StoredConfig> {
  // Migration runs FIRST so the subsequent reads observe the cleaned
  // state. `migrateStaleConfig` may promote a stale `opencues_config.apiKey`
  // into `opencues_user_keys.GROQ_API_KEY` — `readKeyBags` then sees
  // that promoted value.
  const storedRaw = await chrome.storage.local.get(STORAGE_KEY)
    .then(r => r[STORAGE_KEY] as Record<string, unknown> | undefined);
  await migrateStaleConfig(storedRaw);

  const [stored, bags] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY).then(r => r[STORAGE_KEY] as Record<string, unknown> | undefined),
    readKeyBags(),
  ]);

  const merged: StoredConfig = { ...DEFAULT_CONFIG, ...bags.legacy };
  if (stored) {
    const mergedAny = merged as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(stored)) {
      // `llmApiKeys` is never read from `opencues_config` anymore — it
      // lives in its own storage area. Skip defensively in case a
      // future bug re-introduces it.
      if (k === 'llmApiKeys') continue;
      if (v !== '' && v !== null && v !== undefined) {
        mergedAny[k] = v;
      }
    }
  }
  // Final llmApiKeys bag — host + user, user wins on collision.
  merged.llmApiKeys = { ...bags.host, ...bags.user };
  return merged;
}

/** Save popup-owned settings to `opencues_config`. NEVER writes
 *  `llmApiKeys` or `apiKey` — those live in `opencues_user_keys` and
 *  go through `saveUserKeys`. */
export async function saveConfig(config: Partial<StoredConfig>): Promise<void> {
  const cleaned: Record<string, unknown> = { ...config };
  delete cleaned.llmApiKeys;
  delete cleaned.apiKey;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = (result[STORAGE_KEY] as Record<string, unknown>) ?? {};
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...stored, ...cleaned },
  });
}

/** Save popup-pasted provider keys to `opencues_user_keys`. Keys
 *  with empty / whitespace-only values are dropped (not persisted as
 *  zero-length strings that would later mask a host-pushed value). */
export async function saveUserKeys(keys: Record<string, string>): Promise<void> {
  const existing = await chrome.storage.local.get(USER_KEYS_STORAGE);
  const current = sanitiseKeyBag(existing[USER_KEYS_STORAGE]);
  for (const [envName, raw] of Object.entries(keys)) {
    if (!envName.endsWith('_API_KEY')) continue;
    const value = (raw ?? '').trim();
    if (value.length === 0) delete current[envName];
    else current[envName] = value;
  }
  await chrome.storage.local.set({ [USER_KEYS_STORAGE]: current });
}

/** Read just the popup-pasted provider keys (for popup UI prefill). */
export async function loadUserKeys(): Promise<Record<string, string>> {
  const existing = await chrome.storage.local.get(USER_KEYS_STORAGE);
  return sanitiseKeyBag(existing[USER_KEYS_STORAGE]);
}

/** Reset config to defaults (clears stored values). Also clears
 *  user-pasted keys so "Reset to Defaults" is genuinely a clean
 *  slate. Host-pushed keys are untouched — they belong to the host. */
export async function resetConfig(): Promise<void> {
  await chrome.storage.local.remove([STORAGE_KEY, USER_KEYS_STORAGE]);
}

/** Wipe every storage surface chrome-host can write into. Called by
 *  the popup's Save handler when the user toggles `deferToChromeHost`
 *  OFF — the user is explicitly opting out of chrome-host-derived
 *  state, so any of it that lingered would surface as "weird
 *  persistence" (e.g. OPENCUES.md scalars pushed by the host keep
 *  driving config after the toggle was supposed to disable them).
 *
 *  Three layers in one shot:
 *   1. `opencues_bundle`      — the host's file map
 *   2. `opencues_host_keys`   — env-var keys pushed by the host
 *   3. `opencues_runtime:*`   — per-file caches the bootstrap
 *                               populates from each bundle push
 *                               (`opencues-bootstrap.ts` writes
 *                               OPENCUES.md / CUES.md / BLANK.md
 *                               into per-file keys; readFile then
 *                               reads them as a fallback layer
 *                               below the bundle).
 *
 *  Hostless users never see the toggle (popup hides it when the SW
 *  reports the host disconnected), so this wipe only fires when a
 *  user who actively opted in once toggles back OFF. Chrome-side
 *  cycled state on pure-hostless installs is therefore never
 *  accidentally wiped by this path. */
export async function clearChromeHostState(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keysToRemove: string[] = ['opencues_bundle', 'opencues_host_keys'];
  for (const k of Object.keys(all)) {
    if (k.startsWith('opencues_runtime:')) keysToRemove.push(k);
  }
  await chrome.storage.local.remove(keysToRemove);
}

/** Listen for config changes. Fires on any of the three storage
 *  areas (popup settings, host keys, user keys) and always re-resolves
 *  the merged view.
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
    if (!(changes[STORAGE_KEY] || changes[HOST_KEYS_STORAGE] || changes[USER_KEYS_STORAGE])) return;
    void loadConfig().then(callback);
  });
}
