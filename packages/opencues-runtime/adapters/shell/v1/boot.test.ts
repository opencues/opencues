import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import type { KeyEvent } from '../../../src/adapter';

describe('Shell v1 boot()', () => {
  const minimalHost = {
    hostVersion: '0.1.0',
    cwd: '/proj',
    getText: () => '',
    getCursorOffset: () => 0,
    setText: () => {},
    setCursorOffset: () => {},
    forceRender: () => {},
  };

  it('returns dispatchKey + notifyTextChange + dispose handles', () => {
    const result = boot(minimalHost);
    expect(typeof result.dispatchKey).toBe('function');
    expect(typeof result.notifyTextChange).toBe('function');
    expect(typeof result.notifyCursorChange).toBe('function');
    expect(typeof result.collectRenderDirectives).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });

  it('dispatchKey returns false when no handler is subscribed', () => {
    const result = boot(minimalHost);
    const evt: KeyEvent = {
      key: 'left',
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      text: '',
      cursorOffset: 0,
    };
    expect(result.dispatchKey(evt)).toBe(false);
  });

  it('logs "OpenCues runtime starting (Shell v1)" with host=shell', () => {
    const log = vi.fn();
    boot({ ...minimalHost, log });
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('Shell v1'),
      expect.objectContaining({ host: 'shell' }),
    );
  });

  it('reports the right capability set (no spawn unless host.spawnProcess)', () => {
    const log = vi.fn();
    boot({ ...minimalHost, log });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('Shell v1'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('file-read');
    expect(caps).toContain('file-write');
    expect(caps).toContain('force-render');
    expect(caps).toContain('dim-ranges');
    expect(caps).toContain('render-rgb-color');
    expect(caps).not.toContain('spawn-process');
  });

  it('opt-in spawn-process when host supplies spawnProcess', () => {
    const log = vi.fn();
    boot({ ...minimalHost, spawnProcess: () => ({} as any), log });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('Shell v1'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('spawn-process');
  });

  it('Navigation subscribed — Ctrl+Alt+Left consumed when text has words', () => {
    let text = 'alpha beta gamma';
    let cursor = 0;
    const result = boot({
      ...minimalHost,
      getText: () => text,
      getCursorOffset: () => cursor,
      setText: (t) => { text = t; },
      setCursorOffset: (c) => { cursor = c; },
    });
    const consumed = result.dispatchKey({
      key: 'left',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text,
      cursorOffset: cursor,
    });
    expect(consumed).toBe(true);
  });

  // ─── resetBufferState contract ──────────────────────────────────────────
  // Mirrors chrome's contract test. The wipe set + multi-step journey
  // assertions live in `src/modules/reset-buffer-state.scenarios.test.ts`;
  // this is just the per-band guarantee that the method exists, accepts
  // repeated calls, and doesn't throw on a cold boot.
  it('exposes resetBufferState as a method', () => {
    const result = boot(minimalHost);
    expect(typeof result.resetBufferState).toBe('function');
  });

  it('resetBufferState is idempotent on a cold boot (no prior state)', () => {
    const result = boot(minimalHost);
    expect(() => {
      result.resetBufferState();
      result.resetBufferState();
      result.resetBufferState();
    }).not.toThrow();
  });
});
