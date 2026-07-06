// SubprocessIsolateRunner — main-process side of the user-blank subprocess
// architecture.
//
// On Bun-based hosts (opencode, shell), `isolated-vm`'s `.node` binding
// can't load (V8 ABI vs JavaScriptCore). This loader spawns a long-lived
// Node helper process (subprocess-runner.cjs at ~/.opencues/vendor/) that
// owns the isolates, and IPCs to it over newline-delimited JSON on
// stdin/stdout. The user blank still runs in a real isolated-vm sandbox —
// just in a different process.
//
// Key properties:
//   - Same security boundary as the in-process loader. User code never
//     reaches the main process's globals; everything that crosses the
//     subprocess boundary does so as JSON.
//   - One subprocess per session, multiplexed across every user-pack JS
//     blank. Loaded lazily on first invoke; idle-reaped after 5 min;
//     respawned if it dies unexpectedly.
//   - Capability calls (ctx.fetch / ctx.llm / ctx.storage) round-trip back
//     to the main process for allow-list + quota + secret-binding checks,
//     so the existing enforcement code in registry.ts continues to apply.
//   - The loader exposes the same `LoadedUserBlank` shape as the in-process
//     node-loader — registry.ts can swap between them transparently.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { rewriteEsmToCjsShim } from './esm-rewrite';
import { buildRequestParts, enforceSecretBindings, buildLlmSecretGuard, type BoundSecret } from './secret-leak-guard';
import type {
  BlankCapabilities,
  BlankContext,
  UserBlankModule,
} from './types';
import type {
  LoaderOptions,
  LoadedUserBlank,
  StorageAdapter,
  LlmAdapter,
} from './node-loader';

const DEFAULT_REAP_MS = 5 * 60 * 1000;

// ─── Capability handler (per-blank, owned by main) ──────────────────────
//
// One CapabilityHandler per loaded blank. Main keeps a Map<blankName, …>
// and dispatches `cap-*` requests from the runner to the matching entry.

interface CapabilityHandler {
  fetch?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; text: string }>;
  llm?: (req: { prompt: string; system?: string; model?: string; maxTokens?: number; temperature?: number }) => Promise<string>;
  storageGet?: (key: string) => Promise<string | null>;
  storageSet?: (key: string, value: string) => Promise<void>;
}

// ─── IPC protocol shapes ─────────────────────────────────────────────────

type RunnerOut =
  | { op: 'ready'; node: string; ivm: string }
  | { op: 'load-result'; id: string; ok: true }
  | { op: 'load-result'; id: string; ok: false; error: string }
  | { op: 'get-result'; id: string; ok: true; value: string | null }
  | { op: 'get-result'; id: string; ok: false; error: string }
  | { op: 'set-result'; id: string; ok: true }
  | { op: 'set-result'; id: string; ok: false; error: string }
  | { op: 'log'; level: string; message: string; data?: unknown }
  | { op: 'cap-fetch'; id: string; callbackId: string; url: string; init?: RequestInit }
  | { op: 'cap-storage-get'; id: string; callbackId: string; key: string }
  | { op: 'cap-storage-set'; id: string; callbackId: string; key: string; value: string }
  | { op: 'cap-llm'; id: string; callbackId: string; req: { prompt: string; system?: string; model?: string; maxTokens?: number; temperature?: number } }
  | { op: 'cap-secret'; id: string; callbackId: string; name: string };

type RunnerIn =
  | { op: 'load'; id: string; blankName: string; modulePath: string; sourceCode: string; timeoutMs?: number; memoryLimitMb?: number; capsAvailable?: { fetch?: boolean; llm?: boolean; storage?: boolean } }
  | { op: 'get'; id: string; blankName: string; args: readonly unknown[]; secrets?: Record<string, string> | null }
  | { op: 'set'; id: string; blankName: string; args: readonly unknown[]; secrets?: Record<string, string> | null }
  | { op: 'cap-result'; callbackId: string; ok: true; value: unknown }
  | { op: 'cap-result'; callbackId: string; ok: false; error: string }
  | { op: 'shutdown' };

// ─── SubprocessIsolateRunner ─────────────────────────────────────────────

export interface SubprocessRunnerOptions {
  /** Absolute path to subprocess-runner.cjs. Required. */
  readonly runnerPath: string;
  /** Reap idle subprocess after this many ms of inactivity. Default 5min. */
  readonly reapMs?: number;
  /** Path to node binary. Defaults to 'node' on PATH. */
  readonly nodeBinary?: string;
  /** Logger — main-side messages. */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** NODE_PATH override so the runner can find isolated-vm. Defaults to
   *  the vendor dir alongside `runnerPath` (where the installer puts a
   *  node_modules with isolated-vm). */
  readonly nodePath?: string;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class SubprocessIsolateRunner {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  private stdoutBuf = '';
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  /** Per-blank capability handlers; populated at load time. */
  private readonly handlers = new Map<string, CapabilityHandler>();
  /** Per-invocation: id → blankName (so cap-* dispatched by id finds its handler). */
  private readonly inflightToBlank = new Map<string, string>();

  private reapTimer: NodeJS.Timeout | null = null;
  private readonly reapMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

  constructor(private readonly opts: SubprocessRunnerOptions) {
    this.reapMs = opts.reapMs ?? DEFAULT_REAP_MS;
    this.log = opts.log ?? ((lvl, m) => console.log(`[user-blank-subprocess] [${lvl}] ${m}`));
  }

  private genId(): string { return 'm' + (this.nextId++); }

  /** Lazy-spawn. Returns once the subprocess emits `ready`. */
  private async ensureSpawned(): Promise<void> {
    if (this.proc && this.readyPromise) {
      await this.readyPromise;
      return;
    }
    if (!fs.existsSync(this.opts.runnerPath)) {
      throw new Error(
        `user-blank runner missing at ${this.opts.runnerPath}. ` +
        `Re-run \`opencues install <host>\` to install the vendor helper.`,
      );
    }
    const node = this.opts.nodeBinary ?? 'node';
    const nodePath = this.opts.nodePath ?? path.join(path.dirname(this.opts.runnerPath), 'node_modules');
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (nodePath) {
      env.NODE_PATH = env.NODE_PATH ? `${nodePath}${path.delimiter}${env.NODE_PATH}` : nodePath;
    }
    const proc = spawn(node, [this.opts.runnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.log('warn', `[runner stderr] ${chunk.trimEnd()}`);
    });
    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE fires when the child died between our `writable` check and
      // the kernel-level write. The `exit` handler will reject pending
      // promises; this listener prevents the error from becoming an
      // uncaught-exception that crashes the host.
      if (err.code !== 'EPIPE') {
        this.log('warn', `runner stdin error: ${err.message}`);
      }
    });
    proc.on('exit', (code, signal) => this.onExit(code, signal));
    proc.on('error', (err) => {
      this.log('error', `runner spawn error: ${err.message}`);
      this.rejectAllPending(err);
      this.proc = null;
    });

    this.readyPromise = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    // 5s timeout on ready — if the subprocess can't even start, fail fast.
    const readyTimeout = setTimeout(() => {
      if (this.readyReject) {
        const e = new Error('runner did not emit ready within 5s');
        this.readyReject(e);
      }
    }, 5000);
    this.readyPromise.finally(() => clearTimeout(readyTimeout));

    await this.readyPromise;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: RunnerOut;
      try { msg = JSON.parse(line) as RunnerOut; }
      catch (e) {
        this.log('warn', `non-JSON from runner: ${line.slice(0, 200)}`);
        continue;
      }
      this.handleRunnerOut(msg);
    }
  }

  private handleRunnerOut(msg: RunnerOut): void {
    switch (msg.op) {
      case 'ready':
        this.log('info', `runner ready (node ${msg.node}, ivm ${msg.ivm})`);
        if (this.readyResolve) { this.readyResolve(); this.readyResolve = null; this.readyReject = null; }
        return;
      case 'log':
        this.log(
          msg.level === 'warn' || msg.level === 'error' ? msg.level : 'info',
          `[runner] ${msg.message}`,
          msg.data,
        );
        return;
      case 'load-result':
      case 'get-result':
      case 'set-result': {
        const p = this.pending.get(msg.id);
        if (!p) {
          this.log('warn', `result for unknown id: ${msg.id}`);
          return;
        }
        this.pending.delete(msg.id);
        this.inflightToBlank.delete(msg.id);
        if (msg.ok) {
          // 'value' present on get-result only; load/set return undefined.
          p.resolve((msg as { value?: unknown }).value);
        } else {
          p.reject(new Error(msg.error));
        }
        this.armReap();
        return;
      }
      case 'cap-fetch':
      case 'cap-storage-get':
      case 'cap-storage-set':
      case 'cap-llm':
      case 'cap-secret':
        this.handleCapRequest(msg);
        return;
      default:
        this.log('warn', `unknown op from runner: ${(msg as { op: string }).op}`);
    }
  }

  private async handleCapRequest(msg: Extract<RunnerOut, { callbackId: string }>): Promise<void> {
    const blankName = this.inflightToBlank.get(msg.id);
    const handler = blankName ? this.handlers.get(blankName) : undefined;
    const reply = (ok: true, value: unknown) => this.write({ op: 'cap-result', callbackId: msg.callbackId, ok, value });
    const fail = (err: Error) => this.write({ op: 'cap-result', callbackId: msg.callbackId, ok: false, error: err.message });

    if (!handler) {
      fail(new Error(`no capability handler for blank "${blankName ?? '<unknown>'}" (request id ${msg.id})`));
      return;
    }

    try {
      switch (msg.op) {
        case 'cap-fetch': {
          if (!handler.fetch) throw new Error('ctx.fetch not enabled for this blank');
          const res = await handler.fetch(msg.url, msg.init);
          // Runner expects the value as JSON-stringified or a structured
          // object. We send the object; runner re-parses.
          reply(true, JSON.stringify(res));
          return;
        }
        case 'cap-storage-get': {
          if (!handler.storageGet) throw new Error('ctx.storage not enabled for this blank');
          const v = await handler.storageGet(msg.key);
          reply(true, v);
          return;
        }
        case 'cap-storage-set': {
          if (!handler.storageSet) throw new Error('ctx.storage not enabled for this blank');
          await handler.storageSet(msg.key, msg.value);
          reply(true, null);
          return;
        }
        case 'cap-llm': {
          if (!handler.llm) throw new Error('ctx.llm not enabled for this blank');
          const out = await handler.llm(msg.req);
          reply(true, out);
          return;
        }
        case 'cap-secret':
          // Secrets are bundled into each get/set call as `msg.secrets`;
          // a per-call cap-secret would be a future extension. For now,
          // refuse — user code reads ctx.secrets directly.
          fail(new Error('cap-secret not supported; use ctx.secrets directly'));
          return;
      }
    } catch (e) {
      fail(e as Error);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.log('info', `runner exited code=${code} signal=${signal}`);
    const err = new Error(`runner process exited (code=${code}, signal=${signal})`);
    this.rejectAllPending(err);
    if (this.readyReject) { this.readyReject(err); this.readyReject = null; this.readyResolve = null; }
    this.proc = null;
    this.readyPromise = null;
    this.handlers.clear();
    this.inflightToBlank.clear();
    if (this.reapTimer) { clearTimeout(this.reapTimer); this.reapTimer = null; }
  }

  private rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      try { p.reject(err); } catch { /* ignore */ }
    }
    this.pending.clear();
  }

  private armReap(): void {
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = setTimeout(() => {
      if (this.pending.size > 0) { this.armReap(); return; }
      this.log('info', `reaping idle runner after ${this.reapMs}ms`);
      this.write({ op: 'shutdown' });
      // Give it 500ms to exit cleanly, then SIGKILL.
      const proc = this.proc;
      if (proc) {
        setTimeout(() => {
          if (this.proc === proc && !proc.killed) {
            try { proc.kill('SIGKILL'); } catch { /* */ }
          }
        }, 500).unref();
      }
    }, this.reapMs);
    this.reapTimer.unref?.();
  }

  private write(msg: RunnerIn): void {
    if (!this.proc || !this.proc.stdin.writable) {
      this.log('warn', `dropping write — runner not available: op=${msg.op}`);
      return;
    }
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      // EPIPE — subprocess died between the writable check and write.
      // The 'exit' handler will reject all pending; just swallow here.
      this.log('warn', `write failed: ${(e as Error).message} (op=${msg.op})`);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Send a request and await the matching `<op>-result` message. */
  private async request<T>(msg: RunnerIn, blankName?: string): Promise<T> {
    await this.ensureSpawned();
    const id = (msg as { id?: string }).id ?? this.genId();
    (msg as { id?: string }).id = id;
    if (blankName) this.inflightToBlank.set(id, blankName);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write(msg);
    });
  }

  async loadBlank(
    blankName: string,
    sourceCode: string,
    modulePath: string,
    handler: CapabilityHandler,
    timeoutMs = 8000,
    memoryLimitMb = 32,
  ): Promise<void> {
    this.handlers.set(blankName, handler);
    await this.request<void>({
      op: 'load',
      id: this.genId(),
      blankName,
      modulePath,
      sourceCode,
      timeoutMs,
      memoryLimitMb,
      capsAvailable: {
        fetch: typeof handler.fetch === 'function',
        llm: typeof handler.llm === 'function',
        storage: typeof handler.storageGet === 'function' && typeof handler.storageSet === 'function',
      },
    });
  }

  async invokeGet(
    blankName: string,
    args: readonly unknown[],
    secrets: Record<string, string> | undefined,
  ): Promise<string> {
    const v = await this.request<string | null>({
      op: 'get', id: this.genId(), blankName, args, secrets: secrets ?? null,
    }, blankName);
    return v == null ? '' : String(v);
  }

  async invokeSet(
    blankName: string,
    args: readonly unknown[],
    secrets: Record<string, string> | undefined,
  ): Promise<void> {
    await this.request<void>({
      op: 'set', id: this.genId(), blankName, args, secrets: secrets ?? null,
    }, blankName);
  }

  /** Forget a blank's capability handler. Called when the blank is
   *  disposed at the registry level. The subprocess isolate persists
   *  (it's keyed by blankName; the next `load` for the same name
   *  replaces it). For full reclaim, call `shutdown()`. */
  disposeBlank(blankName: string): void {
    this.handlers.delete(blankName);
  }

  /** Graceful stop. Idempotent. */
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.write({ op: 'shutdown' });
    const proc = this.proc;
    // Wait up to 1s for exit.
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* */ }
        res();
      }, 1000);
      proc.once('exit', () => { clearTimeout(t); res(); });
    });
    this.proc = null;
    this.readyPromise = null;
  }
}

// ─── Default-runner singleton + loadUserBlank-compatible wrapper ─────────

let _defaultRunner: SubprocessIsolateRunner | null = null;

export function getDefaultRunnerPath(): string {
  const home = os.homedir();
  return path.join(home, '.opencues', 'vendor', 'user-blank-runner.cjs');
}

export function getDefaultSubprocessRunner(opts?: Partial<SubprocessRunnerOptions>): SubprocessIsolateRunner {
  if (_defaultRunner) return _defaultRunner;
  const runnerPath = opts?.runnerPath ?? getDefaultRunnerPath();
  _defaultRunner = new SubprocessIsolateRunner({
    runnerPath,
    reapMs: opts?.reapMs,
    nodeBinary: opts?.nodeBinary,
    log: opts?.log,
    nodePath: opts?.nodePath,
  });
  return _defaultRunner;
}

/** For tests: reset the singleton (and shut down the current one if any). */
export async function resetDefaultSubprocessRunner(): Promise<void> {
  if (_defaultRunner) {
    await _defaultRunner.shutdown();
    _defaultRunner = null;
  }
}

/**
 * Load a user blank through the subprocess runner. Same surface as
 * `loadUserBlank` from node-loader.ts so registry.ts can call either
 * implementation interchangeably — RETURNS SYNCHRONOUSLY just like the
 * in-process loader. The actual `load` op runs on a background promise;
 * the first get/set awaits it, so load errors surface on first invoke
 * (one cycle later than the in-process loader, but the registry already
 * handles get/set failures gracefully).
 *
 * Pre-rewrite (acorn) and capability handler construction happen SYNC
 * before return, so any synchronous error (syntax, ESM violations, bad
 * capabilities declaration) is thrown here exactly like the in-process
 * loader.
 */
export function loadUserBlankSubprocess(
  absJsPath: string,
  blankName: string,
  opts: LoaderOptions & { runner?: SubprocessIsolateRunner },
): LoadedUserBlank {
  const runner = opts.runner ?? getDefaultSubprocessRunner();
  const source = fs.readFileSync(absJsPath, 'utf8');
  const folder = path.dirname(absJsPath);
  const caps = opts.capabilities;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const memoryLimit = opts.memoryLimitMb ?? 32;

  // Pre-rewrite in main, exactly like node-loader.ts. Same error surface
  // so existing tests catch dynamic-import etc. consistently. Throws sync
  // on parse / unsupported-feature.
  const { code: wrapped, warnings } = rewriteEsmToCjsShim(source);
  if (warnings.length > 0) {
    throw new Error(`user-blank rewrite: ${warnings.join('; ')}`);
  }

  // Build the capability handler — mirrors registry.ts buildContextFromCaps
  // but with the host-side checks unchanged. Secret-binding enforcement
  // happens here so the subprocess never sees raw secret values being
  // smuggled.
  const handler = buildCapabilityHandler(caps, opts);

  // Fire `load` in the background. First invoke awaits this; the user
  // blank can't run before the load completes anyway.
  const loadPromise = runner.loadBlank(
    blankName, wrapped, absJsPath, handler, timeoutMs, memoryLimit,
  );
  // Swallow unhandled rejection — every get/set already awaits.
  loadPromise.catch(() => { /* surfaced via per-invoke await below */ });

  // Per-call secrets bundle: only the declared subset reaches the user
  // code. Computed once, sent on every invoke (so host-side rotation
  // is reflected immediately).
  const secretsForInvoke = pickDeclaredSecrets(caps, opts.secrets);

  const moduleProxy: UserBlankModule = {
    get: async (_ctx, args) => {
      await loadPromise;
      const r = await runner.invokeGet(blankName, args ?? [], secretsForInvoke);
      return r;
    },
    set: async (_ctx, value, args) => {
      await loadPromise;
      await runner.invokeSet(blankName, [value, ...(args ?? [])], secretsForInvoke);
    },
  };

  return {
    module: moduleProxy,
    folder,
    capabilities: caps,
    dispose: () => { runner.disposeBlank(blankName); },
  };
}

// ─── Capability handler builder ─────────────────────────────────────────

export function buildCapabilityHandler(
  caps: BlankCapabilities,
  opts: LoaderOptions,
): CapabilityHandler {
  const handler: CapabilityHandler = {};
  const boundSecrets: BoundSecret[] = [];
  if (caps.secrets && opts.secrets) {
    for (const name of caps.secrets) {
      const value = opts.secrets[name];
      if (typeof value !== 'string' || value.length === 0) continue;
      const allowedHosts = caps.secretBindings?.[name] ?? [];
      boundSecrets.push({ name, value, allowedHosts: [...allowedHosts] });
    }
  }

  if (caps.network && caps.network.length > 0) {
    const allowed = new Set(caps.network.map(s => s.toLowerCase()));
    handler.fetch = async (url, init) => {
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
      const res = await (globalThis as { fetch: typeof fetch }).fetch(url, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const text = await res.text();
      return { ok: res.ok, status: res.status, statusText: res.statusText, headers, text };
    };
  }

  if (caps.llm && opts.llm) {
    // Hostname resolution + coerce-then-scan-then-dispatch is shared
    // with registry.ts's in-process buildContextFromCaps — see
    // buildLlmSecretGuard (INFOSEC NF1: the two loaders drifted on this
    // guard once already; don't hand-mirror it a third time).
    handler.llm = buildLlmSecretGuard(caps.llm, boundSecrets, opts.secrets, opts.llm);
  }

  if (caps.storage && opts.storage) {
    const ns = caps.storage;
    const storage = opts.storage;
    handler.storageGet = (key) => storage.get(ns, key);
    handler.storageSet = (key, value) => storage.set(ns, key, value);
  }

  return handler;
}

function pickDeclaredSecrets(
  caps: BlankCapabilities,
  source: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!caps.secrets || caps.secrets.length === 0 || !source) return undefined;
  const out: Record<string, string> = {};
  for (const name of caps.secrets) {
    const v = source[name];
    if (typeof v === 'string' && v.length > 0) out[name] = v;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// Re-export the storage adapter factory so the registry doesn't have to
// know which loader it's using.
export { createFileStorageAdapter } from './node-loader';
export type { StorageAdapter, LlmAdapter } from './node-loader';
