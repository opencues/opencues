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
const RECONNECT_MS = 30_000;
const EXEC_TIMEOUT_FALLBACK_MS = 15_000;

interface BundleMessage {
  type: 'bundle';
  root: string;
  files: Record<string, string>;
  reason?: string;
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
}

let nativePort: chrome.runtime.Port | null = null;
let nextRequestId = 1;
type Pending = (msg: ExecResultMessage) => void;
const pending: Map<string, Pending> = new Map();

function failPending(reason: string): void {
  for (const [id, resolve] of pending) {
    resolve({ type: 'exec-result', requestId: id, exitCode: 127, stdout: '', stderr: reason, timedOut: false });
  }
  pending.clear();
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
    const msg = raw as BundleMessage | ExecResultMessage;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'bundle' && typeof msg.files === 'object') {
      const fileCount = Object.keys(msg.files).length;
      chrome.storage.local.set({ [BUNDLE_KEY]: { files: msg.files, root: msg.root } })
        .then(() => console.log(`[opencues] bundle stored (${fileCount} files, reason=${msg.reason ?? 'unknown'})`))
        .catch((err) => console.warn('[opencues] bundle storage write failed', err));
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
    });
  } catch (err) {
    pending.delete(requestId);
    sendResponse({ exitCode: 127, stdout: '', stderr: 'postMessage failed: ' + String(err), timedOut: false });
  }
  return true;
});

connectNativeHost();
