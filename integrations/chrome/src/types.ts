/** Popup-editable settings stored in chrome.storage.local.
 *
 * NOTE: cue / blank CONTENT no longer lives here. It comes
 * from the bake-time defaults seeded by opencues-bootstrap.ts and
 * (optionally) the `opencues sync chrome` bundle. The popup is a
 * settings panel only.
 */
export interface StoredConfig {
  /** Groq API key. Legacy field — kept for popup back-compat. The
   *  resolver-level bag lives in `llmApiKeys` (which also includes
   *  GROQ_API_KEY for free, so this duplicates it). */
  apiKey: string;
  /** CSS selector for the target element */
  targetSelector: string;
  /** LLM model name (default: openai/gpt-oss-120b) */
  model: string;
  /** API endpoint URL */
  apiUrl: string;
  /** Enable TTS */
  ttsEnabled: boolean;
  /** TTS speech rate (1-5) */
  ttsRate: number;
  /** Finnhub API key for stock prices */
  finnhubApiKey: string;
  /** Multi-provider key bag, keyed by env-var name
   *  (GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
   *  CEREBRAS_API_KEY, OPENROUTER_API_KEY). Forwarded straight to the
   *  runtime resolver. Without this, switching `llm-provider:` in
   *  CUES.md to anything other than Groq would silently no-op on
   *  chrome — the resolver couldn't find a key for the chosen
   *  provider and would return null without surfacing the failure.
   *  Populated by the native-messaging host's config push;
   *  chrome-storage-adapter writes both this AND the legacy
   *  fields above so popup-only users keep working. */
  llmApiKeys: Readonly<Record<string, string>>;
  /** How far the dim colour is mixed toward the page background (0-1).
   *  0 = identical to host text colour; 1 = invisible. Default 0.45. */
  dimMix: number;
}

// Build-time injection — esbuild replaces these with literals from .env.
declare const __GROQ_API_KEY__: string;
declare const __FINNHUB_API_KEY__: string;

export const DEFAULT_CONFIG: StoredConfig = {
  apiKey: __GROQ_API_KEY__,
  targetSelector: '[contenteditable="true"]',
  model: 'openai/gpt-oss-120b',
  apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  ttsEnabled: false,
  ttsRate: 2,
  finnhubApiKey: __FINNHUB_API_KEY__,
  llmApiKeys: __GROQ_API_KEY__ ? { GROQ_API_KEY: __GROQ_API_KEY__ } : {},
  dimMix: 0.45,
};
