import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import type { KeyEvent } from '../../../src/adapter';

describe('OpenCode v1.14 boot()', () => {
  it('returns dispatchKey + notifyTextChange + dispose handles', () => {
    const result = boot({
      hostVersion: '1.14.17',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
    });
    expect(typeof result.dispatchKey).toBe('function');
    expect(typeof result.notifyTextChange).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });

  it('dispatchKey returns false when no handler subscribed', () => {
    const result = boot({
      hostVersion: '1.14.17',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
    });
    const evt: KeyEvent = {
      key: 'left',
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      text: '',
      cursorOffset: 0,
    };
    expect(result.dispatchKey(evt)).toBe(false);
  });

  it('logs "OpenCues runtime starting" via host.log', () => {
    const log = vi.fn();
    boot({
      hostVersion: '1.14.17',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
      log,
    });
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('OpenCues runtime starting'),
      expect.objectContaining({ host: 'opencode' }),
    );
  });

  it('reports the right capability set (no spawn unless host.spawnProcess)', () => {
    const log = vi.fn();
    boot({
      hostVersion: '1.14.17',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
      log,
    });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('OpenCode v1.14'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('file-read');
    expect(caps).toContain('file-write');
    expect(caps).toContain('force-render');
    expect(caps).toContain('dim-ranges');
    expect(caps).not.toContain('spawn-process');
  });

  it('Navigation subscribed — Ctrl+Alt+Left consumed when text has words', () => {
    let text = 'alpha beta gamma';
    let cursor = 0;
    const result = boot({
      hostVersion: '1.14.17',
      cwd: '/proj',
      getText: () => text,
      getCursorOffset: () => cursor,
      setText: (t) => { text = t; },
      setCursorOffset: (c) => { cursor = c; },
      forceRender: () => {},
    });
    const consumed = result.dispatchKey({
      key: 'left',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text,
      cursorOffset: cursor,
    });
    expect(consumed).toBe(true);
  });

  it('opt-in spawn-process when host supplies spawnProcess', () => {
    const log = vi.fn();
    boot({
      hostVersion: '1.14.17',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
      spawnProcess: () => ({} as any),
      log,
    });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('OpenCode v1.14'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('spawn-process');
  });

  // ─── resetBufferState contract ──────────────────────────────────────────
  // Per-band guarantee that the method is wired. Deep wipe-set + journey
  // assertions live in `src/modules/reset-buffer-state.scenarios.test.ts`.
  const minimalHost = {
    hostVersion: '1.14.17',
    cwd: '/proj',
    getText: () => '',
    getCursorOffset: () => 0,
    setText: () => {},
    setCursorOffset: () => {},
    forceRender: () => {},
  };

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

  it('glimmer is RENDER-ONLY: frames arrive as textOverride directives, the buffer is NEVER written', async () => {
    // Mirrors the shell band's pin (adapters/shell/v1/boot.test.ts) —
    // real-write mode is retired on BOTH OpenTUI bands; the fork
    // bootstrap paints the override diff as a display-only overlay.
    const setTextCalls: string[] = [];
    const text = 'hello zephyr world';
    const result = boot({
      ...minimalHost,
      getText: () => text,
      setText: (s: string) => { setTextCalls.push(s); },
    });
    result.glimmer.start(6, 'zephyr');
    await new Promise((r) => setTimeout(r, 40));
    const frames = result.collectRenderDirectives(text, 12);
    const override = frames.map((d) => d.textOverride).find((o): o is string => typeof o === 'string');
    expect(override, 'render-only glimmer must emit a textOverride directive').toBeDefined();
    expect(override).toHaveLength(text.length);
    expect(override).not.toBe(text);
    expect(setTextCalls, 'the buffer must never hold a scrambled frame').toEqual([]);
    result.glimmer.cancel(false);
    const after = result.collectRenderDirectives(text, 12)
      .map((d) => d.textOverride).find((o): o is string => typeof o === 'string');
    expect(after).toBeUndefined();
    expect(setTextCalls).toEqual([]);
    result.dispose();
  });
});
