import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  // REGRESSION (2026-07-25): this band was the ONLY one that never wired
  // calendarContext — cc/oc/gemini/shell/chrome all did. Both hosts on the
  // band (mac, apple-notes) answered "I don't have access to your calendar"
  // for `whats my next meeting _` even with a synced ~/.cues/calendar.json,
  // because the resolver was constructed without the holder. Reported live
  // in Apple Notes. Hermetic: OPENCUES_HOME is redirected to a mkdtemp dir
  // and restored, so this never reads or writes the real ~/.cues.
  describe('calendar-context wiring', () => {
    let tmp: string;
    let prevHome: string | undefined;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-universal-cal-'));
      prevHome = process.env.OPENCUES_HOME;
      process.env.OPENCUES_HOME = tmp;
    });
    afterEach(() => {
      if (prevHome === undefined) delete process.env.OPENCUES_HOME;
      else process.env.OPENCUES_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('loads the calendar.json snapshot into the resolver at boot', () => {
      fs.writeFileSync(path.join(tmp, 'calendar.json'), JSON.stringify({
        source: 'test',
        ingestedAt: '2026-07-25T19:00:00.000Z',
        events: [{ title: 'Standup', start: '2026-07-31T09:00', end: '2026-07-31T10:00' }],
      }));
      const log = vi.fn();
      const result = boot({ ...minimalHost, log });
      // Match on the message only — log() carries a third meta arg
      // (null here), so an exact toHaveBeenCalledWith(2-arg) never fits.
      const loaded = log.mock.calls.filter(c =>
        /calendar-context: 1 calendar event\(s\) loaded/.test(String(c[1])));
      expect(loaded).toHaveLength(1);
      result.dispose();
    });

    it('stays inert with no snapshot — no calendar log, boot still succeeds', () => {
      const log = vi.fn();
      const result = boot({ ...minimalHost, log });
      const calls = log.mock.calls.filter(c => String(c[1]).includes('calendar event(s) loaded'));
      expect(calls).toHaveLength(0);
      expect(typeof result.dispose).toBe('function');
      result.dispose();
    });
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
