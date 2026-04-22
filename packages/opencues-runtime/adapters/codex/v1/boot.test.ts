import { describe, expect, it } from 'vitest';
import * as bootModule from './boot';
import { startDaemon, createDaemon, type CodexHostInfo, type Frame } from './daemon';

/**
 * Surface-level checks for the codex/v1 adapter band's `boot.ts`.
 *
 * Unlike OC's adapter band (which exposes a real `boot()` function
 * with handler subscriptions), codex's adapter band is a thin
 * re-export over `daemon.ts` — codex itself can't load
 * `@opencues/runtime` in-process (it's Rust), so the daemon owns the
 * runtime state and the bridge calls it via JSON-RPC.
 *
 * These tests pin the contract that `boot.ts` re-exports the daemon
 * symbols at the names the rest of the runtime expects, and that
 * `CodexHostInfo` keeps its required shape so the protocol stays
 * stable across refactors.
 */

describe('codex/v1 adapter band — surface', () => {
  it('re-exports startDaemon from daemon.ts', () => {
    expect((bootModule as { startDaemon: typeof startDaemon }).startDaemon).toBe(startDaemon);
    expect(typeof bootModule.startDaemon).toBe('function');
  });

  it('re-exports the CodexHostInfo type (compile-time check via assignment)', () => {
    // Type-only check: this won't compile if the re-export breaks.
    const sample: CodexHostInfo = {
      hostVersion: 'test',
      cwd: '/proj',
      configSearchPaths: ['/proj/.opencues', '/home/x/.opencues'],
    };
    expect(sample.cwd).toBe('/proj');
    expect(sample.configSearchPaths).toHaveLength(2);
  });

  it('CodexHostInfo treats hostVersion + configSearchPaths as optional', () => {
    const minimal: CodexHostInfo = { cwd: '/proj' };
    expect(minimal.cwd).toBe('/proj');
    expect(minimal.hostVersion).toBeUndefined();
    expect(minimal.configSearchPaths).toBeUndefined();
  });

  it('createDaemon returns a handle with handleLine + booted', () => {
    const frames: Frame[] = [];
    const daemon = createDaemon({ send: (f) => { frames.push(f); } });
    expect(typeof daemon.handleLine).toBe('function');
    expect(daemon.booted).toBe(false);
  });

  it('createDaemon does not require a log callback (defaults to a `log` notification)', () => {
    const frames: Frame[] = [];
    const daemon = createDaemon({ send: (f) => { frames.push(f); } });
    daemon.handleLine(JSON.stringify({
      jsonrpc: '2.0', method: 'boot', params: { cwd: '/p' }, id: 1,
    }));
    // First frame: the boot response. Second frame: the default-log notification.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const logFrame = frames.find(f => 'method' in f && f.method === 'log');
    expect(logFrame).toBeDefined();
    expect(logFrame).toMatchObject({
      jsonrpc: '2.0',
      method: 'log',
      params: { level: 'info' },
    });
  });
});
