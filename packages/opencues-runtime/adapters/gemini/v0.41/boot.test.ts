import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import type { KeyEvent } from '../../../src/adapter';

describe('Gemini CLI v0.41 boot()', () => {
  it('returns the expected BootResult surface', () => {
    const result = boot({
      hostVersion: '0.41.x',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
    });
    expect(typeof result.dispatchKey).toBe('function');
    expect(typeof result.notifyTextChange).toBe('function');
    expect(typeof result.notifyCursorChange).toBe('function');
    expect(typeof result.collectRenderDirectives).toBe('function');
    expect(typeof result.decorateLine).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });

  it('dispatchKey returns false when no handler subscribed', () => {
    const result = boot({
      hostVersion: '0.41.x',
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

  it('logs "OpenCues runtime starting (Gemini CLI v0.41)" via host.log', () => {
    const log = vi.fn();
    boot({
      hostVersion: '0.41.x',
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
      expect.objectContaining({ host: 'gemini-cli' }),
    );
  });

  it('reports the right capability set (no spawn unless host.spawnProcess)', () => {
    const log = vi.fn();
    boot({
      hostVersion: '0.41.x',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
      log,
    });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('Gemini CLI v0.41'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('file-read');
    expect(caps).toContain('file-write');
    expect(caps).toContain('force-render');
    expect(caps).toContain('dim-ranges');
    expect(caps).not.toContain('spawn-process');
  });

  it('Phase G.3: Navigation subscribed — Ctrl+Alt+Left consumed when text has words', () => {
    let text = 'alpha beta gamma';
    let cursor = 0;
    const result = boot({
      hostVersion: '0.41.x',
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
      hostVersion: '0.41.x',
      cwd: '/proj',
      getText: () => '',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
      spawnProcess: () => ({} as any),
      log,
    });
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('Gemini CLI v0.41'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('spawn-process');
  });

  // ─── React-render contract pins ───────────────────────────────────
  //
  // These tests pin the gemini-specific render-integration invariants
  // that the headless agentic harness can't catch (because headless
  // bypasses the React render path entirely via headlessTrigger).
  // Regressing any of these breaks interactive Gemini in ways the
  // unit suite would otherwise be silent about.

  it('host.forceRender fires when runtime calls setText (React kick contract)', () => {
    let text = 'alpha beta gamma';
    const forceRender = vi.fn();
    const result = boot({
      hostVersion: '0.41.x',
      cwd: '/proj',
      getText: () => text,
      getCursorOffset: () => 0,
      setText: (t) => { text = t; },
      setCursorOffset: () => {},
      forceRender,
    });
    // Trigger Navigation's activate path — it calls adapter.setText
    // (cursor) + adapter.forceRender. Both routes through the kick.
    result.dispatchKey({
      key: 'left',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text, cursorOffset: 0,
    });
    // Without the host.forceRender?.() call inside wrappedForceRender
    // / wrappedSetCursorOffset, React never re-renders → the symptom
    // is "swap doesn't show until I move my cursor".
    expect(forceRender).toHaveBeenCalled();
  });

  it('consumePendingRender returns null when nothing is pending', () => {
    const result = boot({
      hostVersion: '0.41.x',
      cwd: '/proj',
      getText: () => 'hello',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
    });
    expect(result.consumePendingRender('hello', 0)).toBeNull();
  });

  it('consumePendingRender returns ZWS-toggled text after a forceRender-only pulse', () => {
    let text = 'alpha beta gamma';
    const result = boot({
      hostVersion: '0.41.x',
      cwd: '/proj',
      getText: () => text,
      getCursorOffset: () => 0,
      setText: (t) => { text = t; },
      setCursorOffset: () => {},
      forceRender: () => {},
    });
    // Dispatch nav to force pendingRender = true via Navigation's
    // activate → adapter.forceRender path.
    result.dispatchKey({
      key: 'left',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text, cursorOffset: 0,
    });
    // Navigation also queues pendingCursor (it called setCursorOffset
    // during activate). Drain that first via consumePendingRender,
    // then any subsequent forceRender-only pulse would return ZWS.
    // For this contract test we just verify SOMETHING comes out and
    // that a second consume returns null (idempotent drain).
    const first = result.consumePendingRender(text, 0);
    expect(first).not.toBeNull();
    // Drain again — should be null now.
    const second = result.consumePendingRender(first?.text ?? text, first?.cursor ?? 0);
    expect(second).toBeNull();
  });

  it('decorateLine is a fast pass-through when no render handlers subscribed', () => {
    const result = boot({
      hostVersion: '0.41.x',
      cwd: '/proj',
      getText: () => 'hello world',
      getCursorOffset: () => 0,
      setText: () => {},
      setCursorOffset: () => {},
      forceRender: () => {},
    });
    // No DimRender handlers subscribed yet (no LLM key, no resolver)
    // — decorateLine should return the lineText verbatim.
    expect(result.decorateLine('hello world', 'hello world', 0, 0, 11)).toBe('hello world');
  });
});
