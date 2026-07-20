// Phase-2 render/hook/overlay invariants.
//
// Two halves, same rationale as clipboard-invariants.mjs:
//
//   A. Unit tests for the daemon's directive → wire mapping
//      (src/render-wire.cjs) — the one pure seam between the runtime's
//      RenderDirectives and the shim's overlay.
//   B. SOURCE guards over the Add-Type-compiled C# shim for phase-2
//      failure modes that would be silent on a refactor:
//        1. A WH_KEYBOARD_LL callback that blocks (socket write inline)
//           gets the hook silently REMOVED by Windows after ~300ms —
//           chords just stop working, no error anywhere.
//        2. A re-injected chord without the INJECT_MARK pass-through is
//           re-caught by our own hook — an infinite feedback loop.
//        3. An overlay window without WS_EX_TRANSPARENT/WS_EX_NOACTIVATE
//           steals clicks/focus from the app it annotates — the overlay
//           must never be interactable.
//        4. Chord swallowing without the per-field `_fieldCycling` gate
//           eats Ctrl+Alt+arrows system-wide even on fields we can't
//           cycle (or when detached) — keys vanish for the user.
//
// Run: node integrations/windows/tests/render-wire-invariants.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { mergeRenderDirectives } = require(path.resolve(here, '..', 'src', 'render-wire.cjs'));

let failures = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  ok  ${name}`); return; }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── A. mergeRenderDirectives ────────────────────────────────────────────
{
  const out = mergeRenderDirectives([]);
  check('empty directives → empty wire', out.dim.length === 0 && out.hl === null);
}
{
  const out = mergeRenderDirectives([
    { dimRanges: [{ start: 0, end: 3 }, { start: 8, end: 12 }] },
    { highlight: { start: 4, end: 7 } },
  ]);
  check('dim + highlight flatten across subscribers',
    JSON.stringify(out.dim) === '[[0,3],[8,12]]' && JSON.stringify(out.hl) === '[4,7]');
}
{
  const out = mergeRenderDirectives([
    { dimRanges: [{ start: 4, end: 7 }, { start: 10, end: 14 }], highlight: { start: 4, end: 7 } },
  ]);
  check('active span never double-paints as dim',
    JSON.stringify(out.dim) === '[[10,14]]' && JSON.stringify(out.hl) === '[4,7]');
}
{
  const out = mergeRenderDirectives([
    { dimRanges: [{ start: 3, end: 3 }, { start: 5, end: 2 }, { start: NaN, end: 9 }, null] },
    null,
    { highlight: { start: 2, end: 2 } },
  ]);
  check('degenerate/invalid ranges dropped', out.dim.length === 0 && out.hl === null);
}
{
  const out = mergeRenderDirectives(undefined);
  check('non-array input tolerated', out.dim.length === 0 && out.hl === null);
}

// ── B. C# shim source guards ────────────────────────────────────────────
const shimSrc = fs.readFileSync(path.resolve(here, '..', 'native', 'OpenCuesWindows.cs'), 'utf8');

check('hook callback never writes the socket inline (ThreadPool send)',
  /QueueUserWorkItem[\s\S]{0,80}SendRaw/.test(shimSrc),
  'QueueKeyMessage must dispatch SendRaw via ThreadPool — a blocking LL hook gets silently removed by Windows');

check('re-injected chords carry INJECT_MARK and the hook passes them through',
  shimSrc.includes('dwExtraInfo == INJECT_MARK') && shimSrc.includes('dwExtraInfo = INJECT_MARK'),
  'without the mark check, a consumed=false re-injection loops through our own hook forever');

check('overlay window is click-through and non-activating',
  /WS_EX_TRANSPARENT/.test(shimSrc) && /WS_EX_NOACTIVATE/.test(shimSrc)
    && /cp\.ExStyle \|= WS_EX_LAYERED \| WS_EX_TRANSPARENT \| WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE/.test(shimSrc),
  'the overlay must never take clicks or focus from the app it annotates');

check('chord swallow is gated on the per-field cycling capability',
  /_attached && _enabled && _fieldCycling && Connected/.test(shimSrc),
  'swallowing Ctrl+Alt+arrows without the _fieldCycling gate eats keys on non-cycling fields');

check('escape is observe-only (forwarded, never swallowed)',
  /VK_ESCAPE\)\s*\{\s*if \(down\) QueueKeyMessage\("escape", 0, false\);\s*return CallNextHookEx/.test(shimSrc),
  'swallowing global Escape would break every app\'s own Escape behaviour');

// ── B2. daemon source guards ────────────────────────────────────────────
const hostdSrc = fs.readFileSync(path.resolve(here, '..', 'src', 'hostd.cjs'), 'utf8');

check('focus handler sets fieldCycling BEFORE seeding the runtime',
  (() => {
    const focus = hostdSrc.slice(hostdSrc.indexOf("case 'focus'"), hostdSrc.indexOf("case 'blur'"));
    const a = focus.indexOf('fieldCycling = msg.cycling');
    const b = focus.indexOf('bootResult.notifyTextChange');
    return a >= 0 && b >= 0 && a < b;
  })(),
  "the resolver's source (re)build reads supportsCycling during the seeding notifyTextChange");

check('blur clears fieldCycling', /case 'blur'[\s\S]{0,900}fieldCycling = false/.test(hostdSrc),
  'a stale true leaks cycling onto the next non-cycling field');

// ── B3. same-field resume + late-write guards ───────────────────────────
{
  const blurCase = hostdSrc.slice(hostdSrc.indexOf("case 'blur'"), hostdSrc.indexOf("case 'text'"));
  check('blur DEFERS the buffer reset (no resetBufferState in the blur case)',
    !blurCase.includes('resetBufferState'),
    'an immediate reset on blur destroys spans a same-field refocus should resume');
}
check('focus has the same-field resume branch',
  /focus resume/.test(hostdSrc) && /fieldId === lastBlurFieldId/.test(hostdSrc),
  'without resume, every focus flicker wipes the marks (the 2026-07-20 report)');
check('daemon drops writes with no attached field AND poisons the resume',
  /setText dropped/.test(hostdSrc) && /pushText dropped/.test(hostdSrc)
    && (() => {
      const g = hostdSrc.indexOf('setText dropped');
      const around = hostdSrc.slice(Math.max(0, g - 400), g);
      return around.includes('lastBlurFieldId = null');
    })(),
  'a late in-flight result must neither ship detached nor leave stale spans resumable');
check('shim verifies the write target is the attached element',
  /FocusedElementIsAttached/.test(shimSrc) && /set-text dropped/.test(shimSrc),
  'a set-text after a focus change must never land in whatever the user focused next');

if (failures > 0) {
  console.error(`\n${failures} invariant(s) violated.`);
  process.exit(1);
}
console.log('\nAll phase-2 render/hook/overlay invariants hold.');
