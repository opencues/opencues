import { describe, expect, it, vi } from 'vitest';
import { createDaemon, type Frame, type RuntimeBundle, type CodexHostInfo } from './daemon';
import { MockAdapter } from '../../../testing/mock-adapter';
import { ConfigLoader } from '../../../src/modules/config-loader';
import { createSourceReclassifier } from '../../../src/boot-common';
import { CodexAdapter } from './adapter';
import type { BlankInvokeSpec } from '../../../src/adapter';

/**
 * Build a fresh daemon with a recording `send` callback. Returns the
 * daemon handle plus a `frames` array that captures every emitted
 * frame. By default uses a stub buildRuntime so tests don't hit the
 * real filesystem; pass `realBuildRuntime: true` to opt in.
 */
function build(opts: { realBuildRuntime?: boolean } = {}) {
  const frames: Frame[] = [];
  const log = vi.fn<[string, string], void>();
  let buildRuntimeCalls: CodexHostInfo[] = [];

  const stubBuildRuntime = vi.fn(async (params: CodexHostInfo, daemonLog) => {
    buildRuntimeCalls.push(params);
    // The reclassifier is shared between the adapter (which calls
    // markRuntimeWrite inside setText) and the bundle (which the
    // daemon's text-change RPC handler calls reclassify on). Tests
    // must wire BOTH to the same instance to mirror production.
    const reclassifier = createSourceReclassifier();
    const adapter = new CodexAdapter({
      cwd: params.cwd,
      log: () => {},
      reclassifier,
    });
    const configLoader = new ConfigLoader(adapter, {
      configSearchPaths: params.configSearchPaths,
    });
    configLoader.subscribe();
    await configLoader.load();
    // Empty registry for tests — Tier 3.D's real-registry test uses
    // defaultBuildRuntime via realBuildRuntime: true.
    const controlsRegistry = new Map();
    const blankInvoke = () => null;
    // Minimal SharedRuntime stand-in: runtime modules aren't wired
    // for these tests (tests don't exercise Navigation / Cycling /
    // BlankFill / DimRender; the Tier 3.A test that needs them goes
    // through the real default builder). Expose null state classes
    // so the type contract holds; the daemon's RPC handlers don't
    // touch shared.* directly — they go through the adapter.
    const shared = {
      configLoader,
      hlState: null as never,
      dynDefs: null as never,
      controlValues: null as never,
      spanFillState: null as never,
      dismissedBlanks: null as never,
      selectorSatelliteState: null as never,
    };
    return { adapter, shared, configLoader, reclassifier, controlsRegistry, blankInvoke } as RuntimeBundle;
  });

  const daemon = createDaemon({
    send: (f) => { frames.push(f); },
    log,
    ...(opts.realBuildRuntime ? {} : { buildRuntime: stubBuildRuntime }),
  });
  return { daemon, frames, log, stubBuildRuntime, buildRuntimeCalls };
}

describe('codex daemon — JSON-RPC handler', () => {
  it('ignores blank/whitespace lines (no frames emitted)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine('');
    await daemon.handleLine('   ');
    await daemon.handleLine('\t');
    expect(frames).toEqual([]);
  });

  it('returns parse error (-32700) with id:null on malformed JSON', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine('not json');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32700 },
      id: null,
    });
    expect((frames[0] as { error: { message: string } }).error.message).toMatch(/parse error/);
  });

  it('returns invalid-request error (-32600) when jsonrpc !== "2.0"', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({ jsonrpc: '1.0', method: 'boot', id: 1 }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32600 },
      id: 1,
    });
  });

  it('returns method-not-found error (-32601) for unknown methods', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'wat', id: 7 }));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'unknown method: wat' },
      id: 7,
    });
  });

  it('responds to boot request with {ok: true} and flips booted state', async () => {
    const { daemon, frames } = build();
    expect(daemon.booted).toBe(false);
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: { hostVersion: 'test', cwd: '/proj' },
      id: 1,
    }));
    expect(daemon.booted).toBe(true);
    expect(frames[0]).toEqual({
      jsonrpc: '2.0',
      result: { ok: true },
      id: 1,
    });
  });

  it('logs the boot params (truncated to 200 chars) via the log callback', async () => {
    const { daemon, log } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/proj' }, id: 1,
    }));
    expect(log).toHaveBeenCalledWith('info', expect.stringMatching(/^daemon booted /));
  });

  it('responds to key request with {consumed: false} (scaffold; runtime modules TODO)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'key',
      params: {
        key: 'ArrowUp',
        modifiers: { ctrl: true, alt: true, shift: false, meta: false },
        text: 'hello',
        cursorOffset: 5,
      },
      id: 42,
    }));
    expect(frames[0]).toEqual({
      jsonrpc: '2.0',
      result: { consumed: false },
      id: 42,
    });
  });

  it('text-change notification is handled silently (no response, no error)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'text-change',
      params: { text: 'abc', cursorOffset: 1, source: 'user' },
      // no id → notification
    }));
    expect(frames).toEqual([]);
  });

  it('force-render notification is handled silently (no response yet — TODO directives emit)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'force-render',
    }));
    expect(frames).toEqual([]);
  });

  it('boot-as-notification (no id) flips state but emits no response frame', async () => {
    const { daemon, frames, log } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: { cwd: '/proj' },
      // no id
    }));
    expect(daemon.booted).toBe(true);
    expect(frames).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it('parse-error response always uses id:null (id is unknown when JSON is broken)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine('{"id":7, broken');
    expect(frames[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('handles multiple frames in sequence with independent state', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'boot', id: 1 }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'key', params: {}, id: 2 }));
    await daemon.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'unknown', id: 3 }));
    expect(frames).toHaveLength(3);
    expect((frames[0] as { id: number }).id).toBe(1);
    expect((frames[1] as { id: number }).id).toBe(2);
    expect((frames[2] as { id: number }).id).toBe(3);
  });
});

describe('codex daemon — Tier 3.A: ConfigLoader wiring', () => {
  it('boot constructs a runtime bundle and exposes it on the daemon handle', async () => {
    const { daemon } = build();
    expect(daemon.runtime).toBeNull();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: { cwd: '/proj' },
      id: 1,
    }));
    expect(daemon.runtime).not.toBeNull();
    expect(daemon.runtime?.adapter.cwd).toBe('/proj');
    expect(daemon.runtime?.configLoader).toBeInstanceOf(ConfigLoader);
  });

  it('boot forwards configSearchPaths from the boot params to the buildRuntime factory', async () => {
    const { daemon, buildRuntimeCalls } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: {
        cwd: '/proj',
        configSearchPaths: ['/tmp/proj-a/.opencues', '/home/x/.opencues'],
      },
      id: 1,
    }));
    expect(buildRuntimeCalls).toHaveLength(1);
    expect(buildRuntimeCalls[0].cwd).toBe('/proj');
    expect(buildRuntimeCalls[0].configSearchPaths).toEqual([
      '/tmp/proj-a/.opencues',
      '/home/x/.opencues',
    ]);
  });

  it('boot waits for buildRuntime to resolve before sending the response', async () => {
    const frames: Frame[] = [];
    let resolveBuild: (() => void) | undefined;
    const buildPromise = new Promise<void>((r) => { resolveBuild = r; });

    const daemon = createDaemon({
      send: (f) => { frames.push(f); },
      buildRuntime: async (params) => {
        await buildPromise;
        const adapter = new MockAdapter({ cwd: params.cwd });
        const configLoader = new ConfigLoader(adapter, {});
        configLoader.subscribe();
        await configLoader.load();
        return { adapter, configLoader };
      },
    });

    const handlePromise = daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/proj' }, id: 1,
    }));

    // Pre-resolve: no response frame yet.
    expect(daemon.booted).toBe(false);
    expect(frames.find(f => 'result' in f)).toBeUndefined();

    // Resolve buildRuntime, then await handleLine.
    resolveBuild!();
    await handlePromise;

    expect(daemon.booted).toBe(true);
    expect(frames.find(f => 'result' in f)).toEqual({
      jsonrpc: '2.0',
      result: { ok: true },
      id: 1,
    });
  });

  it('boot returns -32001 + leaves booted=false when buildRuntime throws', async () => {
    const frames: Frame[] = [];
    const log = vi.fn<[string, string], void>();
    const daemon = createDaemon({
      send: (f) => { frames.push(f); },
      log,
      buildRuntime: async () => { throw new Error('config corrupt'); },
    });

    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/proj' }, id: 1,
    }));

    expect(daemon.booted).toBe(false);
    expect(daemon.runtime).toBeNull();
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001 },
      id: 1,
    });
    expect((frames[0] as { error: { message: string } }).error.message).toMatch(/boot failed/);
    expect(log).toHaveBeenCalledWith('error', expect.stringMatching(/^boot failed/));
  });

  it('default buildRuntime (real fs) loads cleanly when search paths point at non-existent dirs', async () => {
    // Don't pass buildRuntime → uses defaultBuildRuntime → CodexAdapter
    // + real ConfigLoader hitting real fs. Search paths point at a
    // dir that doesn't exist — ConfigLoader silently skips missing
    // dirs and returns an empty config.
    const frames: Frame[] = [];
    const daemon = createDaemon({ send: (f) => { frames.push(f); } });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: {
        cwd: '/tmp/codex-nonexistent-cwd',
        configSearchPaths: ['/tmp/definitely-does-not-exist-abc123'],
      },
      id: 1,
    }));
    expect(daemon.booted).toBe(true);
    expect(daemon.runtime).not.toBeNull();
    expect(frames.find(f => 'result' in f)).toEqual({
      jsonrpc: '2.0',
      result: { ok: true },
      id: 1,
    });
    // Empty cueMap from the missing search path — graceful degradation.
    expect(daemon.runtime?.configLoader.cueMap.size).toBe(0);
  });
});

describe('codex daemon — Tier 3.C: source reclassifier', () => {
  it('boot bundle includes a reclassifier instance', async () => {
    const { daemon } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/proj' }, id: 1,
    }));
    expect(daemon.runtime?.reclassifier).toBeDefined();
    expect(typeof daemon.runtime?.reclassifier.markRuntimeWrite).toBe('function');
    expect(typeof daemon.runtime?.reclassifier.reclassify).toBe('function');
  });

  it('CodexAdapter.setText calls markRuntimeWrite on the supplied reclassifier', () => {
    const reclassifier = createSourceReclassifier();
    const adapter = new CodexAdapter({
      cwd: '/proj',
      log: () => {},
      reclassifier,
    });
    adapter.setText('hello world');
    // After markRuntimeWrite, an incoming text-change with the same
    // text is reclassified from 'user' to 'runtime'.
    expect(reclassifier.reclassify('hello world', 'user')).toBe('runtime');
  });

  it('CodexAdapter.pushText also calls markRuntimeWrite', () => {
    const reclassifier = createSourceReclassifier();
    const adapter = new CodexAdapter({
      cwd: '/proj',
      log: () => {},
      reclassifier,
    });
    adapter.pushText('async fill');
    expect(reclassifier.reclassify('async fill', 'user')).toBe('runtime');
  });

  it('reclassify is one-shot — second identical text stays "user"', () => {
    const reclassifier = createSourceReclassifier();
    const adapter = new CodexAdapter({
      cwd: '/proj',
      log: () => {},
      reclassifier,
    });
    adapter.setText('cycle result');
    expect(reclassifier.reclassify('cycle result', 'user')).toBe('runtime');
    // The user later types the exact same text by hand — must NOT be
    // misclassified as runtime (the one-shot stash was cleared).
    expect(reclassifier.reclassify('cycle result', 'user')).toBe('user');
  });

  it('CodexAdapter without a reclassifier is a no-op (graceful, no throws)', () => {
    const adapter = new CodexAdapter({ cwd: '/proj', log: () => {} });
    expect(() => adapter.setText('no reclassifier')).not.toThrow();
    expect(() => adapter.pushText('no reclassifier')).not.toThrow();
  });
});

describe('codex daemon — Tier 3.D: controls registry', () => {
  it('default buildRuntime registers the same six controls OC wires', async () => {
    // Real buildRuntime — exercises the actual registry construction.
    const frames: Frame[] = [];
    const daemon = createDaemon({ send: (f) => { frames.push(f); } });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'boot',
      params: { cwd: '/tmp/codex-controls-test', configSearchPaths: ['/tmp/nonexistent'] },
      id: 1,
    }));
    const reg = daemon.runtime?.controlsRegistry;
    expect(reg).toBeInstanceOf(Map);
    expect([...reg!.keys()].sort()).toEqual([
      'answer', 'hackernews', 'opencues', 'prompt', 'stocks', 'weather',
    ]);
  });

  it('controlInvoke dispatches to the right control + returns null for unknown', async () => {
    const frames: Frame[] = [];
    const daemon = createDaemon({ send: (f) => { frames.push(f); } });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/tmp/codex' }, id: 1,
    }));
    // Unknown control → null (BlankFill / Cycling fall through to spawnProcess).
    const unknown = daemon.runtime?.blankInvoke({
      controlName: 'definitely-not-real',
      action: 'get',
      args: [],
    });
    expect(unknown).toBeNull();
    // Known control → ProcessHandle (the result Promise will resolve
    // with whatever the underlying control returns; we don't await
    // it here to keep the test fast and offline-safe).
    const known = daemon.runtime?.blankInvoke({
      controlName: 'opencues',
      action: 'get',
      args: ['voice-mode'],
    });
    expect(known).not.toBeNull();
    expect(known).toHaveProperty('result');
  });

  it('CodexAdapter advertises control-invoke capability when binding is supplied', () => {
    const withInvoke = new CodexAdapter({
      cwd: '/proj',
      log: () => {},
      blankInvoke: () => null,
    });
    expect(withInvoke.capabilities).toContain('control-invoke');

    const withoutInvoke = new CodexAdapter({ cwd: '/proj', log: () => {} });
    expect(withoutInvoke.capabilities).not.toContain('control-invoke');
  });

  it('CodexAdapter.controlInvoke forwards to the supplied binding', () => {
    const calls: BlankInvokeSpec[] = [];
    const stub = (spec: BlankInvokeSpec): null => { calls.push(spec); return null; };
    const adapter = new CodexAdapter({
      cwd: '/proj',
      log: () => {},
      blankInvoke: stub,
    });
    adapter.blankInvoke({ controlName: 'foo', action: 'get', args: ['bar'] });
    expect(calls).toEqual([{ controlName: 'foo', action: 'get', args: ['bar'] }]);
  });

  it('CodexAdapter.controlInvoke returns null when no binding is supplied', () => {
    const adapter = new CodexAdapter({ cwd: '/proj', log: () => {} });
    const result = adapter.blankInvoke({ controlName: 'x', action: 'get', args: [] });
    expect(result).toBeNull();
  });
});

describe('codex daemon — Tier 3.E: control-invoke RPC', () => {
  it('returns -32000 when called before boot', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'control-invoke',
      params: { controlName: 'opencues', action: 'get', args: ['voice-mode'] },
      id: 9,
    }));
    expect(frames[0]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32000 },
      id: 9,
    });
  });

  it('returns -32602 when params are missing controlName or action', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/proj' }, id: 1,
    }));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'control-invoke',
      params: { controlName: 'opencues' /* no action */ },
      id: 9,
    }));
    expect(frames[1]).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32602 },
      id: 9,
    });
  });

  it('returns null result when controlName is unknown (fallback to native)', async () => {
    const frames: Frame[] = [];
    const stubInvoke = vi.fn(() => null);
    const daemon = createDaemon({
      send: (f) => { frames.push(f); },
      buildRuntime: async (params) => ({
        adapter: new MockAdapter({ cwd: params.cwd }),
        configLoader: {} as never,
        reclassifier: createSourceReclassifier(),
        controlsRegistry: new Map(),
        blankInvoke: stubInvoke,
      }),
    });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'control-invoke',
      params: { controlName: 'no-such', action: 'get', args: [] },
      id: 2,
    }));
    expect(frames.find(f => 'id' in f && f.id === 2)).toEqual({
      jsonrpc: '2.0',
      result: null,
      id: 2,
    });
    expect(stubInvoke).toHaveBeenCalledWith({
      controlName: 'no-such', action: 'get', args: [],
    });
  });

  it('forwards the ProcessResult from the dispatcher when control runs', async () => {
    const frames: Frame[] = [];
    const stubInvoke = vi.fn(() => ({
      result: Promise.resolve({
        stdout: 'active', stderr: '', exitCode: 0, timedOut: false,
      }),
      kill: () => {},
    }));
    const daemon = createDaemon({
      send: (f) => { frames.push(f); },
      buildRuntime: async (params) => ({
        adapter: new MockAdapter({ cwd: params.cwd }),
        configLoader: {} as never,
        reclassifier: createSourceReclassifier(),
        controlsRegistry: new Map(),
        blankInvoke: stubInvoke,
      }),
    });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'control-invoke',
      params: { controlName: 'opencues', action: 'get', args: ['voice-mode'] },
      id: 5,
    }));
    expect(frames.find(f => 'id' in f && f.id === 5)).toEqual({
      jsonrpc: '2.0',
      result: { stdout: 'active', stderr: '', exitCode: 0, timedOut: false },
      id: 5,
    });
  });

  it('control-invoke returns the dispatcher\'s wrapped error result (non-zero exitCode)', async () => {
    // The createControlInvoke dispatcher catches throws inside the
    // control and wraps them into { exitCode: 1, stderr: msg } —
    // this is normal control behavior, NOT a JSON-RPC error.
    const frames: Frame[] = [];
    const stubInvoke = vi.fn(() => ({
      result: Promise.resolve({
        stdout: '', stderr: 'control failed', exitCode: 1, timedOut: false,
      }),
      kill: () => {},
    }));
    const daemon = createDaemon({
      send: (f) => { frames.push(f); },
      buildRuntime: async (params) => ({
        adapter: new MockAdapter({ cwd: params.cwd }),
        configLoader: {} as never,
        reclassifier: createSourceReclassifier(),
        controlsRegistry: new Map(),
        blankInvoke: stubInvoke,
      }),
    });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'control-invoke',
      params: { controlName: 'opencues', action: 'set', args: ['x'] },
      id: 6,
    }));
    const resp = frames.find(f => 'id' in f && f.id === 6);
    expect(resp).toEqual({
      jsonrpc: '2.0',
      result: { stdout: '', stderr: 'control failed', exitCode: 1, timedOut: false },
      id: 6,
    });
    // NOT a JSON-RPC error — explicitly a successful call returning
    // a non-zero-exit result.
    expect(resp).not.toHaveProperty('error');
  });

  it('end-to-end: real registry — opencues "get voice-mode" returns the user-config value', async () => {
    // Default buildRuntime → real OpenCuesSettingsControl → reads
    // ~/.opencues/opencues.md. Returns whatever the live file contains.
    const frames: Frame[] = [];
    const daemon = createDaemon({ send: (f) => { frames.push(f); } });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/tmp' }, id: 1,
    }));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'control-invoke',
      params: { controlName: 'opencues', action: 'get', args: ['voice-mode'] },
      id: 7,
    }));
    const resp = frames.find(f => 'id' in f && f.id === 7) as { result?: { stdout: string; exitCode: number } };
    expect(resp).toBeDefined();
    expect(resp.result).toBeDefined();
    expect(resp.result?.exitCode).toBe(0);
    // Whatever value voice-mode is set to (we don't pin it — just that it returns *something*).
    expect(typeof resp.result?.stdout).toBe('string');
  });
});

describe('codex daemon — Tier 3.F: text-change / key / force-render fanout', () => {
  it('text-change RPC fans into adapter text subscribers', async () => {
    const { daemon } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    const seen: { text: string; cursor: number; source: string }[] = [];
    daemon.runtime!.adapter.onTextChange((e) => {
      seen.push({ text: e.text, cursor: e.cursorOffset, source: e.source });
    });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'text-change',
      params: { text: 'the quick fox', cursorOffset: 9, source: 'user' },
    }));
    expect(seen).toEqual([{ text: 'the quick fox', cursor: 9, source: 'user' }]);
  });

  it('text-change reclassifies to "runtime" when text matches a previous setText', async () => {
    const { daemon } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    // Simulate a runtime-driven setText (e.g. cycling result):
    daemon.runtime!.adapter.setText('the lawyer');
    const seen: string[] = [];
    daemon.runtime!.adapter.onTextChange((e) => seen.push(e.source));
    // Bridge echoes the text back labelled as 'user' — reclassifier
    // should flip it to 'runtime'.
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'text-change',
      params: { text: 'the lawyer', cursorOffset: 10, source: 'user' },
    }));
    expect(seen).toEqual(['runtime']);
  });

  it('text-change pre-boot is a silent no-op (no error response, no fanout)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'text-change',
      params: { text: 'pre-boot', cursorOffset: 0, source: 'user' },
    }));
    expect(frames).toEqual([]);
    expect(daemon.runtime).toBeNull();
  });

  it('text-change with non-string text is a silent no-op', async () => {
    const { daemon } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    const seen: unknown[] = [];
    daemon.runtime!.adapter.onTextChange((e) => seen.push(e));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'text-change',
      params: { /* missing text */ cursorOffset: 0 },
    }));
    expect(seen).toEqual([]);
  });

  it('key RPC fans into adapter key subscribers + returns consumed=true when handler claims it', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    daemon.runtime!.adapter.onKey(null, (event) => {
      // Consume only Ctrl+Alt+Up — same shape Cycling uses.
      return event.key === 'up' && event.modifiers.ctrl && event.modifiers.alt;
    });
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0',
      method: 'key',
      params: {
        key: 'up',
        modifiers: { ctrl: true, alt: true, shift: false, meta: false },
        text: 'foo',
        cursorOffset: 3,
      },
      id: 5,
    }));
    expect(frames.find(f => 'id' in f && f.id === 5)).toEqual({
      jsonrpc: '2.0',
      result: { consumed: true },
      id: 5,
    });
  });

  it('key RPC returns consumed=false when no handler claims it', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    daemon.runtime!.adapter.onKey(null, () => false);
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'key',
      params: { key: 'a', modifiers: { ctrl: false, alt: false, shift: false, meta: false } },
      id: 6,
    }));
    expect(frames.find(f => 'id' in f && f.id === 6)).toEqual({
      jsonrpc: '2.0', result: { consumed: false }, id: 6,
    });
  });

  it('key RPC pre-boot returns {consumed:false} (graceful degrade, no error)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'key',
      params: { key: 'a' }, id: 7,
    }));
    expect(frames[0]).toEqual({
      jsonrpc: '2.0', result: { consumed: false }, id: 7,
    });
  });

  it('key RPC with non-string key returns {consumed:false} (defensive)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'key', params: { /* no key */ }, id: 8,
    }));
    expect(frames.find(f => 'id' in f && f.id === 8)).toEqual({
      jsonrpc: '2.0', result: { consumed: false }, id: 8,
    });
  });

  it('force-render emits a `directives` notification merging every render handler', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    // Two render handlers — one emits dim ranges, one emits a highlight.
    daemon.runtime!.adapter.onRender(() => ({
      dimRanges: [{ start: 0, end: 3 }, { start: 8, end: 11 }],
    }));
    daemon.runtime!.adapter.onRender(() => ({
      highlight: { start: 4, end: 7 },
    }));
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'force-render',
      params: { text: 'the quick fox', cursor: 4 },
    }));
    const directivesFrame = frames.find(f => 'method' in f && f.method === 'directives');
    expect(directivesFrame).toEqual({
      jsonrpc: '2.0',
      method: 'directives',
      params: {
        dim: [{ start: 0, end: 3 }, { start: 8, end: 11 }],
        active: { start: 4, end: 7 },
      },
    });
  });

  it('force-render pre-boot is a silent no-op (no notification emitted)', async () => {
    const { daemon, frames } = build();
    await daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'force-render',
    }));
    expect(frames).toEqual([]);
  });
});
