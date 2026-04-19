/** Config stored in chrome.storage.local */
export interface StoredConfig {
  /** Raw cues.md content (copy-pasted) */
  cuesMd: string;
  /** Raw blanks.md content (copy-pasted) */
  blanksMd: string;
  /** Raw opencues.md content (copy-pasted) */
  opencuesMd: string;
  /** Extra tips JSON (optional — tips are usually inline in cues.md ## Tips block) */
  tipsJson: string;
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
}

// Build-time injection — esbuild replaces these with literals from .env + project files
declare const __GROQ_API_KEY__: string;
declare const __FINNHUB_API_KEY__: string;
declare const __DEFAULT_CUES_MD__: string;
declare const __DEFAULT_BLANKS_MD__: string;
declare const __DEFAULT_CUE_FOLDERS__: Record<string, string>;
declare const __DEFAULT_CONTROL_FOLDERS__: Record<string, string>;
declare const __DEFAULT_OPENCUES_MD__: string;
declare const __DEFAULT_TIPS_JSON__: string;

export const DEFAULT_CONFIG: StoredConfig = {
  cuesMd: __DEFAULT_CUES_MD__,
  blanksMd: __DEFAULT_BLANKS_MD__,
  opencuesMd: __DEFAULT_OPENCUES_MD__,
  tipsJson: __DEFAULT_TIPS_JSON__,
  apiKey: __GROQ_API_KEY__,
  targetSelector: '[contenteditable="true"]',
  model: 'openai/gpt-oss-120b',
  apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  ttsEnabled: false,
  ttsRate: 2,
  finnhubApiKey: __FINNHUB_API_KEY__,
};

