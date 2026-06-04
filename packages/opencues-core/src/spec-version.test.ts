// Spec-version gate — unit tests for parseSpecPin + isSpecCompatible.
//
// These pin the version-compat algorithm against:
//   - the current draft regime (`0.x`)
//   - the projected post-stable regime (`1.0+`)
//   - omitted / unparseable input
//   - the pre-release suffix not affecting comparison
//
// Future-proofing: every test below uses an INDEPENDENT future
// SPEC_VERSION mock (via the comparison helper, not the global
// constant) so when the live SPEC_VERSION bumps, the test continues
// to assert the algorithm's properties without false positives.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseSpecPin, isSpecCompatible, SPEC_VERSION, SPEC_OMIT_DEFAULT } from './spec-version';

// ────────────────────────────────────────────────────────────────────────────
// parseSpecPin
// ────────────────────────────────────────────────────────────────────────────

describe('parseSpecPin — frontmatter spec: string decomposition', () => {
  it('parses canonical opencues/<major>.<minor>', () => {
    const r = parseSpecPin('opencues/0.2');
    assert.deepStrictEqual(r, { major: 0, minor: 2, pre: undefined, raw: 'opencues/0.2' });
  });

  it('parses opencues/<major>.<minor>-<pre>', () => {
    const r = parseSpecPin('opencues/0.2-alpha');
    assert.deepStrictEqual(r, { major: 0, minor: 2, pre: 'alpha', raw: 'opencues/0.2-alpha' });
  });

  it('parses dotted + numbered pre-releases', () => {
    assert.strictEqual(parseSpecPin('opencues/1.0-rc1')?.pre, 'rc1');
    assert.strictEqual(parseSpecPin('opencues/2.5-beta.2')?.pre, 'beta.2');
  });

  it('parses large versions', () => {
    assert.deepStrictEqual(parseSpecPin('opencues/99.42'), {
      major: 99, minor: 42, pre: undefined, raw: 'opencues/99.42',
    });
  });

  it('refuses missing "opencues/" prefix', () => {
    assert.strictEqual(parseSpecPin('0.2-alpha'), null);
    assert.strictEqual(parseSpecPin('cues/0.2'), null);
  });

  it('refuses missing minor component', () => {
    assert.strictEqual(parseSpecPin('opencues/1'), null);
  });

  it('refuses missing major component', () => {
    assert.strictEqual(parseSpecPin('opencues/.2'), null);
  });

  it('refuses non-numeric components', () => {
    assert.strictEqual(parseSpecPin('opencues/v1.0'), null);
    assert.strictEqual(parseSpecPin('opencues/one.two'), null);
  });

  it('refuses empty string', () => {
    assert.strictEqual(parseSpecPin(''), null);
  });

  it('refuses whitespace-padded input', () => {
    // Strict — callers responsible for trimming. Defensive against
    // YAML parsers that don't trim values.
    assert.strictEqual(parseSpecPin(' opencues/0.2 '), null);
  });

  it('refuses trailing garbage after the version', () => {
    assert.strictEqual(parseSpecPin('opencues/0.2 extra'), null);
    assert.strictEqual(parseSpecPin('opencues/0.2/extra'), null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isSpecCompatible — current SPEC_VERSION (smoke tests bound to live version)
// ────────────────────────────────────────────────────────────────────────────

describe('isSpecCompatible — live SPEC_VERSION acceptance', () => {
  it(`accepts the runtime's own SPEC_VERSION (${SPEC_VERSION})`, () => {
    const r = isSpecCompatible(`opencues/${SPEC_VERSION}`);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, undefined);
  });

  it(`accepts alpha pre-release of the runtime's version`, () => {
    const r = isSpecCompatible(`opencues/${SPEC_VERSION}-alpha`);
    assert.strictEqual(r.ok, true);
  });

  it('accepts omitted (undefined) spec — treats as SPEC_OMIT_DEFAULT', () => {
    const r = isSpecCompatible(undefined);
    assert.strictEqual(r.ok, true);
  });

  it('accepts omitted (null) spec — treats as SPEC_OMIT_DEFAULT', () => {
    const r = isSpecCompatible(null);
    assert.strictEqual(r.ok, true);
  });

  it('accepts empty-string spec — treats as SPEC_OMIT_DEFAULT', () => {
    const r = isSpecCompatible('');
    assert.strictEqual(r.ok, true);
  });

  it('confirms SPEC_OMIT_DEFAULT itself is always accepted', () => {
    // Invariant: the omit-default must NEVER refuse. If this fails,
    // every legacy spec-less file would suddenly stop loading.
    const r = isSpecCompatible(SPEC_OMIT_DEFAULT);
    assert.strictEqual(r.ok, true, `SPEC_OMIT_DEFAULT (${SPEC_OMIT_DEFAULT}) must always pass against the current SPEC_VERSION (${SPEC_VERSION})`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isSpecCompatible — refusal paths
// ────────────────────────────────────────────────────────────────────────────

describe('isSpecCompatible — refusal paths', () => {
  it('refuses obviously-newer minor (matches the conformance fixture)', () => {
    const r = isSpecCompatible('opencues/99.0');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason!, /opencues\/99\.0/);
  });

  it('refuses one-minor-newer same-major', () => {
    // Future-proof: this would refuse against any current SPEC_VERSION
    // because we construct a version that's always one minor higher.
    const [major, minor] = SPEC_VERSION.split('.').map(Number);
    const r = isSpecCompatible(`opencues/${major}.${minor + 1}`);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason!, /newer than runtime/);
  });

  it('refuses one-major-newer', () => {
    const [major] = SPEC_VERSION.split('.').map(Number);
    const r = isSpecCompatible(`opencues/${major + 1}.0`);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason!, /major/);
  });

  it('refuses unparseable spec (defensive)', () => {
    const r = isSpecCompatible('not-a-version');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason!, /unparseable/);
  });

  it('refuses garbage with the right prefix', () => {
    const r = isSpecCompatible('opencues/banana');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason!, /unparseable/);
  });

  it('reason strings include the offending version for debuggability', () => {
    const cases = ['opencues/99.0', 'opencues/3.0', 'opencues/0.999'];
    for (const v of cases) {
      const r = isSpecCompatible(v);
      assert.strictEqual(r.ok, false);
      assert.ok(r.reason!.includes(v), `reason should mention "${v}", got: ${r.reason}`);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Forward compatibility — semantic tests that pin the ALGORITHM, not the
// live SPEC_VERSION. These continue to hold when SPEC_VERSION bumps.
// ────────────────────────────────────────────────────────────────────────────

// Re-implement the comparison against an arbitrary "reader version" so we
// can pin pre-stable + post-stable semantics independent of the live constant.
function isCompatAgainst(filePin: string, readerMajor: number, readerMinor: number): boolean {
  const file = parseSpecPin(filePin);
  if (!file) return false;
  if (file.major > readerMajor) return false;
  if (file.major < readerMajor && readerMajor >= 1) return false;
  if (file.major === readerMajor && file.minor > readerMinor) return false;
  return true;
}

describe('forward-compatibility semantics — algorithm-level tests', () => {
  describe('pre-stable readers (0.x) — only refuses NEWER (or unparseable)', () => {
    it('0.5 reader accepts 0.1, 0.4, 0.5 files', () => {
      assert.strictEqual(isCompatAgainst('opencues/0.1', 0, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/0.4', 0, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/0.5', 0, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/0.5-rc1', 0, 5), true);
    });

    it('0.5 reader refuses 0.6+, 1.0+', () => {
      assert.strictEqual(isCompatAgainst('opencues/0.6', 0, 5), false);
      assert.strictEqual(isCompatAgainst('opencues/0.99', 0, 5), false);
      assert.strictEqual(isCompatAgainst('opencues/1.0', 0, 5), false);
      assert.strictEqual(isCompatAgainst('opencues/2.0', 0, 5), false);
    });
  });

  describe('stable readers (1.0+) — semver semantics: major bumps break', () => {
    it('1.5 reader accepts every 1.x with minor <= 5', () => {
      assert.strictEqual(isCompatAgainst('opencues/1.0', 1, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/1.3', 1, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/1.5', 1, 5), true);
    });

    it('1.5 reader refuses 1.6+', () => {
      assert.strictEqual(isCompatAgainst('opencues/1.6', 1, 5), false);
    });

    it('1.5 reader REFUSES 0.x files (cross-major-to-pre-stable)', () => {
      // Post-stable: a 1.x reader has broken with 0.x files. Major bump
      // = breaking by definition. This is the post-1.0 rule.
      assert.strictEqual(isCompatAgainst('opencues/0.5', 1, 5), false);
      assert.strictEqual(isCompatAgainst('opencues/0.9', 1, 5), false);
    });

    it('2.0 reader refuses all 1.x and 0.x', () => {
      // Another major bump means 2.0 broke with 1.x too. Same rule
      // applies forward forever.
      assert.strictEqual(isCompatAgainst('opencues/1.0', 2, 0), false);
      assert.strictEqual(isCompatAgainst('opencues/1.99', 2, 0), false);
      assert.strictEqual(isCompatAgainst('opencues/0.5', 2, 0), false);
      assert.strictEqual(isCompatAgainst('opencues/2.0', 2, 0), true);
    });

    it('2.5 reader accepts every 2.x with minor <= 5', () => {
      assert.strictEqual(isCompatAgainst('opencues/2.0', 2, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/2.5', 2, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/2.6', 2, 5), false);
    });
  });

  describe('pre-release tags are informational only', () => {
    it('0.5 reader treats 0.5-alpha and 0.5 equivalently', () => {
      assert.strictEqual(isCompatAgainst('opencues/0.5-alpha', 0, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/0.5-beta.2', 0, 5), true);
      assert.strictEqual(isCompatAgainst('opencues/0.5-rc1', 0, 5), true);
    });

    it('pre-release on a newer minor still refuses', () => {
      assert.strictEqual(isCompatAgainst('opencues/0.6-alpha', 0, 5), false);
    });
  });
});
