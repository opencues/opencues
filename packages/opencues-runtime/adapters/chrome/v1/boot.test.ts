import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import type { KeyEvent } from '../../../src/adapter';

// Minimal HostInfo factory — use everywhere defaults make sense.
function makeHost(overrides: Partial<Parameters<typeof boot>[0]> = {}): Parameters<typeof boot>[0] {
  return {
    hostVersion: '0.1.0',
    cwd: '/chrome-storage',
    getText: () => '',
    getCursorOffset: () => 0,
    setText: () => {},
    setCursorOffset: () => {},
    forceRender: () => {},
    ...overrides,
  };
}

describe('Chrome v1 boot()', () => {
  it('returns dispatchKey + notifyTextChange + dispose handles', () => {
    const result = boot(makeHost());
    expect(typeof result.dispatchKey).toBe('function');
    expect(typeof result.notifyTextChange).toBe('function');
    expect(typeof result.dispose).toBe('function');
  });

  it('dispatchKey returns false when no handler subscribed', () => {
    const result = boot(makeHost());
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
    boot(makeHost({ log }));
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('OpenCues runtime starting'),
      expect.objectContaining({ host: 'chrome' }),
    );
  });

  it('NEVER advertises spawn-process even if host accidentally supplies one', () => {
    const log = vi.fn();
    // Chrome's HostInfo doesn't accept spawnProcess at the type level, but
    // verify the capability set never includes it regardless. Sandbox
    // contract: extension cannot fork processes.
    boot(makeHost({ log }));
    const startupCall = log.mock.calls.find(c => String(c[1]).includes('Chrome v1'));
    const caps = (startupCall?.[2] as { capabilities?: string[] } | undefined)?.capabilities ?? [];
    expect(caps).toContain('file-read');
    expect(caps).toContain('file-write');
    expect(caps).toContain('dim-ranges');
    expect(caps).not.toContain('spawn-process');
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
    });
    expect(consumed).toBe(true);
  });

  it('statusSnapshotHook fires when supplied', () => {
    // The hook should be called once Statusline writes (deduped). Since
    // there's no active highlight at boot, the first payload is
    // {active:false, timestamp:...}. We just assert the wiring exists
    // — actual payload-shape testing belongs in statusline.test.ts.
    const onSnap = vi.fn();
    const result = boot(makeHost({ statusSnapshotHook: onSnap }));
    // Trigger a render so Statusline.maybeWrite fires.
    result.collectRenderDirectives('hello world', 0);
    expect(onSnap).toHaveBeenCalled();
  });

  it('Resolver constructed only when llmApiKey set', () => {
    const log = vi.fn();
    boot(makeHost({ log }));
    // No llmApiKey → no Resolver build log. Find any "Resolver:" line.
    const resolverLines = log.mock.calls.filter(c => String(c[1]).startsWith('Resolver:'));
    expect(resolverLines.length).toBe(0);
  });
});
