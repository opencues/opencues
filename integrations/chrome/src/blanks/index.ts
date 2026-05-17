// Chrome blanks registry. Thin wrapper over @opencues/runtime's
// BUILTIN_BLANKS registry — same single source of truth used by
// CC / OC / gemini-cli. Adding a new built-in blank is one entry in
// packages/opencues-runtime/src/blanks/index.ts; no edit here.
//
// VolumeBlank (tab-scoped Web Audio gain) is intentionally NOT
// registered as 'volume': with `opencues install chrome-host`,
// `volume _` falls through to spawnProcess and runs the same system-
// volume script CC/OC use — keeping behaviour consistent across hosts.
// The class is kept around for a future re-binding under a different
// keyword (e.g. `tab-volume`) if needed.
// import { VolumeBlank } from './volume';

import type { BrowserBlank } from './types';
import { createDefaultBlanksRegistry } from '@opencues/runtime/dist/src/blanks';

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
  const opencuesMdIO = (options?.opencuesMdReadFile && options.opencuesMdWriteFile)
    ? { readFile: options.opencuesMdReadFile, writeFile: options.opencuesMdWriteFile }
    : undefined;
  return createDefaultBlanksRegistry({
    llmConfig: options?.llmConfig,
    finnhubApiKey: options?.finnhubApiKey,
    customTickers: options?.customTickers,
    opencuesMdIO,
  }) as Map<string, BrowserBlank>;
}
