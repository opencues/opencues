import { describe, expect, it } from 'vitest';
import { boot, type HostInfo } from './boot';

function fakeHost(text = 'alpha beta gamma'): HostInfo & { _text: string; _offset: number } {
  const state = { _text: text, _offset: 0 };
  return Object.assign(state, {
    hostVersion: '2.1.x',
    cwd: '/test',
    getText: () => state._text,
    getCursorOffset: () => state._offset,
  });
}

describe('boot()', () => {
  it('returns a fully wired BootResult on first call', () => {
    const result = boot(fakeHost());
    expect(result.failed).toBe(false);
    expect(result.adapter.hostName).toBe('claude-code');
    expect(typeof result.dispatchKey).toBe('function');
    expect(typeof result.consumePendingRender).toBe('function');
    expect(typeof result.toggleRenderText).toBe('function');
    expect(typeof result.applyRender).toBe('function');
  });

  it('Navigation is subscribed: Ctrl+Alt+Left consumes and activates highlight', () => {
    const host = fakeHost('alpha beta gamma');
    const result = boot(host);
    const consumed = result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0);
    expect(consumed).toBe(true);
    expect(result.hlState.active).toBe(true);
    expect(result.hlState.wordIndex).toBe(2); // gamma — rightmost
  });

  it('consumePendingRender flips after Navigation calls forceRender', () => {
    const host = fakeHost('one two');
    const result = boot(host);
    expect(result.consumePendingRender()).toBe(false);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0);
    expect(result.consumePendingRender()).toBe(true);
    expect(result.consumePendingRender()).toBe(false); // cleared after read
  });

  it('toggleRenderText alternates ZWS and ZWNJ', () => {
    const result = boot(fakeHost());
    const a = result.toggleRenderText('hello');
    const b = result.toggleRenderText(a);
    expect(a).not.toBe(b);
    expect(a.length).toBe(6);
    expect(b.length).toBe(6);
  });

  it('applyRender wraps active word with inverse codes', () => {
    const host = fakeHost('alpha beta gamma');
    const result = boot(host);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0); // activate gamma
    const out = result.applyRender('alpha beta gamma', host.getText(), 0);
    expect(out).toBe('alpha beta \x1b[7mgamma\x1b[27m');
  });

  it('applyRender pass-through when no handlers consumed (inactive state)', () => {
    const result = boot(fakeHost('alpha beta'));
    const out = result.applyRender('alpha beta', 'alpha beta', 0);
    expect(out).toBe('alpha beta');
  });

  it('applyRender pass-through for non-string input', () => {
    const result = boot(fakeHost());
    const obj = { not: 'a string' };
    expect(result.applyRender(obj, '', 0)).toBe(obj);
  });

  it('dispatchKey survives a throwing handler and reports via log', () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const host = Object.assign(fakeHost(), {
      log: (level: string, msg: string) => { logs.push({ level, msg }); },
    });
    const result = boot(host);
    // Inject a throwing handler via the adapter
    result.adapter.onKey(null, () => { throw new Error('boom'); });
    expect(() => result.dispatchKey({ key: 'x' }, '', 0)).not.toThrow();
    // Adapter catches the throw and logs via bindings.log (which routes here).
    expect(logs.some(l => l.level === 'error' && /handler threw/.test(l.msg))).toBe(true);
  });

  it('Ctrl+Alt+Right + applyRender — full visible-navigation pipeline', () => {
    const host = fakeHost('one two three');
    const result = boot(host);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0); // three
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0); // two
    expect(result.hlState.wordIndex).toBe(1);
    const out = result.applyRender('one two three', host.getText(), 0);
    expect(out).toBe('one \x1b[7mtwo\x1b[27m three');
  });
});
