import { describe, expect, it, vi } from 'vitest';
import { boot, resolveAgentWindowWords, VSCODE_DEFAULT_AGENT_WINDOW_WORDS } from './boot';
import { VscodeV1Adapter, type VscodeBindings } from './adapter';
import type { KeyEvent } from '../../../src/adapter';

function makeHost(overrides: Partial<Parameters<typeof boot>[0]> = {}): Parameters<typeof boot>[0] {
  return {
    hostVersion: '1.90.0',
    cwd: '/workspace',
    getText: () => '',
    getCursorOffset: () => 0,
    setText: () => {},
    setCursorOffset: () => {},
    forceRender: () => {},
    ...overrides,
  };
}

function makeBindings(overrides: Partial<VscodeBindings> = {}): VscodeBindings {
  return {
    hostVersion: '1.90.0',
    cwd: '/workspace',
    getText: () => '',
    getCursorOffset: () => 0,
    setText: () => {},
    setCursorOffset: () => {},
    forceRender: () => {},
    registerKeyHandler: () => () => {},
    registerTextChangeHandler: () => () => {},
    registerCursorChangeHandler: () => () => {},
    registerRenderHandler: () => () => {},
    ...overrides,
  };
}

describe('VS Code v1 boot()', () => {
  it('returns the full BootResult surface', () => {
    const result = boot(makeHost());
    expect(typeof result.dispatchKey).toBe('function');
    expect(typeof result.notifyTextChange).toBe('function');
    expect(typeof result.notifyCursorChange).toBe('function');
    expect(typeof result.collectRenderDirectives).toBe('function');
    expect(typeof result.resetBufferState).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });

  it('logs "OpenCues runtime starting" with host vscode', () => {
    const log = vi.fn();
    boot(makeHost({ log }));
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('OpenCues runtime starting'),
      expect.objectContaining({ host: 'vscode' }),
    );
  });

  it('capabilities: spawn-process/blank-invoke only when bindings supplied; never render-override', () => {
    const log = vi.fn();
    boot(makeHost({ log }));
    const startup = log.mock.calls.find(c => String(c[1]).includes('VS Code v1'));
    const caps = (startup?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('dim-ranges');
    expect(caps).toContain('highlight-range');
    expect(caps).toContain('selection');
    expect(caps).toContain('render-rgb-color');
    expect(caps).toContain('change-source');
    // Decorations cannot display text that differs from the buffer.
    expect(caps).not.toContain('render-override');
    expect(caps).not.toContain('spawn-process');

    const log2 = vi.fn();
    boot(makeHost({
      log: log2,
      spawnProcess: () => ({ pid: 1 } as never),
      blankInvoke: () => null,
    }));
    const startup2 = log2.mock.calls.find(c => String(c[1]).includes('VS Code v1'));
    const caps2 = (startup2?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps2).toContain('spawn-process');
    expect(caps2).toContain('blank-invoke');
  });

  it('Navigation subscribed — Ctrl+Alt+Left consumed when text has words', () => {
    let text = 'alpha beta gamma';
    let cursor = 0;
    const result = boot(makeHost({
      getText: () => text,
      getCursorOffset: () => cursor,
      setText: (t) => { text = t; },
      setCursorOffset: (c) => { cursor = c; },
    }));
    const consumed = result.dispatchKey({
      key: 'left',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text,
      cursorOffset: cursor,
    } satisfies KeyEvent);
    expect(consumed).toBe(true);
  });

  it('dispatchKey returns false when nothing consumes', () => {
    const result = boot(makeHost());
    expect(result.dispatchKey({
      key: 'up',
      modifiers: { ctrl: true, alt: true, shift: false, meta: false },
      text: '',
      cursorOffset: 0,
    })).toBe(false);
  });

  it('statusSnapshotHook fires on render when supplied', () => {
    const onSnap = vi.fn();
    const result = boot(makeHost({ statusSnapshotHook: onSnap }));
    result.collectRenderDirectives('hello world', 0);
    expect(onSnap).toHaveBeenCalled();
  });

  it('resetBufferState is idempotent and resets the diff baseline', () => {
    const result = boot(makeHost());
    result.notifyTextChange('first document text', 5, 'user');
    result.resetBufferState();
    result.resetBufferState(); // second call must not throw
    // After a reset the next change event must not diff against the
    // previous document — verified indirectly: no throw, and a fresh
    // change goes through cleanly.
    result.notifyTextChange('second document', 3, 'user');
  });

  it('TTS wiring accepts speakFn without a script path (D16)', () => {
    const speakFn = vi.fn();
    const result = boot(makeHost({ speakFn }));
    expect(typeof result.dispatchKey).toBe('function');
  });
});

describe('resolveAgentWindowWords (D14 band default)', () => {
  it('defaults to the band window when unset/blank/garbage', () => {
    expect(resolveAgentWindowWords(undefined)).toBe(VSCODE_DEFAULT_AGENT_WINDOW_WORDS);
    expect(resolveAgentWindowWords('')).toBe(VSCODE_DEFAULT_AGENT_WINDOW_WORDS);
    expect(resolveAgentWindowWords('abc')).toBe(VSCODE_DEFAULT_AGENT_WINDOW_WORDS);
  });
  it('explicit values win — including 0 (whole-buffer opt-out)', () => {
    expect(resolveAgentWindowWords('0')).toBe(0);
    expect(resolveAgentWindowWords('250')).toBe(250);
  });
});

describe('VscodeV1Adapter capability probes', () => {
  it('supportsCycling defaults true when binding absent', () => {
    const adapter = new VscodeV1Adapter(makeBindings());
    expect(adapter.supportsCycling()).toBe(true);
  });

  it('supportsCycling threads the binding verdict (live re-evaluation)', () => {
    let verdict = true;
    const adapter = new VscodeV1Adapter(makeBindings({ supportsCycling: () => verdict }));
    expect(adapter.supportsCycling()).toBe(true);
    verdict = false; // editor switched to an off-allowlist / over-gate document
    expect(adapter.supportsCycling()).toBe(false);
  });

  it('supportsCycling swallows a throwing probe as true', () => {
    const adapter = new VscodeV1Adapter(makeBindings({
      supportsCycling: () => { throw new Error('editor disposed'); },
    }));
    expect(adapter.supportsCycling()).toBe(true);
  });

  it('supportsAgentRewrite threads the binding verdict', () => {
    const adapter = new VscodeV1Adapter(makeBindings({ supportsAgentRewrite: () => false }));
    expect(adapter.supportsAgentRewrite()).toBe(false);
  });

  it('getSelection routes to the binding (real selections, unlike shell)', () => {
    const adapter = new VscodeV1Adapter(makeBindings({
      getSelection: () => ({ start: 2, end: 7 }),
    }));
    expect(adapter.getSelection()).toEqual({ start: 2, end: 7 });
  });
});
