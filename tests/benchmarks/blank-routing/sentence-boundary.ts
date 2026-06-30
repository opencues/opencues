// Benchmark: sentence-aware shaped-blank routing (A/B vs the old newline-only
// boundary). Deterministic — no LLM. Measures whether anchoring a command at
// the last SENTENCE terminator (or newline) instead of just the newline:
//   (a) RECOVERS recall — commands written after a `.`/`!`/`?` on the same line
//       now fire ("let me check the audio. volume 30 _"), and
//   (b) HOLDS precision — prose that merely mentions a keyword, and decimals /
//       versions ("3.5", "gpt-5.4"), still cede cleanly.
//
// Run: npx tsx tests/benchmarks/blank-routing/sentence-boundary.ts
//
// The NEW boundary is `segmentStart` from @opencues/core (the same predicate
// fluid-config's summonPhraseStart uses). The OLD boundary is reproduced inline
// so the two can be scored on the identical corpus.

import { segmentStart } from '../../../packages/opencues-core/src/segment';
import { synthesizeKeywordShapes, type BlankShape } from '../../../packages/opencues-core/src/cues-md';

type Boundary = (text: string, pos: number) => number;

// OLD: physical-line only — scan back to the last newline before `_`.
const oldBoundary: Boundary = (text, pos) => text.lastIndexOf('\n', pos) + 1;
// NEW: sentence terminator OR newline (the shipped change).
const newBoundary: Boundary = (text, pos) => segmentStart(text, pos);

const BLANKS: ReadonlyMap<string, BlankShape[]> = new Map([
  ['volume', [
    { pattern: '^volume\\s*_$', action: 'get' },
    { pattern: '^volume\\s+(\\d+)\\s*%?\\s*_$', action: 'set', valueGroup: 1 },
    { pattern: '^set\\s+volume\\s+(?:to\\s+)?(\\d+)\\s*%?\\s*_$', action: 'set', valueGroup: 1 },
    { pattern: '^volume\\s+(up|down)\\s*_$', action: 'step', valueGroup: 1 },
  ]],
  ['weather', synthesizeKeywordShapes(['weather', 'forecast'], false)],
]);

// Faithful re-implementation of matchBlankShape with a pluggable boundary.
function route(text: string, boundary: Boundary): string | null {
  const s = text.replace(/[​‌]/g, '');
  const us = s.lastIndexOf('_');
  if (us === -1) return null;
  const start = boundary(s, us);
  let end = s.indexOf('\n', us);
  if (end === -1) end = s.length;
  const seg = s.slice(start, end).trim();
  if (!seg.includes('_')) return null;
  for (const [name, shapes] of BLANKS) {
    for (const shape of shapes) {
      let re: RegExp;
      try { re = new RegExp(shape.pattern, 'i'); } catch { continue; }
      if (re.test(seg)) return name;
    }
  }
  return null;
}

interface Case { text: string; expect: string | null; cat: string; }

const CORPUS: Case[] = [
  // bare command (both should fire)
  { text: 'volume _', expect: 'volume', cat: 'bare' },
  { text: 'volume 30 _', expect: 'volume', cat: 'bare' },
  { text: 'volume up _', expect: 'volume', cat: 'bare' },
  { text: 'weather oslo _', expect: 'weather', cat: 'bare' },
  { text: 'forecast _', expect: 'weather', cat: 'bare' },

  // command on its own line, prior content above (both should fire)
  { text: 'some notes here\nvolume 30 _', expect: 'volume', cat: 'newline' },
  { text: 'todo list:\nweather paris _', expect: 'weather', cat: 'newline' },
  { text: 'line one\nline two\nvolume _', expect: 'volume', cat: 'newline' },

  // THE FIX: command after a sentence terminator on the SAME line
  { text: 'let me check the audio. volume 30 _', expect: 'volume', cat: 'sentence-same-line' },
  { text: 'one sec. weather oslo _', expect: 'weather', cat: 'sentence-same-line' },
  { text: 'done with that! volume up _', expect: 'volume', cat: 'sentence-same-line' },
  { text: 'what now? volume _', expect: 'volume', cat: 'sentence-same-line' },
  { text: 'turning things down. set volume to 20 _', expect: 'volume', cat: 'sentence-same-line' },
  { text: 'first the lights. weather tokyo _', expect: 'weather', cat: 'sentence-same-line' },

  // A connective word BEFORE the keyword still cedes — the command must LEAD
  // its sentence; sentence-awareness doesn't strip "then"/"and"/etc. (clean
  // cede to fluid-blank, never garbage). Documents the boundary's limit.
  { text: 'first the lights. then weather tokyo _', expect: null, cat: 'connective-prefix' },
  { text: 'ok and volume 30 _', expect: null, cat: 'connective-prefix' },

  // CJK terminator (no trailing space) — also same-line recovery
  { text: 'こんにちは世界。volume 40 _', expect: 'volume', cat: 'cjk-terminator' },
  { text: '準備中です。weather kyoto _', expect: 'weather', cat: 'cjk-terminator' },

  // decimal / version dots must NOT split (and command is buried → cede)
  { text: 'the cost was 3.5 dollars volume _', expect: null, cat: 'decimal-guard' },
  { text: 'gpt-5.4 is fast volume _', expect: null, cat: 'decimal-guard' },
  // …but a real sentence end before the command DOES fire it
  { text: 'it cost 3.5 dollars. volume _', expect: 'volume', cat: 'decimal-then-cmd' },

  // prose that merely mentions a keyword — must cede (precision)
  { text: 'the volume was lovely today _', expect: null, cat: 'prose-precision' },
  { text: 'the volume of the box is _', expect: null, cat: 'prose-precision' },
  { text: 'what should i set the volume to _', expect: null, cat: 'prose-precision' },
  { text: 'i love checking the weather _', expect: null, cat: 'prose-precision' },
  { text: 'how much is amd stock _', expect: null, cat: 'prose-precision' },

  // sentence ends, then a NON-command sentence — must cede (precision)
  { text: 'i turned it down. what a lovely day _', expect: null, cat: 'sentence-then-prose' },
  { text: 'done. anyway moving on _', expect: null, cat: 'sentence-then-prose' },
  { text: 'checked the forecast. it looks nice _', expect: null, cat: 'sentence-then-prose' },

  // keyword on a PREVIOUS line, command line is prose — must cede
  { text: 'volume notes\njust a plain line _', expect: null, cat: 'prev-line' },
];

function score(boundary: Boundary) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const byCat: Record<string, { fire: number; total: number; wrong: number }> = {};
  for (const c of CORPUS) {
    const got = route(c.text, boundary);
    const slot = (byCat[c.cat] ??= { fire: 0, total: 0, wrong: 0 });
    slot.total += 1;
    if (c.expect === null) {
      if (got === null) tn += 1; else { fp += 1; slot.wrong += 1; }
    } else if (got === c.expect) { tp += 1; slot.fire += 1; }
    else if (got === null) { fn += 1; }
    else { fp += 1; slot.wrong += 1; } // fired the wrong blank
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { tp, fp, fn, tn, precision, recall, byCat };
}

const pct = (n: number) => (n * 100).toFixed(1) + '%';

const oldS = score(oldBoundary);
const newS = score(newBoundary);

console.log('\nSentence-aware shaped-blank routing — A/B over ' + CORPUS.length + ' labeled cases\n');
console.log('                         OLD (newline only)   NEW (sentence-aware)');
console.log('  precision              ' + pct(oldS.precision).padEnd(20) + pct(newS.precision));
console.log('  recall                 ' + pct(oldS.recall).padEnd(20) + pct(newS.recall));
console.log('  TP / FP / FN / TN      ' +
  `${oldS.tp}/${oldS.fp}/${oldS.fn}/${oldS.tn}`.padEnd(20) +
  `${newS.tp}/${newS.fp}/${newS.fn}/${newS.tn}`);

console.log('\n  per-category recall (fired / should-fire), * = improved by NEW:');
const cats = [...new Set(CORPUS.map(c => c.cat))];
for (const cat of cats) {
  const expectFire = CORPUS.filter(c => c.cat === cat && c.expect !== null).length;
  const o = oldS.byCat[cat]?.fire ?? 0;
  const n = newS.byCat[cat]?.fire ?? 0;
  const fpN = newS.byCat[cat]?.wrong ?? 0;
  const star = n > o ? ' *' : '';
  const fpNote = fpN > 0 ? `  [FALSE-FIRE: ${fpN}]` : '';
  if (expectFire > 0) {
    console.log(`    ${cat.padEnd(22)} ${o}/${expectFire}  →  ${n}/${expectFire}${star}${fpNote}`);
  } else {
    // precision categories: report false-fires (lower is better)
    const oFp = oldS.byCat[cat]?.wrong ?? 0;
    console.log(`    ${cat.padEnd(22)} cede ${oFp === 0 ? 'clean' : oFp + ' false'}  →  cede ${fpN === 0 ? 'clean' : fpN + ' false'}${fpN > oFp ? ' *REGRESSED*' : ''}`);
  }
}

const recallGain = newS.recall - oldS.recall;
const precisionDelta = newS.precision - oldS.precision;
console.log('\n  Δ recall    ' + (recallGain >= 0 ? '+' : '') + pct(recallGain));
console.log('  Δ precision ' + (precisionDelta >= 0 ? '+' : '') + pct(precisionDelta) +
  (precisionDelta < 0 ? '   ⚠️  PRECISION REGRESSED' : '   (held)'));
console.log('');

// Non-zero exit if the change ever trades precision for recall — a guard so this
// doubles as a regression gate, not just a report.
if (newS.precision < oldS.precision || newS.recall < oldS.recall) {
  console.error('FAIL: NEW boundary regressed precision or recall vs OLD.');
  process.exit(1);
}
console.log('PASS: recall up, precision held.\n');
