import { describe, expect, it } from 'vitest';
import { boot, type HostInfo } from './boot';

const TIPS = JSON.stringify({
  domain: 'test',
  version: 1,
  concepts: [{ id: 'w', words: { fast: { tip: '', alts: ['quick', 'rapid'] } } }],
});

function fakeHost(text = 'alpha beta gamma', extras: Partial<HostInfo> = {}): HostInfo & { _text: string; _offset: number } {
  const state = { _text: text, _offset: 0 };
  return Object.assign(state, {
    hostVersion: '2.1.x',
    cwd: '/test',
    getText: () => state._text,
    getCursorOffset: () => state._offset,
    ...extras,
  });
}

describe('boot()', () => {
  it('returns a fully wired BootResult on first call', () => {
    const result = boot(fakeHost());
    expect(result.failed).toBe(false);
    expect(result.adapter.hostName).toBe('claude-code');
    expect(typeof result.dispatchKey).toBe('function');
    expect(typeof result.consumePendingRender).toBe('function');
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

  it('consumePendingRender returns ZWS-toggled text after Navigation forceRender', () => {
    const host = fakeHost('one two');
    const result = boot(host);
    expect(result.consumePendingRender(host.getText(), 0)).toBeNull();
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0);
    const pending = result.consumePendingRender(host.getText(), 0);
    expect(pending).not.toBeNull();
    // Just a ZWS toggle — original text is augmented with one zero-width char.
    expect(pending!.text.length).toBe(host.getText().length + 1);
    expect(pending!.cursor).toBe(0);
    expect(result.consumePendingRender(host.getText(), 0)).toBeNull(); // cleared after read
  });

  it('consumePendingRender returns Cycling text replacement when setText was called', async () => {
    const host = fakeHost('fast slow', {
      readFile: async (p: string) => p === '/tips.json' ? TIPS : null,
      tipsPath: '/tips.json',
    });
    const result = boot(host);
    await new Promise(r => setImmediate(r));
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0);
    result.consumePendingRender(host.getText(), 0);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0);
    result.consumePendingRender(host.getText(), 0);
    result.dispatchKey({ key: 'up', ctrl: true, alt: true }, host.getText(), 0);
    const pending = result.consumePendingRender(host.getText(), 0);
    expect(pending).not.toBeNull();
    expect(pending!.text).toBe('quick slow');
  });

  it('consumePendingRender ignores stale bindings.getText — uses passed args', () => {
    const host = fakeHost('fresh');
    const result = boot(host);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, 'fresh', 0);
    // Even if the host's getText would return something else (simulating a
    // stale closure), the explicit currentText arg wins.
    host._text = 'STALE';
    const pending = result.consumePendingRender('fresh', 5);
    expect(pending).not.toBeNull();
    // ZWS toggle of "fresh" — NOT "STALE".
    expect(pending!.text.startsWith('fresh')).toBe(true);
    expect(pending!.cursor).toBe(5);
  });

  it('applyRender wraps active word with inverse codes', () => {
    const host = fakeHost('alpha beta gamma');
    const result = boot(host);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0); // activate gamma
    const out = result.applyRender('alpha beta gamma', host.getText(), 0);
    expect(out).toBe('alpha beta \x1b[97mgamma\x1b[39m');
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

  it('fires user-source textChange when text drifts between dispatches', () => {
    const host = fakeHost('hello');
    const result = boot(host);
    const events: string[] = [];
    result.adapter.onTextChange(e => events.push(`${e.source}:${e.text}`));
    result.dispatchKey({ key: 'a' }, 'hello', 0); // baseline
    host._text = 'hellox';
    result.dispatchKey({ key: 'b' }, 'hellox', 6);
    expect(events).toContain('user:hellox');
  });

  it('does NOT fire textChange when only ZWS noise differs (our own toggle)', () => {
    const host = fakeHost('hello');
    const result = boot(host);
    const events: string[] = [];
    result.adapter.onTextChange(e => events.push(`${e.source}:${e.text}`));
    result.dispatchKey({ key: 'a' }, 'hello', 0);
    result.dispatchKey({ key: 'b' }, 'hello\u200B', 0); // pure ZWS toggle
    expect(events.filter(e => e.startsWith('user:'))).toHaveLength(0);
  });

  it('Ctrl+Alt+Right + applyRender — full visible-navigation pipeline', () => {
    const host = fakeHost('one two three');
    const result = boot(host);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0); // three
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0); // two
    expect(result.hlState.wordIndex).toBe(1);
    const out = result.applyRender('one two three', host.getText(), 0);
    expect(out).toBe('one \x1b[97mtwo\x1b[39m three');
  });
});
