import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import { UniversalV1Adapter } from './adapter';
import type { KeyEvent } from '../../../src/adapter';

describe('universal v1 boot()', () => {
  const minimalHost = {
    hostName: 'apple-notes',
    hostVersion: '0.1.0',
    cwd: '/proj',
    getText: () => '',
    getCursorOffset: () => 0,
    setText: () => {},
    setCursorOffset: () => {},
    forceRender: () => {},
  };

  it('returns notifyTextChange + resetBufferState + dispose handles', () => {
    const result = boot(minimalHost);
    expect(typeof result.notifyTextChange).toBe('function');
    expect(typeof result.resetBufferState).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });

  it('dispatchKey stub always returns false (no key channel)', () => {
    const result = boot(minimalHost);
    const evt: KeyEvent = {
      key: 'left',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text: '',
      cursorOffset: 0,
    };
    expect(result.dispatchKey(evt)).toBe(false);
  });

  it('logs "OpenCues runtime starting (universal v1)" with the declared hostName', () => {
    const log = vi.fn();
    boot({ ...minimalHost, log });
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('universal v1, host: apple-notes'),
      expect.objectContaining({ host: 'apple-notes' }),
    );
  });

  it('reports the no-render capability set (no dim/rgb/spawn by default)', () => {
    const log = vi.fn();
    boot({ ...minimalHost, log });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('universal v1'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('file-read');
    expect(caps).toContain('file-write');
    expect(caps).toContain('force-render');
    expect(caps).not.toContain('dim-ranges');
    expect(caps).not.toContain('render-rgb-color');
    expect(caps).not.toContain('render-override');
    expect(caps).not.toContain('spawn-process');
  });

  it('opt-in spawn-process when host supplies spawnProcess', () => {
    const log = vi.fn();
    boot({ ...minimalHost, spawnProcess: () => ({} as any), log });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('universal v1'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('spawn-process');
  });

  // ─── universal/no-cycling profile pins ──────────────────────────────────
  const minimalBindings = {
    hostName: 'apple-notes',
    hostVersion: '0.1.0',
    cwd: '/proj',
    getText: () => '',
    getCursorOffset: () => 0,
    setText: () => {},
    setCursorOffset: () => {},
    forceRender: () => {},
    registerKeyHandler: () => () => {},
    registerTextChangeHandler: () => () => {},
  };

  it('adapter advertises supportsCycling() === false', () => {
    const adapter = new UniversalV1Adapter(minimalBindings);
    expect(adapter.supportsCycling()).toBe(false);
    expect(adapter.supportsAgentRewrite()).toBe(false);
  });

  it('adapter passes getAnswerCharBudget through; null when absent or throwing', () => {
    expect(new UniversalV1Adapter(minimalBindings).getAnswerCharBudget()).toBe(null);
    expect(new UniversalV1Adapter({
      ...minimalBindings, getAnswerCharBudget: () => 37,
    }).getAnswerCharBudget()).toBe(37);
    expect(new UniversalV1Adapter({
      ...minimalBindings, getAnswerCharBudget: () => { throw new Error('boom'); },
    }).getAnswerCharBudget()).toBe(null);
  });

  it('adapter onKey/onCursorChange/onRender return unsubscribes', () => {
    const adapter = new UniversalV1Adapter(minimalBindings);
    expect(() => {
      adapter.onKey(null, () => true)();
      adapter.onKey({ keys: ['_'] }, () => true)();
      adapter.onCursorChange(() => {})();
      adapter.onRender(() => null)();
    }).not.toThrow();
  });

  // ─── resetBufferState contract (mirrors shell/chrome band tests) ────────
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

  it('notifyTextChange with source=runtime does not throw with no subscribers', () => {
    const result = boot(minimalHost);
    expect(() => {
      result.notifyTextChange('hello _', 6, 'user');
      result.notifyTextChange('hello world', 11, 'runtime');
    }).not.toThrow();
  });
});
