// Registration helper for user-shipped JS blanks. Native-host
// bootstraps (CC / OC / Gemini) call this at boot to discover every
// `impl: ./blank.js` blank in the user's `.cues/blanks/` tree and
// register it alongside the built-in runtime classes.
//
// Chrome uses a separate Worker-based loader (see chrome-loader.ts
// once it lands); the registration shape there is similar — a
// Map<name, Blank> entry per user blank — but the implementation
// uses postMessage rather than vm.runInContext.

import type { Blank } from '../blanks/types';
import type {
  BlankCapabilities,
  BlankContext,
  UserBlankModule,
} from './types';
import {
  loadUserBlank,
  type LoadedUserBlank,
  type LoaderOptions,
  type LlmAdapter,
  type StorageAdapter,
  createFileStorageAdapter,
} from './node-loader';

// ─── BlankConfig shape we need ──────────────────────────────────────────
//
// Match `BlankConfig` from `@opencues/core/cues-md.ts` without
// importing the package directly (avoids the runtime↔core cycle in
// some build layouts).

export interface BlankConfigLike {
  readonly name: string;
  readonly impl?: string;
  readonly userBlankNetwork?: readonly string[];
  readonly userBlankLlm?: string;
  readonly userBlankStorage?: string;
}

// ─── Per-blank Blank instance ───────────────────────────────────────────

/**
 * Wrap a loaded UserBlankModule in the runtime's Blank interface so
 * it can be registered in the same map that built-in blanks live in.
 * The ctx is bound once at registration and reused for every call —
 * keeps the capability gating consistent and avoids per-call setup.
 */
export function wrapUserBlankAsBlank(
  loaded: LoadedUserBlank,
  name: string,
  ctx: BlankContext,
): Blank {
  const mod = loaded.module;
  const readOnly = !!mod.readOnly || (typeof mod.set !== 'function' && typeof mod.up !== 'function' && typeof mod.down !== 'function');

  return {
    name,
    readOnly,
    get: async (keyword?: string, context?: string[]) => {
      const args = [keyword ?? '', ...(context ?? [])];
      const result = await mod.get(ctx, args);
      return String(result ?? '');
    },
    set: mod.set ? async (value: string, keyword?: string) => {
      await mod.set!(ctx, value, [keyword ?? '']);
    } : undefined,
    up: mod.up ? async () => String((await mod.up!(ctx)) ?? '') : undefined,
    down: mod.down ? async () => String((await mod.down!(ctx)) ?? '') : undefined,
  };
}

// ─── Registry builder ───────────────────────────────────────────────────

export interface UserBlankRegistryOptions {
  /** Where to read storage from. Defaults to a file adapter rooted
   *  at the first CUES root (callers should pass `~/.cues` or
   *  `$OPENCUES_HOME`). */
  readonly storageRoot?: string;
  /** LLM adapter for `ctx.llm()`. Optional — blanks that declare
   *  `llm:` without an adapter get a stub that throws. */
  readonly llm?: LlmAdapter;
  /** Per-blank timeout for `get()` / `set()` etc. Defaults to 8s. */
  readonly timeoutMs?: number;
  /** Logger — falls back to console. */
  readonly log?: LoaderOptions['log'];
}

/**
 * Walk a list of parsed BlankConfig entries and register every one
 * with `impl: <absolute-path>.js` as a user blank.
 *
 * Returns a fresh Map ready to merge into a host's existing
 * blank-invoke registry. Skips entries whose impl: is a bare name
 * (those use the built-in registry lookup, not user-blanks).
 *
 * Errors loading a user blank (file missing, syntax error, bad
 * export) are logged via opts.log and the blank is omitted from the
 * registry — the runtime then falls through to spawnProcess for
 * that name (which on a non-script blank means a clean miss, no
 * crash).
 */
export function buildUserBlankRegistry(
  configs: readonly BlankConfigLike[],
  opts: UserBlankRegistryOptions = {},
): Map<string, Blank> {
  const out = new Map<string, Blank>();
  const log = opts.log ?? ((lvl, msg) => console.log(`[user-blank] [${lvl}] ${msg}`));
  const storage = opts.storageRoot
    ? createFileStorageAdapter(opts.storageRoot)
    : undefined;

  for (const cfg of configs) {
    if (!cfg.impl) continue;
    // Bare name (no slash) → built-in registry lookup; skip here.
    if (!cfg.impl.includes('/')) continue;

    const caps: BlankCapabilities = {
      network: cfg.userBlankNetwork ? [...cfg.userBlankNetwork] : undefined,
      llm: cfg.userBlankLlm,
      storage: cfg.userBlankStorage,
    };

    let loaded: LoadedUserBlank;
    try {
      loaded = loadUserBlank(cfg.impl, {
        capabilities: caps,
        storage,
        llm: opts.llm,
        log,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      log('warn', `failed to load user blank "${cfg.name}" from ${cfg.impl}: ${(err as Error).message}`);
      continue;
    }

    // Build the ctx ONCE here so the wrapped Blank reuses it across
    // calls (consistent capability state, especially for storage).
    const ctx = buildContextFromCaps(caps, opts, storage);
    out.set(cfg.name, wrapUserBlankAsBlank(loaded, cfg.name, ctx));
    log('info', `registered user blank "${cfg.name}" from ${cfg.impl}`);
  }

  return out;
}

// ─── Internal: ctx builder mirrors node-loader's ────────────────────────

function buildContextFromCaps(
  caps: BlankCapabilities,
  opts: UserBlankRegistryOptions,
  storage: StorageAdapter | undefined,
): BlankContext {
  const log = opts.log ?? ((lvl, msg) => console.log(`[user-blank] [${lvl}] ${msg}`));
  const ctx: BlankContext = {
    now: () => Date.now(),
    log,
  };

  if (caps.network && caps.network.length > 0) {
    const allowed = new Set(caps.network.map(s => s.toLowerCase()));
    ctx.fetch = async (url, init) => {
      let parsed: URL;
      try { parsed = new URL(url); }
      catch { throw new Error(`ctx.fetch: invalid URL: ${url}`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`ctx.fetch: only http(s) allowed, got ${parsed.protocol}`);
      }
      if (!allowed.has(parsed.hostname.toLowerCase())) {
        throw new Error(
          `ctx.fetch: hostname "${parsed.hostname}" not in declared allow-list [${[...allowed].join(', ')}]`,
        );
      }
      return (globalThis as { fetch: typeof fetch }).fetch(url, init);
    };
  }

  if (caps.llm && opts.llm) {
    const provider = caps.llm;
    const llmFn = opts.llm;
    ctx.llm = async (req) => llmFn(provider, req);
  }

  if (caps.storage && storage) {
    const ns = caps.storage;
    ctx.storage = {
      get: (k) => storage.get(ns, k),
      set: (k, v) => storage.set(ns, k, v),
    };
  }

  return ctx;
}

// Re-exports for convenience.
export type { BlankCapabilities, BlankContext, UserBlankModule } from './types';
export {
  loadUserBlank,
  createFileStorageAdapter,
  type LoadedUserBlank,
  type StorageAdapter,
  type LlmAdapter,
} from './node-loader';
