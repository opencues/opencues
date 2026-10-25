// Doctor's chrome-host push-parity check must read the modules host.cjs
// requires, not host.cjs alone. Since chrome 0.2.206 the push list is built
// in host-bundle.cjs, and reading only host.cjs reported AUDITORS.md and
// NOTES.md as "never pushed" when they were.

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { _internal } = require('./doctor.cjs');
const { readHostScriptWithLocalModules } = _internal;

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-host-'));
  fs.writeFileSync(path.join(dir, 'host.cjs'), [
    "const { buildBundle } = require('./host-bundle.cjs');",
    "const helper = require('./helper');",   // extensionless local require
    "const fsMod = require('node:fs');",     // builtins are not followed
    "const pkg = require('some-package');",  // packages are not followed
    "require('./missing.cjs');",             // a missing module is skipped, not thrown
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'host-bundle.cjs'), 'MARKER_BUNDLE chromeHostFileList()');
  fs.writeFileSync(path.join(dir, 'helper.js'), 'MARKER_HELPER');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('includes the text of local modules the host requires', () => {
  const text = readHostScriptWithLocalModules(path.join(dir, 'host.cjs'));
  assert.ok(text.includes("require('./host-bundle.cjs')"), 'host.cjs itself');
  assert.ok(text.includes('MARKER_BUNDLE'), 'host-bundle.cjs followed');
  assert.ok(text.includes('MARKER_HELPER'), 'extensionless require resolved to helper.js');
  assert.ok(text.includes('chromeHostFileList'), 'registry call visible to the parity check');
});

test('the shipped chrome host is recognised as registry-derived', () => {
  const host = path.resolve(__dirname, '../../../../integrations/chrome/host/host.cjs');
  if (!fs.existsSync(host)) return; // CLI installed without the repo
  assert.ok(readHostScriptWithLocalModules(host).includes('chromeHostFileList'));
});
