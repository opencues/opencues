/** Popup-editable settings stored in chrome.storage.local.
 *
 * NOTE: cue / blank CONTENT no longer lives here. It comes
 * from the bake-time defaults seeded by opencues-bootstrap.ts and
 * (optionally) the `opencues sync chrome` bundle. The popup is a
 * settings panel only.
 */
export interface StoredConfig {
  /** Groq API key. Legacy single-field projection of
   *  `llmApiKeys.GROQ_API_KEY` for popup back-compat. Read-only from
   *  the popup's perspective — writes go through `saveUserKeys`
   *  ({GROQ_API_KEY: '...'}), not `saveConfig`. */
  apiKey: string;
  /** CSS selector for the target element */
  targetSelector: string;
  /** LLM model name (default: openai/gpt-oss-120b) */
  model: string;
  /** API endpoint URL */
  apiUrl: string;
  /** LLM provider id (groq | cerebras | openai | anthropic | gemini |
   *  openrouter). Set via the popup's Provider dropdown. Auto-fills
   *  model + apiUrl with the matching defaults on pick. Empty when
   *  the user has never selected — model/apiUrl are then taken as-is. */
  provider: string;
  /** When true, the popup's Provider/Model/API URL fields are NOT
   *  forwarded as runtime overrides — OPENCUES.md scalars in the
   *  chrome-host-pushed bundle become authoritative. Use when running
   *  `opencues install chrome-host` so your `~/.cues/OPENCUES.md` drives
   *  config (matching how CC/OC/gemini-cli work). Default false:
   *  popup overrides win, which is the right answer for users without
   *  chrome-host. */
  deferToChromeHost: boolean;
  /** Enable TTS */
  ttsEnabled: boolean;
  /** TTS speech rate (1-5) */
  ttsRate: number;
  /** Finnhub API key for stock prices */
  finnhubApiKey: string;
  /** Multi-provider key bag, keyed by env-var name (GROQ_API_KEY,
   *  GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
   *  CEREBRAS_API_KEY, OPENROUTER_API_KEY). Forwarded straight to the
   *  runtime resolver. **Derived in `loadConfig`** by merging the
   *  host bag (`opencues_host_keys`) and the user bag
   *  (`opencues_user_keys`); user keys win on collision. NEVER
   *  persisted into `opencues_config` — that snapshot-into-storage
   *  was the May 2026 regression that made `llm-provider: cerebras`
   *  silently no-op on chrome. */
  llmApiKeys: Readonly<Record<string, string>>;
  /** How far the dim colour is mixed toward the page background (0-1).
   *  0 = identical to host text colour; 1 = invisible. Default 0.45. */
  dimMix: number;
}

// Build-time injection — esbuild replaces these with literals.
// `__FINNHUB_API_KEY__` is kept inert for parity; secrets are never
// baked into the published bundle (esbuild defines them as '' — see
// `esbuild.config.mjs`). The TS declaration keeps the symbol
// addressable for the type-checker.
declare const __FINNHUB_API_KEY__: string;

// In-memory fallback used by `loadConfig` when a field hasn't been
// written to storage yet. **Never persisted** — writing a snapshot of
// the bake-time secrets into `opencues_config` was the structural
// cause of the May 2026 cerebras regression (the snapshot then
// clobbered the host's multi-provider push on every reload).
// `apiKey` is derived at read-time from the live host/user key bags;
// `llmApiKeys` is composed from those bags in `loadConfig`.
export const DEFAULT_CONFIG: StoredConfig = {
  apiKey: '',
  targetSelector: '[contenteditable="true"]',
  model: 'openai/gpt-oss-120b',
  apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  provider: '',
  deferToChromeHost: false,
  ttsEnabled: false,
  ttsRate: 2,
  finnhubApiKey: __FINNHUB_API_KEY__,
  llmApiKeys: {},
  dimMix: 0.45,
};
