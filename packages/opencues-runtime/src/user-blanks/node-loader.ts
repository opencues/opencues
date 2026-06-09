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
// SECURITY POSTURE — IMPORTANT (INFOSEC F1):
//
// Node's `vm` module is NOT a security boundary when host-realm
// objects/functions are shared into the context. The Node docs say
// so directly. The sandbox below shares `Promise`, `URL`, `Date`,
// `Math`, `RegExp`, `setTimeout`, `console.log`, and every function
// on `ctx` — every one of those exposes the host realm's `Function`
// constructor via `.constructor`, and a host-realm `Function` resolves
// free identifiers (`process`, `require`, `globalThis`) against the
// HOST global scope. Concretely:
//
//   Promise.constructor('return process')()
//     // returns the host's `process` — env vars, child_process, fs, …
//
// This is the F1 finding (live-confirmed June 2026). Treat `impl:
// ./blank.js` packs as **full host privilege** today, not as
// sandboxed code. Each one can read your env, spawn processes, and
// touch any file the user has access to.
//
// **Real fix**: replace `vm.runInContext` with `isolated-vm` (a real
// V8 isolate boundary) or out-of-process Node with `--experimental-
// permission`. Tracked at docs/architecture/security-audit.md row #2.
//
// **Current stopgap**: a one-time loud warn fires on first load of
// each blank name (see `_warnedBlankNames` below) so the developer
// using `opencues run` is reminded that custom JS packs are
// effectively trusted. `opencues review` (CLI) already refuses the
// most common escape patterns (.constructor / Reflect / globalThis /
// proto-walk) as hard blockers under F5 — install-time review +
// load-time warn together raise the bar but do not close the gap.
//
// **What we DO mitigate (orthogonal to the vm boundary)**:
//   - Each blank gets a FRESH context (no shared globals across
//     invocations).
//   - `require` / `import` / `process` / `Buffer` / `__dirname` are
//     not exposed; the loader's ESM rewriter rejects dynamic
//     `import()`.
//   - `ctx.fetch` enforces network allow-list + bound-secret
//     destination control (F4).
//   - `ctx.secrets` only contains names the blank declared.
//
// These limit the BLAST RADIUS of a benign-but-buggy blank. They do
// not stop a deliberate constructor-chain escape.

import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rewriteEsmToCjsShim } from './esm-rewrite';
import { buildRequestParts, enforceSecretBindings, type BoundSecret } from './secret-leak-guard';
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
  /** Total bytes currently stored in the namespace (sum of key + value
   *  lengths over every entry, excluding `excludeKey` if provided —
   *  used by the quota check to compute the size delta of an
   *  in-flight `set`). Returns 0 for a missing/empty namespace. */
  size(namespace: string, excludeKey?: string): Promise<number>;
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
    async size(ns, excludeKey) {
      const data = readNs(ns);
      let total = 0;
      for (const [k, v] of Object.entries(data)) {
        if (k === excludeKey) continue;
        total += k.length + (typeof v === 'string' ? v.length : 0);
      }
      return total;
    },
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
    opts: {
      prompt: string;
      system?: string;
      model?: string;
      maxTokens?: number;
      temperature?: number;
    },
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
  /** Secrets map keyed by env-var name. Caller is responsible for
   *  populating from process.env (native hosts) or chrome.storage
   *  (chrome). Only the keys declared in `capabilities.secrets`
   *  reach the BlankContext. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Logger — falls back to console.log if omitted. */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** Hard timeout for the entire `default.get()` call. Defaults to 8s. */
  readonly timeoutMs?: number;
}

// F1 (INFOSEC) stopgap: track which JS paths we've already warned
// about in this process, so the loud-warn fires once per unique blank
// at first load and then stays silent. Cleared by `_resetF1WarnCache`
// for tests.
const _warnedBlankPaths = new Set<string>();
export function _resetF1WarnCache(): void {
  _warnedBlankPaths.clear();
}

/**
 * Load a user blank from disk into an isolated vm context.
 *
 * The returned module's methods (`get`, `set`, etc.) are CALLABLE
 * from outside the sandbox — they're refs to the user's exported
 * functions, but the functions themselves execute inside the sandbox.
 * Throws when the file can't be read, when the JS doesn't parse, or
 * when the exported shape is wrong.
 *
 * **F1 SECURITY POSTURE (June 2026)**: this loader uses `vm.runInContext`
 * which is NOT a security boundary for adversarial JS. See the file
 * header for the constructor-chain escape pivot. A one-time loud
 * warn fires per blank path on first load.
 */
export function loadUserBlank(absJsPath: string, opts: LoaderOptions): LoadedUserBlank {
  const source = fs.readFileSync(absJsPath, 'utf8');
  const folder = path.dirname(absJsPath);
  const caps = opts.capabilities;
  const log = opts.log ?? ((lvl, msg) => console.log(`[user-blank] [${lvl}] ${msg}`));

  // F1 (INFOSEC) stopgap loud-warn — fires once per unique JS path
  // per process. Surfaces the "this pack runs with full host
  // privileges" reality so developers + users have visibility while
  // the real isolated-vm migration is in progress. The warning lands
  // on console.warn (visible in every host) AND through the adapter
  // log (visible in /tmp/opencues.log for steady-state diagnostics).
  if (!_warnedBlankPaths.has(absJsPath)) {
    _warnedBlankPaths.add(absJsPath);
    const msg =
      `[opencues] loading custom JS blank: ${absJsPath}\n` +
      `[opencues] WARNING (INFOSEC F1): user-blank JS runs with FULL host privileges.\n` +
      `[opencues]   The Node \`vm\` sandbox does NOT contain adversarial code — a constructor-chain\n` +
      `[opencues]   escape can reach the host's process, env vars, child_process, and fs.\n` +
      `[opencues]   Only install blanks you trust. \`opencues review <pack>\` refuses the most\n` +
      `[opencues]   common escape patterns at install time. Tracked at security-audit.md row #2.`;
    try { console.warn(msg); } catch { /* swallow */ }
    try { log('warn', msg); } catch { /* swallow */ }
  }

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
  const { code, warnings } = rewriteEsmToCjsShim(source);
  if (warnings.length > 0) {
    throw new Error(`user-blank rewrite: ${warnings.join('; ')}`);
  }
  return code;
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

  // Pre-resolve secret host bindings: pair declared secret names with
  // their injected values + per-secret host allow-lists. ctx.fetch
  // refuses requests where a bound secret value would leak to a
  // non-allowed host (see secret-leak-guard.ts).
  const boundSecrets: BoundSecret[] = [];
  if (caps.secrets && opts.secrets) {
    for (const name of caps.secrets) {
      const value = opts.secrets[name];
      if (typeof value !== 'string' || value.length === 0) continue;
      const allowedHosts = caps.secretBindings?.[name] ?? [];
      boundSecrets.push({ name, value, allowedHosts });
    }
  }

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
      if (boundSecrets.length > 0) {
        enforceSecretBindings(buildRequestParts(url, init), boundSecrets);
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

  // secrets — filtered to declared keys only
  if (caps.secrets && caps.secrets.length > 0 && opts.secrets) {
    const out: Record<string, string> = {};
    for (const name of caps.secrets) {
      const v = opts.secrets[name];
      if (typeof v === 'string' && v.length > 0) out[name] = v;
    }
    ctx.secrets = Object.freeze(out);
  }

  return ctx;
}
