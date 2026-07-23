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

/** Registry of all available browser-native blanks */
export function createBlanks(options?: {
  finnhubApiKey?: string;
  customTickers?: Record<string, string>;
  /**
   * Optional OPENCUES.md file accessors. When supplied, the
   * `opencues settings _` selector/satellite blank is registered.
   * Chrome wires these to browser.storage; without them the blank
   * stays unregistered and the keyword falls through to spawnProcess
   * (which the chrome adapter resolves with exitCode 127).
   */
  opencuesMdReadFile?: () => Promise<string | null>;
  opencuesMdWriteFile?: (content: string) => Promise<void>;
  /**
   * Optional IDENTITY.md file accessors. When supplied, the
   * keyword-bound `set sentinel _` / `remove sentinel _` blank is
   * registered. Chrome wires these to browser.storage; without them
   * the blank stays unregistered (user can still use `opencues
   * identity` from the CLI). Writes go through the same validator
   * as the CLI — see security-audit.md row #24.
   */
  identityMdReadFile?: () => Promise<string | null>;
  identityMdWriteFile?: (content: string) => Promise<void>;
  /**
   * Optional NOTES.md file accessors. When supplied, the keyword-bound
   * `note add/…/delete _` collection blank is registered. Chrome wires
   * these to browser.storage; writes go through @opencues/runtime's
   * validateNoteWrite chokepoint BEFORE the writer is called.
   */
  notesMdReadFile?: () => Promise<string | null>;
  notesMdWriteFile?: (content: string) => Promise<void>;
  /**
   * Live LLM API-key bag thunk (keyed by env-var name) for the `model`
   * blank's effective-routing walk. Chrome keys arrive async post-boot
   * and mutate live (docs/architecture/chrome-llm-keys.md), so this is
   * a thunk over the bootstrap's bag, never a snapshot. Without it the
   * blank still answers for explicitly-configured providers but can't
   * see auto-routed keys.
   */
  getLlmApiKeys?: () => Readonly<Record<string, string | undefined>>;
}): Map<string, BrowserBlank> {
  const opencuesMdIO = (options?.opencuesMdReadFile && options.opencuesMdWriteFile)
    ? { readFile: options.opencuesMdReadFile, writeFile: options.opencuesMdWriteFile }
    : undefined;
  const identityMdIO = (options?.identityMdReadFile && options.identityMdWriteFile)
    ? { readFile: options.identityMdReadFile, writeFile: options.identityMdWriteFile }
    : undefined;
  const notesMdIO = (options?.notesMdReadFile && options.notesMdWriteFile)
    ? { readFile: options.notesMdReadFile, writeFile: options.notesMdWriteFile }
    : undefined;
  return createDefaultBlanksRegistry({
    finnhubApiKey: options?.finnhubApiKey,
    customTickers: options?.customTickers,
    opencuesMdIO,
    identityMdIO,
    notesMdIO,
    hostName: 'chrome',
    getLlmApiKeys: options?.getLlmApiKeys,
  }) as Map<string, BrowserBlank>;
}
