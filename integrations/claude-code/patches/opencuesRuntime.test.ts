// Unit tests for writeOpenCuesRuntimeV2 — the ONE exported, independently
// testable function in opencuesRuntime.ts. Everything else in this file is
// either a private seam-finder regex helper (not exported) or the huge
// string-template bootstrap assembly whose RUNTIME behavior is already
// covered by scripts/check-cc-patch-boot.cjs (which evaluates the emitted
// bootstrap in a Node vm sandbox). This file does NOT duplicate that —
// it tests writeOpenCuesRuntimeV2's own structural contract instead:
//
//   - does it find the 3 mandatory seams (S1 KeyDispatcher, S2
//     InputStateHandler, S3 RenderedValue) and splice around them?
//   - does it treat the 2 optional seams (S6 StatusLineRefresh, S7
//     RenderKick) as truly optional (warn + continue, don't fail)?
//   - does it fail loud (return null + console.error) when a mandatory
//     seam or the createRequire var is missing?
//
// Fixtures are synthetic minified cli.js snippets mirroring the shapes
// scripts/check-cc-patch-boot.cjs already uses to validate the FULL
// emitted bootstrap — see that script's FAKE_CLI_JS for the reference
// shape. `getRequireFuncName` comes from the local test-only `./helpers`
// stub (see helpers.ts) since the real implementation lives in tweakcc's
// cloned source, which isn't vendored in this repo.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeOpenCuesRuntimeV2 } from './opencuesRuntime';

// ─── Fixture pieces ────────────────────────────────────────────────────

// S1: KeyDispatcher — function wH(WH,EH){switch(WH.key){case"escape":...
const S1 = `function wH(WH,EH){switch(WH.key){case"escape":return;case"left":return U.left();default:return U;}}`;

// S2 (InputStateHandler) + S3 (RenderedValue) — the renderedValue call
// lives INSIDE the return statement of the input-state handler in real
// cli.js, so this one fixture provides both seams together.
const S2_FULL = `function PH({value:V,onChange:OC,disableEscapeDoublePress:G,maxVisibleLines:W,externalOffset:EO,onOffsetChange:OOC,inputFilter:F}){let O=EO,OC2=OOC,IZ=b4.fromText(V,X,O);let D=0,j=0,J=0,NH=0,R=0,C=0;return{handleKeyDown:wH,renderedValue:IZ.render(D,j,J,NH,W,R,C),offset:O,setOffset:OC2}}`;

// S2 with the externalOffset/onOffsetChange destructure removed so
// INPUT_STATE_REGEX can't match — used to isolate an "S2 missing" failure
// from an "S3 missing" one.
const S2_BROKEN = `function PH({value:V,onChange:OC,disableEscapeDoublePress:G,maxVisibleLines:W,inputFilter:F}){let O=EO,OC2=OOC,IZ=b4.fromText(V,X,O);return{handleKeyDown:wH,offset:O}}`;

// A bare renderedValue occurrence, independent of S2 — lets a test drop
// S2_FULL (and therefore its embedded renderedValue) while keeping S3
// satisfiable on its own.
const RV_STANDALONE = `var _rvOnly={renderedValue:IZ.render(D,j,J,NH,W,R,C)};`;

// createRequire var declaration — consumed by the local test-only
// getRequireFuncName stub in ./helpers.
const REQUIRE_DECL = `var __req=nodeModule.createRequire(import.meta.url);`;

// S6 (optional): StatusLineRefreshDebounce — useCallback wrapping a
// clearTimeout/setTimeout pair, dep array closing over the same var
// passed as the extra setTimeout arg.
const S6 = `Z=ns.useCallback(()=>{if(ref.current!==void 0)clearTimeout(ref.current);ref.current=setTimeout((a,b)=>{doX()},300,ref,dep)},[dep])`;

// S7 (optional): RenderKick — grandparent component calling the S2-shaped
// handler.
const S7 = `function I8q(H){let a=rns.useMemo(()=>1,[]);let _=D69({value:H.value,onChange:H.onChange});return _;}`;

interface FixtureOpts {
  s1?: boolean;
  s2?: 'full' | 'broken' | 'omit';
  rvStandalone?: boolean;
  requireDecl?: boolean;
  s6?: boolean;
  s7?: boolean;
}

function buildFixture(opts: FixtureOpts = {}): string {
  const {
    s1 = true,
    s2 = 'full',
    rvStandalone = false,
    requireDecl = true,
    s6 = true,
    s7 = true,
  } = opts;
  const parts: string[] = [];
  if (requireDecl) parts.push(REQUIRE_DECL);
  if (s1) parts.push(S1);
  if (s2 === 'full') parts.push(S2_FULL);
  else if (s2 === 'broken') parts.push(S2_BROKEN);
  if (rvStandalone) parts.push(RV_STANDALONE);
  if (s6) parts.push(S6);
  if (s7) parts.push(S7);
  return parts.join('\n');
}

describe('writeOpenCuesRuntimeV2', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // ── Happy path ─────────────────────────────────────────────────────

  it('patches a fixture with all 5 seams present (S1/S2/S3 mandatory + S6/S7 optional)', () => {
    const src = buildFixture();
    const out = writeOpenCuesRuntimeV2(src);

    expect(out).not.toBeNull();
    expect(out).toContain('globalThis.__oc');

    // S1: the bootstrap is inserted BEFORE the original switch statement
    // (a pure insertion at the S1 body-start anchor, not a replacement).
    const bootIdx = out!.indexOf('try{if(!globalThis.__oc){');
    const switchIdx = out!.indexOf('switch(WH.key)');
    expect(bootIdx).toBeGreaterThanOrEqual(0);
    expect(switchIdx).toBeGreaterThan(bootIdx);

    // S3: the original renderedValue expression survives verbatim inside
    // the new applyRender-guarded wrapper.
    expect(out).toContain('IZ.render(D,j,J,NH,W,R,C)');
    expect(out).toContain('globalThis.__oc.applyRender(');

    // S6: the captured callback var is exposed via an appended declarator
    // on the SAME `let`, original callback text preserved.
    expect(out).toContain('__oc_ts6=(globalThis.__oc_refreshHostStatusline=Z)');

    // S7: a useState bumper is injected using the captured React ns,
    // exposed as the render-kick global.
    expect(out).toContain(
      'globalThis.__oc_kickRender=function(){try{__ocS7(function(n){return(n+1)|0;});}catch(__ocS7e){}}',
    );

    // Both optional seams were found — no warnings, no errors.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // ── Edge case: optional seams missing ──────────────────────────────

  it('degrades gracefully (warns, still patches) when optional seams S6 and S7 are both missing', () => {
    const src = buildFixture({ s6: false, s7: false });
    const out = writeOpenCuesRuntimeV2(src);

    expect(out).not.toBeNull();
    expect(out).toContain('globalThis.__oc');
    // No S7 → no kickRender DEFINITION injected (the s1 bootstrap always
    // contains a runtime `if(globalThis.__oc_kickRender)` check as part of
    // its ZWS-toggle fallback logic, so the bare substring isn't a valid
    // signal — only the S7 injection's assignment is).
    expect(out).not.toContain('globalThis.__oc_kickRender=function(){try{__ocS7(');
    // No S6 → no refreshHostStatusline SPLICE (the s1 bootstrap always
    // contains a runtime `refreshStatusline` callback that calls
    // `globalThis.__oc_refreshHostStatusline` if set — only the S6
    // injection actually assigns it via the appended declarator).
    expect(out).not.toContain('__oc_ts6=(globalThis.__oc_refreshHostStatusline=');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('S6 (StatusLineRefresh) not found'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('S7 (RenderKick) not found'));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('degrades gracefully when only S7 (RenderKick) is missing, keeping S6', () => {
    const src = buildFixture({ s7: false });
    const out = writeOpenCuesRuntimeV2(src);

    expect(out).not.toBeNull();
    expect(out).toContain('__oc_ts6=(globalThis.__oc_refreshHostStatusline=Z)');
    expect(out).not.toContain('globalThis.__oc_kickRender=function(){try{__ocS7(');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('S7 (RenderKick) not found'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('S6'));
  });

  // ── Invalid input: mandatory seams missing ─────────────────────────

  it('fails loud and returns null when S1 (KeyDispatcher) is missing', () => {
    const src = buildFixture({ s1: false });
    const out = writeOpenCuesRuntimeV2(src);

    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg] = errorSpy.mock.calls[0] as [string];
    expect(msg).toContain('S1 KeyDispatcher');
    expect(msg).not.toContain('S2 InputStateHandler');
    expect(msg).not.toContain('S3 RenderedValue');
  });

  it('fails loud and returns null when S2 (InputStateHandler) is missing but S3 is independently present', () => {
    const src = buildFixture({ s2: 'broken', rvStandalone: true });
    const out = writeOpenCuesRuntimeV2(src);

    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg] = errorSpy.mock.calls[0] as [string];
    expect(msg).toContain('S2 InputStateHandler');
    expect(msg).not.toContain('S1 KeyDispatcher');
    expect(msg).not.toContain('S3 RenderedValue');
  });

  it('fails loud and returns null naming all 3 mandatory seams on a totally empty source', () => {
    const out = writeOpenCuesRuntimeV2('');

    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg] = errorSpy.mock.calls[0] as [string];
    expect(msg).toContain('S1 KeyDispatcher');
    expect(msg).toContain('S2 InputStateHandler');
    expect(msg).toContain('S3 RenderedValue');
    expect(msg).toContain('FAILED to find 3 critical seam(s)');
  });

  // ── Invalid input: createRequire var missing ───────────────────────

  it('fails loud and returns null when all 3 mandatory seams match but no createRequire var is found', () => {
    const src = buildFixture({ requireDecl: false });
    const out = writeOpenCuesRuntimeV2(src);

    expect(out).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('createRequire'));
  });

  // ── Idempotence / non-mutation ──────────────────────────────────────

  it('does not mutate the input string', () => {
    const src = buildFixture();
    const copy = `${src}`;
    writeOpenCuesRuntimeV2(src);
    expect(src).toBe(copy);
  });
});
