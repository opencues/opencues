// Chrome blanks registry. Constructs the per-host Map<string, Blank>
// that opencues-bootstrap.ts hands to the runtime via createBlankInvoke.
//
// Most blanks live in the runtime (`opencues-runtime/src/blanks/`) and
// are instantiated here. Volume stays per-host because it talks to the
// browser tab's audio (Web Audio API) — no portable TS impl makes
// sense across Node + browser.
//
// ⚠️ ADDING A NEW BLANK: implementing the class in the runtime is NOT
// enough on its own. You also need to (a) IMPORT it from
// `@opencues/runtime/dist/src/blanks` at the top of this file, and
// (b) `blanks.set('<name>', new YourBlank(...))` inside createBlanks
// below. Without both, `<name>` will dispatch but find no handler in
// chrome — the keyword silently falls through to spawnProcess, which
// chrome resolves with exitCode 127. (See claude-status May 2026 — the
// runtime had the impl + tests + dist build, but chrome's registry
// never imported it.)

import type { BrowserBlank } from './types';
// VolumeBlank (tab-scoped Web Audio gain) is intentionally NOT
// registered as the 'volume' keyword. With `opencues install
// chrome-host`, `volume _` falls through to spawnProcess and runs the
// same system-volume script CC/OC use — keeping behaviour consistent
// across hosts. The class is kept around for a future re-binding
// under a different keyword (e.g. `tab-volume`) if needed.
// import { VolumeBlank } from './volume';
import {
  AnswerBlank,
  ClaudeStatusBlank,
  CountriesBlank,
  CryptoBlank,
  DictionaryBlank,
  HackerNewsBlank,
  OpenCuesSettingsBlank,
  PromptImproverBlank,
  StocksBlank,
  WeatherBlank,
} from '@opencues/runtime/dist/src/blanks';

export type { BrowserBlank } from './types';
export { PromptImproverBlank } from '@opencues/runtime/dist/src/blanks';
export type PromptImproverConfig = {
  apiKey: string;
  apiUrl: string;
  model: string;
  altCount?: number;
  includeOriginal?: boolean;
};

/** Registry of all available browser-native blanks */
export function createBlanks(options?: {
  finnhubApiKey?: string;
  customTickers?: Record<string, string>;
  llmConfig?: PromptImproverConfig;
  /**
   * Optional OPENCUES.md file accessors. When supplied, the
   * `opencues settings _` selector/satellite blank is registered.
   * Chrome wires these to chrome.storage; without them the blank
   * stays unregistered and the keyword falls through to spawnProcess
   * (which the chrome adapter resolves with exitCode 127).
   */
  opencuesMdReadFile?: () => Promise<string | null>;
  opencuesMdWriteFile?: (content: string) => Promise<void>;
}): Map<string, BrowserBlank> {
  const blanks = new Map<string, BrowserBlank>();

  // 'volume' deliberately unregistered here — see import-block note.
  blanks.set('stocks', new StocksBlank({
    apiKey: options?.finnhubApiKey,
    customTickers: options?.customTickers,
  }));
  blanks.set('weather', new WeatherBlank());
  blanks.set('hackernews', new HackerNewsBlank());
  blanks.set('dictionary', new DictionaryBlank());
  blanks.set('crypto', new CryptoBlank());
  blanks.set('countries', new CountriesBlank());
  blanks.set('claude-status', new ClaudeStatusBlank());

  if (options?.llmConfig) {
    blanks.set('prompt', new PromptImproverBlank(options.llmConfig));
    // Same LLM credentials power the answer blank — factual lookups,
    // translations, definitions. AnswerBlank is read-only + multi-line
    // for cycling; degrades to "" without a key.
    blanks.set('answer', new AnswerBlank({
      apiKey: options.llmConfig.apiKey,
      apiUrl: options.llmConfig.apiUrl,
      model: options.llmConfig.model,
    }));
  }

  if (options?.opencuesMdReadFile && options.opencuesMdWriteFile) {
    blanks.set('opencues', new OpenCuesSettingsBlank({
      readFile: options.opencuesMdReadFile,
      writeFile: options.opencuesMdWriteFile,
    }));
  }

  return blanks;
}
