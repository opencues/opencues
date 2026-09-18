/**
 * Load the decision package by name.
 *
 * `decisions-provider: <name>` names a package that exports a
 * `createDecisionLegs(options)` factory (decisions/legs.ts). The package
 * owns the provider, the questions and the thresholds; core owns the seam
 * (types, dispatch chokepoint, breaker) and the sources that consume a
 * verdict. Resolution order: `OPENCUES_DECISIONS_PATH` (a directory or an
 * entry file), then the `@opencues/decisions` installed next to this core (found
 * by path from this file), then `~/opencues-decisions` (the checkout the
 * installers copy from), then the bare specifier.
 * Nothing found → one log line, every leg on its chat path.
 *
 * Native hosts only: in a page (chrome, dsh's client half) the key would
 * sit in the bundle; those hosts reach a decision package through their
 * host bridge later.
 */
import type { DecisionLegs, DecisionLegsFactory } from './legs';

export const DECISIONS_PACKAGE = '@opencues/decisions';
export const DECISIONS_PATH_ENV = 'OPENCUES_DECISIONS_PATH';
/** the key every known package reads; the package may name its own in `envKey` */
export const DECISIONS_DEFAULT_ENV_KEY = 'TYPESAFE_API_KEY';

export interface LoadDecisionLegsOptions {
  readonly which: string;
  readonly apiKeys: Readonly<Record<string, string | undefined>>;
  readonly httpAdapter: unknown;
  readonly log?: (msg: string) => void;
}

interface DecisionPackage { createDecisionLegs?: DecisionLegsFactory; envKey?: string; providers?: ReadonlyArray<string> }

let cached: { pkg: DecisionPackage | null; from: string } | null = null;

/** Exported for tests: forget the loaded package. */
export function resetDecisionPackage(): void { cached = null; }

function requirePackage(log?: (m: string) => void): { pkg: DecisionPackage | null; from: string } {
  if (cached) return cached;
  // BROWSER-SAFE-ALLOW: guarded — a page has no process and no require
  if (typeof process === 'undefined' || !process.versions?.node) { cached = { pkg: null, from: 'browser host' }; return cached; }
  const req = typeof require === 'function' ? require : null;   // BROWSER-SAFE-ALLOW: node only past the guard above
  if (!req) { cached = { pkg: null, from: 'no require' }; return cached; }
  // Candidates are EXPLICIT FILES wherever possible: inside a host's compiled
  // runtime (Claude Code's Bun binary) a bare specifier or a directory require
  // from a disk module does not resolve the way it does under node, so the
  // package is found by path — walking up from this file's own location to
  // the nearest node_modules/@opencues/decisions — before the bare specifier
  // is tried as the last resort.
  const fs = require('node:fs') as typeof import('node:fs');             // BROWSER-SAFE-ALLOW: node only past the guard above
  const path = require('node:path') as typeof import('node:path');       // BROWSER-SAFE-ALLOW: node only past the guard above
  const entryOf = (dir: string): string | null => {
    for (const rel of ['dist/index.js', 'index.js']) { const f = path.join(dir, rel); if (fs.existsSync(f)) return f; }
    return null;
  };
  const candidates: string[] = [];
  const envPath = process.env[DECISIONS_PATH_ENV];   // BROWSER-SAFE-ALLOW: node only past the guard above
  if (envPath) candidates.push((fs.existsSync(envPath) && fs.statSync(envPath).isDirectory() ? entryOf(envPath) : null) ?? envPath);
  // the installed package next to this core: <…>/node_modules/@opencues/decisions
  let dir = typeof __dirname === 'string' ? __dirname : '';
  for (let i = 0; dir && i < 8; i++) {
    const f = entryOf(path.join(dir, 'node_modules', '@opencues', 'decisions'));
    if (f) { candidates.push(f); break; }
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  // the checkout setup.sh copies the package FROM, for processes that run
  // outside a host fork (doctor, the benches, a plain node script)
  try { const os = require('node:os') as typeof import('node:os'); const f = entryOf(path.join(os.homedir(), 'opencues-decisions')); if (f) candidates.push(f); } catch { /* no os module: skip */ }   // BROWSER-SAFE-ALLOW: node only past the guard above
  candidates.push(DECISIONS_PACKAGE);
  for (const c of candidates) {
    try { const pkg = req(c) as DecisionPackage; cached = { pkg, from: c }; return cached; }
    catch (e) { log?.(`decisions: ${c} not loadable (${(e as Error).message.split('\n')[0]})`); }
  }
  cached = { pkg: null, from: 'none' };
  return cached;
}

export function loadDecisionLegs(options: LoadDecisionLegsOptions): DecisionLegs | undefined {
  const which = options.which;
  if (!which || which === 'off') return undefined;
  const { pkg, from } = requirePackage(options.log);
  if (!pkg || typeof pkg.createDecisionLegs !== 'function') {
    options.log?.(`buildSources: decisions-provider ${which} but no decision package is installed (${from}) → decision legs stay on chat`);
    return undefined;
  }
  if (pkg.providers && !pkg.providers.includes(which)) { options.log?.(`buildSources: decisions-provider ${which} unknown to ${from} → decision legs stay on chat`); return undefined; }
  const envKey = pkg.envKey ?? DECISIONS_DEFAULT_ENV_KEY;
  const apiKey = options.apiKeys[envKey];
  if (!apiKey) { options.log?.(`buildSources: decisions-provider ${which} but ${envKey} is not set → decision legs stay on chat`); return undefined; }
  const legs = pkg.createDecisionLegs({ which, apiKey, httpAdapter: options.httpAdapter, log: options.log });
  if (!legs) { options.log?.(`buildSources: decisions-provider ${which} refused by ${from} → decision legs stay on chat`); return undefined; }
  options.log?.(`buildSources: decisions → ${legs.id}/${legs.model}`);
  return legs;
}

export type { DecisionLegs };
