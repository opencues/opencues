// Tests for `opencues dismissals` — the undo surface for silenced cues.
//
// Spawned against a sandbox $OPENCUES_HOME so the assertions cover real file
// writes without touching the developer's own ~/.cues/dismissals.json. That
// hermeticity is not optional here: this command's whole job is deleting rows
// from a file the user cares about.

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', 'bin', 'cli.cjs');

let home;
before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-dismissals-')); });
after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });

const FILE = () => path.join(home, 'dismissals.json');

function seed(records) {
  fs.writeFileSync(FILE(), JSON.stringify({ dismissed: records }, null, 2));
}
function readFileRecords() {
  return JSON.parse(fs.readFileSync(FILE(), 'utf8')).dismissed;
}
function run(...args) {
  const env = { ...process.env, OPENCUES_HOME: home, FORCE_COLOR: '0', NO_COLOR: '1' };
  return spawnSync('node', [CLI, 'dismissals', ...args], { env, encoding: 'utf8' });
}

const CAL = {
  key: 'clashes with dentist 10 00',
  label: 'clashes with dentist 10:00',
  source: 'sentence-cue:calendar',
  dismissedAt: '2026-08-08T09:00:00Z',
};
const CONTRA = {
  key: '15 aug 2026 is a saturday not a friday',
  label: '15 Aug 2026 is a Saturday, not a Friday',
  source: 'sentence-cue:contradiction',
  dismissedAt: '2026-08-08T20:00:00Z',
};

describe('opencues dismissals list', () => {
  it('says so plainly when nothing is dismissed', () => {
    try { fs.unlinkSync(FILE()); } catch { /* absent already */ }
    const r = run('list');
    assert.strictEqual(r.status ?? 0, 0);
    assert.match(r.stdout, /nothing dismissed/i);
  });

  it('lists what is forgotten, numbered, with the engine that raised it', () => {
    seed([CAL, CONTRA]);
    const r = run('list');
    assert.match(r.stdout, /1\s+clashes with dentist 10:00/);
    assert.match(r.stdout, /calendar/);
    assert.match(r.stdout, /2\s+15 Aug 2026 is a Saturday/);
    assert.match(r.stdout, /contradiction/);
  });

  it('--json is machine-readable and keeps every field', () => {
    seed([CAL]);
    const out = JSON.parse(run('list', '--json').stdout);
    assert.deepStrictEqual(out.dismissed, [CAL]);
  });
});

describe('opencues dismissals restore', () => {
  it('restores by the number shown in the list', () => {
    seed([CAL, CONTRA]);
    const r = run('restore', '1');
    assert.strictEqual(r.status ?? 0, 0);
    assert.deepStrictEqual(readFileRecords().map((x) => x.key), [CONTRA.key]);
  });

  it('restores by a phrase off the list, so copy-paste works', () => {
    seed([CAL, CONTRA]);
    run('restore', 'Saturday');
    assert.deepStrictEqual(readFileRecords().map((x) => x.key), [CAL.key]);
  });

  it('is a no-op with a clear message when nothing matches', () => {
    seed([CAL]);
    const r = run('restore', 'no such cue');
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no dismissed cue matching/i);
    assert.strictEqual(readFileRecords().length, 1);   // file untouched
  });

  it('needs an argument', () => {
    seed([CAL]);
    const r = run('restore');
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /usage/i);
  });
});

describe('opencues dismissals clear', () => {
  it('brings everything back', () => {
    seed([CAL, CONTRA]);
    const r = run('clear');
    assert.match(r.stdout, /restored 2/);
    assert.deepStrictEqual(readFileRecords(), []);
  });
});

describe('opencues dismissals path', () => {
  it('honours $OPENCUES_HOME rather than the real ~/.cues', () => {
    const r = run('path');
    assert.strictEqual(r.stdout.trim(), FILE());
  });
});

describe('unknown subcommand', () => {
  it('names it and points at --help', () => {
    const r = run('frobnicate');
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown subcommand "frobnicate"/);
  });
});
