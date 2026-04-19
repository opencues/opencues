#!/usr/bin/env node
// @opencues/oc installer.
//
// Usage:
//   From a clone (today):  pnpm --filter @opencues/oc dev-install
//                          node integrations/oc/bin/install.js
//   Post-publish:          npx @opencues/oc
//
// Flags:
//   --target <path>   Path to opencode fork dir (default: $HOME/opencode-cues)
//   --help            Print this and exit
//
// Today this delegates to patches/setup.sh (which clones the opencode fork
// at the pinned version, builds source, copies runtime + core into the
// fork's node_modules, applies bootstrap patches via sed/python). Post-
// publish, the same wrapper resolves built artefacts from the npm
// package's dist/ instead of building from source.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

const args = parseArgs(process.argv.slice(2));
if (args.help) { printHelp(); process.exit(0); }

console.log(`${pkg.name} v${pkg.version} — ${pkg.description}`);
console.log(`Compatible with: ${formatCompat(pkg.compatibility)}`);
console.log();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error('Published-package install path is not implemented yet (Stage 8 ships it).');
  console.error('For now, install from a clone:');
  console.error('  git clone https://github.com/opencues/opencues');
  console.error('  pnpm install');
  console.error('  pnpm --filter @opencues/oc dev-install');
  process.exit(1);
}

// patches/setup.sh accepts an optional opencode-dir argument.
const setupSh = path.join(PKG_DIR, 'patches/setup.sh');
const setupArgs = args.target ? [args.target] : [];
const result = spawnSync(setupSh, setupArgs, { stdio: 'inherit' });

if (result.status !== 0) {
  console.error(`\n${pkg.name} install failed (setup.sh exited ${result.status}).`);
  process.exit(result.status || 1);
}

console.log(`\n${pkg.name} install complete.`);
console.log('cd into the opencode fork and run `bun install && bun run dev`.');

// --- helpers --------------------------------------------------------------

function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--target') out.target = argv[++i];
  }
  return out;
}

function formatCompat(c) {
  if (!c || typeof c !== 'object') return '(unspecified)';
  return Object.entries(c).map(([host, ver]) => `${host} ${ver}`).join(', ');
}

function printHelp() {
  console.log(`${pkg.name} v${pkg.version}`);
  console.log('');
  console.log('Usage: opencues-oc [--target <opencode-fork-dir>]');
  console.log('');
  console.log('  --target <path>   Path to opencode fork (default: $HOME/opencode-cues)');
  console.log('  --help            Show this message');
}
