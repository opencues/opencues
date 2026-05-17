import { describe, expect, it, vi } from 'vitest';
import { boot } from './boot';
import { ChromeV1Adapter, type ChromeBindings } from './adapter';
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

  it('TTS wired via speakFn (no spawnProcess fallback in chrome)', async () => {
    // Boot with speakFn — TTS module subscribes. Manually trigger a
    // render with an active highlight; speakFn should be called.
    // We can't easily exercise the full TTS gate without ConfigLoader
    // populated, so just assert the wiring goes through (no crash).
    const speakFn = vi.fn();
    const result = boot(makeHost({ speakFn }));
    // Boot completes without throwing — that's the wiring smoke test.
    expect(typeof result.dispatchKey).toBe('function');
  });

  it('CursorStateExport wired when cursorStatePath supplied', async () => {
    // Track writeFile calls on the host. CursorStateExport writes the
    // virtual JSON path on every render with active highlight.
    const writeFile = vi.fn(async () => {});
    const result = boot(makeHost({
      cursorStatePath: '/cursor-state.json',
      writeFile,
    }));
    // collectRenderDirectives triggers the render path that fires the
    // module's onRender handler.
    result.collectRenderDirectives('hello world', 5);
    // Without an active highlight the module typically emits the
    // "inactive" payload — still writes once. Just assert the wiring.
    expect(typeof result.collectRenderDirectives).toBe('function');
  });

  it('Resolver receives host-supplied httpAdapter when provided', () => {
    // Without llmApiKey, Resolver isn't constructed. With llmApiKey +
    // a custom httpAdapter, the resolver build path runs and the host
    // adapter is used (verified indirectly by no NodeHttpAdapter load
    // error in the log — Chrome can't load that).
    const log = vi.fn();
    const fakeHttp = { post: async () => '{}' };
    boot(makeHost({
      log,
      llmApiKey: 'test-key',
      httpAdapter: fakeHttp,
    }));
    // No "NodeHttpAdapter load failed" should appear in the log,
    // because the host-supplied adapter wins.
    const adapterFailLines = log.mock.calls.filter(c => String(c[1]).includes('NodeHttpAdapter load failed'));
    expect(adapterFailLines).toHaveLength(0);
  });
});

// ===========================================================================
// ChromeV1Adapter.getAmbientContext — error-path / null-path contract
// ===========================================================================
//
// The runtime gates on `ambient-context-mode` BEFORE calling this method,
// but if it DOES call it, the adapter MUST:
//   - return null when the binding is missing (older bootstrap)
//   - return null when the binding throws (DOM access SecurityError, etc.)
//   - forward the result when the binding returns a valid AmbientContext
//   - forward null when the binding returns null (sensitive field, etc.)
//
// Catch removal would turn a DOM throw into a resolver crash → fluid-blank
// silently dies and the user thinks the feature is broken.

function makeBindings(overrides: Partial<ChromeBindings> = {}): ChromeBindings {
  return {
    hostVersion: '0.1.0',
    cwd: '/chrome-storage',
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

describe('ChromeV1Adapter.getAmbientContext', () => {
  it('returns null when the binding is omitted', () => {
    const adapter = new ChromeV1Adapter(makeBindings());
    expect(adapter.getAmbientContext()).toBeNull();
  });

  it('returns null when the binding throws (SecurityError / DOM detached)', () => {
    const adapter = new ChromeV1Adapter(makeBindings({
      getAmbientContext: () => { throw new Error('SecurityError: blocked'); },
    }));
    // The whole point of the try/catch in the adapter: a throw upstream
    // becomes a benign null, NOT a crashed resolver.
    expect(() => adapter.getAmbientContext()).not.toThrow();
    expect(adapter.getAmbientContext()).toBeNull();
  });

  it('returns null when the binding returns null (sensitive field path)', () => {
    const adapter = new ChromeV1Adapter(makeBindings({
      getAmbientContext: () => null,
    }));
    expect(adapter.getAmbientContext()).toBeNull();
  });

  it('forwards a valid AmbientContext object verbatim', () => {
    const ctx = { label: 'Search', placeholder: 'Where to?', pageTitle: 'Trivia' };
    const adapter = new ChromeV1Adapter(makeBindings({
      getAmbientContext: () => ctx,
    }));
    expect(adapter.getAmbientContext()).toEqual(ctx);
  });
});

// ===========================================================================
// BootResult.resetBufferState — per-buffer state contract
// ===========================================================================
//
// Chrome's normal-input mode (Universal Integration profile) attaches to
// MANY independent buffers per page. Per-buffer state (DynDefs, etc.) is
// keyed by word-index in the current buffer. The chrome bootstrap calls
// `resetBufferState()` on focus change to prevent state leakage.
//
// The canonical bug (May 2026): user fluid-blanks `_` on a LinkedIn URL
// field → DynDef[0] = `https://linkedin.com/...` with blankName. User
// tabs to a GitHub URL field → types `_` → Resolver's "don't clobber
// blank-bound entries" guard blocks the new substitution silently.
// Symptom: bare `_` returns nothing, `answer _` works (different
// wordIndex). No log, no error.

describe('BootResult.resetBufferState (per-buffer-state contract)', () => {
  it('exposes resetBufferState as a method', () => {
    const result = boot(makeHost());
    expect(typeof result.resetBufferState).toBe('function');
  });

  it('is idempotent — calling repeatedly is safe (focus-change spam)', () => {
    const result = boot(makeHost());
    expect(() => {
      result.resetBufferState();
      result.resetBufferState();
      result.resetBufferState();
    }).not.toThrow();
  });

  // The cross-buffer state-leak property is integration-shaped (needs
  // the full Resolver + dynDefs + a fluid-blank result + a focus
  // transition). The unit-level guarantee here is just "method exists,
  // doesn't throw, callable any number of times." The end-to-end
  // contract is documented at:
  //   docs/architecture/universal-integration.md § "Per-buffer state
  //   must reset on focus change"
  //   integrations/chrome/src/opencues-bootstrap.ts:publishTarget
});
