#!/usr/bin/env node
// Compile the Swift AX bridge — macOS only. AppKit/ApplicationServices
// don't exist elsewhere, so on any other platform this is a LOUD no-op:
// the maintainer's Linux CI still builds the TS daemon and runs the
// full daemon-core test suite (see daemon-core.test.ts), it just can't
// produce the bridge binary. `opencues install mac` (darwin-gated)
// remains the path that ships the real bridge to users.
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'darwin') {
  console.log('[mac] skipping swiftc (non-darwin) — TS built, bridge binary not produced');
  process.exit(0);
}

const pkgDir = path.resolve(__dirname, '..');
const r = spawnSync('swiftc', ['-O', 'ax-bridge.swift', '-o', 'dist/ax-bridge'], {
  stdio: 'inherit',
  cwd: pkgDir,
});
if (r.error && r.error.code === 'ENOENT') {
  console.error('[mac] swiftc not found — install the Xcode Command Line Tools: xcode-select --install');
  process.exit(1);
}
process.exit(r.status ?? 1);
