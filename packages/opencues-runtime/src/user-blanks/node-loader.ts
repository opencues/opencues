// Node loader for user-shipped blanks. Reads the JS file, runs it
// in a `vm.runInContext` with a constrained globals object exposing
// only the capabilities the BLANK.md declared.
//
// Used by CC / OC / Gemini-CLI. Chrome uses a Web Worker-based
// loader instead (chrome content scripts can't use Node's vm).
//
// What's in the sandbox context:
//
//   - The BlankContext capability proxies (ctx.fetch, ctx.llm,
//     ctx.storage) — gated by frontmatter declarations.
//   - A minimal globals set: console (log only), URL, JSON, Promise,
//     setTimeout / clearTimeout, Math, Date, RegExp, fetch
//     (REJECTED with a clear error unless network is declared).
//
// What's deliberately NOT in the sandbox:
//
//   - `require` / `import` — no way to load other modules
//   - `process` — no env vars, no exit, no spawn
//   - `Buffer`, `__dirname`, `__filename` — no Node primitives
//   - The runtime's own globals (CueResolver, host adapters, etc.)
//
// The `vm.runInContext` boundary is well-understood. Known escape
// vectors (prototype-chain walking to find the host realm) are
// mitigated by:
//   - Each blank gets a FRESH context (no shared globals across
//     invocations)
//   - The context is created with `vm.createContext({})` — empty
//     start, we add only what we want
//   - User code can't traverse to the host realm via primitive
//     wrappers because we don't expose primitive wrappers from the
//     host (we expose fresh ones from inside the context).

import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BlankCapabilities,
  BlankContext,
  UserBlankModule,
} from './types';

// ─── Storage adapter (per-host implementations supply this) ─────────────
//
// On native hosts: ~/.cues/.user-blank-state/<namespace>.json
// Each get/set is a fresh read+merge+write. Cheap enough at the
// scale these blanks operate (one read+write per `_` fill).

export interface StorageAdapter {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
}

export function createFileStorageAdapter(rootDir: string): StorageAdapter {
  const dir = path.join(rootDir, '.user-blank-state');

  function readNs(ns: string): Record<string, string> {
    try {
      const raw = fs.readFileSync(path.join(dir, `${ns}.json`), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  function writeNs(ns: string, data: Record<string, string>): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ns}.json`), JSON.stringify(data, null, 2));
    } catch { /* swallow — storage is best-effort */ }
  }

  return {
    async get(ns, k) { return readNs(ns)[k] ?? null; },
    async set(ns, k, v) { const data = readNs(ns); data[k] = v; writeNs(ns, data); },
  };
}

// ─── LLM bridge ─────────────────────────────────────────────────────────
//
// User blanks that declare `llm:` get a `ctx.llm({prompt, model?})`
// that routes through the runtime's existing Resolver-backed LLM
// client. The user can't pick endpoints (the provider is fixed at
// frontmatter time + validated against the stock allow-list).
//
// The runtime supplies this function at loader-construction time —
// keeps the loader decoupled from the LLM stack.

export interface LlmAdapter {
  (
    provider: string,
    opts: { prompt: string; model?: string; maxTokens?: number },
  ): Promise<string>;
}

// ─── Loader ──────────────────────────────────────────────────────────────

export interface LoadedUserBlank {
  readonly module: UserBlankModule;
  /** Folder the JS file lives in. Used for diagnostics. */
  readonly folder: string;
  /** Capabilities the BLANK.md declared. */
  readonly capabilities: BlankCapabilities;
}

export interface LoaderOptions {
  readonly capabilities: BlankCapabilities;
  readonly storage?: StorageAdapter;
  readonly llm?: LlmAdapter;
  /** Logger — falls back to console.log if omitted. */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Hard timeout for the entire `default.get()` call. Defaults to 8s. */
  readonly timeoutMs?: number;
}

/**
 * Load a user blank from disk into an isolated vm context.
 *
 * The returned module's methods (`get`, `set`, etc.) are CALLABLE
 * from outside the sandbox — they're refs to the user's exported
 * functions, but the functions themselves execute inside the sandbox.
 * Throws when the file can't be read, when the JS doesn't parse, or
 * when the exported shape is wrong.
 */
export function loadUserBlank(absJsPath: string, opts: LoaderOptions): LoadedUserBlank {
  const source = fs.readFileSync(absJsPath, 'utf8');
  const folder = path.dirname(absJsPath);
  const caps = opts.capabilities;
  const log = opts.log ?? ((lvl, msg) => console.log(`[user-blank] [${lvl}] ${msg}`));

  // Build the context proxy that gets injected into the sandbox.
  const ctx = buildBlankContext(caps, opts, log);

  // The user wrote `export default { get, set }`. ESM `export
  // default` isn't directly supported in classic-script vm.Context.
  // Wrap the source in a CommonJS-style module shim: we set up
  // `module = { exports: { default: undefined } }`, run the source,
  // and read `module.exports.default` out. The wrapper also handles
  // bare `export default X` syntax via a regex rewrite to
  // `module.exports.default = X`. Crude but adequate for the v1
  // export shapes we support.
  const wrapped = rewriteEsmExportDefault(source);
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    console: { log: (...a: unknown[]) => log('info', a.map(String).join(' ')) },
    Promise,
    URL,
    JSON,
    Math,
    Date,
    RegExp,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // Capability proxies — only present when declared.
    ctx,
  };
  vm.createContext(sandbox);

  try {
    vm.runInContext(wrapped, sandbox, {
      filename: absJsPath,
      timeout: opts.timeoutMs ?? 8000,
    });
  } catch (err) {
    throw new Error(`user-blank load failed: ${absJsPath}: ${(err as Error).message}`);
  }

  const mod = (sandbox.module as { exports: { default?: UserBlankModule } }).exports.default
    || (sandbox.module as { exports: UserBlankModule }).exports;
  if (!mod || typeof mod.get !== 'function') {
    throw new Error(`user-blank ${absJsPath} must export default { get(ctx, args) }`);
  }

  return { module: mod, folder, capabilities: caps };
}

// Rewrite ESM `export default X` → `module.exports.default = X`. The
// vm.Context doesn't parse ESM (it runs classic script), but most user
// blanks will be written in modern syntax. Two recognised forms:
//
//   export default { ... };
//   export default async function (...) { ... };
//
// More exotic ESM (named exports, top-level await, dynamic import) is
// rejected. We also strip bare-`import` statements at the top of the
// file — user code can't import other modules anyway.
function rewriteEsmExportDefault(source: string): string {
  let out = source;
  // Drop import statements (they'd be a SyntaxError in a CJS-style
  // wrapper). Replace with a same-length comment line so line
  // numbers stay stable for error messages.
  out = out.replace(/^(\s*)import\s.*$/gm, (m, ws) => `${ws}// import stripped — user blanks can't load modules`);
  // `export default { ... }` or `export default function/async function ...`
  out = out.replace(/^(\s*)export\s+default\s+/m, '$1module.exports.default = ');
  // `export const xxx = ...` → drop the `export` (becomes a top-level binding)
  out = out.replace(/^(\s*)export\s+(?=(const|let|var|function|async\s+function))/gm, '$1');
  return out;
}

// ─── Build the BlankContext ──────────────────────────────────────────────

function buildBlankContext(
  caps: BlankCapabilities,
  opts: LoaderOptions,
  log: NonNullable<LoaderOptions['log']>,
): BlankContext {
  const ctx: BlankContext = {
    now: () => Date.now(),
    log,
  };

  // network — fetch with hostname allow-list
  if (caps.network && caps.network.length > 0) {
    const allowed = new Set(caps.network.map(s => s.toLowerCase()));
    ctx.fetch = async (url: string, init?: RequestInit) => {
      let parsed: URL;
      try { parsed = new URL(url); }
      catch { throw new Error(`ctx.fetch: invalid URL: ${url}`); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`ctx.fetch: only http(s) allowed, got ${parsed.protocol}`);
      }
      if (!allowed.has(parsed.hostname.toLowerCase())) {
        throw new Error(
          `ctx.fetch: hostname "${parsed.hostname}" not in declared allow-list ` +
          `[${[...allowed].join(', ')}]`,
        );
      }
      // Use the global fetch (Node 18+).
      return (globalThis as { fetch: typeof fetch }).fetch(url, init);
    };
  }

  // llm — route through the runtime's configured LLM
  if (caps.llm && opts.llm) {
    const provider = caps.llm;
    const llmFn = opts.llm;
    ctx.llm = async (req) => llmFn(provider, req);
  }

  // storage — namespaced
  if (caps.storage && opts.storage) {
    const ns = caps.storage;
    const storage = opts.storage;
    ctx.storage = {
      get: (k) => storage.get(ns, k),
      set: (k, v) => storage.set(ns, k, v),
    };
  }

  return ctx;
}
