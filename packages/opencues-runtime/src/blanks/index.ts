// Blanks registry helpers — every host wires its blanks into a
// `Map<string, Blank>` and exposes them to BlankFill + Cycling via
// the `blankInvoke` adapter binding. The dispatch logic
// (translating {blankName, action, args} → blk.get/set/up/down) is
// identical across hosts; it lives here once.
//
// Hosts construct their registry with the blanks they support (chrome:
// the runtime classes + chrome-only OS blanks; opencode: same TS
// classes; CC: same; gemini-cli: same), then pass `createBlankInvoke(registry)` as their
// adapter binding's blankInvoke.

import type { BlankInvokeSpec, ProcessHandle, ProcessResult } from '../adapter';
import type { Blank } from './types';

export type { Blank } from './types';
export { FetchHttpAdapter } from './http-adapter';
export { HackerNewsBlank } from './hackernews';
export { StocksBlank, type StocksBlankOptions } from './stocks';
export { WeatherBlank, type WeatherBlankOptions } from './weather';
export { OpenCuesSettingsBlank, type OpenCuesSettingsBlankOptions } from './opencues-settings';
export { SentinelBlank, type SentinelBlankOptions } from './sentinel';
export { DictionaryBlank, type DictionaryBlankOptions } from './dictionary';
export { LocationBlank, type LocationBlankOptions } from './location';
export { CryptoBlank, type CryptoBlankOptions } from './crypto';
export { CountriesBlank, type CountriesBlankOptions } from './countries';
export { ClaudeStatusBlank, type ClaudeStatusBlankOptions } from './claude-status';
export { NoteBlank, type NoteBlankOptions, type NoteCaps } from './note';

// Imports for the BUILTIN_BLANKS registry below. The above `export`
// lines re-publish them; these `import` lines bring them into scope
// so the factories can reference them.
import { HackerNewsBlank } from './hackernews';
import { StocksBlank } from './stocks';
import { WeatherBlank } from './weather';
import { OpenCuesSettingsBlank } from './opencues-settings';
import { SentinelBlank } from './sentinel';
import { DictionaryBlank } from './dictionary';
import { LocationBlank } from './location';
import { CryptoBlank } from './crypto';
import { CountriesBlank } from './countries';
import { ClaudeStatusBlank } from './claude-status';
import { NoteBlank } from './note';

// ──────────────────────────────────────────────────────────────────────
// Built-in blanks registry — single source of truth across hosts.
//
// THE PROBLEM THIS SOLVES
//
// Each host bootstrap (CC / OC / chrome / gemini-cli) used to maintain
// its own `['name', new BlankClass(opts)]` Map. They overlapped but
// were never identical: claude-status was registered on opencode + chrome
// but missing from CC and gemini-cli — a silent feature gap shipped to
// users. Adding a new built-in required editing four bootstraps.
//
// HOW TO ADD A NEW BUILT-IN BLANK
//
//   1. Implement the class under packages/opencues-runtime/src/blanks/.
//   2. Add an `export { … }` line above.
//   3. Add an entry to BUILTIN_BLANKS below.
//
// That's it. All four host bootstraps invoke `createDefaultBlanksRegistry(ctx)`
// and pick up the new blank automatically.
//
// FACTORY CONTRACT
//
// Each factory takes a BuiltinBlankContext and returns either a Blank
// instance or null. Return null when prereqs aren't met (e.g. no Finnhub
// key for the stocks blank, no settings-file IO for the opencues
// blank). `createDefaultBlanksRegistry` filters nulls out so the host
// doesn't need to know which prereqs each blank checks.

/**
 * Context passed to every BUILTIN_BLANKS factory. Hosts populate the
 * subset they have available; factories check what they need and
 * return null when they don't have enough to construct a usable blank.
 */
export interface BuiltinBlankContext {
  /**
   * Finnhub API key for the stocks blank. Optional — without it the
   * blank still registers but live quote requests will fail at runtime
   * (handled in StocksBlank itself).
   */
  readonly finnhubApiKey?: string;
  /**
   * Custom ticker name → symbol overrides for the stocks blank.
   * Chrome-only today.
   */
  readonly customTickers?: Record<string, string>;
  /**
   * Read/write accessors for the user's OPENCUES.md (or CUES.md)
   * settings file. Required to register the `opencues` selector-
   * satellite blank. Hosts that don't supply this skip the opencues
   * blank.
   */
  readonly opencuesMdIO?: {
    readonly readFile: () => Promise<string | null>;
    readonly writeFile: (content: string) => Promise<void>;
  };
  /**
   * Read/write accessors for the user's IDENTITY.md file. Required
   * to register the `sentinel` keyword-bound write blank. Hosts that
   * don't supply this skip the sentinel blank — the user can still
   * use `opencues identity set` from the CLI.
   *
   * SECURITY: the blank's writes are validated by
   * @opencues/core's `validateSentinelWrite` BEFORE this writer is
   * called. Hosts MUST NOT add a parallel write path that skips the
   * validator. Audit row #24.
   */
  readonly identityMdIO?: {
    readonly readFile: () => Promise<string | null>;
    readonly writeFile: (content: string) => Promise<void>;
  };
  /**
   * Read/write accessors for the user's NOTES.md file. Required to
   * register the `note` collection blank (PROTOTYPE — issue #210).
   * Hosts that don't supply this skip the note blank.
   *
   * Writes are validated by `validateNoteWrite` in note.ts BEFORE
   * this writer is called — same chokepoint discipline as sentinel.
   */
  readonly notesMdIO?: {
    readonly readFile: () => Promise<string | null>;
    readonly writeFile: (content: string) => Promise<void>;
  };
  /**
   * Host name passed through to OpenCuesSettingsBlank so the
   * registry's host-scoped tunables (e.g. chrome's `dim-mix`) only
   * surface in the cycling menu on their target host.
   */
  readonly hostName?: string;
}

/** One entry in BUILTIN_BLANKS. */
export interface BuiltinBlankSpec {
  /** Keyword the blank is registered under (the part before `_`). */
  readonly name: string;
  /** Construct the blank, or return null if prereqs aren't met. */
  readonly factory: (ctx: BuiltinBlankContext) => Blank | null;
}

/**
 * Every built-in blank that ships with OpenCues. Hosts iterate this
 * via `createDefaultBlanksRegistry(ctx)`; do NOT maintain per-host
 * copies. Drift across hosts is the exact failure class this registry
 * exists to prevent.
 *
 * Order matters only for the resulting Map's iteration order (and
 * therefore the order they appear in `opencues list`). Group: HTTP
 * fetch blanks first, then static lookups, then LLM-driven, then the
 * settings blank.
 */
export const BUILTIN_BLANKS: readonly BuiltinBlankSpec[] = [
  // ── HTTP fetch / external API ────────────────────────────────────
  { name: 'hackernews',    factory: () => new HackerNewsBlank() },
  // Stocks needs a non-LLM API key (Finnhub). Without it, every quote
  // request would fail at runtime — so we skip registration entirely
  // and the `stocks _` keyword falls through to fluid-blank (or no
  // substitution at all). Decision is host-agnostic: any host that
  // doesn't supply finnhubApiKey gets no stocks blank, regardless of
  // which host it is. Chrome users without a Finnhub key, native hosts
  // without FINNHUB_API_KEY in env — same behaviour.
  { name: 'stocks',        factory: ctx => ctx.finnhubApiKey ? new StocksBlank({ apiKey: ctx.finnhubApiKey, customTickers: ctx.customTickers }) : null },
  { name: 'weather',       factory: () => new WeatherBlank() },
  { name: 'location',      factory: () => new LocationBlank() },
  { name: 'claude-status', factory: () => new ClaudeStatusBlank() },

  // ── Static lookups (offline / cached) ────────────────────────────
  { name: 'dictionary',    factory: () => new DictionaryBlank() },
  { name: 'crypto',        factory: () => new CryptoBlank() },
  { name: 'countries',     factory: () => new CountriesBlank() },

  // NOTE: the legacy bespoke LLM blanks `answer` + `prompt` were removed
  // (June 2026). They were direct-to-Groq HTTP clients that bypassed the
  // provider/dispatch layer, so they couldn't honour the user's configured
  // provider. Their intents are now served by the generalized semantic-`_`
  // sources that already use the user's provider: `answer _` / `what is the
  // answer _` → FluidBlank meta-triggers; `improve prompt _` → TransformBlank.

  // ── Settings / selector-satellite (skip when no IO supplied) ─────
  { name: 'opencues',      factory: ctx => ctx.opencuesMdIO ? new OpenCuesSettingsBlank({ ...ctx.opencuesMdIO, hostName: ctx.hostName }) : null },

  // ── IdentityField-write (keyword-bound `set sentinel <k> <v> _` /
  //    `remove sentinel <k> _`). Skips when no IO supplied (host
  //    can't write IDENTITY.md). Audit row #24 — every host that
  //    wires identityMdIO MUST hand the writer the file content
  //    AS-RETURNED by SentinelBlank.get(); never bypass the writer
  //    or replace its content with a non-validated path.
  { name: 'sentinel',      factory: ctx => ctx.identityMdIO ? new SentinelBlank(ctx.identityMdIO) : null },

  // ── Collection blank (PROTOTYPE — issue #210). Keyword-bound
  //    add/recall/delete over ~/.cues/NOTES.md; every write goes
  //    through validateNoteWrite. Skips when no IO supplied.
  { name: 'note',          factory: ctx => ctx.notesMdIO ? new NoteBlank(ctx.notesMdIO) : null },
];

/**
 * Build the canonical `Map<string, Blank>` registry for a host. Hosts
 * supply whatever context they have; blanks whose prereqs aren't met
 * are silently skipped (null factory result).
 *
 * Replaces the per-host hardcoded Map literals that used to drift —
 * canonical Set of registered blanks is now `BUILTIN_BLANKS` ∩
 * `factory(ctx) !== null`.
 */
export function createDefaultBlanksRegistry(ctx: BuiltinBlankContext): Map<string, Blank> {
  const out = new Map<string, Blank>();
  for (const spec of BUILTIN_BLANKS) {
    const instance = spec.factory(ctx);
    if (instance) out.set(spec.name, instance);
  }
  return out;
}

/**
 * Build a blankInvoke handler that dispatches into the given registry.
 * Returns null when the blankName isn't registered — the runtime then
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
    const blk = registry.get(spec.blankName);
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

