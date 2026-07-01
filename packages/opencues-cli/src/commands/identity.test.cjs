// Tests for `opencues identity` — IDENTITY.md sentinel management.
//
// Two layers:
//   1. Pure parser/derivation/quoting helpers — exercise the
//      __test__ exports directly. These mirror contracts shared with
//      @opencues/core's identity.ts and would silently drift if
//      the regex chains diverge.
//   2. Subcommand E2E — spawn `bin/cli.cjs identity …` against a
//      sandbox HOME so we can assert real file writes without
//      touching the developer's actual ~/.cues/IDENTITY.md.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', 'bin', 'cli.cjs');
const cmd = require('./identity.cjs');
const { parseSentinelsMd, deriveToken, needsQuoting, stripInlineComment } = cmd.__test__;

// ────────────────────────────────────────────────────────────────────────────
// Token derivation — locked to core/identity.ts contract.
// ────────────────────────────────────────────────────────────────────────────

describe('deriveToken (must match @opencues/core)', () => {
  it('camelCase → spaced + upper-cased', () => {
    assert.strictEqual(deriveToken('firstName'), '[FIRST NAME]');
    assert.strictEqual(deriveToken('workCityHome'), '[WORK CITY HOME]');
    assert.strictEqual(deriveToken('signOff'), '[SIGN OFF]');
  });
  it('snake_case + kebab-case both flatten to spaces', () => {
    assert.strictEqual(deriveToken('first_name'), '[FIRST NAME]');
    assert.strictEqual(deriveToken('first-name'), '[FIRST NAME]');
  });
  it('SCREAMING_SNAKE survives uppercase', () => {
    assert.strictEqual(deriveToken('FIRST_NAME'), '[FIRST NAME]');
  });
  it('letter→digit boundary stays together (camelCase split is letter→letter)', () => {
    assert.strictEqual(deriveToken('phoneE164'), '[PHONE E164]');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Frontmatter parser
// ────────────────────────────────────────────────────────────────────────────

describe('parseSentinelsMd', () => {
  it('returns [] on empty/missing content', () => {
    assert.deepStrictEqual(parseSentinelsMd(''), []);
    assert.deepStrictEqual(parseSentinelsMd(null), []);
    assert.deepStrictEqual(parseSentinelsMd('no frontmatter here'), []);
  });
  it('parses simple key:value pairs', () => {
    const fields = parseSentinelsMd('---\nfirstName: Wilfred\nemail: w@e\n---');
    assert.deepStrictEqual(fields, [
      { key: 'firstName', value: 'Wilfred' },
      { key: 'email', value: 'w@e' },
    ]);
  });
  it('strips surrounding double + single quotes', () => {
    const fields = parseSentinelsMd('---\ntwitter: "@inventor"\nphone: \'+44 1\'\n---');
    assert.strictEqual(fields[0].value, '@inventor');
    assert.strictEqual(fields[1].value, '+44 1');
  });
  it('strips inline " # comment" outside quotes', () => {
    const fields = parseSentinelsMd('---\ncolor: blue # favourite\n---');
    assert.strictEqual(fields[0].value, 'blue');
  });
  it('preserves `#` inside a quoted value', () => {
    const fields = parseSentinelsMd('---\nslug: "#opencues"\n---');
    assert.strictEqual(fields[0].value, '#opencues');
  });
  it('skips empty-value lines', () => {
    const fields = parseSentinelsMd('---\nfirstName: Wilfred\nemptyKey:\n---');
    assert.strictEqual(fields.length, 1);
  });
  it('skips comment + indented lines', () => {
    const fields = parseSentinelsMd('---\n# section\nfirstName: Wilfred\n  notKey: x\n---');
    assert.deepStrictEqual(fields, [{ key: 'firstName', value: 'Wilfred' }]);
  });
});

describe('stripInlineComment', () => {
  it('removes " # ..." outside quotes', () => {
    assert.strictEqual(stripInlineComment('blue # favourite'), 'blue');
  });
  it('preserves "#" inside quotes', () => {
    assert.strictEqual(stripInlineComment('"#opencues"'), '"#opencues"');
  });
  it('keeps the value when no comment exists', () => {
    assert.strictEqual(stripInlineComment('Wilfred Kasekende'), 'Wilfred Kasekende');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Quoting policy
// ────────────────────────────────────────────────────────────────────────────

describe('needsQuoting', () => {
  it('plain text needs no quotes', () => {
    assert.strictEqual(needsQuoting('Wilfred Kasekende'), false);
    assert.strictEqual(needsQuoting('vim'), false);
  });
  it('YAML-reserved starters need quotes', () => {
    assert.strictEqual(needsQuoting('@inventor'), true);
    assert.strictEqual(needsQuoting('#tag'), true);
    assert.strictEqual(needsQuoting('-leading-dash'), true);
  });
  it('values that look like booleans/null need quotes', () => {
    for (const v of ['yes', 'no', 'true', 'false', 'null', 'On', 'OFF']) {
      assert.strictEqual(needsQuoting(v), true, `${v} should be quoted`);
    }
  });
  it('embedded " #" (would be parsed as inline comment) needs quotes', () => {
    assert.strictEqual(needsQuoting('foo #bar'), true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// E2E — spawn the CLI against a sandbox HOME.
//
// Each test gets a fresh tmpdir + HOME override + ~/.cues/ scaffold, so
// writes are isolated from the dev's real IDENTITY.md.
// ────────────────────────────────────────────────────────────────────────────

function runCli(args, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sent-'));
  const env = { ...process.env, HOME: tmp, FORCE_COLOR: '0', NO_COLOR: '1' };
  // These tests exercise HOME-based resolution; strip any ambient
  // $OPENCUES_HOME so a dev with it set in their shell doesn't redirect
  // the write out of the sandbox HOME. (The dedicated OPENCUES_HOME tests
  // below set it explicitly.)
  delete env.OPENCUES_HOME;
  if (opts.userMd) {
    fs.mkdirSync(path.join(tmp, '.cues'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.cues', 'IDENTITY.md'), opts.userMd, 'utf8');
  }
  const r = spawnSync('node', [CLI, 'identity', ...args], { env, encoding: 'utf8' });
  return { ...r, tmp, userMdPath: path.join(tmp, '.cues', 'IDENTITY.md') };
}

describe('opencues identity — E2E', () => {
  it('path: prints the absolute IDENTITY.md path (scriptable)', () => {
    const r = runCli(['path']);
    assert.strictEqual(r.status, 0);
    // Path resolves to $HOME/.cues/IDENTITY.md — the sandbox tmpdir's HOME.
    assert.match(r.stdout, /\.cues\/IDENTITY\.md\n$/);
    assert.strictEqual(r.stderr, '');
  });

  it('list: empty state on a fresh HOME shows an info hint', () => {
    const r = runCli(['list']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /no identity defined/);
  });

  it('list --json: emits valid JSON', () => {
    const r = runCli(['list', '--json'], {
      userMd: '---\nfirstName: Wilfred\nemail: w@e\n---\n',
    });
    assert.strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.deepStrictEqual(parsed, [
      { key: 'firstName', token: '[FIRST NAME]', value: 'Wilfred' },
      { key: 'email',     token: '[EMAIL]',      value: 'w@e' },
    ]);
  });

  it('set: writes a new sentinel + IDENTITY.md round-trips through parse', () => {
    const r = runCli(['set', 'jobTitle', 'Founder']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /added jobTitle/);
    const written = fs.readFileSync(r.userMdPath, 'utf8');
    assert.deepStrictEqual(parseSentinelsMd(written), [
      { key: 'jobTitle', value: 'Founder' },
    ]);
  });

  it('set: multi-word values (single argv after quoting at the shell) are joined', () => {
    // After the OS shell, "Staff Engineer" arrives as ONE argv entry —
    // simulate that here. (The CLI joins extra positional args defensively
    // so unquoted multi-word values still work: set signOff Best regards.)
    const r = runCli(['set', 'signOff', 'Best', 'regards']);
    assert.strictEqual(r.status, 0);
    const written = fs.readFileSync(r.userMdPath, 'utf8');
    assert.deepStrictEqual(parseSentinelsMd(written), [
      { key: 'signOff', value: 'Best regards' },
    ]);
  });

  it('set: updates an existing key in place', () => {
    const r1 = runCli(['set', 'jobTitle', 'Engineer'], {
      userMd: '---\njobTitle: Founder\n---\n',
    });
    assert.strictEqual(r1.status, 0);
    assert.match(r1.stdout, /updated jobTitle/);
    const written = fs.readFileSync(r1.userMdPath, 'utf8');
    const parsed = parseSentinelsMd(written);
    assert.deepStrictEqual(parsed, [{ key: 'jobTitle', value: 'Engineer' }]);
  });

  it('set: rejects an invalid key', () => {
    const r = runCli(['set', '123invalid', 'x']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /key "123invalid" must match/);
  });

  it('set: warns + exits non-zero on token collision', () => {
    const r = runCli(['set', 'first_name', 'Other'], {
      userMd: '---\nfirstName: Wilfred\n---\n',
    });
    assert.notStrictEqual(r.status, 0);
    // Both first_name and firstName derive to [FIRST NAME] — collision.
    assert.match(r.stderr, /FIRST NAME/);
    assert.match(r.stderr, /collision/);
  });

  it('add: alias for set', () => {
    const r = runCli(['add', 'jobTitle', 'Founder']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /added jobTitle/);
  });

  it('set: quotes values that start with YAML special chars (@, #, etc.)', () => {
    const r = runCli(['set', 'twitter', '@inventor']);
    assert.strictEqual(r.status, 0);
    const written = fs.readFileSync(r.userMdPath, 'utf8');
    // Verify the written file uses quotes (so it round-trips through
    // the YAML parser without misinterpretation).
    assert.match(written, /twitter:\s+"@inventor"/);
    assert.deepStrictEqual(parseSentinelsMd(written), [
      { key: 'twitter', value: '@inventor' },
    ]);
  });

  it('remove: deletes a sentinel', () => {
    const r = runCli(['remove', 'jobTitle'], {
      userMd: '---\nfirstName: Wilfred\njobTitle: Founder\n---\n',
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /removed jobTitle/);
    const written = fs.readFileSync(r.userMdPath, 'utf8');
    assert.deepStrictEqual(parseSentinelsMd(written), [
      { key: 'firstName', value: 'Wilfred' },
    ]);
  });

  it('rm: alias for remove', () => {
    const r = runCli(['rm', 'jobTitle'], {
      userMd: '---\njobTitle: Founder\n---\n',
    });
    assert.strictEqual(r.status, 0);
  });

  it('remove: errors on missing key', () => {
    const r = runCli(['remove', 'nope']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /no sentinel with key "nope"/);
  });

  it('unknown subcommand: prints error + non-zero exit', () => {
    const r = runCli(['frobnicate']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /unknown subcommand/);
  });

  it('--help: prints help + exits 0', () => {
    const r = runCli(['--help']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /opencues identity/);
    assert.match(r.stdout, /identity-context-mode/);
  });

  it('preserves user-added keys not asked about in the interview when writing via set', () => {
    // A user has favoriteEditor in IDENTITY.md. Setting a NEW key should
    // leave favoriteEditor in place.
    const r = runCli(['set', 'jobTitle', 'Founder'], {
      userMd: '---\nfirstName: Wilfred\nfavoriteEditor: vim\n---\n',
    });
    assert.strictEqual(r.status, 0);
    const written = fs.readFileSync(r.userMdPath, 'utf8');
    const parsed = parseSentinelsMd(written);
    const keys = parsed.map(p => p.key);
    assert.ok(keys.includes('firstName'));
    assert.ok(keys.includes('favoriteEditor'));
    assert.ok(keys.includes('jobTitle'));
  });

  it('set: refuses with capacity-exceeded once IDENTITY.md is full', () => {
    // Build a IDENTITY.md at the default cap (64 fields) and try to add
    // one more. The validator should refuse with an exit code and a
    // visible hint about removing unused identity.
    const lines = Array.from({ length: 64 }, (_, i) => `k${i}: v${i}`).join('\n');
    const r = runCli(['set', 'overflow', 'x'], {
      userMd: `---\n${lines}\n---\n`,
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /IDENTITY\.md is full/);
    assert.match(r.stderr, /remove unused/i);
  });

  it('set: refuses with value-too-long when value exceeds cap', () => {
    const huge = 'x'.repeat(300);
    const r = runCli(['set', 'bio', huge]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /exceeds 256-char cap/);
  });

  it('set: refuses values with NUL or control chars', () => {
    // Bash doesn't easily pass NUL to argv; use an ESC-containing
    // value instead (also caught by FORBIDDEN_VALUE_CHARS).
    const r = runCli(['set', 'k', `foo\x1bbar`]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /forbidden control characters/);
  });

  it('honours $OPENCUES_HOME over ~/.cues for the write target', () => {
    // Regression: identity used to hardcode os.homedir()/.cues, silently
    // ignoring $OPENCUES_HOME and always writing the real ~/.cues/IDENTITY.md
    // even when the caller pointed OPENCUES_HOME elsewhere.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sent-'));
    const ocHome = path.join(tmp, 'custom', '.cues');
    fs.mkdirSync(ocHome, { recursive: true });
    const env = { ...process.env, HOME: tmp, OPENCUES_HOME: ocHome, FORCE_COLOR: '0', NO_COLOR: '1' };
    const r = spawnSync('node', [CLI, 'identity', 'set', 'jobTitle', 'Founder'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    // Write landed under $OPENCUES_HOME …
    const ocFile = path.join(ocHome, 'IDENTITY.md');
    assert.ok(fs.existsSync(ocFile), 'IDENTITY.md should be written under $OPENCUES_HOME');
    assert.deepStrictEqual(parseSentinelsMd(fs.readFileSync(ocFile, 'utf8')), [
      { key: 'jobTitle', value: 'Founder' },
    ]);
    // … and NOT under $HOME/.cues.
    assert.ok(!fs.existsSync(path.join(tmp, '.cues', 'IDENTITY.md')),
      '$HOME/.cues/IDENTITY.md must NOT be created when $OPENCUES_HOME is set');
  });

  it('path: reflects $OPENCUES_HOME when set', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sent-'));
    const ocHome = path.join(tmp, 'custom', '.cues');
    fs.mkdirSync(ocHome, { recursive: true });
    const env = { ...process.env, HOME: tmp, OPENCUES_HOME: ocHome, FORCE_COLOR: '0', NO_COLOR: '1' };
    const r = spawnSync('node', [CLI, 'identity', 'path'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), path.join(ocHome, 'IDENTITY.md'));
  });

  it('preserves the file body (docstring) across writes', () => {
    const body = '# IDENTITY.md — custom body\n\nMy notes here.\n';
    const r = runCli(['set', 'jobTitle', 'Founder'], {
      userMd: `---\nfirstName: Wilfred\n---\n${body}`,
    });
    assert.strictEqual(r.status, 0);
    const written = fs.readFileSync(r.userMdPath, 'utf8');
    assert.ok(written.includes('My notes here.'),
      `body docstring should survive. Wrote:\n${written}`);
  });
});
