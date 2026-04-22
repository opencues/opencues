import { describe, expect, it, vi } from 'vitest';
import { createDaemon, type Frame, type RuntimeBundle, type CodexHostInfo } from './daemon';
import { MockAdapter } from '../../../testing/mock-adapter';
import { ConfigLoader } from '../../../src/modules/config-loader';

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
    const adapter = new MockAdapter({ cwd: params.cwd });
    const configLoader = new ConfigLoader(adapter, {
      configSearchPaths: params.configSearchPaths,
    });
    configLoader.subscribe();
    await configLoader.load();
    return { adapter, configLoader } as RuntimeBundle;
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
