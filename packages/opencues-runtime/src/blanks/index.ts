// Blanks registry helpers — every host wires blanks (script-replaceable
// controls) into a `Map<string, Blank>` and exposes them to BlankFill +
// Cycling via the `blankInvoke` adapter binding. The dispatch logic
// (translating {controlName, action, args} → blk.get/set/up/down) is
// identical across hosts; it lives here once.
//
// Hosts construct their registry with the blanks they support (chrome:
// the runtime classes + chrome-only OS controls; opencode: same TS
// classes; CC: same), then pass `createBlankInvoke(registry)` as their
// adapter binding's blankInvoke.
//
// NOTE: the JSON-RPC wire keys ('control-invoke' method name and
// 'controlName' param key) are preserved as wire format and must NOT
// be renamed — see integrations/codex/patches/opencues-bridge/src/lib.rs.

import type { BlankInvokeSpec, ProcessHandle, ProcessResult } from '../adapter';
import type { Blank } from './types';

export type { Blank } from './types';
export { FetchHttpAdapter } from './http-adapter';
export { HackerNewsControl } from './hackernews';
export { StocksControl, type StocksControlOptions } from './stocks';
export { WeatherControl, type WeatherControlOptions } from './weather';
export { AnswerControl, type AnswerControlOptions } from './answer';
export { PromptImproverControl, type PromptImproverControlOptions } from './prompt-improver';
export { OpenCuesSettingsControl, type OpenCuesSettingsControlOptions } from './opencues-settings';
export { DictionaryControl, type DictionaryControlOptions } from './dictionary';
export { CryptoControl, type CryptoControlOptions } from './crypto';
export { CountriesControl, type CountriesControlOptions } from './countries';

/**
 * Build a blankInvoke handler that dispatches into the given registry.
 * Returns null when the controlName isn't registered — the runtime then
 * falls through to spawnProcess (which sandboxed hosts resolve with
 * exitCode 127 to surface the gap visibly).
 *
 * Action mapping mirrors the chrome implementation that this replaces:
 *   'get'  → blk.get(args[0] as keyword, args.slice(1) as context)
 *   'set'  → blk.set?.(args[0], args[1])
 *   'up'   → blk.up?.()
 *   'down' → blk.down?.()
 */
export function createBlankInvoke(
  registry: Map<string, Blank>,
): (spec: BlankInvokeSpec) => ProcessHandle | null {
  return (spec) => {
    const blk = registry.get(spec.controlName);
    if (!blk) return null;
    const run = async (): Promise<ProcessResult> => {
      try {
        let stdout = '';
        switch (spec.action) {
          case 'get': {
            const keyword = spec.args[0];
            const context = spec.args.slice(1) as string[];
            stdout = await blk.get(keyword, context);
            break;
          }
          case 'set': {
            if (blk.set) await blk.set(spec.args[0] ?? '', spec.args[1]);
            break;
          }
          case 'up': {
            if (blk.up) stdout = await blk.up();
            break;
          }
          case 'down': {
            if (blk.down) stdout = await blk.down();
            break;
          }
        }
        return { stdout, stderr: '', exitCode: 0, timedOut: false };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { stdout: '', stderr: msg, exitCode: 1, timedOut: false };
      }
    };
    return { result: run(), kill: () => { /* no-op */ } };
  };
}

