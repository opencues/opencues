/**
 * Background service worker.
 *
 * Two responsibilities:
 *
 * 1. **Cross-origin fetch proxy** for LLM API calls. Content scripts
 *    pay a CORS preflight (`OPTIONS` round-trip, ~100-300ms RTT) on
 *    every cross-origin POST with `Authorization: Bearer ...`. The
 *    service worker doesn't — extensions can fetch any host listed in
 *    manifest's `host_permissions` without CORS or preflight. Routing
 *    LLM POSTs through a `chrome.runtime.sendMessage` proxy here saves
 *    one preflight per call (3-4 per transform-blank pipeline). The
 *    one-IPC-hop overhead is ~5ms, much less than the preflight it
 *    replaces. The service worker's own connection pool also reuses
 *    TCP+TLS across consecutive calls (keep-alive equivalent),
 *    eliminating the per-call TLS-handshake cost on calls 2+ in the
 *    pipeline.
 *
 * 2. **Preconnect** to LLM origins on first request to warm the TCP +
 *    TLS connection. The first call still pays handshake; preconnect
 *    moves that cost off the critical path so the first user-visible
 *    LLM call doesn't see it.
 */

interface FetchRequest {
  type: 'opencues:fetch';
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

const preconnected = new Set<string>();

function preconnectOrigin(originUrl: string): void {
  let origin: string;
  try { origin = new URL(originUrl).origin; }
  catch { return; }
  if (preconnected.has(origin)) return;
  preconnected.add(origin);
  // Fire-and-forget HEAD request — warms the TCP socket + TLS
  // session. Errors don't matter; this is purely a perf hint.
  fetch(origin, { method: 'HEAD', credentials: 'omit' }).catch(() => {
    // 404/405/etc. are fine — the connection is already established.
  });
}

chrome.runtime.onMessage.addListener((message: FetchRequest, _sender, sendResponse) => {
  if (message?.type !== 'opencues:fetch') return false;

  preconnectOrigin(message.url);

  (async (): Promise<FetchResponse> => {
    try {
      const response = await fetch(message.url, {
        method: message.method,
        headers: message.headers,
        body: message.body,
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        statusText: err instanceof Error ? err.message : String(err),
        text: '',
      };
    }
  })().then(sendResponse);

  // Returning true keeps the message channel open for the async
  // sendResponse call above.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('OpenCues extension installed');
});

// ─── Native-messaging bridge ────────────────────────────────────────────
//
// Connect to the local host process (installed via `opencues install
// chrome-host`). The host watches ~/.cues/ and pushes a fresh bundle on
// every filesystem change. We persist the bundle to chrome.storage.local
// under a single key — content scripts read it via the resolution chain
// in opencues-bootstrap.ts.
//
// If the host isn't installed, connectNative will fail synchronously or
// the port will disconnect immediately. We log + retry on a slow timer
// so users who install the host later get picked up without restarting
// the browser. Bake-time defaults cover the no-host case.

const NATIVE_HOST = 'com.opencues.sync';
const BUNDLE_KEY = 'opencues_bundle';
const HOST_KEYS_STORAGE = 'opencues_host_keys';
const RECONNECT_MS = 30_000;
const EXEC_TIMEOUT_FALLBACK_MS = 15_000;

interface BundleMessage {
  type: 'bundle';
  root: string;
  files: Record<string, string>;
  reason?: string;
}
interface HostConfigMessage {
  type: 'config';
  apiKeys: Record<string, string>;
}
interface ExecResultMessage {
  type: 'exec-result';
  requestId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
interface ExecRequestFromContent {
  type: 'opencues:exec';
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  /** OS-level sandbox config from the runtime (when the blank's
   *  frontmatter declared `sandbox: strict`). The host applies bwrap
   *  if available; otherwise runs unwrapped. */
  sandbox?: {
    mode?: 'strict' | 'off';
    net?: 'allow' | 'deny';
    fs?: 'ro' | 'rw';
    workdir?: string;
  };
}

interface UserBlankInvokeRequestFromContent {
  type: 'opencues:user-blank-invoke';
  name: string;
  method: 'get' | 'set';
  args: string[];
}
interface UserBlankResultMessage {
  type: 'user-blank-result';
  requestId: string;
  ok: boolean;
  output?: string;
  error?: string;
}
interface WriteFileRequestFromContent {
  type: 'opencues:write-file';
  path: string;
  content: string;
}
interface WriteFileResultMessage {
  type: 'write-file-result';
  requestId: string;
  ok: boolean;
  error?: string;
}

let nativePort: chrome.runtime.Port | null = null;
let nextRequestId = 1;
type ExecPending = (msg: ExecResultMessage) => void;
type UserBlankPending = (msg: UserBlankResultMessage) => void;
type WriteFilePending = (msg: WriteFileResultMessage) => void;
const pending: Map<string, ExecPending> = new Map();
const pendingUserBlank: Map<string, UserBlankPending> = new Map();
const pendingWriteFile: Map<string, WriteFilePending> = new Map();

function failPending(reason: string): void {
  for (const [id, resolve] of pending) {
    resolve({ type: 'exec-result', requestId: id, exitCode: 127, stdout: '', stderr: reason, timedOut: false });
  }
  pending.clear();
  for (const [id, resolve] of pendingUserBlank) {
    resolve({ type: 'user-blank-result', requestId: id, ok: false, error: reason });
  }
  pendingUserBlank.clear();
  for (const [id, resolve] of pendingWriteFile) {
    resolve({ type: 'write-file-result', requestId: id, ok: false, error: reason });
  }
  pendingWriteFile.clear();
}

function connectNativeHost(): void {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (err) {
    console.warn('[opencues] native host connect threw — host not installed?', err);
    scheduleReconnect();
    return;
  }
  console.log('[opencues] native host port opened');

  nativePort.onMessage.addListener((raw: unknown) => {
    const msg = raw as BundleMessage | ExecResultMessage | HostConfigMessage;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'bundle' && typeof msg.files === 'object') {
      const fileCount = Object.keys(msg.files).length;
      chrome.storage.local.set({ [BUNDLE_KEY]: { files: msg.files, root: msg.root } })
        .then(() => console.log(`[opencues] bundle stored (${fileCount} files, reason=${msg.reason ?? 'unknown'})`))
        .catch((err) => console.warn('[opencues] bundle storage write failed', err));
      return;
    }
    if (msg.type === 'config' && msg.apiKeys && typeof msg.apiKeys === 'object') {
      // API keys from the host's process.env. Replaces the old
      // bake-time inlining of GROQ_API_KEY / FINNHUB_API_KEY. The
      // chrome-storage-adapter layers these between the empty
      // bake-time defaults and any popup-set user overrides.
      const keyNames = Object.keys(msg.apiKeys);
      chrome.storage.local.set({ [HOST_KEYS_STORAGE]: msg.apiKeys })
        .then(() => console.log(`[opencues] host API keys received (${keyNames.length} keys: ${keyNames.join(', ')})`))
        .catch((err) => console.warn('[opencues] host-keys storage write failed', err));
      return;
    }
    if (msg.type === 'exec-result' && typeof msg.requestId === 'string') {
      const resolve = pending.get(msg.requestId);
      if (resolve) {
        pending.delete(msg.requestId);
        resolve(msg);
      }
      return;
    }
    const ubr = raw as UserBlankResultMessage;
    if (ubr.type === 'user-blank-result' && typeof ubr.requestId === 'string') {
      const resolve = pendingUserBlank.get(ubr.requestId);
      if (resolve) {
        pendingUserBlank.delete(ubr.requestId);
        resolve(ubr);
      }
      return;
    }
    const wfr = raw as WriteFileResultMessage;
    if (wfr.type === 'write-file-result' && typeof wfr.requestId === 'string') {
      const resolve = pendingWriteFile.get(wfr.requestId);
      if (resolve) {
        pendingWriteFile.delete(wfr.requestId);
        resolve(wfr);
      }
      return;
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('[opencues] native host disconnected', err?.message);
    nativePort = null;
    failPending('native host disconnected');
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  setTimeout(() => { if (!nativePort) connectNativeHost(); }, RECONNECT_MS);
}

// Content scripts ask the SW to run a subprocess via the native host.
// We assign a requestId, forward the spec, await the matching
// exec-result. Returns ProcessResult-shape JSON via sendResponse.
chrome.runtime.onMessage.addListener((message: ExecRequestFromContent, _sender, sendResponse) => {
  if (message?.type !== 'opencues:exec') return false;
  if (!nativePort) {
    sendResponse({ exitCode: 127, stdout: '', stderr: 'native host not connected', timedOut: false });
    return true;
  }
  const requestId = String(nextRequestId++);
  const timeoutMs = typeof message.timeoutMs === 'number' ? message.timeoutMs : EXEC_TIMEOUT_FALLBACK_MS;
  pending.set(requestId, (result) => {
    sendResponse({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });
  });
  // Per-request safety net — if the host never replies, free the slot.
  // The host enforces its own timeout too; this is one tier above that.
  setTimeout(() => {
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    resolve({ type: 'exec-result', requestId, exitCode: 124, stdout: '', stderr: 'SW-side timeout', timedOut: true });
  }, timeoutMs + 5_000);
  try {
    nativePort.postMessage({
      type: 'exec',
      requestId,
      command: message.command,
      args: message.args,
      env: message.env,
      timeoutMs,
      sandbox: message.sandbox,
    });
  } catch (err) {
    pending.delete(requestId);
    sendResponse({ exitCode: 127, stdout: '', stderr: 'postMessage failed: ' + String(err), timedOut: false });
  }
  return true;
});

// Content scripts ask the SW to invoke a user-blank via the native host.
// Same shape as the exec relay: assign requestId, forward to host,
// match the user-blank-result reply, return { ok, output, error }.
// Replaces the in-page Web Worker — see user-blank-loader.ts.
chrome.runtime.onMessage.addListener((message: UserBlankInvokeRequestFromContent, _sender, sendResponse) => {
  if (message?.type !== 'opencues:user-blank-invoke') return false;
  if (!nativePort) {
    sendResponse({ ok: false, error: 'native host not connected — install via `opencues install chrome-host`' });
    return true;
  }
  const requestId = String(nextRequestId++);
  pendingUserBlank.set(requestId, (result) => {
    sendResponse({
      ok: result.ok,
      output: result.output ?? '',
      error: result.error,
    });
  });
  // 15s safety net — the host's per-blank timeout defaults to 8s in
  // the runtime loader. One tier above; the host's own timer should
  // always fire first under normal conditions.
  setTimeout(() => {
    const resolve = pendingUserBlank.get(requestId);
    if (!resolve) return;
    pendingUserBlank.delete(requestId);
    resolve({ type: 'user-blank-result', requestId, ok: false, error: 'SW-side timeout' });
  }, 15_000);
  try {
    nativePort.postMessage({
      type: 'user-blank-invoke',
      requestId,
      name: message.name,
      method: message.method,
      args: message.args,
    });
  } catch (err) {
    pendingUserBlank.delete(requestId);
    sendResponse({ ok: false, error: 'postMessage failed: ' + String(err) });
  }
  return true;
});

// Forward content-script log lines to the native host so they land
// in /tmp/opencues.log alongside CC/OC/gemini. Fire-and-forget — log
// must never block the runtime keystroke path. Silently drops when
// the host isn't connected.
// Popup queries the SW to find out whether the native-messaging
// host is currently connected. Drives the "use ~/.cues/ config
// (chrome-host)" toggle's visibility — we only show the toggle when
// there's actually a host pushing config; otherwise it'd be a footgun
// (defer to a nonexistent source = empty config).
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type !== 'opencues:host-status') return false;
  sendResponse({ connected: nativePort !== null });
  return true;
});

chrome.runtime.onMessage.addListener((message: { type?: string; level?: string; msg?: string; data?: unknown }, _sender, sendResponse) => {
  if (message?.type !== 'opencues:log') return false;
  if (nativePort) {
    try {
      nativePort.postMessage({
        type: 'log',
        level: message.level ?? 'info',
        msg: message.msg ?? '',
        data: message.data,
      });
    } catch { /* port disconnected mid-write; drop */ }
  }
  sendResponse({ ok: true });
  return true;
});

// Content scripts ask the SW to write a file (currently only OPENCUES.md)
// via the native host. When the host isn't connected, the response
// shape signals that so the caller can fall back to chrome.storage —
// the bundle isn't the source of truth when there's no host pushing.
// Storage stays a valid fallback for cycling that happens before host
// install; the first bundle push after host install converges the two.
chrome.runtime.onMessage.addListener((message: WriteFileRequestFromContent, _sender, sendResponse) => {
  if (message?.type !== 'opencues:write-file') return false;
  if (!nativePort) {
    sendResponse({ ok: false, error: 'native host not connected' });
    return true;
  }
  const requestId = String(nextRequestId++);
  pendingWriteFile.set(requestId, (result) => {
    sendResponse({ ok: result.ok, error: result.error });
  });
  setTimeout(() => {
    const resolve = pendingWriteFile.get(requestId);
    if (!resolve) return;
    pendingWriteFile.delete(requestId);
    resolve({ type: 'write-file-result', requestId, ok: false, error: 'SW-side timeout' });
  }, 10_000);
  try {
    nativePort.postMessage({
      type: 'write-file',
      requestId,
      path: message.path,
      content: message.content,
    });
  } catch (err) {
    pendingWriteFile.delete(requestId);
    sendResponse({ ok: false, error: 'postMessage failed: ' + String(err) });
  }
  return true;
});

connectNativeHost();
