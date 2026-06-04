/**
 * Tests for the SENTINELS.md write-validator.
 *
 * Two layers under test:
 *   1. SHAPE checks — key regex, value control-char filter, length cap.
 *   2. STATE checks — token collision, capacity, no-op detection.
 *
 * These are the load-bearing safety properties for any code path that
 * mutates SENTINELS.md. The validator is the single chokepoint; tests below
 * pin every failure mode + every success-action variant.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  validateSentinelWrite,
  DEFAULT_SENTINEL_CAPS,
  type SentinelField,
} from './identity-validator';

const field = (key: string, value: string): SentinelField => ({ key, value });

// ────────────────────────────────────────────────────────────────────────────
// SET — happy paths
// ────────────────────────────────────────────────────────────────────────────

describe('validateSentinelWrite — set (add)', () => {
  it('returns action: added when the key is new', () => {
    const r = validateSentinelWrite([], { op: 'set', key: 'firstName', value: 'Wilfred' });
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.action, 'added');
      assert.deepStrictEqual(r.fields, [{ key: 'firstName', value: 'Wilfred' }]);
    }
  });

  it('appends to existing fields, preserving order', () => {
    const existing = [field('firstName', 'Wilfred'), field('email', 'w@e')];
    const r = validateSentinelWrite(existing, { op: 'set', key: 'company', value: 'Command Stick' });
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.deepStrictEqual(r.fields.map(f => f.key), ['firstName', 'email', 'company']);
    }
  });
});

describe('validateSentinelWrite — set (update)', () => {
  it('returns action: updated when the key exists with a different value', () => {
    const existing = [field('firstName', 'Wilfred'), field('email', 'w@e')];
    const r = validateSentinelWrite(existing, { op: 'set', key: 'firstName', value: 'Wilf' });
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.action, 'updated');
      assert.deepStrictEqual(r.fields, [
        { key: 'firstName', value: 'Wilf' },
        { key: 'email', value: 'w@e' },
      ]);
    }
  });

  it('returns action: noop when the key exists with the SAME value', () => {
    const existing = [field('firstName', 'Wilfred')];
    const r = validateSentinelWrite(existing, { op: 'set', key: 'firstName', value: 'Wilfred' });
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.strictEqual(r.action, 'noop');
  });

  it('update does NOT consume a capacity slot (already counted)', () => {
    const existing = Array.from({ length: DEFAULT_SENTINEL_CAPS.maxFields }, (_, i) =>
      field(`k${i}`, `v${i}`),
    );
    // We're AT cap. Updating an existing field should still succeed.
    const r = validateSentinelWrite(existing, { op: 'set', key: 'k0', value: 'updated' });
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.strictEqual(r.action, 'updated');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SET — failures
// ────────────────────────────────────────────────────────────────────────────

describe('validateSentinelWrite — set rejects invalid keys', () => {
  for (const bad of ['', '123foo', '_leading', '-leading', 'has space', 'has.dot', 'has/slash', 'has@at']) {
    it(`rejects key "${bad}"`, () => {
      const r = validateSentinelWrite([], { op: 'set', key: bad, value: 'x' });
      assert.strictEqual(r.ok, false);
      if (!r.ok) assert.strictEqual(r.error, 'invalid-key');
    });
  }
  for (const good of ['firstName', 'first_name', 'first-name', 'a', 'A', 'a1', 'Foo_Bar-Baz123']) {
    it(`accepts key "${good}"`, () => {
      const r = validateSentinelWrite([], { op: 'set', key: good, value: 'x' });
      assert.strictEqual(r.ok, true);
    });
  }
});

describe('validateSentinelWrite — set rejects invalid values', () => {
  it('rejects values with NUL bytes', () => {
    const r = validateSentinelWrite([], { op: 'set', key: 'k', value: 'foo\x00bar' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.strictEqual(r.error, 'value-invalid');
  });

  it('rejects values with C0 control chars (e.g. ESC)', () => {
    const r = validateSentinelWrite([], { op: 'set', key: 'k', value: 'foo\x1bbar' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.strictEqual(r.error, 'value-invalid');
  });

  it('allows tab + newline (legitimate in multi-line sign-offs)', () => {
    const r = validateSentinelWrite([], { op: 'set', key: 'signOff', value: 'Best,\nWilfred' });
    assert.strictEqual(r.ok, true);
  });

  it('rejects values longer than the cap', () => {
    const big = 'x'.repeat(DEFAULT_SENTINEL_CAPS.maxValueLength + 1);
    const r = validateSentinelWrite([], { op: 'set', key: 'k', value: big });
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.strictEqual(r.error, 'value-too-long');
      assert.strictEqual(r.context!.maxValueLength, DEFAULT_SENTINEL_CAPS.maxValueLength);
    }
  });

  it('value exactly at cap is allowed', () => {
    const exact = 'x'.repeat(DEFAULT_SENTINEL_CAPS.maxValueLength);
    const r = validateSentinelWrite([], { op: 'set', key: 'k', value: exact });
    assert.strictEqual(r.ok, true);
  });
});

describe('validateSentinelWrite — token collision detection', () => {
  it('rejects first_name when firstName exists (both → [FIRST NAME])', () => {
    const r = validateSentinelWrite(
      [field('firstName', 'Wilfred')],
      { op: 'set', key: 'first_name', value: 'Other' },
    );
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.strictEqual(r.error, 'collision');
      assert.strictEqual(r.context!.token, '[FIRST NAME]');
      assert.strictEqual(r.context!.conflictingKey, 'firstName');
    }
  });

  it('rejects first-name when first_name exists', () => {
    const r = validateSentinelWrite(
      [field('first_name', 'Wilfred')],
      { op: 'set', key: 'first-name', value: 'Other' },
    );
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.strictEqual(r.error, 'collision');
  });

  it('updating same-canonical key under its own name is fine (no collision against self)', () => {
    const r = validateSentinelWrite(
      [field('firstName', 'Wilfred')],
      { op: 'set', key: 'firstName', value: 'Wilf' },
    );
    assert.strictEqual(r.ok, true);
  });
});

describe('validateSentinelWrite — capacity', () => {
  it('rejects add when at cap with capacity-exceeded error', () => {
    const fields = Array.from({ length: DEFAULT_SENTINEL_CAPS.maxFields }, (_, i) =>
      field(`k${i}`, `v${i}`),
    );
    const r = validateSentinelWrite(fields, { op: 'set', key: 'overflow', value: 'x' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) {
      assert.strictEqual(r.error, 'capacity-exceeded');
      assert.strictEqual(r.context!.maxFields, DEFAULT_SENTINEL_CAPS.maxFields);
      assert.strictEqual(r.context!.current, DEFAULT_SENTINEL_CAPS.maxFields);
      // Detail message helps the user know what to do.
      assert.match(r.detail, /remove unused ones/i);
    }
  });

  it('rejects add when one short of cap then attempting two-step add (state propagates)', () => {
    const fields = Array.from({ length: DEFAULT_SENTINEL_CAPS.maxFields - 1 }, (_, i) =>
      field(`k${i}`, `v${i}`),
    );
    const r1 = validateSentinelWrite(fields, { op: 'set', key: 'almost', value: 'x' });
    assert.strictEqual(r1.ok, true);
    if (r1.ok) {
      const r2 = validateSentinelWrite(r1.fields, { op: 'set', key: 'overflow', value: 'x' });
      assert.strictEqual(r2.ok, false);
      if (!r2.ok) assert.strictEqual(r2.error, 'capacity-exceeded');
    }
  });

  it('honours per-call cap overrides', () => {
    const r = validateSentinelWrite(
      [field('a', '1'), field('b', '2')],
      { op: 'set', key: 'c', value: '3' },
      { maxFields: 2, maxValueLength: 10 },
    );
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.strictEqual(r.error, 'capacity-exceeded');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// REMOVE
// ────────────────────────────────────────────────────────────────────────────

describe('validateSentinelWrite — remove', () => {
  it('returns action: removed when the key exists', () => {
    const existing = [field('firstName', 'Wilfred'), field('email', 'w@e')];
    const r = validateSentinelWrite(existing, { op: 'remove', key: 'firstName' });
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.action, 'removed');
      assert.deepStrictEqual(r.fields, [{ key: 'email', value: 'w@e' }]);
    }
  });

  it('errors with not-found when the key is absent', () => {
    const r = validateSentinelWrite([field('firstName', 'Wilfred')], { op: 'remove', key: 'nope' });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.strictEqual(r.error, 'not-found');
  });

  it('does not check capacity or collision on remove (operation shrinks state)', () => {
    // Remove from a max-capacity state — must succeed.
    const fields = Array.from({ length: DEFAULT_SENTINEL_CAPS.maxFields }, (_, i) =>
      field(`k${i}`, `v${i}`),
    );
    const r = validateSentinelWrite(fields, { op: 'remove', key: 'k0' });
    assert.strictEqual(r.ok, true);
  });
});
