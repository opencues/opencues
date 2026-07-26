import { describe, it, expect } from 'vitest';
import { WindowsV1Adapter, type WindowsBindings } from './adapter';

// ===========================================================================
// WindowsV1Adapter.getAmbientContext — delegation + error-path contract
// ===========================================================================
//
// The daemon (hostd.cjs) holds the focused field's UIA metadata from the
// last `focus` event and hands it back through the getAmbientContext
// binding. The runtime gates on `ambient-context-mode` BEFORE calling this
// method, but when it DOES call, the adapter MUST:
//   - return null when the binding is missing (older daemon)
//   - return null when the binding throws (never crash the resolver)
//   - forward the daemon's AmbientContext verbatim (incl. the native-only
//     `app` field that steers output format for File Explorer etc.)
//   - forward null when nothing is attached
//
// See docs/architecture/ambient-context.md and the mirror contract in
// adapters/chrome/v1/boot.test.ts.

function makeBindings(overrides: Partial<WindowsBindings> = {}): WindowsBindings {
  return {
    hostVersion: '0.1.0',
    cwd: '/home/user',
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

describe('WindowsV1Adapter.getAmbientContext', () => {
  it('returns null when the binding is omitted (older daemon)', () => {
    const adapter = new WindowsV1Adapter(makeBindings());
    expect(adapter.getAmbientContext()).toBeNull();
  });

  it('returns null when the binding throws (never crashes the resolver)', () => {
    const adapter = new WindowsV1Adapter(makeBindings({
      getAmbientContext: () => { throw new Error('socket dead'); },
    }));
    expect(() => adapter.getAmbientContext()).not.toThrow();
    expect(adapter.getAmbientContext()).toBeNull();
  });

  it('returns null when nothing is attached', () => {
    const adapter = new WindowsV1Adapter(makeBindings({
      getAmbientContext: () => null,
    }));
    expect(adapter.getAmbientContext()).toBeNull();
  });

  it('forwards the daemon AmbientContext verbatim, including the native app field', () => {
    // The File Explorer search-box case: window title is the folder, app
    // steers the output toward a file-search-valid shape.
    const ctx = {
      label: 'Search Box',
      pageTitle: 'Documents - File Explorer',
      app: 'explorer',
    };
    const adapter = new WindowsV1Adapter(makeBindings({
      getAmbientContext: () => ctx,
    }));
    expect(adapter.getAmbientContext()).toEqual(ctx);
  });
});
