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
//   3. Daemon initialises ConfigLoader, replies `{ "result": {"ok": true} }`
//   4. Bridge streams `text-change` notifications + `key` requests
//   5. Daemon emits `directives` + `set-text` notifications back
//   6. Bridge closes stdin → daemon exits cleanly
//
// This is the SCAFFOLDING for that loop. The actual integration of
// runtime modules (Navigation, Cycling, BlankFill, DimRender) into the
// JSON-RPC handlers is TODO — marked inline. See HANDOFF.md.

import * as readline from 'node:readline';
import * as fs from 'node:fs';

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

type Frame = JsonRpcResponse | JsonRpcNotification;

/**
 * Start the daemon. Called from a one-line wrapper script the install
 * pipeline drops at a known path. Blocks until stdin closes.
 */
export function startDaemon(): void {
  const rl = readline.createInterface({ input: process.stdin });
  let booted = false;
  // TODO: real runtime state. For now, just hand-shake correctly so the
  // bridge crate's smoke test passes.
  // const adapter = new CodexAdapter(...);
  // const configLoader = new ConfigLoader(adapter, ...);
  // const navigation = new Navigation(adapter, ...);
  // const cycling = new Cycling(adapter, ...);
  // ...

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try { req = JSON.parse(line); }
    catch (err) {
      send({ jsonrpc: '2.0', error: { code: -32700, message: `parse error: ${err}` }, id: null });
      return;
    }

    if (req.jsonrpc !== '2.0') {
      sendError(req, -32600, 'jsonrpc must be "2.0"');
      return;
    }

    switch (req.method) {
      case 'boot': {
        // TODO: actually wire ConfigLoader + modules with the params.
        booted = true;
        sendResult(req, { ok: true });
        log('info', `daemon booted (params=${JSON.stringify(req.params).slice(0, 200)})`);
        break;
      }
      case 'text-change': {
        // TODO: forward to runtime onTextChange.
        // const { text, cursorOffset, source } = req.params as { text: string; cursorOffset: number; source: string };
        // adapter.notifyTextChange(text, cursorOffset, source);
        break;
      }
      case 'key': {
        // TODO: forward to runtime dispatchKey, return { consumed: bool }.
        // For the scaffold, never consume.
        sendResult(req, { consumed: false });
        break;
      }
      case 'force-render': {
        // TODO: ask runtime for current directives + emit `directives` notification.
        break;
      }
      default: {
        sendError(req, -32601, `unknown method: ${req.method}`);
      }
    }
  });

  rl.on('close', () => {
    log('info', 'daemon shutting down (stdin closed)');
    process.exit(0);
  });

  log('info', `daemon started; pid=${process.pid}`);
}

function send(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + '\n');
}
function sendResult(req: JsonRpcRequest, result: unknown): void {
  if (req.id == null) return; // notifications get no response
  send({ jsonrpc: '2.0', result, id: req.id });
}
function sendError(req: JsonRpcRequest, code: number, message: string): void {
  if (req.id == null) return;
  send({ jsonrpc: '2.0', error: { code, message }, id: req.id });
}
function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
  // Daemon-side log notification. Bridge can route it (e.g. write to /tmp/opencues.log).
  send({ jsonrpc: '2.0', method: 'log', params: { level, msg } });
  // Also write directly so logs survive even if the bridge drops them.
  try {
    fs.appendFileSync('/tmp/opencues.log',
      `[${new Date().toISOString().slice(11, 23)}][codex-daemon][${level}] ${msg}\n`);
  } catch { /* ignore */ }
}

// CLI entry — run this file directly as `node daemon.js`.
if (require.main === module) {
  startDaemon();
}
