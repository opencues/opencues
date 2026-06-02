'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickNavCombo } = require('./nav-combo.cjs');

// The banner's Keys line reads as the FIRST thing the user sees after
// `opencues run <host>`. If the chord label doesn't match the keys
// they can actually press, the rest of the product looks broken before
// they've typed anything. These pins lock the platform-to-label
// resolution so a change to one platform's path can't accidentally
// flip another.

describe('pickNavCombo — banner label resolution', () => {
  describe('macOS — Ctrl+Option (matches physical Mac keyboard label)', () => {
    for (const host of ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell']) {
      test(`darwin + ${host} → Ctrl+Option`, () => {
        assert.equal(pickNavCombo(host, 'darwin'), 'Ctrl+Option');
      });
    }
  });

  describe('Linux — Ctrl+Alt', () => {
    for (const host of ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell']) {
      test(`linux + ${host} → Ctrl+Alt`, () => {
        assert.equal(pickNavCombo(host, 'linux'), 'Ctrl+Alt');
      });
    }
  });

  describe('Windows — Ctrl+Alt', () => {
    for (const host of ['claude-code', 'chrome']) {
      test(`win32 + ${host} → Ctrl+Alt`, () => {
        assert.equal(pickNavCombo(host, 'win32'), 'Ctrl+Alt');
      });
    }
  });

  describe('Other Unix-like (freebsd, openbsd) fall through to Ctrl+Alt', () => {
    for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix']) {
      test(`${platform} → Ctrl+Alt`, () => {
        assert.equal(pickNavCombo('claude-code', platform), 'Ctrl+Alt');
      });
    }
  });

  describe('chrome — label still reflects keyboard, not browser env', () => {
    // Chrome is a desktop browser; the user presses keys on their own
    // physical keyboard. Mac users see "Option" on the key; everyone else
    // sees "Alt". The label must match what's on the user's keys, not the
    // browser's runtime.
    test('chrome on macOS → Ctrl+Option (Mac keyboard has Option)', () => {
      assert.equal(pickNavCombo('chrome', 'darwin'), 'Ctrl+Option');
    });
    test('chrome on Linux → Ctrl+Alt', () => {
      assert.equal(pickNavCombo('chrome', 'linux'), 'Ctrl+Alt');
    });
    test('chrome on Windows → Ctrl+Alt', () => {
      assert.equal(pickNavCombo('chrome', 'win32'), 'Ctrl+Alt');
    });
  });

  describe('platform argument defaulting', () => {
    test('defaults to process.platform when not passed', () => {
      // Whatever the current platform is, we should match the explicit
      // form of the same call. This validates the default-arg wiring.
      const explicit = pickNavCombo('claude-code', process.platform);
      const implicit = pickNavCombo('claude-code');
      assert.equal(implicit, explicit);
    });
  });

  describe('return type', () => {
    test('always returns one of the two known labels — no string drift', () => {
      const allowed = new Set(['Ctrl+Option', 'Ctrl+Alt']);
      for (const platform of ['darwin', 'linux', 'win32', 'freebsd', 'openbsd', 'unknown-platform']) {
        for (const host of ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell', 'unknown-host']) {
          assert.ok(
            allowed.has(pickNavCombo(host, platform)),
            `pickNavCombo(${host}, ${platform}) returned ${pickNavCombo(host, platform)}`,
          );
        }
      }
    });
  });
});
