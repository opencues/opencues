/**
 * Load the decision package by name.
 *
 * `decisions-provider: <name>` names a package that exports a
 * `createDecisionLegs(options)` factory (decisions/legs.ts). The package
 * owns the provider, the questions and the thresholds; core owns the seam
 * (types, dispatch chokepoint, breaker) and the sources that consume a
 * verdict. Resolution order: `OPENCUES_DECISIONS_PATH` (a directory or an
 * entry file), then `@opencues/decisions` from the usual module paths.
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
  const candidates: string[] = [];
  const envPath = process.env[DECISIONS_PATH_ENV];   // BROWSER-SAFE-ALLOW: node only past the guard above
  if (envPath) candidates.push(envPath);
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
