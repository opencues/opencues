// Unit tests for the pure/isolable logic in opencuesBootstrap.ts.
//
// This file is the Gemini CLI glue layer between React/Ink's TextBuffer
// and @opencues/runtime's boot(). Per gemini-cli/CLAUDE.md §5, its most
// bug-prone logic is the code-point ↔ UTF-16-code-unit cursor conversion
// (Gemini's buffer tracks cursor offsets in CODE POINTS; the runtime
// tracks them in CODE UNITS) — that logic was previously "pinned by
// manual test" only (see CLAUDE.md's pinned-test note), with zero
// automated coverage. This suite closes that gap by exercising the
// exported binding functions (dispatchOpenCuesKey, consumePendingOpenCues,
// decorateOpenCuesLine, getOpenCuesDirectiveRanges) against a MOCKED
// runtime boot() — real boot() constructs a full Runtime + ConfigLoader
// that reads real ~/.cues files and is already covered by the runtime's
// own tests + the agentic harness; this file only cares about the
// conversion/glue logic that lives in THIS module.
//
// `isAsciiFast` / `codeUnitsToCodePoints` / `codePointsToCodeUnits` /
// `normaliseKeyName` are private (not exported) — they're exercised
// indirectly through the public functions that use them, per the task's
// "do not modify the patch source" constraint.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock every @opencues/* + node:fs import so module-scope code in
// opencuesBootstrap.ts (createDefaultBlanksRegistry, the user-blank
// filesystem walk, etc.) never touches the real filesystem or spins up
// the real Runtime. ────────────────────────────────────────────────────

vi.mock('@opencues/runtime/dist/adapters/gemini/v0.41/boot.js', () => ({
  boot: vi.fn(),
}));
vi.mock('@opencues/runtime/dist/src/boot-common.js', () => ({
  createSourceReclassifier: vi.fn(),
}));
vi.mock('@opencues/runtime/dist/src/blanks/index.js', () => ({
  createDefaultBlanksRegistry: vi.fn(() => new Map()),
  createBlankInvoke: vi.fn(() => vi.fn(() => null)),
}));
vi.mock('@opencues/runtime/dist/src/security/spawn-sandbox.js', () => ({
  validateScriptPath: vi.fn(() => ({ ok: true })),
  appendAuditLog: vi.fn(),
}));
vi.mock('@opencues/runtime/dist/src/security/sandbox-runner.js', () => ({
  wrapWithBwrap: vi.fn(() => null),
}));
vi.mock('@opencues/runtime/dist/src/user-blanks/registry.js', () => ({
  buildUserBlankRegistry: vi.fn(() => new Map()),
  createNativeLlmAdapter: vi.fn(() => null),
}));
vi.mock('@opencues/core', () => ({
  parseSingleCueMd: vi.fn(() => ({ blanks: {} })),
}));
// `_discoverUserBlankConfigs` (module scope) calls these three directly —
// stub them so it never touches the real disk regardless of what CUES
// roots happen to exist on the machine running the test.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ''),
}));

// A fake BootResult + sourceReclassifier we control per test. Grabbed via
// the mocked `boot`/`createSourceReclassifier` factories above so each
// test can configure return values / assert call args.
function makeFakeBootResult() {
  return {
    dispatchKey: vi.fn(() => true),
    notifyTextChange: vi.fn(),
    notifyCursorChange: vi.fn(),
    collectRenderDirectives: vi.fn(() => []),
    decorateLine: vi.fn((lineText: string) => lineText),
    getDirectiveRangesForLine: vi.fn(() => ({ dimRanges: [], highlight: null })),
    consumePendingRender: vi.fn(() => null),
    resetBufferState: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeFakeReclassifier() {
  return {
    markRuntimeWrite: vi.fn(),
    reclassify: vi.fn((_text: string, source: string) => source),
  };
}

// Each test gets a FRESH module instance (bootResult / __gcPromptHolder /
// _ocTip are module-level singletons) via vi.resetModules() + dynamic
// import, so tests can't leak boot state into each other.
async function freshModule() {
  vi.resetModules();
  const bootMod = await import('@opencues/runtime/dist/adapters/gemini/v0.41/boot.js');
  const bootCommonMod = await import('@opencues/runtime/dist/src/boot-common.js');
  const fakeBootResult = makeFakeBootResult();
  const fakeReclassifier = makeFakeReclassifier();
  (bootMod.boot as ReturnType<typeof vi.fn>).mockReturnValue(fakeBootResult);
  (bootCommonMod.createSourceReclassifier as ReturnType<typeof vi.fn>).mockReturnValue(fakeReclassifier);
  const mod = await import('./opencuesBootstrap');
  return { mod, fakeBootResult, fakeReclassifier, bootMock: bootMod.boot as ReturnType<typeof vi.fn> };
}

describe('opencuesBootstrap — before startOpenCues (bootResult unset)', () => {
  it('dispatchOpenCuesKey returns false without a bootResult', async () => {
    const { mod } = await freshModule();
    expect(mod.dispatchOpenCuesKey({ name: 'a' })).toBe(false);
  });

  it('consumePendingOpenCues returns null without a bootResult', async () => {
    const { mod } = await freshModule();
    expect(mod.consumePendingOpenCues('hello', 2)).toBeNull();
  });

  it('decorateOpenCuesLine returns lineText unchanged without a bootResult', async () => {
    const { mod } = await freshModule();
    expect(mod.decorateOpenCuesLine('hello', 'hello world', 3, 0, 5)).toBe('hello');
  });

  it('getOpenCuesDirectiveRanges returns empty defaults without a bootResult', async () => {
    const { mod } = await freshModule();
    expect(mod.getOpenCuesDirectiveRanges('hello world', 3, 0, 5)).toEqual({ dimRanges: [], highlight: null });
  });
});

describe('opencuesBootstrap — holderBackedPromptAccess / publishPromptAccess', () => {
  it('defaults to empty read / zero cursor and no-ops write/setCursor when nothing is published', async () => {
    const { mod } = await freshModule();
    const access = mod.holderBackedPromptAccess();
    expect(access.read()).toBe('');
    expect(access.cursor()).toBe(0);
    expect(() => access.write('x')).not.toThrow();
    expect(() => access.setCursor(3)).not.toThrow();
  });

  it('delegates to the published access after publishPromptAccess', async () => {
    const { mod } = await freshModule();
    const inner = {
      read: vi.fn(() => 'buffer text'),
      write: vi.fn(),
      cursor: vi.fn(() => 7),
      setCursor: vi.fn(),
    };
    mod.publishPromptAccess(inner);
    const access = mod.holderBackedPromptAccess();
    expect(access.read()).toBe('buffer text');
    expect(access.cursor()).toBe(7);
    access.write('new text');
    expect(inner.write).toHaveBeenCalledWith('new text');
    access.setCursor(9);
    expect(inner.setCursor).toHaveBeenCalledWith(9);
  });

  it('reverts to defaults after publishing null (unmount)', async () => {
    const { mod } = await freshModule();
    mod.publishPromptAccess({ read: () => 'x', write: () => {}, cursor: () => 1, setCursor: () => {} });
    mod.publishPromptAccess(null);
    const access = mod.holderBackedPromptAccess();
    expect(access.read()).toBe('');
    expect(access.cursor()).toBe(0);
  });
});

describe('opencuesBootstrap — dispatchOpenCuesKey (code-point → code-unit conversion + key normalisation)', () => {
  it('forwards ASCII text/cursor unchanged (fast path, units === points)', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.publishPromptAccess({ read: () => 'hello world', write: () => {}, cursor: () => 5, setCursor: () => {} });
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    mod.dispatchOpenCuesKey({ name: 'a', ctrl: false, alt: false, shift: false, cmd: false });

    expect(fakeBootResult.dispatchKey).toHaveBeenCalledTimes(1);
    const event = fakeBootResult.dispatchKey.mock.calls[0][0];
    expect(event.text).toBe('hello world');
    expect(event.cursorOffset).toBe(5); // ASCII: code units === code points
    expect(event.key).toBe('a');
  });

  it('converts a code-point cursor past emoji to the correct UTF-16 code-unit offset', async () => {
    const { mod, fakeBootResult } = await freshModule();
    // '😊' is a surrogate pair — 1 code point, 2 code units. Cursor sits
    // right after the emoji: 2 code points in (the emoji), so code-point
    // cursor = 2 ("😊" counts as 1 point... actually cpCursor here counts
    // JS array-of-codepoints entries: index 1 = right after the emoji).
    const text = '😊x';
    mod.publishPromptAccess({ read: () => text, write: () => {}, cursor: () => 1, setCursor: () => {} });
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    mod.dispatchOpenCuesKey({ name: 'b' });

    const event = fakeBootResult.dispatchKey.mock.calls[0][0];
    // The emoji is 2 UTF-16 code units; code-point offset 1 (just past the
    // emoji) must convert to code-unit offset 2.
    expect(event.cursorOffset).toBe(2);
  });

  it('normalises key.name (lowercased) over key.sequence when both are present', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.publishPromptAccess({ read: () => '', write: () => {}, cursor: () => 0, setCursor: () => {} });
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    mod.dispatchOpenCuesKey({ name: 'Return', sequence: '\r' });

    expect(fakeBootResult.dispatchKey.mock.calls[0][0].key).toBe('return');
  });

  it('falls back to key.sequence when name is absent', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.publishPromptAccess({ read: () => '', write: () => {}, cursor: () => 0, setCursor: () => {} });
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    mod.dispatchOpenCuesKey({ sequence: '[A' });

    expect(fakeBootResult.dispatchKey.mock.calls[0][0].key).toBe('[A');
  });

  it('normalises to an empty string when neither name nor sequence is present (invalid key input)', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.publishPromptAccess({ read: () => '', write: () => {}, cursor: () => 0, setCursor: () => {} });
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    mod.dispatchOpenCuesKey({});

    expect(fakeBootResult.dispatchKey.mock.calls[0][0].key).toBe('');
  });

  it('maps modifiers, including cmd → meta', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.publishPromptAccess({ read: () => '', write: () => {}, cursor: () => 0, setCursor: () => {} });
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    mod.dispatchOpenCuesKey({ name: 'a', ctrl: true, alt: true, shift: false, cmd: true });

    const event = fakeBootResult.dispatchKey.mock.calls[0][0];
    expect(event.modifiers).toEqual({ ctrl: true, alt: true, shift: false, meta: true });
  });

  it('returns bootResult.dispatchKey\'s return value (consumed flag)', async () => {
    const { mod, fakeBootResult } = await freshModule();
    fakeBootResult.dispatchKey.mockReturnValue(false);
    mod.publishPromptAccess({ read: () => '', write: () => {}, cursor: () => 0, setCursor: () => {} });
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    expect(mod.dispatchOpenCuesKey({ name: 'a' })).toBe(false);
  });
});

describe('opencuesBootstrap — consumePendingOpenCues (round-trip cp/cu conversion + runtime-write marking)', () => {
  it('returns null when nothing is pending', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    fakeBootResult.consumePendingRender.mockReturnValue(null);

    expect(mod.consumePendingOpenCues('hello', 3)).toBeNull();
  });

  it('converts the returned code-unit cursor back to code points and marks the write as runtime-originated when text changed', async () => {
    const { mod, fakeBootResult, fakeReclassifier } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    // Runtime hands back emoji text + a code-UNIT cursor of 2 (right after
    // the 2-code-unit emoji).
    fakeBootResult.consumePendingRender.mockReturnValue({ text: '😊x', cursor: 2 });

    const result = mod.consumePendingOpenCues('x', 0);

    expect(result).not.toBeNull();
    expect(result!.text).toBe('😊x');
    // Code-unit offset 2 (past the emoji) → code-point offset 1.
    expect(result!.cursor).toBe(1);
    expect(fakeReclassifier.markRuntimeWrite).toHaveBeenCalledWith('😊x');
  });

  it('does NOT mark a runtime write when the pending text equals the current text (cursor-only change)', async () => {
    const { mod, fakeBootResult, fakeReclassifier } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    fakeBootResult.consumePendingRender.mockReturnValue({ text: 'same', cursor: 2 });

    mod.consumePendingOpenCues('same', 0);

    expect(fakeReclassifier.markRuntimeWrite).not.toHaveBeenCalled();
  });

  it('converts the incoming code-point cursor to code units before calling consumePendingRender', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    fakeBootResult.consumePendingRender.mockReturnValue(null);

    // '😊y' — code-point cursor 2 (past both chars) is code-unit cursor 3
    // (emoji = 2 units + 'y' = 1 unit).
    mod.consumePendingOpenCues('😊y', 2);

    expect(fakeBootResult.consumePendingRender).toHaveBeenCalledWith('😊y', 3);
  });
});

describe('opencuesBootstrap — decorateOpenCuesLine (cp → cu conversion on all 3 offset args)', () => {
  it('converts cursor/lineStart/lineEnd from code points to code units before calling the runtime, and passes fullText/lineText through unconverted', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    fakeBootResult.decorateLine.mockReturnValue('DECORATED');

    // fullText has an emoji before every one of the three offsets.
    const fullText = '😊abc';
    const result = mod.decorateOpenCuesLine('abc', fullText, /*cursor cp*/ 3, /*lineStart cp*/ 1, /*lineEnd cp*/ 4);

    expect(fakeBootResult.decorateLine).toHaveBeenCalledTimes(1);
    const [lineTextArg, fullTextArg, cuCursor, cuLineStart, cuLineEnd] = fakeBootResult.decorateLine.mock.calls[0];
    expect(lineTextArg).toBe('abc');
    expect(fullTextArg).toBe(fullText);
    // code point 3 → code unit 4 (emoji absorbs +1 unit before it)
    expect(cuCursor).toBe(4);
    expect(cuLineStart).toBe(2);
    expect(cuLineEnd).toBe(5);
    expect(result).toBe('DECORATED');
  });

  it('returns lineText unchanged (fast path) on pure-ASCII input with no conversion needed', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    fakeBootResult.decorateLine.mockImplementation((lineText: string) => lineText);

    const result = mod.decorateOpenCuesLine('plain line', 'plain line', 5, 0, 10);

    expect(fakeBootResult.decorateLine).toHaveBeenCalledWith('plain line', 'plain line', 5, 0, 10);
    expect(result).toBe('plain line');
  });
});

describe('opencuesBootstrap — BUG: getOpenCuesDirectiveRanges skips the cp→cu conversion decorateOpenCuesLine performs', () => {
  // decorateOpenCuesLine (above) explicitly converts cursor/lineStart/
  // lineEnd from Gemini's code-point space to the runtime's code-unit
  // space before calling into bootResult. boot.ts's own comment says
  // getDirectiveRangesForLine "mirrors decorateLine's collect+clip logic"
  // — i.e. it expects the SAME code-unit-space offsets. But
  // getOpenCuesDirectiveRanges (this module) forwards its args to
  // bootResult.getDirectiveRangesForLine WITH NO CONVERSION AT ALL. This
  // is also why the gemini-cli/CLAUDE.md "code-point vs code-unit" table
  // (§5) does not list getOpenCuesDirectiveRanges as a conversion
  // boundary — it was missed. Any buffer with an emoji before the
  // requested line/cursor will report directive ranges shifted by the
  // per-emoji code-unit delta, the same "highlight drifts near emoji"
  // symptom §5 documents for the other four boundaries it DOES cover.
  //
  // Documented via it.fails() per the task's do-not-fix-source rule.
  // Suggested fix direction (NOT applied): convert `cursor`/`lineStart`/
  // `lineEnd` via `codePointsToCodeUnits(fullText, ...)` before calling
  // `bootResult.getDirectiveRangesForLine`, mirroring decorateOpenCuesLine.
  it.fails('should convert cursor/lineStart/lineEnd to code units before calling getDirectiveRangesForLine, like decorateOpenCuesLine does', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    fakeBootResult.getDirectiveRangesForLine.mockReturnValue({ dimRanges: [], highlight: null });

    const fullText = '😊abc';
    mod.getOpenCuesDirectiveRanges(fullText, /*cursor cp*/ 3, /*lineStart cp*/ 1, /*lineEnd cp*/ 4);

    const [, cuCursor, cuLineStart, cuLineEnd] = fakeBootResult.getDirectiveRangesForLine.mock.calls[0];
    // Same expected conversion as decorateOpenCuesLine's test above:
    // code-point 3 → code-unit 4, 1 → 2, 4 → 5. Today the function
    // forwards the raw code-point values unconverted, so these fail.
    expect(cuCursor).toBe(4);
    expect(cuLineStart).toBe(2);
    expect(cuLineEnd).toBe(5);
  });

  it('passes through bootResult.getDirectiveRangesForLine\'s return value unchanged', async () => {
    const { mod, fakeBootResult } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    const expected = { dimRanges: [{ start: 1, end: 2 }], highlight: { start: 0, end: 1 } };
    fakeBootResult.getDirectiveRangesForLine.mockReturnValue(expected);

    const result = mod.getOpenCuesDirectiveRanges('plain', 1, 0, 5);

    expect(result).toEqual(expected);
  });
});

describe('opencuesBootstrap — notifyOpenCuesTextChange / notifyOpenCuesCursorChange', () => {
  it('reclassifies the source and converts the cursor before notifying the runtime (text change)', async () => {
    const { mod, fakeBootResult, fakeReclassifier } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });
    fakeReclassifier.reclassify.mockReturnValue('runtime');

    mod.notifyOpenCuesTextChange('😊x', 1, 'user');

    expect(fakeReclassifier.reclassify).toHaveBeenCalledWith('😊x', 'user');
    expect(fakeBootResult.notifyTextChange).toHaveBeenCalledWith('😊x', 2, 'runtime');
  });

  it('converts the cursor before notifying the runtime (cursor-only change), without reclassifying', async () => {
    const { mod, fakeBootResult, fakeReclassifier } = await freshModule();
    mod.startOpenCues({ cwd: '/tmp', hostVersion: '0.41.2' });

    mod.notifyOpenCuesCursorChange('😊x', 1, 'user');

    expect(fakeReclassifier.reclassify).not.toHaveBeenCalled();
    expect(fakeBootResult.notifyCursorChange).toHaveBeenCalledWith('😊x', 2, 'user');
  });
});
