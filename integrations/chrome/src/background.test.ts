// Tests for background.ts — the service worker's message-routing /
// dispatch logic. Complements manifest-security.test.ts (which tests
// sw-auth.ts's isInternalSender / isFetchOriginAllowed in isolation)
// by proving background.ts's handlers ACTUALLY refuse when the sender
// check fails, and that the native-messaging relay (exec / user-blank-
// invoke / write-file) correctly assigns requestIds, matches replies,
// handles concurrent in-flight requests, and degrades when the native
// host disconnects mid-request.
//
// background.ts registers all its onMessage listeners as a MODULE-LEVEL
// side effect (including calling connectNativeHost() at the bottom), so
// every test re-imports a fresh module instance (vi.resetModules +
// dynamic import) against a freshly-built chrome mock. This mirrors the
// mocking convention in manifest-security.test.ts / chrome-storage-adapter.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

interface MockPort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (cb: (msg: unknown) => void) => void; fire: (msg: unknown) => void };
  onDisconnect: { addListener: (cb: () => void) => void; fire: () => void };
}

function makeMockPort(): MockPort {
  let messageCb: ((msg: unknown) => void) | undefined;
  let disconnectCb: (() => void) | undefined;
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (cb) => { messageCb = cb; },
      fire: (msg) => messageCb?.(msg),
    },
    onDisconnect: {
      addListener: (cb) => { disconnectCb = cb; },
      fire: () => disconnectCb?.(),
    },
  };
}

let messageListeners: MessageListener[];
let installedListeners: Array<() => void>;
let storageChangeListeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>;
let storageState: Record<string, unknown>;
let connectNativeImpl: () => MockPort;
let connectNativeCalls: number;
let lastCreatedPort: MockPort | null;

function setupChromeMock(): void {
  messageListeners = [];
  installedListeners = [];
  storageChangeListeners = [];
  storageState = {};
  connectNativeCalls = 0;
  lastCreatedPort = null;

  const chromeMock = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined as { message?: string } | undefined,
      onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
      onInstalled: { addListener: (fn: () => void) => installedListeners.push(fn) },
      connectNative: vi.fn(() => {
        connectNativeCalls += 1;
        const port = connectNativeImpl();
        lastCreatedPort = port;
        return port;
      }),
    },
    storage: {
      local: {
        get: vi.fn((keys?: string | string[] | null) => {
          const out: Record<string, unknown> = {};
          if (typeof keys === 'string') {
            if (keys in storageState) out[keys] = storageState[keys];
          } else if (Array.isArray(keys)) {
            for (const k of keys) if (k in storageState) out[k] = storageState[k];
          } else {
            for (const [k, v] of Object.entries(storageState)) out[k] = v;
          }
          return Promise.resolve(out);
        }),
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(storageState, items);
          return Promise.resolve();
        }),
      },
      onChanged: { addListener: (fn: typeof storageChangeListeners[number]) => storageChangeListeners.push(fn) },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
}

/** Simulate chrome's dispatch of a message to every registered
 *  onMessage listener. Returns whether some listener claimed the
 *  message (returned `true`) plus a promise resolving to whatever
 *  that listener eventually passes to sendResponse (sync or async). */
function dispatchMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender = { id: 'test-extension-id' } as chrome.runtime.MessageSender,
): { handled: boolean; response: Promise<unknown> } {
  let resolveResponse!: (r: unknown) => void;
  const response = new Promise<unknown>((resolve) => { resolveResponse = resolve; });
  let handled = false;
  for (const listener of messageListeners) {
    const result = listener(message, sender, (r: unknown) => resolveResponse(r));
    if (result === true) { handled = true; break; }
  }
  return { handled, response };
}

const INTERNAL_SENDER = { id: 'test-extension-id' } as chrome.runtime.MessageSender;
const EVIL_SENDER = { id: 'evil-extension-id' } as chrome.runtime.MessageSender;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  setupChromeMock();
  connectNativeImpl = () => makeMockPort();
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => 'response-body',
  }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  await import('./background');
  // connectNativeHost() logs "native host port opened" via dlog(), which
  // mirrors to the native port itself (mirrorToNativeHost). Clear that
  // baseline call so postMessage assertions in each test start clean.
  lastCreatedPort?.postMessage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opencues:fetch relay', () => {
  it('happy path — relays to fetch and returns the response shape', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:fetch',
      method: 'POST',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { Authorization: 'Bearer x' },
      body: '{}',
    }, INTERNAL_SENDER);
    const result = await response as { ok: boolean; status: number; text: string };
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.text).toBe('response-body');
    // A POST call for the actual request must have happened (in
    // addition to the fire-and-forget preconnect HEAD).
    const postCalls = fetchMock.mock.calls.filter(([, init]) => (init as { method?: string })?.method === 'POST');
    expect(postCalls.length).toBe(1);
  });

  it('refuses when sender is not internal (F6) — does not call fetch', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:fetch',
      method: 'POST',
      url: 'https://api.groq.com/v1/x',
      headers: {},
    }, EVIL_SENDER);
    const result = await response as { ok: boolean; statusText: string };
    expect(result.ok).toBe(false);
    expect(result.statusText).toMatch(/sender not internal/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when URL origin is not in the allow-list (F6) — does not call fetch', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:fetch',
      method: 'POST',
      url: 'https://evil.example/exfil',
      headers: {},
    }, INTERNAL_SENDER);
    const result = await response as { ok: boolean; statusText: string };
    expect(result.ok).toBe(false);
    expect(result.statusText).toMatch(/origin not in allow-list/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetch throwing returns ok:false with the error message, not a crash', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw new Error('network down');
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
    });
    const { response } = dispatchMessage({
      type: 'opencues:fetch',
      method: 'POST',
      url: 'https://api.groq.com/v1/x',
      headers: {},
    }, INTERNAL_SENDER);
    const result = await response as { ok: boolean; statusText: string };
    expect(result.ok).toBe(false);
    expect(result.statusText).toBe('network down');
  });

  it('non-matching message type is ignored (returns undefined, not handled)', () => {
    const { handled } = dispatchMessage({ type: 'something-else' }, INTERNAL_SENDER);
    expect(handled).toBe(false);
  });
});

describe('opencues:exec relay', () => {
  it('refuses when sender is not internal — does not touch the native port', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:exec', command: 'ls', args: [],
    }, EVIL_SENDER);
    const result = await response as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/sender not internal/);
    expect(lastCreatedPort?.postMessage).not.toHaveBeenCalled();
  });

  it('responds "native host not connected" once the port has disconnected', async () => {
    // Force a disconnect so nativePort becomes null.
    lastCreatedPort!.onDisconnect.fire();
    const { response } = dispatchMessage({ type: 'opencues:exec', command: 'ls', args: [] }, INTERNAL_SENDER);
    const result = await response as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe('native host not connected');
  });

  it('happy path — forwards to the native port, resolves on matching exec-result', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:exec', command: 'echo', args: ['hi'], timeoutMs: 5000,
    }, INTERNAL_SENDER);
    expect(lastCreatedPort!.postMessage).toHaveBeenCalledTimes(1);
    const sent = lastCreatedPort!.postMessage.mock.calls[0][0] as { type: string; requestId: string; command: string };
    expect(sent.type).toBe('exec');
    expect(sent.command).toBe('echo');

    lastCreatedPort!.onMessage.fire({
      type: 'exec-result', requestId: sent.requestId, exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false,
    });
    const result = await response as { exitCode: number; stdout: string };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi\n');
  });

  it('concurrent requests get distinct requestIds and resolve independently (no crosstalk)', async () => {
    const call1 = dispatchMessage({ type: 'opencues:exec', command: 'first', args: [] }, INTERNAL_SENDER);
    const call2 = dispatchMessage({ type: 'opencues:exec', command: 'second', args: [] }, INTERNAL_SENDER);

    const sent1 = lastCreatedPort!.postMessage.mock.calls[0][0] as { requestId: string };
    const sent2 = lastCreatedPort!.postMessage.mock.calls[1][0] as { requestId: string };
    expect(sent1.requestId).not.toBe(sent2.requestId);

    // Resolve out of order — second request's reply arrives first.
    lastCreatedPort!.onMessage.fire({ type: 'exec-result', requestId: sent2.requestId, exitCode: 2, stdout: 'second-out', stderr: '', timedOut: false });
    lastCreatedPort!.onMessage.fire({ type: 'exec-result', requestId: sent1.requestId, exitCode: 1, stdout: 'first-out', stderr: '', timedOut: false });

    const result1 = await call1.response as { exitCode: number; stdout: string };
    const result2 = await call2.response as { exitCode: number; stdout: string };
    expect(result1.exitCode).toBe(1);
    expect(result1.stdout).toBe('first-out');
    expect(result2.exitCode).toBe(2);
    expect(result2.stdout).toBe('second-out');
  });

  it('port disconnecting mid-request fails the pending call with a disconnect reason', async () => {
    const { response } = dispatchMessage({ type: 'opencues:exec', command: 'slow', args: [] }, INTERNAL_SENDER);
    // Host never replies; the port drops instead.
    lastCreatedPort!.onDisconnect.fire();
    const result = await response as { exitCode: number; stderr: string; timedOut: boolean };
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe('native host disconnected');
    expect(result.timedOut).toBe(false);
  });

  it('postMessage throwing synchronously reports failure instead of hanging', async () => {
    lastCreatedPort!.postMessage.mockImplementation(() => { throw new Error('port closed'); });
    const { response } = dispatchMessage({ type: 'opencues:exec', command: 'x', args: [] }, INTERNAL_SENDER);
    const result = await response as { exitCode: number; stderr: string };
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toMatch(/postMessage failed: Error: port closed/);
  });

  it('SW-side timeout fires when the host never replies', async () => {
    vi.useFakeTimers();
    const { response } = dispatchMessage({ type: 'opencues:exec', command: 'hangs', args: [], timeoutMs: 1000 }, INTERNAL_SENDER);
    // SW-side safety net is timeoutMs + 5000ms.
    await vi.advanceTimersByTimeAsync(6000);
    const result = await response as { exitCode: number; stderr: string; timedOut: boolean };
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toBe('SW-side timeout');
  });

  it('a stale/duplicate exec-result (unknown requestId) is ignored without crashing', async () => {
    const { response } = dispatchMessage({ type: 'opencues:exec', command: 'once', args: [] }, INTERNAL_SENDER);
    const sent = lastCreatedPort!.postMessage.mock.calls[0][0] as { requestId: string };

    // Reply once — resolves the pending call and removes it from the map.
    expect(() => lastCreatedPort!.onMessage.fire({ type: 'exec-result', requestId: sent.requestId, exitCode: 0, stdout: 'ok', stderr: '', timedOut: false })).not.toThrow();
    await response;

    // A second reply with the SAME requestId (host bug / replay) must not throw.
    expect(() => lastCreatedPort!.onMessage.fire({ type: 'exec-result', requestId: sent.requestId, exitCode: 0, stdout: 'replayed', stderr: '', timedOut: false })).not.toThrow();
  });

  it('missing command/args are still forwarded as-is (no source-side validation) — documents current behaviour', async () => {
    dispatchMessage({ type: 'opencues:exec' } as unknown as Record<string, unknown>, INTERNAL_SENDER);
    const sent = lastCreatedPort!.postMessage.mock.calls[0][0] as { command: unknown; args: unknown };
    expect(sent.command).toBeUndefined();
    expect(sent.args).toBeUndefined();
  });
});

describe('opencues:user-blank-invoke relay', () => {
  it('refuses when sender is not internal', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:user-blank-invoke', name: 'volume', method: 'get', args: [],
    }, EVIL_SENDER);
    const result = await response as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sender not internal/);
  });

  it('responds with a helpful error when the native host is not connected', async () => {
    lastCreatedPort!.onDisconnect.fire();
    const { response } = dispatchMessage({
      type: 'opencues:user-blank-invoke', name: 'volume', method: 'get', args: [],
    }, INTERNAL_SENDER);
    const result = await response as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/native host not connected/);
  });

  it('happy path round-trip via the native port', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:user-blank-invoke', name: 'volume', method: 'set', args: ['40'],
    }, INTERNAL_SENDER);
    const sent = lastCreatedPort!.postMessage.mock.calls[0][0] as { type: string; requestId: string; name: string; method: string };
    expect(sent.type).toBe('user-blank-invoke');
    expect(sent.name).toBe('volume');
    expect(sent.method).toBe('set');

    lastCreatedPort!.onMessage.fire({ type: 'user-blank-result', requestId: sent.requestId, ok: true, output: '40%' });
    const result = await response as { ok: boolean; output: string };
    expect(result.ok).toBe(true);
    expect(result.output).toBe('40%');
  });

  it('15s safety-net timeout fires when the host never replies', async () => {
    vi.useFakeTimers();
    const { response } = dispatchMessage({
      type: 'opencues:user-blank-invoke', name: 'volume', method: 'get', args: [],
    }, INTERNAL_SENDER);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await response as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SW-side timeout');
  });
});

describe('opencues:host-status', () => {
  it('refuses (reports disconnected) when sender is not internal, regardless of real port state', async () => {
    // Port IS connected, but an external sender must still get {connected:false}.
    const { response } = dispatchMessage({ type: 'opencues:host-status' }, EVIL_SENDER);
    const result = await response as { connected: boolean };
    expect(result.connected).toBe(false);
  });

  it('reports connected:true while the native port is open', async () => {
    const { response } = dispatchMessage({ type: 'opencues:host-status' }, INTERNAL_SENDER);
    const result = await response as { connected: boolean };
    expect(result.connected).toBe(true);
  });

  it('reports connected:false after the port disconnects', async () => {
    lastCreatedPort!.onDisconnect.fire();
    const { response } = dispatchMessage({ type: 'opencues:host-status' }, INTERNAL_SENDER);
    const result = await response as { connected: boolean };
    expect(result.connected).toBe(false);
  });
});

describe('opencues:log', () => {
  it('refuses (ok:false) when sender is not internal — does not forward to the host', async () => {
    const { response } = dispatchMessage({ type: 'opencues:log', level: 'info', msg: 'hi' }, EVIL_SENDER);
    const result = await response as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(lastCreatedPort!.postMessage).not.toHaveBeenCalled();
  });

  it('forwards to the native port and acks ok:true when connected', async () => {
    const { response } = dispatchMessage({ type: 'opencues:log', level: 'warn', msg: 'careful' }, INTERNAL_SENDER);
    const result = await response as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(lastCreatedPort!.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'log', level: 'warn', msg: 'careful' }));
  });

  it('still acks ok:true (fire-and-forget) even with no native port connected', async () => {
    lastCreatedPort!.onDisconnect.fire();
    const { response } = dispatchMessage({ type: 'opencues:log', level: 'info', msg: 'no host' }, INTERNAL_SENDER);
    const result = await response as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

describe('opencues:write-file relay', () => {
  it('refuses when sender is not internal', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:write-file', path: '/OPENCUES.md', content: 'x',
    }, EVIL_SENDER);
    const result = await response as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sender not internal/);
  });

  it('reports "native host not connected" when there is no port', async () => {
    lastCreatedPort!.onDisconnect.fire();
    const { response } = dispatchMessage({
      type: 'opencues:write-file', path: '/OPENCUES.md', content: 'x',
    }, INTERNAL_SENDER);
    const result = await response as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('native host not connected');
  });

  it('happy path round-trip', async () => {
    const { response } = dispatchMessage({
      type: 'opencues:write-file', path: '/OPENCUES.md', content: 'voice-mode: on',
    }, INTERNAL_SENDER);
    const sent = lastCreatedPort!.postMessage.mock.calls[0][0] as { type: string; requestId: string; path: string };
    expect(sent.type).toBe('write-file');
    expect(sent.path).toBe('/OPENCUES.md');
    lastCreatedPort!.onMessage.fire({ type: 'write-file-result', requestId: sent.requestId, ok: true });
    const result = await response as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it('10s safety-net timeout fires when the host never replies', async () => {
    vi.useFakeTimers();
    const { response } = dispatchMessage({
      type: 'opencues:write-file', path: '/x.md', content: 'y',
    }, INTERNAL_SENDER);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await response as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SW-side timeout');
  });

  it('postMessage throwing reports failure', async () => {
    lastCreatedPort!.postMessage.mockImplementation(() => { throw new Error('closed'); });
    const { response } = dispatchMessage({
      type: 'opencues:write-file', path: '/x.md', content: 'y',
    }, INTERNAL_SENDER);
    const result = await response as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/postMessage failed/);
  });
});

describe('native host connect / reconnect', () => {
  it('schedules a reconnect when connectNative throws synchronously at startup', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    setupChromeMock();
    let throwOnce = true;
    connectNativeImpl = () => {
      if (throwOnce) { throwOnce = false; throw new Error('host not installed') as unknown as MockPort; }
      return makeMockPort();
    };
    // connectNative itself throws (not the returned port), so wrap the mock.
    (globalThis as unknown as { chrome: { runtime: { connectNative: () => MockPort } } }).chrome.runtime.connectNative = vi.fn(() => {
      connectNativeCalls += 1;
      if (connectNativeCalls === 1) throw new Error('host not installed');
      const port = makeMockPort();
      lastCreatedPort = port;
      return port;
    });
    await import('./background');
    expect(connectNativeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connectNativeCalls).toBe(2);
  });

  it('schedules a reconnect after the port disconnects', async () => {
    vi.useFakeTimers();
    lastCreatedPort!.onDisconnect.fire();
    expect(connectNativeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connectNativeCalls).toBe(2);
  });
});

describe('storage.onChanged — deferToChromeHost flip reconnects the native host', () => {
  it('reconnects when deferToChromeHost flips OFF -> ON while a port is already open', () => {
    expect(connectNativeCalls).toBe(1);
    const portBeforeFlip = lastCreatedPort;
    for (const listener of storageChangeListeners) {
      listener({
        opencues_config: {
          oldValue: { deferToChromeHost: false },
          newValue: { deferToChromeHost: true },
        },
      }, 'local');
    }
    // The flip disconnects the OLD port and opens a NEW one — assert on
    // the pre-flip reference, since `lastCreatedPort` is reassigned by
    // the reconnect's own connectNative() call.
    expect(portBeforeFlip!.disconnect).toHaveBeenCalled();
    expect(connectNativeCalls).toBe(2);
    expect(lastCreatedPort).not.toBe(portBeforeFlip);
  });

  it('does nothing when the area is not "local"', () => {
    for (const listener of storageChangeListeners) {
      listener({
        opencues_config: {
          oldValue: { deferToChromeHost: false },
          newValue: { deferToChromeHost: true },
        },
      }, 'sync');
    }
    expect(connectNativeCalls).toBe(1);
  });

  it('does nothing when deferToChromeHost was already on (no flip)', () => {
    for (const listener of storageChangeListeners) {
      listener({
        opencues_config: {
          oldValue: { deferToChromeHost: true },
          newValue: { deferToChromeHost: true },
        },
      }, 'local');
    }
    expect(connectNativeCalls).toBe(1);
  });
});
