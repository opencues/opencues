// Newline-rendering invariants — a SOURCE guard for the C# shim.
//
// The shim's newline handling (NormalizeNewlinesForApp / EolNorm / the EM
// soft-break conversion / the Slack paste routing) is Add-Type-compiled C#,
// Windows-only, and its real effect is VISUAL rendering inside WordPad/Slack —
// so it can't be unit-tested here and the r5 e2e (which drives the daemon via a
// fake shim) never reaches it. What this file CAN do cheaply, on any OS, is pin
// the invariants whose loss is SILENT — the exact bug classes that cost real
// time (a case-sensitive richedit check that never fired; the blank-line
// collapse that erased paragraph structure; an EolNorm that didn't fold the
// soft-break char, so soft-break writes read back "different" and loop). If a
// refactor drops one of these, the feature breaks with no error — this catches
// that. The visual behavior itself is verified by newline-rendering.manual.md.
//
// Run: node integrations/windows/tests/newline-invariants.mjs

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

// 1. EolNorm must fold every break dress (CR, VT soft break, U+2028) to LF, or
//    a soft-break write reads back "different" and the write-attribution loops.
check('EolNorm folds VT (\\v)', has(/EolNorm[\s\S]*?Replace\('\\v',\s*'\\n'\)/),
  'EolNorm must .Replace(\'\\v\', \'\\n\')');
check('EolNorm folds U+2028', has(/EolNorm[\s\S]*?Replace\('\\u2028',\s*'\\n'\)/),
  'EolNorm must .Replace(\'\\u2028\', \'\\n\')');

// 2. Paragraph-apps must NOT collapse \n\n (that erased the blank lines and
//    flattened the paragraph structure — the retired d10579ff behavior).
check('NormalizeNewlinesForApp does NOT collapse \\n\\n',
  !/while\s*\([^)]*Contains\("\\n\\n"\)\)/.test(src),
  'found a `while (… Contains("\\n\\n"))` collapse loop — it must stay retired');

// 3. The richedit class test must be CASE-INSENSITIVE — IsEditClassHwnd returns
//    the raw class ("RICHEDIT50W"); a plain Contains("richedit") silently never
//    fired, so the WordPad soft-break conversion never ran.
check('richedit class check is case-insensitive',
  has(/ToLowerInvariant\(\)\.Contains\("richedit"\)/),
  'the WordPad EM gate must use ToLowerInvariant().Contains("richedit")');

// 4. WordPad path converts every newline to the VT soft break (no paragraph
//    margin), and Slack's final write is routed through paste (soft breaks).
check('WordPad EM path maps \\n -> VT (\\v)', has(/Replace\('\\n',\s*'\\v'\)/),
  'the emText conversion must map \\n to \\v');
check('Slack final write routes through paste',
  has(/PastePreferredApps\.Contains\(_lastApp\)/) && has(/PasteReplace\(/),
  'a PastePreferredApps.Contains(_lastApp) branch must call PasteReplace');

// 5. The per-app routing sets carry the expected default members.
check('RichEditParagraphApps includes wordpad',
  /RichEditParagraphApps[\s\S]*?\{\s*"wordpad"\s*\}/.test(src));
check('PastePreferredApps default includes slack',
  /ReadPasteApps[\s\S]*?Add\("slack"\)/.test(src));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
