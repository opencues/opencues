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
import { ConfigLoader } from '../../../src/modules/config-loader';
import type { HostAdapter, LogLevel } from '../../../src/adapter';
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
async function defaultBuildRuntime(
  params: CodexHostInfo,
  log: (level: LogLevel, msg: string, data?: unknown) => void,
): Promise<RuntimeBundle> {
  const adapter = new CodexAdapter({
    cwd: params.cwd,
    hostVersion: params.hostVersion,
    log,
  });
  const configLoader = new ConfigLoader(adapter, {
    configSearchPaths: params.configSearchPaths,
  });
  configLoader.subscribe();
  await configLoader.load();
  return { adapter, configLoader };
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

  // Track in-flight handleLine promises so we don't exit mid-boot when
  // stdin closes. (Single-line stdin pipe → rl 'close' fires before
  // an async boot handler resolves.)
  const inflight = new Set<Promise<void>>();
  rl.on('line', (line) => {
    const p = daemon.handleLine(line)
      .catch((err) => fileLog('error', `handleLine threw: ${String(err)}`))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  });
  rl.on('close', () => {
    void Promise.allSettled(inflight).then(() => {
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
