// Pure-logic tests for `opencues show`'s discovery/matching helpers (no TTY —
// the interactive explorer is validated by hand; this pins the search layer).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { __test__ } = require('./show.cjs');
const { enumerateNames, findMatches, parseFrontmatter } = __test__;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-show-'));
  const mk = (rel, body) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  mk('cues/formal/CUE.md', '---\ntype: alternatives\ntip: Make it formal\n---\n');
  mk('cues/casual/CUE.md', '---\ntype: alternatives\n---\n');
  mk('blanks/volume/BLANK.md', '---\ntype: blank\n---\n\nImpl note.\n');
  return dir;
}

test('enumerateNames: folder cues + blanks, sorted, kind-tagged', () => {
  const dir = fixture();
  const names = enumerateNames([dir]);
  assert.deepStrictEqual(names, [
    { name: 'casual', kind: 'cue' },
    { name: 'formal', kind: 'cue' },
    { name: 'volume', kind: 'blank' },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enumerateNames: dedups the same name across two search paths', () => {
  const dir = fixture();
  const names = enumerateNames([dir, dir]); // same dir twice
  assert.strictEqual(names.filter(n => n.name === 'formal').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findMatches: resolves a folder blank; empty for unknown', () => {
  const dir = fixture();
  const m = findMatches('volume', [dir]);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].kind, 'blank');
  assert.ok(m[0].source.endsWith(path.join('blanks', 'volume', 'BLANK.md')));
  assert.deepStrictEqual(findMatches('nope', [dir]), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findMatches: returns matches in path (priority) order', () => {
  const a = fixture(); const b = fixture();
  const m = findMatches('formal', [a, b]);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].scope, a); // first path wins
  assert.strictEqual(m[1].scope, b);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test('parseFrontmatter: splits key/value fields + body, skips comments', () => {
  const { fields, body } = parseFrontmatter('---\nname: v\ntype: blank\n# a comment\n---\n\nbody text\n');
  assert.deepStrictEqual(fields, [['name', 'v'], ['type', 'blank']]);
  assert.strictEqual(body.trim(), 'body text');
});

test('parseFrontmatter: no frontmatter → empty fields, whole content as body', () => {
  const { fields, body } = parseFrontmatter('just prose, no fence');
  assert.deepStrictEqual(fields, []);
  assert.strictEqual(body, 'just prose, no fence');
});
