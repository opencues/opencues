// Codex daemon entry point.
//
// Long-running Node process spawned by the opencues-bridge Rust crate
// (which lives inside the codex-rs workspace). Speaks JSON-RPC v2.0
// line-delimited over stdin/stdout.
//
// See integrations/codex/docs/protocol.md for the wire format.
//
// Lifecycle:
//   1. Bridge spawns this process: `node .../codex/v1/daemon.js`
//   2. Bridge sends `{ "method": "boot", "params": {...}, "id": 1 }`
//   3. Daemon constructs CodexAdapter + ConfigLoader, awaits load(),
//      replies `{ "result": {"ok": true} }`
//   4. Bridge streams `text-change` notifications + `key` requests
//   5. Daemon emits `directives` + `set-text` notifications back
//   6. Bridge closes stdin → daemon exits cleanly
//
// Tier 3 progress (see CODEX-CHECKLIST.md):
//   ✓ A. ConfigLoader wired
//   ✓ B. CodexAdapter (FS subset only — UI methods are stubs)
//   ☐ C. Source reclassifier (next)
//   ☐ D-I. Controls registry, Navigation/Cycling/BlankFill/etc.

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { createSourceReclassifier, type SourceReclassifier } from '../../../src/boot-common';
import type { ControlInvokeSpec, HostAdapter, LogLevel, ProcessHandle } from '../../../src/adapter';
import {
  AnswerControl,
  HackerNewsControl,
  OpenCuesSettingsControl,
  PromptImproverControl,
  StocksControl,
  WeatherControl,
  createControlInvoke,
  type Control,
} from '../../../src/controls';
import { CodexAdapter } from './adapter';

export interface CodexHostInfo {
  /** Codex version that spawned us (informational). */
  readonly hostVersion?: string;
  /** Project working directory (passed via `boot` params). */
  readonly cwd: string;
  /** Search paths in priority order. */
  readonly configSearchPaths?: readonly string[];
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: number | string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: { code: number; message: string };
  id: number | string | null;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type Frame = JsonRpcResponse | JsonRpcNotification;

/** Bundle constructed in `boot` and stored for subsequent RPC handlers. */
export interface RuntimeBundle {
  readonly adapter: HostAdapter;
  readonly configLoader: ConfigLoader;
  /** Source reclassifier — the daemon's `text-change` RPC handler
   *  calls `reclassify(text, source)` before fanning to the adapter,
   *  flipping 'user' → 'runtime' when text matches what the runtime
   *  just wrote via `setText` / `pushText`. Avoids feedback loops. */
  readonly reclassifier: SourceReclassifier;
  /** Hoisted controls map — same six classes OC wires (HackerNews,
   *  Stocks, Weather, Answer, PromptImprover, OpenCuesSettings).
   *  Exposed so the upcoming `control-invoke` RPC method (Tier 3.E)
   *  can dispatch directly without going through the adapter. */
  readonly controlsRegistry: Map<string, Control>;
  /** Dispatcher derived from controlsRegistry. Returns null for
   *  unregistered controls (BlankFill / Cycling fall through to
   *  spawnProcess for shell-script controls). */
  readonly controlInvoke: (spec: ControlInvokeSpec) => ProcessHandle | null;
}

export interface DaemonHandle {
  /** Process one inbound JSON-RPC frame (raw line text). Async because
   *  `boot` constructs ConfigLoader and awaits its initial `load()`. */
  handleLine(line: string): Promise<void>;
  /** Whether the daemon has received its `boot` request yet. */
  readonly booted: boolean;
  /** The runtime bundle constructed at boot time. `null` until boot
   *  completes. Exposed for tests + future RPC handlers that need to
   *  reach into ConfigLoader / future modules. */
  readonly runtime: RuntimeBundle | null;
}

export interface CreateDaemonOptions {
  /** How to emit a frame back to the bridge. */
  send: (frame: Frame) => void;
  /** How to log a daemon-side message. Defaults to a `log` notification on `send`. */
  log?: (level: LogLevel, msg: string, data?: unknown) => void;
  /**
   * Test injection: how to build the runtime bundle from boot params.
   * Production omits this and uses the default (CodexAdapter +
   * ConfigLoader). Tests provide a stub that uses MockAdapter so they
   * don't hit the real filesystem.
   */
  buildRuntime?: (params: CodexHostInfo, log: (level: LogLevel, msg: string, data?: unknown) => void) => Promise<RuntimeBundle>;
}

/**
 * Create a testable daemon instance. The state (`booted` flag,
 * runtime bundle) lives in this closure. `startDaemon` below wires
 * one of these up to stdin/stdout; tests build one with mock callbacks.
 */
export function createDaemon(opts: CreateDaemonOptions): DaemonHandle {
  let booted = false;
  let runtime: RuntimeBundle | null = null;

  const log = opts.log ?? ((level, msg, _data) => {
    opts.send({ jsonrpc: '2.0', method: 'log', params: { level, msg } });
  });

  const buildRuntime = opts.buildRuntime ?? defaultBuildRuntime;

  function sendResult(req: JsonRpcRequest, result: unknown): void {
    if (req.id == null) return; // notifications get no response
    opts.send({ jsonrpc: '2.0', result, id: req.id });
  }
  function sendError(req: JsonRpcRequest, code: number, message: string): void {
    if (req.id == null) return;
    opts.send({ jsonrpc: '2.0', error: { code, message }, id: req.id });
  }

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try { req = JSON.parse(line); }
    catch (err) {
      opts.send({
        jsonrpc: '2.0',
        error: { code: -32700, message: `parse error: ${String(err)}` },
        id: null,
      });
      return;
    }

    if (req.jsonrpc !== '2.0') {
      sendError(req, -32600, 'jsonrpc must be "2.0"');
      return;
    }

    switch (req.method) {
      case 'boot': {
        const params = (req.params ?? {}) as Partial<CodexHostInfo>;
        const hostInfo: CodexHostInfo = {
          cwd: params.cwd ?? process.cwd(),
          hostVersion: params.hostVersion,
          configSearchPaths: params.configSearchPaths,
        };
        const paramsRepr = String(JSON.stringify(req.params ?? null)).slice(0, 200);
        try {
          runtime = await buildRuntime(hostInfo, log);
          booted = true;
          sendResult(req, { ok: true });
          log('info', `daemon booted (params=${paramsRepr})`);
        } catch (err) {
          sendError(req, -32001, `boot failed: ${String(err)}`);
          log('error', `boot failed (params=${paramsRepr}): ${String(err)}`);
        }
        break;
      }
      case 'text-change': {
        // TODO Tier 3.F: parse params, call adapter.notifyTextChangeFromBridge.
        // For now: ignored — no runtime modules subscribed yet.
        break;
      }
      case 'key': {
        // TODO Tier 3.F: parse params, call adapter.dispatchKeyFromBridge.
        // For the scaffold, never consume.
        sendResult(req, { consumed: false });
        break;
      }
      case 'force-render': {
        // TODO Tier 3.I: ask adapter for current directives + emit them.
        break;
      }
      case 'control-invoke': {
        // Tier 3.E. Bridge dispatches one of the hoisted controls
        // directly. Returns the underlying ProcessResult, or `null`
        // when the control isn't registered (so the bridge can fall
        // back to native handling).
        if (!runtime) {
          sendError(req, -32000, 'daemon not yet booted');
          break;
        }
        const spec = req.params as ControlInvokeSpec | undefined;
        if (!spec || typeof spec.controlName !== 'string' || typeof spec.action !== 'string') {
          sendError(req, -32602, 'control-invoke requires { controlName, action, args }');
          break;
        }
        const handle = runtime.controlInvoke({
          controlName: spec.controlName,
          action: spec.action,
          args: Array.isArray(spec.args) ? spec.args : [],
        });
        if (!handle) {
          sendResult(req, null);
          break;
        }
        try {
          const result = await handle.result;
          sendResult(req, result);
        } catch (err) {
          // ProcessHandle.result shouldn't reject in practice (the
          // dispatcher catches throws), but guard anyway.
          sendError(req, -32603, `control-invoke failed: ${String(err)}`);
        }
        break;
      }
      default: {
        sendError(req, -32601, `unknown method: ${req.method}`);
      }
    }
  }

  return {
    handleLine,
    get booted() { return booted; },
    get runtime() { return runtime; },
  };
}

/**
 * Default runtime construction: real CodexAdapter + real ConfigLoader.
 * Production path. Tests inject a different `buildRuntime` to avoid
 * hitting the real filesystem.
 */
/**
 * Resolve the path to opencues.md for the OpenCuesSettingsControl.
 * Mirrors `findOpenCuesMdPath` in
 * `integrations/opencode/patches/opencuesBootstrap.ts:88-94` exactly:
 * - $OPENCUES_HOME wins if set (CI / container deploys / tests)
 * - else ~/.opencues/opencues.md (user-level only — see CLAUDE.md
 *   "Config search paths — who reads what" for the rationale)
 */
function findOpenCuesMdPath(): string {
  if (process.env.OPENCUES_HOME) {
    return path.join(process.env.OPENCUES_HOME, 'opencues.md');
  }
  return path.join(process.env.HOME ?? '~', '.opencues', 'opencues.md');
}

/**
 * Build the same six-control registry OC wires. Mirrors
 * `integrations/opencode/patches/opencuesBootstrap.ts:116-127` —
 * if you change the wiring there, change it here too.
 */
function buildControlsRegistry(): Map<string, Control> {
  return new Map<string, Control>([
    ['hackernews', new HackerNewsControl()],
    ['stocks', new StocksControl({ apiKey: process.env.FINNHUB_API_KEY })],
    ['weather', new WeatherControl()],
    ['answer', new AnswerControl({ apiKey: process.env.GROQ_API_KEY })],
    ['prompt', new PromptImproverControl({ apiKey: process.env.GROQ_API_KEY })],
    ['opencues', new OpenCuesSettingsControl({
      readFile: async () => {
        try { return await fsp.readFile(findOpenCuesMdPath(), 'utf8'); }
        catch { return null; }
      },
      writeFile: async (content) => {
        await fsp.writeFile(findOpenCuesMdPath(), content, 'utf8');
      },
    })],
  ]);
}

async function defaultBuildRuntime(
  params: CodexHostInfo,
  log: (level: LogLevel, msg: string, data?: unknown) => void,
): Promise<RuntimeBundle> {
  const reclassifier = createSourceReclassifier();
  const controlsRegistry = buildControlsRegistry();
  const controlInvoke = createControlInvoke(controlsRegistry);
  const adapter = new CodexAdapter({
    cwd: params.cwd,
    hostVersion: params.hostVersion,
    log,
    reclassifier,
    controlInvoke,
  });
  const configLoader = new ConfigLoader(adapter, {
    configSearchPaths: params.configSearchPaths,
  });
  configLoader.subscribe();
  await configLoader.load();
  return { adapter, configLoader, reclassifier, controlsRegistry, controlInvoke };
}

/**
 * Start the daemon. Called from a one-line wrapper script the install
 * pipeline drops at a known path. Blocks until stdin closes.
 */
export function startDaemon(): void {
  const rl = readline.createInterface({ input: process.stdin });
  const stdoutSend = (frame: Frame): void => {
    process.stdout.write(JSON.stringify(frame) + '\n');
  };
  const fileLog = (level: LogLevel, msg: string, _data?: unknown): void => {
    // Daemon-side log notification. Bridge can route it (e.g. write to /tmp/opencues.log).
    stdoutSend({ jsonrpc: '2.0', method: 'log', params: { level, msg } });
    // Also write directly so logs survive even if the bridge drops them.
    try {
      fs.appendFileSync('/tmp/opencues.log',
        `[${new Date().toISOString().slice(11, 23)}][codex-daemon][${level}] ${msg}\n`);
    } catch { /* ignore */ }
  };

  const daemon = createDaemon({ send: stdoutSend, log: fileLog });

  // Serialize inbound RPC handling. Two reasons:
  // (1) FIFO ordering — the bridge expects responses in request order
  //     (a control-invoke that arrives after boot must wait for boot
  //     to finish before being processed, not race ahead because the
  //     boot handler is doing async work).
  // (2) Drain on shutdown — the chain promise tracks all in-flight
  //     work so a single-line stdin pipe doesn't exit mid-boot.
  let pending: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    pending = pending
      .then(() => daemon.handleLine(line))
      .catch((err) => fileLog('error', `handleLine threw: ${String(err)}`));
  });
  rl.on('close', () => {
    void pending.finally(() => {
      fileLog('info', 'daemon shutting down (stdin closed)');
      process.exit(0);
    });
  });

  fileLog('info', `daemon started; pid=${process.pid}`);
}

// CLI entry — run this file directly as `node daemon.js`.
if (require.main === module) {
  startDaemon();
}
