// Chrome user-blank loader. Spawns a Web Worker for each
// user-shipped blank's JS, gives it ONLY the capabilities declared
// in BLANK.md frontmatter.
//
// The Worker is a separate JS context — no DOM, no chrome.* APIs,
// no access to the content script's globals. Capability proxies
// (fetch / llm / storage) post-message back to the main thread,
// which fulfils them after re-checking the allow-list.
//
// Same isolation philosophy as Figma plugins: tiny capability
// surface, message-passing bridge, declared permissions only.

import type { Blank } from '@opencues/runtime/dist/src/blanks';
import { log as runtimeLog } from './opencues-bootstrap';
import { resolveLLM, buildProviderRequest, parseProviderResponse, type ProviderId } from '@opencues/core';

// ─── Worker harness source ──────────────────────────────────────────────
//
// We CANNOT use `new Function` or `eval` inside the Worker because
// strict-CSP pages (claude.ai's `strict-dynamic` etc.) block runtime
// JS evaluation even in Workers. Instead, we EMBED the user's
// blank.js source directly into the Worker's startup script — at
// registration time we concatenate harness-prefix + rewritten user
// source + harness-suffix into one blob URL. The user's code runs
// as part of Worker startup (a normal script load), not via eval.
//
// The user's `export default { ... }` is regex-rewritten to
// `module.exports.default = { ... }` before embedding, same pattern
// as the Node loader. Then a harness-suffix captures the result
// into a Worker global the message handlers read.

const WORKER_HARNESS_PREFIX = String.raw`
  let userMod = null;
  const pending = new Map();
  let nextCallId = 0;

  function callMain(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++nextCallId;
      pending.set(id, { resolve, reject });
      self.postMessage({ type: 'ctx-call', callId: id, method, args });
    });
  }

  function buildCtx(caps) {
    const ctx = {
      now: () => Date.now(),
      log: (level, msg) => self.postMessage({ type: 'log', level, msg }),
    };
    if (caps.network) {
      ctx.fetch = async (url, init) => {
        const r = await callMain('fetch', [url, init]);
        return {
          ok: r.ok, status: r.status, statusText: r.statusText,
          async text() { return r.text; },
          async json() { return JSON.parse(r.text); },
        };
      };
    }
    if (caps.llm) {
      ctx.llm = (req) => callMain('llm', [req]);
    }
    if (caps.storage) {
      ctx.storage = {
        get: (k) => callMain('storage.get', [k]),
        set: (k, v) => callMain('storage.set', [k, v]),
      };
    }
    if (caps.secrets) {
      // Secrets pre-resolved by the main thread; the worker just
      // exposes them as a frozen object on ctx.
      ctx.secrets = Object.freeze(caps.secrets);
    }
    return ctx;
  }

  self.addEventListener('message', async (e) => {
    const msg = e.data;
    if (msg.type === 'init') {
      // User code already ran at Worker startup. If userMod wasn't
      // populated, the embedded source was malformed.
      if (!userMod || typeof userMod.get !== 'function') {
        self.postMessage({ type: 'init-error', error: 'user blank must export default { get(ctx, args) }' });
      } else {
        self.postMessage({ type: 'init-ok' });
      }
      return;
    }
    if (msg.type === 'invoke') {
      const { invokeId, method, args, capabilities } = msg;
      try {
        if (typeof userMod[method] !== 'function') {
          self.postMessage({ type: 'invoke-error', invokeId, error: 'method not exported: ' + method });
          return;
        }
        const ctx = buildCtx(capabilities);
        const result = await userMod[method](ctx, args || []);
        self.postMessage({ type: 'invoke-result', invokeId, result: result == null ? '' : String(result) });
      } catch (err) {
        self.postMessage({ type: 'invoke-error', invokeId, error: String(err && err.message || err) });
      }
      return;
    }
    if (msg.type === 'ctx-call-result') {
      const p = pending.get(msg.callId);
      if (p) {
        pending.delete(msg.callId);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }
  });

  // User module wrapper — IIFE that runs at Worker startup. The
  // rewritten user source (in WORKER_USER_WRAPPER) sets
  // module.exports.default; we promote that to the userMod global
  // the message handler reads above.
  (function() {
    var module = { exports: {} };
    var exports = module.exports;
    try {
`;

const WORKER_HARNESS_SUFFIX = String.raw`
      userMod = module.exports.default || module.exports;
    } catch (e) {
      // Syntax / runtime error in user code → leave userMod null;
      // the init message handler reports it back to main thread.
      self.__ocLoadErr = String(e && e.message || e);
    }
  })();
`;

function rewriteUserSource(source: string): string {
  // Strip ESM `import` (no module loading in Workers anyway).
  let out = source.replace(/^(\s*)import\s.*$/gm, (_m, ws) => `${ws}// import stripped`);
  // `export default X` → `module.exports.default = X`
  out = out.replace(/^(\s*)export\s+default\s+/m, '$1module.exports.default = ');
  // `export const/let/var/function/async function` → drop `export `
  out = out.replace(/^(\s*)export\s+(?=(const|let|var|function|async\s+function))/gm, '$1');
  return out;
}

// ─── Main-thread loader ─────────────────────────────────────────────────

export interface ChromeUserBlankOptions {
  /** Hostnames the blank may fetch from. Enforced both in the worker
   *  AND on the main thread (defence in depth — the worker can't
   *  reach the network anyway, but a malicious worker shouldn't be
   *  able to fool the main thread either). */
  readonly network?: readonly string[];
  /** LLM provider name. When set, ctx.llm() is available; main thread
   *  routes through the content script's fetch proxy via the SW. */
  readonly llm?: string;
  /** Storage namespace. Reads/writes go to chrome.storage.local under
   *  `opencues_user_blank:<namespace>:<key>`. */
  readonly storage?: string;
  /** API keys keyed by env-var name (GROQ_API_KEY, OPENAI_API_KEY,
   *  ANTHROPIC_API_KEY, etc.). Sourced from the chrome runtime's
   *  llmApiKey + llmApiKeys options (host-pushed via native messaging
   *  + popup overrides). The LLM bridge picks the right key for
   *  the declared `llm:` provider. */
  readonly llmApiKeys?: Readonly<Record<string, string>>;
  /** Secret env-var names the blank may read via `ctx.secrets[<NAME>]`.
   *  Declared in BLANK.md frontmatter via `secrets: [NAME1, NAME2]`.
   *  Same trust model as llmApiKeys — host injects, the worker
   *  receives only the keys it asked for. */
  readonly secrets?: readonly string[];
  /** Secret VALUES map. Sourced from chrome.storage's host-pushed
   *  opencues_host_keys (same source that feeds llmApiKeys). Only
   *  the keys listed in `secrets` are sent to the worker. */
  readonly secretValues?: Readonly<Record<string, string>>;
  /** Hard cap on a single invoke. Default 10s. */
  readonly timeoutMs?: number;
}

interface PendingInvoke {
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ChromeUserBlank implements Blank {
  readonly name: string;
  readonly readOnly = false;
  private worker: Worker;
  private ready: Promise<void>;
  private pending = new Map<string, PendingInvoke>();
  private nextInvokeId = 0;

  constructor(
    name: string,
    source: string,
    private opts: ChromeUserBlankOptions,
  ) {
    this.name = name;
    // Concatenate harness + rewritten user source + suffix into ONE
    // worker script. No `new Function` at runtime → no CSP eval
    // violation on strict-CSP pages (claude.ai, etc.).
    const fullSource =
      WORKER_HARNESS_PREFIX +
      rewriteUserSource(source) +
      WORKER_HARNESS_SUFFIX;
    const blob = new Blob([fullSource], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));
    this.worker.addEventListener('message', (e) => this.onMessage(e));
    this.ready = this.handshake();
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === 'init-ok') {
          this.worker.removeEventListener('message', handler);
          resolve();
        } else if (e.data.type === 'init-error') {
          this.worker.removeEventListener('message', handler);
          reject(new Error(e.data.error));
        }
      };
      this.worker.addEventListener('message', handler);
      // Trigger the init-status reply. The Worker has already
      // executed the user code at startup; this just asks "did it
      // populate userMod?" via the message handler.
      this.worker.postMessage({ type: 'init' });
    });
  }

  async get(keyword?: string, context?: string[]): Promise<string> {
    await this.ready;
    return this.invoke('get', [keyword ?? '', ...(context ?? [])]);
  }

  async set(value: string, keyword?: string): Promise<void> {
    await this.ready;
    await this.invoke('set', [value, keyword ?? '']);
  }

  private invoke(method: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const invokeId = String(++this.nextInvokeId);
      const timer = setTimeout(() => {
        this.pending.delete(invokeId);
        reject(new Error(`user-blank invoke timeout (${this.opts.timeoutMs ?? 10_000}ms)`));
      }, this.opts.timeoutMs ?? 10_000);
      this.pending.set(invokeId, { resolve, reject, timer });

      // Resolve declared secrets to their values RIGHT BEFORE
      // sending. Filters the host-pushed map down to only the
      // names the blank's frontmatter asked for.
      let resolvedSecrets: Record<string, string> | undefined;
      if (this.opts.secrets && this.opts.secrets.length > 0 && this.opts.secretValues) {
        resolvedSecrets = {};
        for (const name of this.opts.secrets) {
          const v = this.opts.secretValues[name];
          if (typeof v === 'string' && v.length > 0) resolvedSecrets[name] = v;
        }
      }

      this.worker.postMessage({
        type: 'invoke',
        invokeId,
        method,
        args,
        capabilities: {
          network: this.opts.network,
          llm: this.opts.llm,
          storage: this.opts.storage,
          secrets: resolvedSecrets,
        },
      });
    });
  }

  private onMessage(e: MessageEvent): void {
    const msg = e.data;
    if (msg.type === 'invoke-result' || msg.type === 'invoke-error') {
      const p = this.pending.get(msg.invokeId);
      if (!p) return;
      this.pending.delete(msg.invokeId);
      clearTimeout(p.timer);
      if (msg.type === 'invoke-result') p.resolve(String(msg.result ?? ''));
      else p.reject(new Error(msg.error));
      return;
    }
    if (msg.type === 'ctx-call') {
      this.handleCtxCall(msg.callId, msg.method, msg.args);
      return;
    }
    if (msg.type === 'log') {
      runtimeLog.info(`[user-blank:${this.name}] ${msg.msg}`);
      return;
    }
  }

  // ─── Capability bridge — fulfils worker requests on the main thread ──
  private async handleCtxCall(callId: number, method: string, args: unknown[]): Promise<void> {
    try {
      let result: unknown;
      switch (method) {
        case 'fetch':
          result = await this.handleFetch(args[0] as string, args[1] as RequestInit | undefined);
          break;
        case 'storage.get':
          result = await this.handleStorageGet(args[0] as string);
          break;
        case 'storage.set':
          await this.handleStorageSet(args[0] as string, args[1] as string);
          result = null;
          break;
        case 'llm':
          result = await this.handleLlm(args[0] as { prompt: string; model?: string });
          break;
        default:
          throw new Error('unknown ctx method: ' + method);
      }
      this.worker.postMessage({ type: 'ctx-call-result', callId, result });
    } catch (err) {
      this.worker.postMessage({
        type: 'ctx-call-result',
        callId,
        error: String((err as Error).message ?? err),
      });
    }
  }

  private async handleFetch(url: string, init?: RequestInit): Promise<unknown> {
    if (!this.opts.network || this.opts.network.length === 0) {
      throw new Error('ctx.fetch: network capability not declared');
    }
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new Error(`ctx.fetch: invalid URL: ${url}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`ctx.fetch: only http(s), got ${parsed.protocol}`);
    }
    const allowed = new Set(this.opts.network.map(s => s.toLowerCase()));
    if (!allowed.has(parsed.hostname.toLowerCase())) {
      throw new Error(
        `ctx.fetch: hostname "${parsed.hostname}" not in declared allow-list ` +
        `[${[...allowed].join(', ')}]`,
      );
    }
    // Route through the SW's fetch proxy (avoids CORS, reuses
    // host_permissions). The response body comes back as text; the
    // worker reconstructs a Response-like object.
    const reply = await chrome.runtime.sendMessage({
      type: 'opencues:fetch',
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return {
      ok: reply.ok,
      status: reply.status,
      statusText: reply.statusText,
      text: reply.text,
    };
  }

  private async handleStorageGet(key: string): Promise<string | null> {
    if (!this.opts.storage) throw new Error('ctx.storage: storage capability not declared');
    const storageKey = `opencues_user_blank:${this.opts.storage}:${key}`;
    const result = await chrome.storage.local.get(storageKey);
    const v = result[storageKey];
    return typeof v === 'string' ? v : null;
  }

  private async handleStorageSet(key: string, value: string): Promise<void> {
    if (!this.opts.storage) throw new Error('ctx.storage: storage capability not declared');
    const storageKey = `opencues_user_blank:${this.opts.storage}:${key}`;
    await chrome.storage.local.set({ [storageKey]: String(value) });
  }

  private async handleLlm(req: {
    prompt: string;
    system?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    if (!this.opts.llm) throw new Error('ctx.llm: llm capability not declared');
    if (!this.opts.llmApiKeys || Object.keys(this.opts.llmApiKeys).length === 0) {
      throw new Error('ctx.llm: no LLM credentials available — install chrome-host or set keys in popup');
    }

    // Resolve the LLM client for the declared provider. resolveLLM
    // handles the credential lookup (it knows GROQ_API_KEY etc.) and
    // returns the wire endpoint + default model. The user's `model`
    // override (if any) wins over the provider default.
    const resolved = resolveLLM({
      apiKeys: this.opts.llmApiKeys,
      globalProvider: this.opts.llm,
      modelOverride: req.model,
    });
    if (!resolved) {
      throw new Error(
        `ctx.llm: provider "${this.opts.llm}" not available — ` +
        `check the API key is set (popup) or pushed by chrome-host`,
      );
    }

    // Build the wire request. Each provider has its own body shape;
    // buildProviderRequest dispatches per provider.
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    const wire = buildProviderRequest(
      resolved.provider.id as ProviderId,
      {
        messages,
        model: resolved.model,
        temperature: req.temperature ?? 0,
        maxTokens: req.maxTokens ?? 1024,
      },
      { apiKey: resolved.apiKey, endpoint: resolved.endpoint },
    );

    // POST via the SW's fetch proxy (avoids CORS, reuses
    // host_permissions). Response body comes back as text; pass to
    // the provider's parser for the .choices[0].message.content
    // extraction.
    const resp = await chrome.runtime.sendMessage({
      type: 'opencues:fetch',
      method: 'POST',
      url: wire.url,
      headers: wire.headers,
      // buildProviderRequest returns wire.body pre-stringified.
      // Double-stringify yields a quoted JSON string the LLM
      // rejects with HTTP 400 ("cannot unmarshal").
      body: typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body),
    });
    if (!resp || !resp.ok) {
      throw new Error(
        `ctx.llm http ${resp?.status ?? '???'}: ` +
        `${(resp?.text ?? '').slice(0, 200)}`,
      );
    }
    return parseProviderResponse(resolved.provider.id as ProviderId, resp.text);
  }

  dispose(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('blank disposed'));
    }
    this.pending.clear();
    this.worker.terminate();
  }
}
