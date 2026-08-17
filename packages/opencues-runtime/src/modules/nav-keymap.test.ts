import { describe, expect, it, afterEach } from 'vitest';
import { resolveNavKeymap } from './nav-keymap';

const ORIGINAL_TERM_PROGRAM = process.env.TERM_PROGRAM;

afterEach(() => {
  if (ORIGINAL_TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
  else process.env.TERM_PROGRAM = ORIGINAL_TERM_PROGRAM;
});

describe('resolveNavKeymap', () => {
  it('explicit ctrl-alt is honoured on every host', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    expect(resolveNavKeymap('ctrl-alt', 'mock')).toBe('ctrl-alt');
    expect(resolveNavKeymap('ctrl-alt', 'chrome')).toBe('ctrl-alt');
    expect(resolveNavKeymap('ctrl-alt', 'claude-code')).toBe('ctrl-alt');
  });

  it('explicit ctrl-shift is honoured on terminal hosts, even when running in Apple_Terminal', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    expect(resolveNavKeymap('ctrl-shift', 'claude-code')).toBe('ctrl-shift');
    delete process.env.TERM_PROGRAM;
    expect(resolveNavKeymap('ctrl-shift', 'opencode')).toBe('ctrl-shift');
  });

  it('chrome ignores explicit ctrl-shift and pins to ctrl-alt — browser owns ctrl-shift+arrow', () => {
    // The chrome adapter band doesn't subscribe ctrl-shift at all
    // (see navigation.ts / cycling.ts), so this branch is belt-and-
    // braces — if someone wires the runtime up differently, the
    // resolver still keeps chrome on the safe combo.
    expect(resolveNavKeymap('ctrl-shift', 'chrome')).toBe('ctrl-alt');
  });

  it('auto resolves to ctrl-alt on macOS Terminal.app — Ctrl+Option+arrow survives as Meta-prefixed CSI and adapters coalesce option/meta → alt', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    expect(resolveNavKeymap('auto', 'claude-code')).toBe('ctrl-alt');
    expect(resolveNavKeymap('auto', 'opencode')).toBe('ctrl-alt');
    expect(resolveNavKeymap('auto', 'shell')).toBe('ctrl-alt');
  });

  it('auto resolves to ctrl-alt on Ghostty / iTerm2 / no TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'ghostty';
    expect(resolveNavKeymap('auto', 'claude-code')).toBe('ctrl-alt');
    process.env.TERM_PROGRAM = 'iTerm.app';
    expect(resolveNavKeymap('auto', 'claude-code')).toBe('ctrl-alt');
    delete process.env.TERM_PROGRAM;
    expect(resolveNavKeymap('auto', 'claude-code')).toBe('ctrl-alt');
  });

  it('auto resolves to ctrl-alt for chrome — TERM_PROGRAM is irrelevant in a browser', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    expect(resolveNavKeymap('auto', 'chrome')).toBe('ctrl-alt');
  });
});

describe('resolveNavKeymap — every browser host, not just chrome', () => {
  // The rule is "the browser owns ctrl-shift+arrow", so it belongs to
  // browser-ness rather than to the name `chrome`. Written as
  // `hostName === 'chrome'` it silently gave the second browser host
  // (DeepSeek Harness) a keymap the page steals from it — navigation would
  // appear to do nothing, with no error to explain why.
  for (const host of ['chrome', 'dsh']) {
    it(`${host}: forces ctrl-alt even when ctrl-shift is configured`, () => {
      expect(resolveNavKeymap('auto', host)).toBe('ctrl-alt');
      expect(resolveNavKeymap('ctrl-shift', host)).toBe('ctrl-alt');
    });
  }

  it('a terminal host still honours an explicit ctrl-shift', () => {
    // The guard must not have widened into "nobody may pick ctrl-shift".
    expect(resolveNavKeymap('ctrl-shift', 'claude-code')).toBe('ctrl-shift');
  });
});
