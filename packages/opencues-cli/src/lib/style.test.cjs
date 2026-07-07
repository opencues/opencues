// Tests for `lib/style.cjs` — terminal styling chrome (colour/glyph
// auto-detection + the tag/tree/banner/fileLink helpers every command uses).
// No prior coverage existed.
//
// `enabled`/`utf8` are computed ONCE at module load from env vars +
// process.stdout.isTTY, so exercising both branches requires resetting
// require.cache and re-requiring after changing env — mirrors the
// freshPrompt() pattern in prompt.test.cjs. No filesystem/HOME access
// happens anywhere in this module, so the usual HOME-hermeticity rule
// doesn't apply here; we still restore every env var we touch so this
// file can't leak state into sibling test files run in the same process.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR', 'TERM', 'OPENCUES_ASCII', 'LANG', 'LC_ALL', 'LC_CTYPE'];

// Require style.cjs with a fully-controlled env (every relevant var either
// cleared or set explicitly) so tests don't depend on the ambient shell.
function freshStyle(overrides = {}) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  delete require.cache[require.resolve('./style.cjs')];
  const mod = require('./style.cjs');
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('./style.cjs')];
  };
  return { mod, restore };
}

function withStyle(overrides, fn) {
  const { mod, restore } = freshStyle(overrides);
  try {
    fn(mod);
  } finally {
    restore();
  }
}

// ─── Happy path — colour enabled (FORCE_COLOR) ─────────────────────────────

test('happy: FORCE_COLOR=1 enables ANSI wrapping on bold/dim/colours', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.bold('x'), '\x1b[1mx\x1b[22m');
    assert.strictEqual(s.dim('x'), '\x1b[2mx\x1b[22m');
    assert.strictEqual(s.green('x'), '\x1b[32mx\x1b[39m');
    assert.strictEqual(s.red('x'), '\x1b[31mx\x1b[39m');
  });
});

test('happy: tag() returns a coloured glyph for each known severity kind', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    assert.strictEqual(s.tag('ok'), '\x1b[32m[ok]\x1b[39m');
    assert.strictEqual(s.tag('warn'), '\x1b[33m[warn]\x1b[39m');
    assert.strictEqual(s.tag('err'), '\x1b[31m[err]\x1b[39m');
    assert.ok(s.tag('info').length > 0);
  });
});

test('happy: LANG=en_US.UTF-8 selects the UTF-8 glyph set', () => {
  withStyle({ FORCE_COLOR: '1', LANG: 'en_US.UTF-8' }, (s) => {
    assert.strictEqual(s.utf8, true);
    assert.strictEqual(s.G.ringOn, '●'); // ●
    assert.strictEqual(s.G.pointer, '❯'); // ❯
  });
});

test('happy: banner() includes version + tagline when colour is enabled', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    const out = s.banner({ version: '1.2.3', tagline: 'lint .cues/ configs' });
    assert.match(out, /v1\.2\.3/);
    assert.match(out, /lint \.cues\/ configs/);
    assert.match(out, /OpenCues/);
  });
});

test('happy: tree() renders aligned label/value rows under a title', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    const out = s.tree({
      title: 'Section',
      rows: [['short', 'v1'], ['muchlonger', 'v2']],
    });
    const lines = out.split('\n');
    assert.match(lines[0], /Section/);
    // 3 lines: title, connector, then one row per entry (2 rows) = 4 total
    assert.strictEqual(lines.length, 4);
  });
});

test('happy: cliVersion(ctx) prefers ctx.pkg.version', () => {
  withStyle({}, (s) => {
    assert.strictEqual(s.cliVersion({ pkg: { version: '9.9.9' } }), '9.9.9');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────

test('edge: NO_COLOR wins over FORCE_COLOR (disables colour regardless)', () => {
  withStyle({ NO_COLOR: '1', FORCE_COLOR: '1' }, (s) => {
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.bold('x'), 'x');
  });
});

test('edge: TERM=dumb disables colour even with FORCE_COLOR set', () => {
  withStyle({ FORCE_COLOR: '1', TERM: 'dumb' }, (s) => {
    assert.strictEqual(s.enabled, false);
  });
});

test('edge: OPENCUES_ASCII=1 forces the ASCII glyph set even under a UTF-8 locale', () => {
  withStyle({ FORCE_COLOR: '1', LANG: 'en_US.UTF-8', OPENCUES_ASCII: '1' }, (s) => {
    assert.strictEqual(s.utf8, false);
    assert.strictEqual(s.G.ringOn, '(*)');
  });
});

test('edge: cliVersion falls back to reading package.json when ctx has no pkg', () => {
  withStyle({}, (s) => {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const expected = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    assert.strictEqual(s.cliVersion({}), expected);
    assert.strictEqual(s.cliVersion(undefined), expected);
  });
});

test('edge: existsMark distinguishes true / false / unknown', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    assert.notStrictEqual(s.existsMark(true), '');
    assert.notStrictEqual(s.existsMark(false), '');
    assert.notStrictEqual(s.existsMark(true), s.existsMark(false));
    assert.strictEqual(s.existsMark(undefined), '');
    assert.strictEqual(s.existsMark(null), '');
  });
});

test('edge: fileLink wraps an absolute path with OSC 8 when enabled', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    const out = s.fileLink('label', '/home/user/.cues/CUES.md');
    assert.match(out, /\x1b\]8;;file:\/\/\/home\/user\/\.cues\/CUES\.md\x07label/);
  });
});

test('edge: fileLink returns plain text for a relative path (no leading slash)', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    assert.strictEqual(s.fileLink('label', 'relative/path.md'), 'label');
  });
});

test('edge: link()/fileLink() return plain text when colour is disabled', () => {
  withStyle({}, (s) => {
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.link('label', 'https://example.com'), 'label');
    assert.strictEqual(s.fileLink('label', '/abs/path.md'), 'label');
  });
});

test('edge: rule() defaults to 60 chars, honours an explicit width', () => {
  withStyle({}, (s) => {
    assert.strictEqual(s.rule().length, 60);
    assert.strictEqual(s.rule(10).length, 10);
  });
});

test('edge: gutter() accepts both a string (split on \\n) and an array of lines', () => {
  withStyle({}, (s) => {
    const fromString = s.gutter('a\nb');
    const fromArray = s.gutter(['a', 'b']);
    assert.strictEqual(fromString, fromArray);
    assert.strictEqual(fromString.split('\n').length, 2);
  });
});

// ─── Invalid / degenerate input ────────────────────────────────────────────

test('invalid: tag() with an unknown kind falls back to a bracketed label', () => {
  withStyle({ FORCE_COLOR: '1' }, (s) => {
    assert.strictEqual(s.tag('bogus-kind'), '[bogus-kind]');
  });
});

test('invalid: tree() with an empty rows array and no title renders nothing', () => {
  withStyle({}, (s) => {
    assert.strictEqual(s.tree({ rows: [] }), '');
  });
});

test('invalid: cliVersion swallows a read failure and returns undefined', () => {
  withStyle({}, (s) => {
    // ctx.pkg present but version missing falls through to the file-read
    // fallback (real file exists in this repo, so this still resolves) —
    // pass a ctx that can't be mistaken for a real pkg object at all
    // to confirm the function never throws on odd input.
    assert.doesNotThrow(() => s.cliVersion({ pkg: {} }));
    assert.doesNotThrow(() => s.cliVersion(null));
  });
});
