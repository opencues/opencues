// Controls registry helpers — every host wires controls into a
// `Map<string, Control>` and exposes them to BlankFill + Cycling via the
// `controlInvoke` adapter binding. The dispatch logic (translating
// {controlName, action, args} → ctl.get/set/up/down) is identical across
// hosts; it lives here once.
//
// Hosts construct their registry with the controls they support (chrome:
// the runtime classes + chrome-only OS controls; opencode: same TS
// classes; CC: same), then pass `createControlInvoke(registry)` as their
// adapter binding's controlInvoke.

import type { ControlInvokeSpec, ProcessHandle, ProcessResult } from '../adapter';
import type { Control } from './types';

export type { Control } from './types';
export { FetchHttpAdapter } from './http-adapter';
export { HackerNewsControl } from './hackernews';
export { StocksControl, type StocksControlOptions } from './stocks';
export { WeatherControl, type WeatherControlOptions } from './weather';

/**
 * Build a controlInvoke handler that dispatches into the given registry.
 * Returns null when the controlName isn't registered — the runtime then
 * falls through to spawnProcess (which sandboxed hosts resolve with
 * exitCode 127 to surface the gap visibly).
 *
 * Action mapping mirrors the chrome implementation that this replaces:
 *   'get'  → ctl.get(args[0] as keyword, args.slice(1) as context)
 *   'set'  → ctl.set?.(args[0], args[1])
 *   'up'   → ctl.up?.()
 *   'down' → ctl.down?.()
 */
export function createControlInvoke(
  registry: Map<string, Control>,
): (spec: ControlInvokeSpec) => ProcessHandle | null {
  return (spec) => {
    const ctl = registry.get(spec.controlName);
    if (!ctl) return null;
    const run = async (): Promise<ProcessResult> => {
      try {
        let stdout = '';
        switch (spec.action) {
          case 'get': {
            const keyword = spec.args[0];
            const context = spec.args.slice(1) as string[];
            stdout = await ctl.get(keyword, context);
            break;
          }
          case 'set': {
            if (ctl.set) await ctl.set(spec.args[0] ?? '', spec.args[1]);
            break;
          }
          case 'up': {
            if (ctl.up) stdout = await ctl.up();
            break;
          }
          case 'down': {
            if (ctl.down) stdout = await ctl.down();
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
