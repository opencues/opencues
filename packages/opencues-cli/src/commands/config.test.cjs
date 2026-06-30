// Pins that `opencues config`'s section grouping covers EVERY scalar the
// registry exposes — so a newly-added FEATURE/MENU_TUNABLE can't silently
// fall into the "More" catch-all unnoticed. If this fails, add the new scalar
// to a SECTIONS entry in config.cjs.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { SECTIONS } = require('./config.cjs');
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const reg = require(path.join(REPO_ROOT, 'packages/opencues-core/dist/feature-registry.js'));

test('every registry menu scalar is assigned to a config section', () => {
  const menuScalars = [...reg.getMenuDefinitions().keys()];
  const grouped = new Set(SECTIONS.flatMap(s => s.scalars));
  const missing = menuScalars.filter(sc => !grouped.has(sc));
  assert.deepStrictEqual(missing, [], `unsectioned scalars (add to SECTIONS): ${missing.join(', ')}`);
});

test('SECTIONS lists no scalar that the registry no longer exposes', () => {
  const menuScalars = new Set(reg.getMenuDefinitions().keys());
  const stale = SECTIONS.flatMap(s => s.scalars).filter(sc => !menuScalars.has(sc));
  assert.deepStrictEqual(stale, [], `stale scalars in SECTIONS (remove): ${stale.join(', ')}`);
});

test('SECTIONS has no duplicate scalar across sections', () => {
  const all = SECTIONS.flatMap(s => s.scalars);
  const dupes = all.filter((sc, i) => all.indexOf(sc) !== i);
  assert.deepStrictEqual(dupes, [], `duplicate scalars: ${dupes.join(', ')}`);
});
