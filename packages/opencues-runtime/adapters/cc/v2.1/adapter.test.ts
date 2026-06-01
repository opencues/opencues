import { describe, expect, it } from 'vitest';
import { ClaudeCodeV21Adapter, type HostBindings, normaliseKeyEvent, toggleZeroWidth } from './adapter';
import type { KeyEvent, RenderContext, RenderDirectives, TextChangeEvent, Unsubscribe } from '../../../src/adapter';

class FakeBindings implements HostBindings {
  readonly hostVersion = '2.1.110';
  readonly cwd = '/test/cwd';

  private _text = '';
  private _offset = 0;
  forceRenderCalls = 0;

  private _keyHandlers: Array<(e: KeyEvent) => boolean> = [];
  private _renderHandlers: Array<(c: RenderContext) => RenderDirectives | null> = [];
  private _textHandlers: Array<(e: TextChangeEvent) => void> = [];

  getText(): string { return this._text; }
  getCursorOffset(): number { return this._offset; }
  setText(t: string): void {
    const prev = this._text;
    this._text = t;
    if (this._offset > t.length) this._offset = t.length;
    for (const h of [...this._textHandlers]) {
      h({ text: t, cursorOffset: this._offset, previousText: prev, source: 'runtime' });
    }
  }
  setCursorOffset(o: number): void { this._offset = Math.max(0, Math.min(o, this._text.length)); }
  forceRender(): void { this.forceRenderCalls += 1; }

  registerKeyHandler(cb: (e: KeyEvent) => boolean): Unsubscribe {
    this._keyHandlers.push(cb);
    return () => { this._keyHandlers = this._keyHandlers.filter(h => h !== cb); };
  }
  registerRenderHandler(cb: (c: RenderContext) => RenderDirectives | null): Unsubscribe {
    this._renderHandlers.push(cb);
    return () => { this._renderHandlers = this._renderHandlers.filter(h => h !== cb); };
  }
  registerTextChangeHandler(cb: (e: TextChangeEvent) => void): Unsubscribe {
    this._textHandlers.push(cb);
    return () => { this._textHandlers = this._textHandlers.filter(h => h !== cb); };
  }

  fireRawKey(raw: { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }): boolean {
    const event = normaliseKeyEvent(raw, this._text, this._offset);
    for (const h of [...this._keyHandlers]) {
      if (h(event)) return true;
    }
    return false;
  }

  pushUserText(t: string): void {
    const prev = this._text;
    this._text = t;
    for (const h of [...this._textHandlers]) {
      h({ text: t, cursorOffset: this._offset, previousText: prev, source: 'user' });
    }
  }
}

describe('ClaudeCodeV21Adapter', () => {
  it('advertises expected capabilities', () => {
    const a = new ClaudeCodeV21Adapter(new FakeBindings());
    expect(a.hostName).toBe('claude-code');
    expect(a.hostVersion).toBe('2.1.110');
    expect(a.capabilities).toContain('file-read');
    expect(a.capabilities).toContain('force-render');
    expect(a.capabilities).toContain('render-override');
  });

  it('getters fall back to sensible defaults on binding errors', () => {
    const errorBindings = new FakeBindings();
    (errorBindings as unknown as { getText: () => string }).getText = () => { throw new Error('boom'); };
    (errorBindings as unknown as { getCursorOffset: () => number }).getCursorOffset = () => { throw new Error('boom'); };
    const a = new ClaudeCodeV21Adapter(errorBindings);
    expect(a.getText()).toBe('');
    expect(a.getCursorOffset()).toBe(0);
  });

  it('routes onKey filters', () => {
    const b = new FakeBindings();
    const a = new ClaudeCodeV21Adapter(b);
    let hits = 0;
    a.onKey({ keys: ['left'], requireModifiers: ['ctrl', 'alt'] }, () => { hits += 1; return true; });

    expect(b.fireRawKey({ key: 'left', ctrl: true, alt: true })).toBe(true);
    expect(hits).toBe(1);

    expect(b.fireRawKey({ key: 'left' })).toBe(false);
    expect(b.fireRawKey({ key: 'right', ctrl: true, alt: true })).toBe(false);
    expect(hits).toBe(1);
  });

  it('normaliseKeyEvent treats option/meta as alt', () => {
    const e = normaliseKeyEvent({ key: 'left', ctrl: true, option: true }, '', 0);
    expect(e.modifiers.ctrl).toBe(true);
    expect(e.modifiers.alt).toBe(true);
  });

  it('Mac Terminal.app double-ESC arrow synthesises ctrl=true (Ctrl+Option+arrow has no Ctrl byte in stream)', () => {
    // Ink parses `\x1b\x1b[A` (Mac Terminal Ctrl+Option+Up) as
    // { key: 'up', option: true, ctrl: false } per parse-keypress.js:471.
    // The runtime's `ctrl-alt` matcher needs ctrl=true to fire; the synth
    // is what closes the loop on Mac Terminal.app users.
    for (const key of ['up', 'down', 'left', 'right'] as const) {
      const e = normaliseKeyEvent({ key, option: true }, '', 0);
      expect(e.modifiers.ctrl).toBe(true);
      expect(e.modifiers.alt).toBe(true);
    }
  });

  it('Mac double-ESC synth does NOT fire on non-arrow keys (avoid hijacking Option+letter)', () => {
    const e = normaliseKeyEvent({ key: 'a', option: true }, '', 0);
    expect(e.modifiers.ctrl).toBe(false);
    expect(e.modifiers.alt).toBe(true);
  });

  it('Mac double-ESC synth does not re-trigger when ctrl was already set (Ghostty/iTerm2 path)', () => {
    // Modifier-encoded CSI from Ghostty/iTerm2 arrives with ctrl=true already;
    // the synth is conditional on !ctrl so this path is unchanged.
    const e = normaliseKeyEvent({ key: 'up', ctrl: true, option: true }, '', 0);
    expect(e.modifiers.ctrl).toBe(true);
    expect(e.modifiers.alt).toBe(true);
  });

  it('forceRender is gated by capability', () => {
    const b = new FakeBindings();
    const a = new ClaudeCodeV21Adapter(b, ['file-read']); // no force-render
    a.forceRender();
    expect(b.forceRenderCalls).toBe(0);

    const b2 = new FakeBindings();
    const a2 = new ClaudeCodeV21Adapter(b2);
    a2.forceRender();
    expect(b2.forceRenderCalls).toBe(1);
  });

  it('dispose detaches root subscriptions and is idempotent', () => {
    const b = new FakeBindings();
    const a = new ClaudeCodeV21Adapter(b);
    a.onKey(null, () => true);
    expect(b.fireRawKey({ key: 'x', ctrl: true, alt: true })).toBe(true);
    a.dispose();
    a.dispose();
    expect(b.fireRawKey({ key: 'x', ctrl: true, alt: true })).toBe(false);
  });

  it('setCursorOffset clamps to text length', () => {
    const b = new FakeBindings();
    b.setText('hello');
    const a = new ClaudeCodeV21Adapter(b);
    a.setCursorOffset(100);
    expect(b.getCursorOffset()).toBe(5);
    a.setCursorOffset(-5);
    expect(b.getCursorOffset()).toBe(0);
  });

  it('readFile returns null and writeFile rejects when bindings omit fs methods', async () => {
    const a = new ClaudeCodeV21Adapter(new FakeBindings());
    await expect(a.readFile('/any/path')).resolves.toBeNull();
    await expect(a.writeFile('/x', 'y')).rejects.toThrow(/file-write/);
  });
});

describe('toggleZeroWidth', () => {
  const ZWS = '\u200b';
  const ZWNJ = '\u200c';

  it('adds ZWS when text has no trailing zero-width char', () => {
    expect(toggleZeroWidth('hello')).toBe(`hello${ZWS}`);
  });

  it('flips ZWS to ZWNJ', () => {
    expect(toggleZeroWidth(`hello${ZWS}`)).toBe(`hello${ZWNJ}`);
  });

  it('flips ZWNJ to ZWS', () => {
    expect(toggleZeroWidth(`hello${ZWNJ}`)).toBe(`hello${ZWS}`);
  });

  it('strips accumulated trailing ZW chars before toggling', () => {
    expect(toggleZeroWidth(`hello${ZWS}${ZWNJ}${ZWS}`)).toBe(`hello${ZWNJ}`);
    expect(toggleZeroWidth(`hello${ZWNJ}${ZWS}${ZWNJ}`)).toBe(`hello${ZWS}`);
  });

  it('empty text yields a single ZWS', () => {
    expect(toggleZeroWidth('')).toBe(ZWS);
  });

  it('preserves non-trailing ZW chars (text in the middle)', () => {
    // If a ZW char is embedded mid-string, only trailing ones strip. Keeps
    // the invariant that the toggle doesn't corrupt user text.
    expect(toggleZeroWidth(`a${ZWS}b`)).toBe(`a${ZWS}b${ZWS}`);
  });

  it('successive toggles guarantee a different string each time', () => {
    let t = 'navigating words';
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      t = toggleZeroWidth(t);
      seen.add(t);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2); // alternates between two states
  });
});
