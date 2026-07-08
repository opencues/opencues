// Faithful JS port of the C# diff-window planning in OpenCuesWindows.cs
// (CommonPrefixLen / CommonSuffixLen / PasteReplace's branch choice) so the
// logic is testable on WSL where the C# can't compile (same approach that
// validated MiniJson). HAND-MIRRORED: if you edit the C# planning logic,
// update this port in the same PR or it silently pins stale behaviour.
// Run: node integrations/windows/tests/diff-window.test.mjs

const LEFT_MAX = 400;
const BACKSPACE_MAX = 160;

function commonPrefixLen(a, b) {
  if (a == null || b == null) return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a, b, prefix) {
  if (a == null || b == null) return 0;
  const n = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function plan(text, oldText) {
  const oldLen = oldText != null ? oldText.length : 0;
  const p = commonPrefixLen(oldText, text);
  const s = commonSuffixLen(oldText, text, p);
  const changed = oldLen - p - s;
  const fragment = text.substring(p, text.length - s);
  const caretWalkable = s === 0
    || (s <= LEFT_MAX && oldText.indexOf('\r', oldLen - s) < 0);
  const windowed = changed <= BACKSPACE_MAX && caretWalkable;
  return { p, s, changed, fragment, windowed,
           usesClipboard: windowed ? fragment.length > 0 : true };
}

// Invariant check: replaying the plan must reconstruct `text` from `oldText`.
function replay(text, oldText, pl) {
  if (!pl.windowed) return text; // ctrl+A + full paste
  const old = oldText ?? '';
  return old.slice(0, pl.p) + pl.fragment + (pl.s > 0 ? old.slice(old.length - pl.s) : '');
}

let fails = 0;
function t(name, oldText, text, expect) {
  const pl = plan(text, oldText);
  const rebuilt = replay(text, oldText, pl);
  const problems = [];
  if (rebuilt !== text) problems.push(`replay mismatch: ${JSON.stringify(rebuilt)}`);
  for (const [k, v] of Object.entries(expect)) {
    if (pl[k] !== v) problems.push(`${k}: got ${JSON.stringify(pl[k])}, want ${JSON.stringify(v)}`);
  }
  if (problems.length) { fails++; console.log(`FAIL ${name}\n  ${problems.join('\n  ')}`); }
  else console.log(`ok   ${name}  (p=${pl.p} s=${pl.s} win=${pl.changed} frag=${pl.fragment.length})`);
}

t('append at end',            'abc',                'abc def',             { p: 3, s: 0, changed: 0, windowed: true, usesClipboard: true });
t('truncate tail (pure del)', 'abc def',            'abc',                 { p: 3, s: 0, changed: 4, fragment: '', windowed: true, usesClipboard: false });
t('mid-buffer word swap',     'the cat sat on mat', 'the dog sat on mat',  { p: 4, s: 11, changed: 3, fragment: 'dog', windowed: true });
t('prefix/suffix overlap',    'aaa',                'aa',                  { p: 2, s: 0, changed: 1, fragment: '', windowed: true, usesClipboard: false });
t('overlap repeat',           'abab',               'ab',                  { p: 2, s: 0, changed: 2, fragment: '', windowed: true });
t('identical',                'same',               'same',                { p: 4, s: 0, changed: 0, fragment: '', windowed: true, usesClipboard: false });
t('empty old',                '',                   'hello',               { p: 0, s: 0, changed: 0, fragment: 'hello', windowed: true });
t('null old',                 null,                 'hello',               { p: 0, s: 0, changed: 0, fragment: 'hello', windowed: true });
t('delete everything',        'hello',              '',                    { p: 0, s: 0, changed: 5, fragment: '', windowed: true, usesClipboard: false });
t('CR in kept suffix -> fallback', 'X\r\ntail',     'ZZ\r\ntail',          { windowed: false, usesClipboard: true });
t('LF-only suffix walkable',  'X\ntail',            'ZZ\ntail',            { p: 0, s: 5, changed: 1, windowed: true });
t('big window -> fallback',   'a'.repeat(500),      'b'.repeat(500),       { windowed: false });
t('huge suffix -> fallback',  'X' + 'k'.repeat(500),'Z' + 'k'.repeat(500), { p: 0, s: 500, windowed: false });
t('mid-buffer sentence rewrite',
  'Intro. The quick brown fox jumps over the lazy dog. Outro stays put.',
  'Intro. A fast auburn fox leaps over the idle hound. Outro stays put.',
  { windowed: true });
t('window == cap boundary',   'x'.repeat(160) + 'T', 'T',                  { changed: 160, windowed: true });
t('window just over cap',     'x'.repeat(161) + 'T', 'T',                  { changed: 161, windowed: false });

// Fuzz: 5000 random old/new pairs (incl. newlines), replay must always equal text.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const alphabet = 'ab \n';
const rndStr = (n) => Array.from({ length: Math.floor(rnd() * n) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
let fuzzFails = 0;
for (let i = 0; i < 5000; i++) {
  const o = rndStr(60), n = rndStr(60);
  const pl = plan(n, o);
  if (replay(n, o, pl) !== n) { fuzzFails++; console.log('FUZZ FAIL', JSON.stringify([o, n])); }
  if (pl.p + pl.s > Math.min(o.length, n.length)) { fuzzFails++; console.log('OVERLAP FAIL', JSON.stringify([o, n])); }
}
console.log(fuzzFails === 0 ? 'ok   fuzz 5000 replays exact' : `FAIL fuzz: ${fuzzFails}`);
process.exit(fails + fuzzFails ? 1 : 0);
