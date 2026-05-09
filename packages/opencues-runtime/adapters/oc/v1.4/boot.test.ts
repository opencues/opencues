import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import type { KeyEvent } from '../../../src/adapter';

describe('OpenCode v1.4 boot()', () => {
  it('returns dispatchKey + notifyTextChange + dispose handles', () => {
    const result = boot({
      hostVersion: '1.4.11',
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
      hostVersion: '1.4.11',
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
      hostVersion: '1.4.11',
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
      hostVersion: '1.4.11',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
      log,
    });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('OpenCode v1.4'));
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
      hostVersion: '1.4.11',
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
      hostVersion: '1.4.11',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
      spawnProcess: () => ({} as any),
      log,
    });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('OpenCode v1.4'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('spawn-process');
  });
});
