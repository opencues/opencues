// Registration helper for user-shipped JS blanks. Native-host
// bootstraps (CC / OC / Gemini) call this at boot to discover every
// `impl: ./blank.js` blank in the user's `.cues/blanks/` tree and
// register it alongside the built-in runtime classes.
//
// Chrome uses a separate Worker-based loader (see chrome-loader.ts
// once it lands); the registration shape there is similar — a
// Map<name, Blank> entry per user blank — but the implementation
// uses postMessage rather than vm.runInContext.

import * as fs from 'node:fs';
import type { Blank } from '../blanks/types';

function fsExistsSync(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function isIvmUnavailableError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  return msg.includes('isolated-vm unavailable');
}
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
import {
  loadUserBlankSubprocess,
  getDefaultRunnerPath,
} from './subprocess-loader';
import { sanitizeBlankOutput } from './sanitize';
import { createQuotaTracker, type QuotaConfig, type QuotaTracker } from './quota';
import { buildRequestParts, enforceSecretBindings, type BoundSecret } from './secret-leak-guard';

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
  readonly userBlankSecrets?: readonly string[];
  /** Per-secret allow-list of hostnames. Maps secret env-var name to
   *  the hostnames where that secret may appear in a request URL/
   *  headers/body. Secrets without a binding here are unrestricted. */
  readonly userBlankSecretBindings?: Readonly<Record<string, readonly string[]>>;
  /** When 'rich', the blank's return values bypass HTML/Unicode
   *  sanitization. Default 'safe' strips tags + ZWS + bidi overrides
   *  + NFKC normalizes + caps length at 8KB. */
  readonly userBlankOutput?: 'safe' | 'rich';
  readonly maxFetchesPerMinute?: number;
  readonly maxLlmPerMinute?: number;
  readonly maxStorageBytes?: number;
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
  outputMode: 'safe' | 'rich' = 'safe',
): Blank {
  const mod = loaded.module;
  const readOnly = !!mod.readOnly || (typeof mod.set !== 'function' && typeof mod.up !== 'function' && typeof mod.down !== 'function');
  const allowRich = outputMode === 'rich';
  const clean = (v: unknown): string => sanitizeBlankOutput(v, { allowRich });

  return {
    name,
    readOnly,
    get: async (keyword?: string, context?: string[]) => {
      const args = [keyword ?? '', ...(context ?? [])];
      const result = await mod.get(ctx, args);
      return clean(result);
    },
    set: mod.set ? async (value: string, keyword?: string) => {
      await mod.set!(ctx, value, [keyword ?? '']);
    } : undefined,
    up: mod.up ? async () => clean(await mod.up!(ctx)) : undefined,
    down: mod.down ? async () => clean(await mod.down!(ctx)) : undefined,
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
  /** Source for ctx.secrets values, keyed by env-var name. Native
   *  hosts default this to process.env; chrome bootstrap builds it
   *  from chrome.storage's opencues_host_keys map. Only declared
   *  secrets reach the blank. */
  readonly secrets?: Readonly<Record<string, string>>;
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

    // First-wins on duplicate names. Two packs both declaring a
    // blank named e.g. "weather" must not silently overwrite — the
    // earlier registration keeps its slot and the conflict is
    // logged loudly. Without this, a later-loaded pack could shadow
    // a built-in (typosquat-style attack post-registry).
    if (out.has(cfg.name)) {
      log('warn',
        `user blank name collision: "${cfg.name}" already registered from an earlier source; ` +
        `ignoring impl: ${cfg.impl}. Rename one of the duplicates.`,
      );
      continue;
    }

    // Required secret bindings: every declared secret MUST have a
    // matching `secret-hosts.<NAME>: [host, ...]` entry. Unbound
    // secrets were back-compat behaviour during the migration; now
    // that the per-secret leak guard is the load-bearing defence
    // against exfil, an unbound secret is an explicit author
    // mistake — refuse to register rather than silently accept.
    if (cfg.userBlankSecrets && cfg.userBlankSecrets.length > 0) {
      const unbound = cfg.userBlankSecrets.filter(name =>
        !cfg.userBlankSecretBindings?.[name] || cfg.userBlankSecretBindings[name].length === 0,
      );
      if (unbound.length > 0) {
        log('warn',
          `user blank "${cfg.name}": secrets [${unbound.join(', ')}] declared without ` +
          `secret-hosts.<NAME> bindings — refusing to load. Add e.g. ` +
          `\`secret-hosts.${unbound[0]}: [api.example.com]\` to BLANK.md frontmatter.`,
        );
        continue;
      }
    }

    const caps: BlankCapabilities = {
      network: cfg.userBlankNetwork ? [...cfg.userBlankNetwork] : undefined,
      llm: cfg.userBlankLlm,
      storage: cfg.userBlankStorage,
      secrets: cfg.userBlankSecrets ? [...cfg.userBlankSecrets] : undefined,
      secretBindings: cfg.userBlankSecretBindings,
    };
    const quotaCfg: QuotaConfig = {
      maxFetchesPerMinute: cfg.maxFetchesPerMinute,
      maxLlmPerMinute: cfg.maxLlmPerMinute,
      maxStorageBytes: cfg.maxStorageBytes,
    };
    const quota = createQuotaTracker(quotaCfg);

    let loaded: LoadedUserBlank;
    try {
      loaded = loadUserBlank(cfg.impl, {
        capabilities: caps,
        storage,
        llm: opts.llm,
        secrets: opts.secrets,
        log,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      // Bun-based hosts (opencode, shell) can't load the isolated-vm
      // native binding. Fall back to the subprocess runner — spawns a
      // Node helper that owns the isolates and IPCs over JSON. Same
      // security boundary; capability gating happens host-side, same
      // as in-process. Subprocess fallback requires the runner script
      // to be present at `~/.opencues/vendor/user-blank-runner.cjs`
      // (installed by `opencues install opencode/shell`). If the
      // runner is missing too, fall through to the warn+skip path
      // exactly as before — built-in blanks + .sh blanks keep working.
      if (isIvmUnavailableError(err) && fsExistsSync(getDefaultRunnerPath())) {
        try {
          loaded = loadUserBlankSubprocess(cfg.impl, cfg.name, {
            capabilities: caps,
            storage,
            llm: opts.llm,
            secrets: opts.secrets,
            log,
            timeoutMs: opts.timeoutMs,
          });
          log('info', `loaded user blank "${cfg.name}" via subprocess (isolated-vm unavailable in-process)`);
        } catch (err2) {
          log('warn', `failed to load user blank "${cfg.name}" from ${cfg.impl} (subprocess fallback): ${(err2 as Error).message}`);
          continue;
        }
      } else {
        log('warn', `failed to load user blank "${cfg.name}" from ${cfg.impl}: ${(err as Error).message}`);
        continue;
      }
    }

    // Build the ctx ONCE here so the wrapped Blank reuses it across
    // calls (consistent capability state, especially for storage +
    // rate-limit counters).
    const ctx = buildContextFromCaps(caps, opts, storage, quota);
    out.set(cfg.name, wrapUserBlankAsBlank(loaded, cfg.name, ctx, cfg.userBlankOutput ?? 'safe'));
    log('info', `registered user blank "${cfg.name}" from ${cfg.impl}`);
  }

  return out;
}

// ─── Internal: ctx builder mirrors node-loader's ────────────────────────

function buildContextFromCaps(
  caps: BlankCapabilities,
  opts: UserBlankRegistryOptions,
  storage: StorageAdapter | undefined,
  quota: QuotaTracker,
): BlankContext {
  const log = opts.log ?? ((lvl, msg) => console.log(`[user-blank] [${lvl}] ${msg}`));
  const ctx: BlankContext = {
    now: () => Date.now(),
    log,
  };

  // Pre-resolve bound secrets: pair each declared secret with its
  // value (if injected) and its host-binding list. Used by the fetch
  // wrapper to refuse outbound requests that would leak a secret to
  // an unbound host.
  const boundSecrets: BoundSecret[] = [];
  if (caps.secrets && opts.secrets) {
    for (const name of caps.secrets) {
      const value = opts.secrets[name];
      if (typeof value !== 'string' || value.length === 0) continue;
      const allowedHosts = caps.secretBindings?.[name] ?? [];
      boundSecrets.push({ name, value, allowedHosts });
    }
  }

  if (caps.network && caps.network.length > 0) {
    const allowed = new Set(caps.network.map(s => s.toLowerCase()));
    ctx.fetch = async (url, init) => {
      quota.recordFetch();
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
      if (boundSecrets.length > 0) {
        enforceSecretBindings(buildRequestParts(url, init), boundSecrets);
      }
      return (globalThis as { fetch: typeof fetch }).fetch(url, init);
    };
  }

  if (caps.llm && opts.llm) {
    const provider = caps.llm;
    const llmFn = opts.llm;

    // Resolve the LLM endpoint up front so we know which host the
    // prompt+system body will be sent to. Used to enforce secret
    // host bindings on the LLM path (a malicious blank could try to
    // exfil a bound secret through the prompt body).
    let llmHostname = '';
    if (opts.secrets && boundSecrets.length > 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const core = require('@opencues/core') as typeof import('@opencues/core');
        const resolved = core.resolveLLM({
          apiKeys: opts.secrets as Record<string, string>,
          globalProvider: provider,
        });
        if (resolved) {
          try { llmHostname = new URL(resolved.endpoint).hostname.toLowerCase(); } catch { /* leave empty → all bound secrets refused on llm path */ }
        }
      } catch { /* core not available — skip scan */ }
    }

    ctx.llm = async (req) => {
      quota.recordLlm();
      if (boundSecrets.length > 0) {
        enforceSecretBindings({
          hostname: llmHostname,
          url: '',
          headers: '',
          body: `${req.system ?? ''}\n${req.prompt}`,
        }, boundSecrets);
      }
      return llmFn(provider, req);
    };
  }

  if (caps.storage && storage) {
    const ns = caps.storage;
    ctx.storage = {
      get: (k) => storage.get(ns, k),
      set: async (k, v) => {
        // True namespace-wide cap: read existing total (excluding the
        // key we're about to overwrite) and add the new entry size.
        // Refuses a write that pushes the namespace over budget rather
        // than only catching single oversized values.
        const existing = await storage.size(ns, k);
        const newTotal = existing + k.length + v.length;
        quota.checkStorageBytes(newTotal);
        return storage.set(ns, k, v);
      },
    };
  }

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

/**
 * Default LLM adapter for native hosts. Uses @opencues/core's
 * resolveLLM + buildProviderRequest + parseProviderResponse to route
 * a (prompt, system?) request through whichever provider the blank
 * declared. apiKeys is the host's process.env (or a filtered subset);
 * the resolver picks the right key by env-var name.
 *
 * Throws when no API key is configured for the declared provider.
 */
export function createNativeLlmAdapter(
  apiKeys: Readonly<Record<string, string>>,
): LlmAdapter {
  // Lazy-load core to avoid a hard dependency cycle at module load.
  // @opencues/core ships its built dist alongside @opencues/runtime;
  // this require resolves the same way the user code did at install
  // time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const core = require('@opencues/core') as typeof import('@opencues/core');
  return async (provider, opts) => {
    const resolved = core.resolveLLM({
      apiKeys: apiKeys as Record<string, string>,
      globalProvider: provider,
      modelOverride: opts.model,
    });
    if (!resolved) {
      throw new Error(`ctx.llm: provider "${provider}" not configured (missing API key?)`);
    }
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: opts.prompt });

    const wire = core.buildProviderRequest(
      resolved.provider.id,
      {
        messages,
        model: resolved.model,
        temperature: opts.temperature ?? 0,
        maxTokens: opts.maxTokens ?? 1024,
      },
      { apiKey: resolved.apiKey, endpoint: resolved.endpoint },
    );
    // buildProviderRequest returns wire.body already pre-stringified.
    // Don't JSON.stringify again — double-stringify yields "{...}" as
    // a quoted string which the LLM rejects with HTTP 400.
    const r = await fetch(wire.url, {
      method: 'POST',
      headers: wire.headers,
      body: typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`ctx.llm http ${r.status}: ${text.slice(0, 200)}`);
    }
    const text = await r.text();
    return core.parseProviderResponse(resolved.provider.id, text);
  };
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
