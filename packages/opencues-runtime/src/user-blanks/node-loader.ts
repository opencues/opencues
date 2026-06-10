// Node loader for user-shipped blanks. Runs the JS in a real V8 isolate
// via `isolated-vm` — a fresh realm with no host-object leakage. The
// constructor-chain escape that was the F1 finding (June 2026,
// `Promise.constructor('return process')()`) physically cannot work
// here: the isolate's `Promise`, `Date`, `Math`, etc. are its OWN, and
// reaching the host `Function` constructor lands you in the isolate's
// Function, which resolves `process` against the isolate's global —
// which is undefined.
//
// Used by CC / OC / Gemini-CLI and (via the chrome-host process)
// Chrome. Chrome's content-script Worker path uses a different loader
// (no Node in content scripts).
//
// What the isolate has:
//
//   - Per-isolate intrinsics: Promise, JSON, Math, Date, RegExp, URL,
//     Map, Set, Array, Object, Function (the isolate's, not the host's).
//   - A `console` object whose `log/info/warn/error` cross back to the
//     host logger via Reference.
//   - A `ctx` argument (passed to the user's `default.get(ctx, args)`)
//     whose methods bridge back to the host capability proxies:
//     fetch / llm / storage / secrets / now / log. Each crosses the
//     isolate boundary via Reference + ExternalCopy.
//
// What the isolate does NOT have:
//
//   - `require` / `import` — no way to load other modules.
//   - `process` — no env vars, no exit, no spawn.
//   - `Buffer`, `__dirname`, `__filename` — no Node primitives.
//   - The runtime's own globals (CueResolver, host adapters, etc.).
//   - The host realm's anything — every intrinsic is the isolate's
//     own; `.constructor` walks land you in the isolate's Function,
//     not the host's.
//
// Cost model (Linux x64, Node 22, isolated-vm 5.0.4):
//   - Per-isolate creation:  ~5-10 ms (one-time per blank load).
//   - Per-context creation:  ~1-2 ms (reused across invocations).
//   - Per-invocation:        ~1-3 ms (cold), sub-ms (warm path through
//                            already-compiled get reference).
//   - Memory budget:         32 MB per isolate (configurable).
//
// For comparison, the prior vm.runInContext loader was ~0.1 ms per
// invocation but offered no security boundary. The 10-30× slowdown
// is acceptable — blank invocations happen on a `_` keystroke, not
// per-frame, and the result cache layer (per-blank TTL) eliminates
// most repeat work.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as ivm from 'isolated-vm';
import { rewriteEsmToCjsShim } from './esm-rewrite';

// `isolated-vm` is a NATIVE Node-V8 binding (INFOSEC F1, June 2026).
// Bun-based hosts (opencode, shell) use JavaScriptCore — loading the
// `.node` binding fails with `undefined symbol: _ZN2v8...` at module
// import. We MUST keep the top-level import type-only and defer the
// real `require()` until a user-blank JS impl actually tries to load;
// the exception then propagates to `registry.ts`'s try/catch and the
// host disables JS user-blanks instead of crashing at boot.
//
// Re-test before changing: `bun -e "require('@opencues/runtime/dist/src/user-blanks/registry')"` MUST succeed.
let _ivm: typeof ivm | null = null;
let _ivmError: Error | null = null;
function getIvm(): typeof ivm {
  if (_ivm) return _ivm;
  if (_ivmError) throw _ivmError;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _ivm = require('isolated-vm') as typeof ivm;
    return _ivm;
  } catch (e) {
    _ivmError = new Error(
      `isolated-vm unavailable on this runtime (${(e as Error).message}). ` +
      `User-blank JS impl: feature requires Node.js with a working ` +
      `isolated-vm binding. Bun-based hosts (opencode, shell) cannot ` +
      `load user-blank JS today — built-in blanks + .sh blanks keep working.`,
    );
    throw _ivmError;
  }
}
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
  /** Dispose the underlying isolate. Calling `module.*` after dispose
   *  throws. Caller owns the lifecycle — typical pattern is to dispose
   *  when the registry rebuilds (fs.watch tick). */
  dispose(): void;
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
  /** Memory limit for the isolate, in MB. Defaults to 32. */
  readonly memoryLimitMb?: number;
}

/**
 * Load a user blank from disk into an isolated V8 realm.
 *
 * Returns a `LoadedUserBlank` whose `module.get(ctx, args)` etc.
 * are async functions: each call serializes args into the isolate,
 * runs the user's exported method to completion (subject to the
 * timeout + memory budget), and serializes the result back.
 *
 * Throws when the file can't be read, the JS doesn't parse, the
 * isolate fails to construct, or the exported shape is wrong.
 */
export function loadUserBlank(absJsPath: string, opts: LoaderOptions): LoadedUserBlank {
  // Lazy load — throws on Bun, caught by registry.ts (gracefully
  // disables this one blank, host keeps running).
  const ivmRT = getIvm();
  const source = fs.readFileSync(absJsPath, 'utf8');
  const folder = path.dirname(absJsPath);
  const caps = opts.capabilities;
  const log = opts.log ?? ((lvl, msg) => console.log(`[user-blank] [${lvl}] ${msg}`));
  const timeoutMs = opts.timeoutMs ?? 8000;
  const memoryLimit = opts.memoryLimitMb ?? 32;

  // Pre-rewrite the user's ESM source to a CJS-shim shape we can run
  // as a classic script in the isolate. The rewriter also rejects
  // dynamic `import()` at parse time (F4 / row #4) — that defence
  // stays in place under isolated-vm.
  const wrapped = rewriteEsmExportDefault(source);

  // Construct the isolate + context.
  const isolate = new ivmRT.Isolate({ memoryLimit });
  const context = isolate.createContextSync();
  const jail = context.global;

  // Standard self-reference so user code that does `globalThis` /
  // `global` gets the isolate's global, not undefined.
  jail.setSync('global', jail.derefInto());
  jail.setSync('globalThis', jail.derefInto());

  // Minimal console — every method routes back to the host log.
  const consoleLogRef = new ivmRT.Reference((msg: string) => log('info', msg));
  const consoleWarnRef = new ivmRT.Reference((msg: string) => log('warn', msg));
  const consoleErrRef = new ivmRT.Reference((msg: string) => log('error', msg));
  jail.setSync('__oc_console_log', consoleLogRef);
  jail.setSync('__oc_console_warn', consoleWarnRef);
  jail.setSync('__oc_console_err', consoleErrRef);
  context.evalSync(`
    globalThis.console = {
      log:   (...a) => __oc_console_log.applyIgnored(undefined, [a.map(String).join(' ')]),
      info:  (...a) => __oc_console_log.applyIgnored(undefined, [a.map(String).join(' ')]),
      warn:  (...a) => __oc_console_warn.applyIgnored(undefined, [a.map(String).join(' ')]),
      error: (...a) => __oc_console_err.applyIgnored(undefined, [a.map(String).join(' ')]),
      debug: (...a) => __oc_console_log.applyIgnored(undefined, [a.map(String).join(' ')]),
    };
  `);

  // CJS-style module shim — the rewriter emits code that writes into
  // `module.exports.default`. Provide the shim object.
  context.evalSync(`
    globalThis.module = { exports: {} };
    globalThis.exports = globalThis.module.exports;
  `);

  // Compile + run the user source. The isolate timeout bounds the
  // top-level execution; async work scheduled via Promise won't be
  // killed by this timer (that's the same caveat as the prior vm
  // loader). The per-invocation `applySync`/`applyAsync` calls below
  // each set their own timeout for the user's method.
  let script: ivm.Script;
  try {
    script = isolate.compileScriptSync(wrapped, { filename: absJsPath });
  } catch (err) {
    isolate.dispose();
    throw new Error(`user-blank load failed: ${absJsPath}: ${(err as Error).message}`);
  }
  try {
    script.runSync(context, { timeout: timeoutMs });
  } catch (err) {
    isolate.dispose();
    throw new Error(`user-blank load failed: ${absJsPath}: ${(err as Error).message}`);
  }

  // Extract a Reference to the user's `default` export. The CJS shim
  // we ship writes either `module.exports.default = X` (ESM
  // shape) or `module.exports = X` (CJS shape) — try default first,
  // fall back to the bare exports.
  const defaultExportRef = context.evalSync(
    'module.exports.default !== undefined ? module.exports.default : module.exports',
    { reference: true },
  );
  if (!defaultExportRef || defaultExportRef.typeof !== 'object') {
    isolate.dispose();
    throw new Error(`user-blank ${absJsPath} must export default { get(ctx, args) }`);
  }
  let getRef: ivm.Reference;
  try {
    getRef = defaultExportRef.getSync('get', { reference: true });
  } catch {
    isolate.dispose();
    throw new Error(`user-blank ${absJsPath} must export default { get(ctx, args) }`);
  }
  if (!getRef || getRef.typeof !== 'function') {
    isolate.dispose();
    throw new Error(`user-blank ${absJsPath} must export default { get(ctx, args) }`);
  }

  // The wrapped module exposes async method shims that bridge ctx
  // and args into the isolate and await the user method's result.
  const moduleProxy: UserBlankModule = {
    get: async (callerCtx, args) => {
      const r = await invokeUserMethod(context, defaultExportRef, 'get', callerCtx, args, timeoutMs);
      return r === undefined || r === null ? '' : String(r);
    },
    set: async (callerCtx, value, args) => {
      const setRef = defaultExportRef.getSync('set', { reference: true });
      if (!setRef || setRef.typeof !== 'function') return;
      // set takes (ctx, value, args); pack as [value, ...args] for the bridge.
      await invokeUserMethod(context, defaultExportRef, 'set', callerCtx, [value, ...(args ?? [])], timeoutMs);
    },
  };

  return {
    module: moduleProxy,
    folder,
    capabilities: caps,
    dispose: () => {
      try { isolate.dispose(); } catch { /* already disposed */ }
    },
  };
}

// ─── Invoke a user method across the isolate boundary ──────────────────

async function invokeUserMethod(
  context: ivm.Context,
  defaultRef: ivm.Reference,
  methodName: string,
  callerCtx: Partial<BlankContext> | undefined,
  args: readonly unknown[] | undefined,
  timeoutMs: number,
): Promise<unknown> {
  // Lazy load. Reaching this path means loadUserBlank already
  // succeeded for this blank, so getIvm() is guaranteed to return
  // the cached module — never throws here in practice.
  const ivmRT = getIvm();
  callerCtx = callerCtx ?? {};
  args = args ?? [];

  // Build host-side References for each ctx method that exists. The
  // user code crosses back through these to call our capability-gated
  // implementations. The Reference proxies are released after the
  // method returns (passing into the isolate via applyOptions.copy
  // keeps the host functions alive only for the call duration).
  const refs: Record<string, ivm.Reference | undefined> = {
    now: typeof callerCtx.now === 'function'
      ? new ivmRT.Reference(() => (callerCtx!.now as () => number)())
      : undefined,
    log: typeof callerCtx.log === 'function'
      ? new ivmRT.Reference((lvl: string, msg: string, data?: unknown) => {
          (callerCtx!.log as (l: 'info' | 'warn' | 'error', m: string, d?: unknown) => void)(
            lvl as 'info' | 'warn' | 'error',
            msg,
            data,
          );
        })
      : undefined,
    fetch: typeof callerCtx.fetch === 'function'
      ? new ivmRT.Reference(async (url: string, init?: string) => {
          // init was JSON-stringified on the way in; parse back.
          const initObj = init ? JSON.parse(init) : undefined;
          const res = await (callerCtx!.fetch as (url: string, init?: RequestInit) => Promise<Response>)(
            url,
            initObj,
          );
          // Marshal Response into a plain object the isolate can consume.
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => { headers[k] = v; });
          const text = await res.text();
          return JSON.stringify({
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            headers,
            text,
          });
        })
      : undefined,
    llm: typeof callerCtx.llm === 'function'
      ? new ivmRT.Reference(async (reqJson: string) => {
          const req = JSON.parse(reqJson);
          const result = await (callerCtx!.llm as (
            req: { prompt: string; system?: string; model?: string; maxTokens?: number; temperature?: number },
          ) => Promise<string>)(req);
          return result;
        })
      : undefined,
    storage_get: typeof callerCtx.storage?.get === 'function'
      ? new ivmRT.Reference(async (k: string) => {
          const v = await callerCtx!.storage!.get(k);
          return v;
        })
      : undefined,
    storage_set: typeof callerCtx.storage?.set === 'function'
      ? new ivmRT.Reference(async (k: string, v: string) => {
          await callerCtx!.storage!.set(k, v);
        })
      : undefined,
  };

  // Build the ctx-shim INSIDE the isolate. We pass each Reference as
  // a separate positional argument (isolated-vm can transfer References
  // as arguments, but can't pack them into an object you `setSync` —
  // hence the long arg list). Undefined refs become sentinel `null`s.
  // The shim wraps each Reference in a small isolate-side function
  // that calls .apply() / .applyIgnored() with the correct transfer
  // options.
  const ctxShimBuilder = context.evalSync(
    `(function buildCtx(refNow, refLog, refFetch, refLlm, refStorageGet, refStorageSet, secretsJson) {
      const ctx = {};
      if (refNow)  ctx.now  = () => refNow.applySync();
      if (refLog)  ctx.log  = (lvl, msg, data) => refLog.applyIgnored(undefined, [lvl, msg, data], { arguments: { copy: true } });
      if (refFetch) ctx.fetch = async (url, init) => {
        const initStr = init === undefined ? undefined : JSON.stringify(init);
        const raw = await refFetch.apply(undefined, [url, initStr], {
          arguments: { copy: true },
          result: { promise: true, copy: true },
        });
        const r = JSON.parse(raw);
        return {
          ok: r.ok,
          status: r.status,
          statusText: r.statusText,
          headers: r.headers,
          // Response-shape compatibility: text() / json() return promises
          // so user code that does \`await r.json()\` keeps working.
          text:    async () => r.text,
          json:    async () => JSON.parse(r.text),
          arrayBuffer: async () => { throw new Error('ctx.fetch: arrayBuffer not supported in user-blank isolate'); },
          blob:    async () => { throw new Error('ctx.fetch: blob not supported in user-blank isolate'); },
        };
      };
      if (refLlm) ctx.llm = async (req) => {
        const reqStr = JSON.stringify(req);
        return refLlm.apply(undefined, [reqStr], {
          arguments: { copy: true },
          result: { promise: true, copy: true },
        });
      };
      if (refStorageGet && refStorageSet) {
        ctx.storage = {
          get: async (k) => refStorageGet.apply(undefined, [k], {
            arguments: { copy: true },
            result: { promise: true, copy: true },
          }),
          set: async (k, v) => refStorageSet.apply(undefined, [k, v], {
            arguments: { copy: true },
            result: { promise: true, copy: true },
          }),
        };
      }
      if (secretsJson) {
        const secrets = JSON.parse(secretsJson);
        if (secrets && typeof secrets === 'object') ctx.secrets = Object.freeze(secrets);
      }
      return ctx;
    })`,
    { reference: true },
  );

  // Positional args: each ref or `null`. Refs are transferable.
  const secretsJson = JSON.stringify(callerCtx.secrets ?? null);
  const ctxShim = (await ctxShimBuilder.apply(undefined, [
    refs.now ?? null,
    refs.log ?? null,
    refs.fetch ?? null,
    refs.llm ?? null,
    refs.storage_get ?? null,
    refs.storage_set ?? null,
    secretsJson,
  ], { result: { reference: true } })) as ivm.Reference;

  // Now call default[methodName](ctxShim, args). default is a Reference
  // to the user's exported object; .get the method, .apply it.
  const methodRef = defaultRef.getSync(methodName, { reference: true });
  if (!methodRef || methodRef.typeof !== 'function') {
    throw new Error(`user-blank: method "${methodName}" is not a function`);
  }

  const result = await methodRef.apply(
    undefined,
    [ctxShim.derefInto(), new ivmRT.ExternalCopy([...args]).copyInto()],
    {
      timeout: timeoutMs,
      result: { promise: true, copy: true },
    },
  );

  // Release the per-call Reference proxies. The isolate-side ctxShim
  // becomes unreachable once the method returns, so its cross-realm
  // references die naturally on the next GC pass.
  for (const r of Object.values(refs)) {
    if (r) { try { r.release(); } catch { /* already released */ } }
  }
  try { ctxShim.release(); } catch { /* */ }

  return result;
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
