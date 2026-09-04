import { describe, expect, it } from 'vitest';
import { boot, type HostInfo } from './boot';
import { wrapTipsAsCuesMd } from '../../../testing/mock-adapter';

const TIPS = wrapTipsAsCuesMd({
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
      // cwd is '/test' (fakeHost default), cc boot adds `.cues`
      // to every search path — serve TIPS from /test/.cues/CUES.md
      // (mirrors what the adapter looks for in production).
      readFile: async (p: string) => p === '/test/.cues/CUES.md' ? TIPS : null,
    });
    const result = boot(host);
    // Wait for ConfigLoader's async readFile chain to settle. One
    // microtask isn't enough — loading + parsing + populating cueMap
    // takes several promise tiers. A short setTimeout drains all
    // outstanding microtasks reliably.
    await new Promise(r => setTimeout(r, 50));
    // Seed the def directly to decouple from configLoader timing.
    // In production, Cycling.handler calls buildDefFrom which looks up
    // the word in configLoader.lookup; this test pre-seeds the def so
    // the test is purely about the dispatch → setText → consumePendingRender
    // chain, not about the cueMap loader race.
    result.dynDefs.set(0, {
      originalWord: 'fast',
      alternatives: ['fast', 'quick', 'rapid'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 4,
    });
    // Activate highlight directly — bypass Navigation so the test is
    // about the cycle → setText → consumePendingRender chain only,
    // not about Navigation's target-discovery race against the async
    // cueMap load.
    result.hlState.activate(0, 'fast slow');
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

  it('KeyEvent.text + cursorOffset are ZWS-stripped before reaching onKey handlers', () => {
    // Regression: without the strip, Resolver.onUnderscoreKey's standalone-`_`
    // check sees the render-kick `\u200B` glued to the cursor word and refuses
    // to arm — masking the second `_` in a chain (`draft email _` →
    // `… translate to japanese _`). See boot.ts:708-727.
    const host = fakeHost('');
    const result = boot(host);
    const seen: Array<{ key: string; text: string; cursorOffset: number }> = [];
    result.adapter.onKey(null, e => {
      seen.push({ key: e.key, text: e.text, cursorOffset: e.cursorOffset });
      return false;
    });
    // Buffer was render-kicked: `prev\u200B translate to japanese ` with the
    // ZWS glued to the first word; user just pressed `_` after the trailing
    // space, so cursorOffset points to the end (in ZWS-bearing space).
    const dirty = 'prev\u200B translate to japanese ';
    result.dispatchKey({ key: '_' }, dirty, dirty.length);
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe('prev translate to japanese ');
    expect(seen[0].cursorOffset).toBe('prev translate to japanese '.length);
    expect(seen[0].text).not.toMatch(/[\u200B\u200C]/);
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

  // ─── resetBufferState contract ──────────────────────────────────────────
  // Per-band guarantee that the method is wired. Deep wipe-set + journey
  // assertions live in `src/modules/reset-buffer-state.scenarios.test.ts`.
  it('exposes resetBufferState as a method', () => {
    const result = boot(fakeHost());
    expect(typeof result.resetBufferState).toBe('function');
  });

  it('resetBufferState is idempotent on a cold boot (no prior state)', () => {
    const result = boot(fakeHost());
    expect(() => {
      result.resetBufferState();
      result.resetBufferState();
      result.resetBufferState();
    }).not.toThrow();
  });

  it('resetBufferState clears dynDefs populated by a prior cycle', () => {
    // Integration-flavoured check at the boot-result level: dispatch a
    // navigation key to populate dynDefs, then reset, then assert dynDefs
    // is empty via the BootResult's exposed handle.
    const host = fakeHost('alpha beta gamma');
    const result = boot(host);
    result.dispatchKey({ key: 'left', ctrl: true, alt: true }, host.getText(), 0);
    expect(result.hlState.active).toBe(true);

    result.resetBufferState();

    expect(result.dynDefs.size).toBe(0);
    expect(result.hlState.active).toBe(false);
  });

  // ── Viewport-slice rendering (the "draft email _ doesn't go grey" bug,
  // Sep 2026). CC hands applyRender only the VISIBLE lines of a tall
  // buffer; spans are full-buffer coords. Pre-fix, the ctx was built from
  // the slice, DimRender's stale-def guard rejected every scrolled span,
  // and a tall transform-blank rewrite lost its dim + inline note. These
  // pin the SCENARIO at the boot-result level (fake host, real modules).
  describe('viewport-slice rendering', () => {
    // A transform-blank-shaped rewrite taller than the input zone: the
    // host scrolls, S3 hands applyRender only the tail lines.
    const FULL = 'AAA first line\n\nBBB middle line\n\nCCC last line';
    const SLICE = FULL.slice(FULL.indexOf('BBB')); // first line scrolled off

    function bootWithSpanDef(text: string) {
      const host = fakeHost(text);
      const result = boot(host);
      result.dynDefs.set(0, {
        originalWord: text,
        blankName: 'transform-blank',
        alternatives: [text, 'draft email _'],
        currentIndex: 0,
        spanStart: 0,
        spanEnd: text.length,
        clearOnEdit: true,
      });
      return { host, result };
    }

    it('scrolled slice still paints the span dim (ranges translated to slice coords)', () => {
      const { result } = bootWithSpanDef(FULL);
      const out = result.applyRender(SLICE, FULL, FULL.length) as string;
      // The span [0, FULL.length) covers the whole slice → dim codes present,
      // and never beyond the slice's own length.
      expect(out).not.toBe(SLICE);
      expect(out).toContain('\x1b[2m'); // ANSI dim on
    });

    it('scrolled slice with the CC cursor-cell pad space still translates', () => {
      const { result } = bootWithSpanDef(FULL);
      const out = result.applyRender(SLICE + ' ', FULL, FULL.length) as string;
      expect(out).toContain('\x1b[2m');
    });

    it('unscrolled buffer behaves exactly as before (span dims at full coords)', () => {
      const { result } = bootWithSpanDef('short span');
      const out = result.applyRender('short span', 'short span', 0) as string;
      expect(out).toContain('\x1b[2m');
    });

    it('non-contiguous slice falls back to pre-fix behaviour (no crash, no phantom dim)', () => {
      const { result } = bootWithSpanDef(FULL);
      // Simulate soft-wrap: the rendered text has an inserted newline the
      // buffer doesn't contain → slice can't be located → legacy ctx.
      const wrapped = 'CCC last\nline';
      expect(() => result.applyRender(wrapped, FULL, 0)).not.toThrow();
    });

    it('span entirely above the viewport paints nothing into the slice', () => {
      const host = fakeHost(FULL);
      const result = boot(host);
      result.dynDefs.set(0, {
        originalWord: 'AAA',
        blankName: 'transform-blank',
        alternatives: ['AAA', 'ZZZ'],
        currentIndex: 0,
        spanStart: 0,
        spanEnd: 3, // covers only the scrolled-off first line
        clearOnEdit: true,
      });
      const out = result.applyRender(SLICE, FULL, FULL.length) as string;
      expect(out).toBe(SLICE); // off-screen span → no codes injected into the slice
    });
  });
});
