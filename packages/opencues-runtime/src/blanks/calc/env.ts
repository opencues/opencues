/**
 * The ambient inputs calculators read (clock, zone, settings, randomness).
 * The blank registry is built by each host's bootstrap before a
 * ConfigLoader exists, so the settings reader is attached later by
 * BlankFill (`configureCalcEnv`), which every band constructs; until then
 * the defaults answer (no VAT rate → the calculator says so).
 */
import type { CalcContext } from './types';

let settingReader: (name: string) => string | undefined = () => undefined;
let clock: () => Date = () => new Date();

export function configureCalcEnv(opts: { setting?: (name: string) => string | undefined; now?: () => Date }): void {
  if (opts.setting) settingReader = opts.setting;
  if (opts.now) clock = opts.now;
}

const uniform = (): number => {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) { const a = new Uint32Array(1); c.getRandomValues(a); return a[0] / 4294967296; }
  return Math.random();
};

export function calcContext(command = ''): CalcContext {
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* no ICU */ }
  return { now: clock, timeZone: tz, setting: settingReader, random: uniform, command };
}
