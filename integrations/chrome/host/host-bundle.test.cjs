// Tests for the chrome host's bundle builder: what reaches chrome.storage
// out of a cues dir. Hermetic: a temp dir, never the real ~/.cues, and a
// stub for the core parsers the folder pass consults.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildBundle } = require('./host-bundle.cjs');

/** the core the builder consults: every folder is chrome-compatible, the registry names OPENCUES.md */
const core = {
  parseCuesMd: () => ({}),
  parseSingleCueMd: () => ({ frontmatter: {} }),
  inferHostCompat: () => ({ hosts: ['chrome'] }),
  chromeHostFileList: () => ['OPENCUES.md', 'CUES.md', 'IDENTITY.md'],
};

function dirOf(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-host-bundle-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  return d;
}

test('buildBundle: the 1.0 files reach the bundle — settings, identity, every row file at any depth', () => {
  const d = dirOf({
    'settings.yaml': 'spec: opencues/1.0\n',
    'identity.yaml': 'spec: opencues/1.0\nfirstName: Zorb\n',
    'rows/zorbpay.yaml': 'kind: command\n',
    'rows/deep/zorbmark.json': '{}',
    'rows/zorbpay/pay.sh': 'echo zorb\n',
    'rows/zorbpay/notes.txt': 'ALT\n',
  });
  const files = buildBundle(d, core);
  assert.strictEqual(files['settings.yaml'], 'spec: opencues/1.0\n');
  assert.ok(files['identity.yaml']);
  assert.ok(files['rows/zorbpay.yaml']);
  assert.ok(files['rows/deep/zorbmark.json']);
  // a command's script and its data stay on disk: the host runs them by exec
  assert.strictEqual(files['rows/zorbpay/pay.sh'], undefined);
  assert.strictEqual(files['rows/zorbpay/notes.txt'], undefined);
});

test('buildBundle: tables and transforms declared before 1.0 are pushed beside cues and blanks', () => {
  const d = dirOf({
    'OPENCUES.md': '---\n---\n',
    'blanks/zorb/BLANK.md': '---\nname: zorb\n---\n',
    'blanks/zorb/zorb.sh': 'echo\n',
    'tables/zorbmeter/TABLE.md': '---\nkeywords: zorb of\n---\n',
    'transforms/zorbwrap/TRANSFORM.md': '---\nop: wrap\n---\n',
  });
  const files = buildBundle(d, core);
  assert.deepStrictEqual(Object.keys(files).sort(), ['OPENCUES.md', 'blanks/zorb/BLANK.md', 'tables/zorbmeter/TABLE.md', 'transforms/zorbwrap/TRANSFORM.md']);
});

test('buildBundle: a missing dir is an empty bundle', () => {
  assert.deepStrictEqual(buildBundle(path.join(os.tmpdir(), 'oc-host-bundle-none-' + process.pid), core), {});
});
