// Chrome controls registry. Constructs the per-host Map<string, Control>
// that opencues-bootstrap.ts hands to the runtime via createControlInvoke.
//
// Most controls live in the runtime now (`opencues-runtime/src/controls/`)
// and are instantiated here. Volume stays per-host because it talks to
// the browser tab's audio (Web Audio API) — no portable TS impl makes
// sense across Node + browser.

import type { BrowserControl } from './types';
import { VolumeControl } from './volume';
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
} from '@opencues/runtime/dist/src/controls';

export type { BrowserControl } from './types';
export { PromptImproverBlank } from '@opencues/runtime/dist/src/controls';
export type PromptImproverConfig = {
  apiKey: string;
  apiUrl: string;
  model: string;
  altCount?: number;
  includeOriginal?: boolean;
};

/** Registry of all available browser-native controls */
export function createControls(options?: {
  finnhubApiKey?: string;
  customTickers?: Record<string, string>;
  llmConfig?: PromptImproverConfig;
  /**
   * Optional opencues.md file accessors. When supplied, the
   * `opencues settings _` selector/satellite control is registered.
   * Chrome wires these to chrome.storage; without them the control
   * stays unregistered and the keyword falls through to spawnProcess
   * (which the chrome adapter resolves with exitCode 127).
   */
  opencuesMdReadFile?: () => Promise<string | null>;
  opencuesMdWriteFile?: (content: string) => Promise<void>;
}): Map<string, BrowserControl> {
  const controls = new Map<string, BrowserControl>();

  controls.set('volume', new VolumeControl());
  controls.set('stocks', new StocksBlank({
    apiKey: options?.finnhubApiKey,
    customTickers: options?.customTickers,
  }));
  controls.set('weather', new WeatherBlank());
  controls.set('hackernews', new HackerNewsBlank());
  controls.set('dictionary', new DictionaryBlank());
  controls.set('crypto', new CryptoBlank());
  controls.set('countries', new CountriesBlank());

  if (options?.llmConfig) {
    controls.set('prompt', new PromptImproverBlank(options.llmConfig));
    // Same LLM credentials power the answer control — factual lookups,
    // translations, definitions. AnswerBlank is read-only + multi-line
    // for cycling; degrades to "" without a key.
    controls.set('answer', new AnswerBlank({
      apiKey: options.llmConfig.apiKey,
      apiUrl: options.llmConfig.apiUrl,
      model: options.llmConfig.model,
    }));
  }

  if (options?.opencuesMdReadFile && options.opencuesMdWriteFile) {
    controls.set('opencues', new OpenCuesSettingsBlank({
      readFile: options.opencuesMdReadFile,
      writeFile: options.opencuesMdWriteFile,
    }));
  }

  return controls;
}
