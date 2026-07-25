// Clipboard + stale-model write invariants — a SOURCE guard for the C# shim.
//
// Same rationale as newline-invariants.mjs: the shim is Add-Type-compiled
// C#, Windows-only, and these failure modes are SILENT — the exact classes
// that cost real time on 2026-07-14:
//
//   1. PasteReplace restored the user's clipboard on a FIXED TIMER (300ms)
//      while Electron consumes the clipboard asynchronously (>1.1s observed
//      on Discord under load). When the restore won the race, Ctrl+V pasted
//      the user's OLD clipboard into the focused app — a copied email
//      address replaced the substitution. That is a clipboard LEAK into
//      whatever app is focused, not just a wrong render.
//   2. Write paths computed diffs against the shim's MODEL of the field
//      (`_lastSentText` / daemon-supplied oldText) without verifying
//      reality; a stale model turned backspace bursts into user-content
//      deletion ("congratulations" typed mid-animation lost its "con").
//
// If a refactor reintroduces either shape, nothing errors — this catches it.
//
// Run: node integrations/windows/tests/clipboard-invariants.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shimPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'OpenCuesWindows.cs');
const src = fs.readFileSync(shimPath, 'utf8');

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && detail ? '  — ' + detail : ''));
  if (!ok) failures++;
};
const has = (re) => re.test(src);

// Slice out PasteReplace's body (up to the next `static ` at the same
// nesting depth is overkill — grab a generous window).
const prStart = src.indexOf('static void PasteReplace');
const pasteReplace = prStart >= 0 ? src.slice(prStart, prStart + 8000) : '';

// 1. The restore must be gated on VERIFIED paste consumption, never a bare
//    timer. Positive: a consumption flag + a conditional restore.
check('PasteReplace verifies consumption before restoring the clipboard',
  /bool consumed = false;[\s\S]*?if \(consumed\)[\s\S]*?SetClipboardText\(saved\)/.test(pasteReplace),
  'restore must sit inside an `if (consumed)` after a field-readback verify loop');

// 2. The old timer-restore shape must not come back: a Sleep immediately
//    followed by an unconditional restore.
check('no timer-raced clipboard restore',
  !/Thread\.Sleep\(\d+\);\s*\r?\n\s*if \(saved != null\) \{ try \{ SetClipboardText\(saved\)/.test(src),
  'Thread.Sleep(N) directly followed by an unconditional SetClipboardText(saved) is the raced shape');

// 3. Fail-safe on timeout: the unverified path must SKIP the restore and
//    say so (losing old clipboard contents is an annoyance; pasting them
//    into the foreground app is a leak).
check('unverified consumption skips the restore, loudly',
  /clipboard NOT restored/.test(pasteReplace),
  'timeout path must warn and skip SetClipboardText(saved)');

// 4. PasteReplace rebases its diff on a FRESH field read before deleting
//    anything (stale oldText → backspaces eat user content).
check('PasteReplace rebases diff on a fresh field read',
  /TryReadCurrentField\(out fresh\)[\s\S]*?oldText = fresh/.test(pasteReplace),
  'must re-read the field and supersede stale oldText before computing the backspace count');

// 5. The micro-frame animation path must verify the field still matches
//    its model before sending backspaces, and DROP the frame on
//    divergence (animation is cosmetic; the final write is the anchor).
const tmStart = src.indexOf('static bool TryTypeMicroEdit');
const tryType = tmStart >= 0 ? src.slice(tmStart, tmStart + 5000) : '';
check('micro-frames read-before-write and drop on divergence',
  /TryReadCurrentField\(out live\)[\s\S]*?return true;/.test(tryType) && /micro-frame skipped/.test(tryType),
  'TryTypeMicroEdit must verify the live field against _lastSentText and swallow the frame on mismatch');

// 6. EOL-blind comparisons everywhere the verify reads back (apps re-dress
//    newlines; a raw != would false-diverge every multi-line field).
check('verify comparisons are EolNorm-folded',
  /EolNorm\(now\) == want/.test(pasteReplace) && /EolNorm\(live\) != EolNorm\(cur\)/.test(tryType),
  'both verify sites must compare through EolNorm');

// 7. Consumption matching must have the fold-tolerant fallback: apps
//    re-dress pasted text in readbacks (Discord/Slate emoji + markdown
//    dress), so exact-equality-only verification times out on pastes
//    that plainly landed — and the fail-safe then eats the user's
//    clipboard restore on EVERY big substitution (observed live
//    2026-07-14 18:35). The fallback must also have a minimum-length
//    gate so short generic pastes can't false-match pre-existing text.
check('consumption verify has the AlnumFold fallback with a min-length gate',
  /wantFold\.Length >= 12/.test(pasteReplace) && /AlnumFold\(now, \d+\)\.Contains\(wantFold\)/.test(pasteReplace),
  'PasteReplace verify loop must fall back to fold-contains with a >=12 fold-char gate');

console.log(failures === 0 ? '\nall clipboard/stale-model invariants hold' : `\n${failures} invariant(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
