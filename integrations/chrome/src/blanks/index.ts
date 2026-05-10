// Chrome blanks registry. Constructs the per-host Map<string, Blank>
// that opencues-bootstrap.ts hands to the runtime via createBlankInvoke.
//
// Most blanks live in the runtime (`opencues-runtime/src/blanks/`) and
// are instantiated here. Volume stays per-host because it talks to the
// browser tab's audio (Web Audio API) — no portable TS impl makes
// sense across Node + browser.

import type { BrowserBlank } from './types';
import { VolumeBlank } from './volume';
import {
  AnswerBlank,
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

  blanks.set('volume', new VolumeBlank());
  blanks.set('stocks', new StocksBlank({
    apiKey: options?.finnhubApiKey,
    customTickers: options?.customTickers,
  }));
  blanks.set('weather', new WeatherBlank());
  blanks.set('hackernews', new HackerNewsBlank());
  blanks.set('dictionary', new DictionaryBlank());
  blanks.set('crypto', new CryptoBlank());
  blanks.set('countries', new CountriesBlank());

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
