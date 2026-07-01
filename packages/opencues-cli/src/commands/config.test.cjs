// Pins that `opencues config` builds its browser sections from the registry's
// `group:` field (single source of truth) — every menu scalar lands in exactly
// one section, and sections follow SETTINGS_GROUP_ORDER. (The registry itself
// pins that every scalar HAS a group — see feature-registry-menu.drift.test.ts.)

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { __test__ } = require('./config.cjs');
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const reg = require(path.join(REPO_ROOT, 'packages/opencues-core/dist/feature-registry.js'));

test('sections cover every registry menu scalar exactly once', () => {
  const m = __test__.model({ REPO_ROOT });
  assert.ok(m, 'model loaded');
  const menuScalars = [...reg.getMenuDefinitions().keys()].sort();
  const sectioned = m.sections.flatMap(s => s.scalars).sort();
  assert.deepStrictEqual(sectioned, menuScalars);
});

test('no scalar falls into the "More" catch-all (all grouped in the registry)', () => {
  const m = __test__.model({ REPO_ROOT });
  const more = m.sections.find(s => s.title === 'More');
  assert.strictEqual(more, undefined, more && `ungrouped scalars: ${more.scalars.join(', ')}`);
});

test('sections follow SETTINGS_GROUP_ORDER', () => {
  const m = __test__.model({ REPO_ROOT });
  const order = reg.SETTINGS_GROUP_ORDER;
  const titles = m.sections.map(s => s.title);
  // The titles that ARE in the order must appear in that relative order.
  const expected = order.filter(g => titles.includes(g));
  const actual = titles.filter(t => order.includes(t));
  assert.deepStrictEqual(actual, expected);
});

test('no duplicate scalar across sections', () => {
  const m = __test__.model({ REPO_ROOT });
  const all = m.sections.flatMap(s => s.scalars);
  const dupes = all.filter((sc, i) => all.indexOf(sc) !== i);
  assert.deepStrictEqual(dupes, [], `duplicates: ${dupes.join(', ')}`);
});
