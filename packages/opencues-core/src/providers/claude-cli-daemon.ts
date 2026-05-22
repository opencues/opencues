/**
 * ClaudeCliDaemon — persistent `claude -p` subprocess used as a
 * subscription-backed Anthropic transport.
 *
 * Why a daemon (vs per-call subprocess): each `claude -p` invocation
 * pays ~900ms of Node + Claude Code startup. A long-lived process
 * pays that ONCE; subsequent turns reuse the loaded runtime and the
 * Anthropic prompt cache. Benchmark — `tests/benchmarks/thinking-
 * budget/claude-cli-daemon-tuned.ts` — measured per-model p50 latency:
 *
 *   Haiku   840ms / p95 874ms   (env: DISABLE_THINKING=1 + MAX_THINKING_TOKENS=0,
 *                                no --effort flag)
 *   Sonnet  1338ms / p95 1445ms (env: DISABLE_THINKING=1, --effort low)
 *   Opus    1982ms / p95 2900ms (env: DISABLE_THINKING=1 + MAX_THINKING_TOKENS=0,
 *                                no --effort flag, but thinking helps Opus
 *                                slightly — kept env vars for jitter reduction)
 *
 * Per-model flag tables baked in below (`MODEL_FLAGS`). Users only
 * pick a model; the daemon picks the optimal flags. See
 * `docs/architecture/claude-cli-provider.md` for the full bench
 * methodology + ToS context (OAuth-token extraction is explicitly
 * forbidden by Anthropic — `claude -p` is the only sanctioned path).
 *
 * Lifecycle:
 *
 *   - Lazy spawn: process starts on first `invoke()` call.
 *   - Request queue: claude-cli processes turns sequentially, so
 *     parallel `invoke()` calls serialise via an internal queue.
 *   - Idle reap: after `idleReapMs` (default 5min — matches Anthropic
 *     prompt-cache TTL) with no requests, the subprocess is killed.
 *     Next `invoke()` lazily respawns.
 *   - Crash restart: if the subprocess exits unexpectedly mid-queue,
 *     pending requests reject with a clear error and the next
 *     `invoke()` spawns fresh.
 *
 * Testability: `spawn` is injectable via the constructor so tests can
 * use a fake child process. Default uses `child_process.spawn`. See
 * `claude-cli-daemon.test.ts`.
 */

import type { ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { spawn as nodeSpawn } from 'child_process';

/** Logical model name the daemon understands. Maps to a `claude --model` argument. */
export type ClaudeCliModel = 'haiku' | 'sonnet' | 'opus';

/** Per-model launch flags + environment overrides, derived from the
 *  bench at tests/benchmarks/thinking-budget/. Each entry is the
 *  optimal configuration for THAT specific model — keep them in sync
 *  with the bench results when re-tuning. */
interface ModelFlagConfig {
  /** Extra CLI args appended after the baseline. */
  extraArgs: string[];
  /** Env vars added to the subprocess environment. */
  env: Record<string, string>;
}

const MODEL_FLAGS: Record<ClaudeCliModel, ModelFlagConfig> = {
  haiku: {
    extraArgs: [], // no --effort (Haiku ignores it; adding it slows things down)
    env: { CLAUDE_CODE_DISABLE_THINKING: '1', MAX_THINKING_TOKENS: '0' },
  },
  sonnet: {
    extraArgs: ['--effort', 'low'], // Sonnet honors --effort meaningfully
    env: { CLAUDE_CODE_DISABLE_THINKING: '1' /* NOT MAX_THINKING_TOKENS — interferes on Sonnet */ },
  },
  opus: {
    extraArgs: [], // Opus is best without --effort (thinking helps but flag interferes)
    env: { CLAUDE_CODE_DISABLE_THINKING: '1', MAX_THINKING_TOKENS: '0' },
  },
};

/** Baseline flags shared by every model — extracted from the bench's
 *  best-overall configuration. */
const BASELINE_ARGS = [
  '--bare',
  '-p',
  '--no-session-persistence',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose', // REQUIRED when --output-format=stream-json; CLI errors without it
  '--exclude-dynamic-system-prompt-sections',
  '--disable-slash-commands',
];

/** Minimal subprocess shape the daemon needs. Lets us inject a fake
 *  for tests without pulling in all of child_process types. */
export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'close' | 'error' | 'exit', listener: (...args: unknown[]) => void): this;
}

/** Injectable spawn — defaults to child_process.spawn. Tests pass a
 *  factory that returns a fake stream pair. */
export type SpawnFn = (
  command: string,
  args: string[],
  env: Record<string, string>,
) => SpawnedProcess;

const defaultSpawn: SpawnFn = (command, args, env) => {
  // Use child_process.spawn with merged env (caller-provided + process.env).
  // stdio: piped so we own stdin/stdout/stderr.
  return nodeSpawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  }) as unknown as SpawnedProcess;
};

export interface ClaudeCliDaemonOptions {
  /** Model alias passed to `claude --model`. */
  model: ClaudeCliModel;
  /** System prompt appended via `--append-system-prompt`. Defines the
   *  cache prefix for this daemon — different prompts get different
   *  daemons (managed by the pool). Required (empty string allowed). */
  systemPrompt: string;
  /** Path to the `claude` binary. Defaults to 'claude' (resolved via $PATH). */
  claudeBin?: string;
  /** Idle reap timeout in ms. Defaults to 5 minutes (300_000) to match
   *  Anthropic's ephemeral prompt cache TTL — past that the cache is
   *  cold anyway, so keeping the subprocess alive is wasted memory. */
  idleReapMs?: number;
  /** Subprocess spawn function — defaults to child_process.spawn.
   *  Tests inject a fake. */
  spawn?: SpawnFn;
  /** Optional logger; defaults to silent. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

interface PendingRequest {
  prompt: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/** Single subprocess daemon. */
export class ClaudeCliDaemon {
  private readonly model: ClaudeCliModel;
  private readonly systemPrompt: string;
  private readonly claudeBin: string;
  private readonly idleReapMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

  private proc: SpawnedProcess | null = null;
  private queue: PendingRequest[] = [];
  private inFlight: PendingRequest | null = null;
  private stdoutBuf = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(opts: ClaudeCliDaemonOptions) {
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
    this.claudeBin = opts.claudeBin ?? 'claude';
    this.idleReapMs = opts.idleReapMs ?? 5 * 60 * 1000;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.log = opts.log ?? (() => { /* silent */ });
  }

  /** Submit a user prompt; resolves with the assistant text from one
   *  turn (one `result` event in the stream-json output). */
  invoke(userPrompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.shuttingDown) { reject(new Error('daemon is shutting down')); return; }
      this.queue.push({ prompt: userPrompt, resolve, reject });
      this.armIdleTimer();
      this.pump();
    });
  }

  /** Explicitly kill the subprocess. Pending requests reject. After
   *  shutdown, future `invoke()` calls also reject — construct a new
   *  daemon if you need to restart. (For pool-managed restart, drop
   *  the daemon and `get()` a new one.) */
  shutdown(): void {
    this.shuttingDown = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.proc) { try { this.proc.kill('SIGTERM'); } catch { /* already dead */ } }
    const drainError = new Error('daemon shut down with pending requests');
    if (this.inFlight) { this.inFlight.reject(drainError); this.inFlight = null; }
    for (const r of this.queue) r.reject(drainError);
    this.queue.length = 0;
  }

  /** True if the subprocess is currently alive (post-spawn, pre-exit). */
  get isAlive(): boolean { return this.proc !== null; }

  // ─── Internals ──────────────────────────────────────────────────────

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.reapIdle(), this.idleReapMs);
    // Don't keep the Node event loop alive just for the reap timer —
    // if the host process is exiting, we don't need to fire.
    if (typeof (this.idleTimer as { unref?: () => void }).unref === 'function') {
      (this.idleTimer as { unref: () => void }).unref();
    }
  }

  private reapIdle(): void {
    if (this.queue.length > 0 || this.inFlight) {
      // Still busy — re-arm and check later.
      this.armIdleTimer();
      return;
    }
    if (this.proc) {
      this.log('debug', `ClaudeCliDaemon[${this.model}]: idle reap (${this.idleReapMs}ms elapsed)`);
      try { this.proc.kill('SIGTERM'); } catch { /* already dead */ }
      this.proc = null;
    }
    this.idleTimer = null;
  }

  private buildArgs(): string[] {
    const flags = MODEL_FLAGS[this.model];
    return [
      ...BASELINE_ARGS,
      '--model', this.model,
      ...flags.extraArgs,
      '--append-system-prompt', this.systemPrompt,
    ];
  }

  private buildEnv(): Record<string, string> {
    return { ...MODEL_FLAGS[this.model].env };
  }

  private ensureSpawned(): void {
    if (this.proc) return;
    const args = this.buildArgs();
    const env = this.buildEnv();
    this.log('debug', `ClaudeCliDaemon[${this.model}]: spawning ${this.claudeBin} (${args.length} args)`);
    let child: SpawnedProcess;
    try {
      child = this.spawnFn(this.claudeBin, args, env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failAllPending(new Error(`failed to spawn ${this.claudeBin}: ${msg}`));
      return;
    }
    this.proc = child;
    this.stdoutBuf = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.drainStdoutBuf();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.log('debug', `ClaudeCliDaemon[${this.model}] stderr: ${s.slice(0, 200).trim()}`);
    });
    child.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log('error', `ClaudeCliDaemon[${this.model}]: subprocess error ${msg}`);
      this.proc = null;
      this.failAllPending(new Error(`subprocess error: ${msg}`));
    });
    child.on('exit', (code: unknown) => {
      this.log('debug', `ClaudeCliDaemon[${this.model}]: subprocess exited (code=${code})`);
      this.proc = null;
      this.failAllPending(new Error(`subprocess exited (code=${code}) with pending request`));
    });
  }

  /** Process the queue: if nothing in-flight, take the next, spawn if
   *  needed, write the prompt to stdin. */
  private pump(): void {
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.ensureSpawned();
    if (!this.proc) {
      // Spawn failed — failAllPending already rejected this request.
      return;
    }
    this.inFlight = next;
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: next.prompt } }) + '\n';
    try {
      this.proc.stdin.write(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      next.reject(new Error(`stdin write failed: ${msg}`));
      this.inFlight = null;
      this.pump();
    }
  }

  /** Parse line-delimited JSON from stdout. The `result` event of type
   *  `success` ends a turn — resolve the in-flight request with its
   *  text. */
  private drainStdoutBuf(): void {
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let j: { type?: string; subtype?: string; result?: string; is_error?: boolean };
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type !== 'result') continue;
      const current = this.inFlight;
      if (!current) {
        // Stray result event with no in-flight — log and drop. Shouldn't
        // happen with one-at-a-time pumping.
        this.log('warn', `ClaudeCliDaemon[${this.model}]: stray result event (no in-flight request)`);
        continue;
      }
      this.inFlight = null;
      if (j.subtype === 'success' && typeof j.result === 'string' && !j.is_error) {
        current.resolve(j.result);
      } else {
        current.reject(new Error(`claude -p returned non-success result (subtype=${j.subtype})`));
      }
      // Continue pumping — there may be more queued.
      this.pump();
    }
  }

  private failAllPending(err: Error): void {
    if (this.inFlight) { this.inFlight.reject(err); this.inFlight = null; }
    const drainQueue = this.queue.splice(0);
    for (const r of drainQueue) r.reject(err);
  }
}

// ─── Pool ───────────────────────────────────────────────────────────────
// One daemon per (model, systemPromptHash) — different system prompts
// can't share a process because --append-system-prompt is launch-time.

export interface ClaudeCliDaemonPoolOptions {
  claudeBin?: string;
  idleReapMs?: number;
  spawn?: SpawnFn;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

/** Cheap stable hash for cache keying — not cryptographic. */
function shortHash(s: string): string {
  // 32-bit FNV-1a; collisions don't matter (worst case we share a
  // daemon between two prompts that happen to hash the same — they
  // wouldn't anyway since one is a launch-time setting).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class ClaudeCliDaemonPool {
  private readonly daemons = new Map<string, ClaudeCliDaemon>();
  private readonly opts: ClaudeCliDaemonPoolOptions;

  constructor(opts: ClaudeCliDaemonPoolOptions = {}) { this.opts = opts; }

  /** Get-or-create the daemon for a (model, systemPrompt) pair. */
  get(model: ClaudeCliModel, systemPrompt: string): ClaudeCliDaemon {
    const key = `${model}:${shortHash(systemPrompt)}`;
    let d = this.daemons.get(key);
    if (!d) {
      d = new ClaudeCliDaemon({
        model,
        systemPrompt,
        claudeBin: this.opts.claudeBin,
        idleReapMs: this.opts.idleReapMs,
        spawn: this.opts.spawn,
        log: this.opts.log,
      });
      this.daemons.set(key, d);
    }
    return d;
  }

  /** Shut down every daemon in the pool. */
  shutdownAll(): void {
    for (const d of this.daemons.values()) d.shutdown();
    this.daemons.clear();
  }

  /** Test helper — current pool size. */
  get size(): number { return this.daemons.size; }
}

// ─── Module-level singleton ────────────────────────────────────────────
// The CLAUDE_CLI provider adapter (in llm-provider.ts) calls into this
// singleton — sources don't manage daemons themselves. Tests that need
// isolated daemons construct their own pool.

let _globalPool: ClaudeCliDaemonPool | null = null;
export function getGlobalClaudeCliPool(): ClaudeCliDaemonPool {
  if (!_globalPool) _globalPool = new ClaudeCliDaemonPool();
  return _globalPool;
}
/** Test-only: replace the global pool. */
export function _setGlobalClaudeCliPoolForTests(pool: ClaudeCliDaemonPool | null): void {
  _globalPool = pool;
}
