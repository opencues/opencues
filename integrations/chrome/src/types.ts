/** Popup-editable settings stored in chrome.storage.local.
 *
 * NOTE: cue / blank CONTENT no longer lives here. It comes
 * from the bake-time defaults seeded by opencues-bootstrap.ts and
 * (optionally) the `opencues sync chrome` bundle. The popup is a
 * settings panel only.
 */
export interface StoredConfig {
  /** Groq API key */
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
  dimMix: 0.45,
};
