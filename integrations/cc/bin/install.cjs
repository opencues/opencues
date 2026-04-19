#!/usr/bin/env node
// @opencues/cc installer.
//
// Usage:
//   From a clone (today):  pnpm --filter @opencues/cc dev-install
//                          node integrations/cc/bin/install.js
//   Post-publish:          npx @opencues/cc
//
// Flags:
//   --target <path>   Path to claude-code's cli.js (default: auto-detect)
//   --help            Print this and exit
//
// Today this delegates to patches/setup.sh (which already builds source +
// installs runtime to ~/.claude/node_modules/@opencues/* + applies tweakcc
// patches). Post-publish, the same wrapper resolves built artefacts from
// inside the npm package's dist/ instead of building from source.

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

// Detect run mode.
const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error('Published-package install path is not implemented yet (Stage 8 ships it).');
  console.error('For now, install from a clone:');
  console.error('  git clone https://github.com/opencues/opencues');
  console.error('  pnpm install');
  console.error('  pnpm --filter @opencues/cc dev-install');
  process.exit(1);
}

// Delegate to patches/setup.sh — it handles the full pipeline:
// build core + runtime, install to ~/.claude/node_modules/@opencues/*,
// build tweakcc.
const setupSh = path.join(PKG_DIR, 'patches/setup.sh');
const tweakccDir = path.join(PKG_DIR, 'tweakcc');
const setupArgs = fs.existsSync(tweakccDir) ? [tweakccDir] : [];
const result = spawnSync(setupSh, setupArgs, { stdio: 'inherit' });

// setup.sh exits non-zero when it can't auto-detect cli.js. If --target
// was passed, fall through to apply patches directly via tweakcc with
// TWEAKCC_CC_INSTALLATION_PATH set to the user-specified path.
if (result.status !== 0 && !args.target) {
  console.error(`\n${pkg.name} install failed (setup.sh exited ${result.status}).`);
  console.error('If your claude-code install is at a non-standard path, re-run with:');
  console.error('  pnpm --filter @opencues/cc dev-install -- --target /path/to/cli.js');
  process.exit(result.status || 1);
}

if (args.target) {
  if (!fs.existsSync(args.target)) {
    console.error(`\n--target path not found: ${args.target}`);
    process.exit(1);
  }
  console.log(`\nApplying patches to ${args.target}...`);
  const tweakccBin = path.join(tweakccDir, 'dist/index.mjs');
  if (!fs.existsSync(tweakccBin)) {
    console.error(`tweakcc not built (expected ${tweakccBin}). Run setup.sh once first.`);
    process.exit(1);
  }
  const apply = spawnSync('node', [tweakccBin, '--apply'], {
    cwd: tweakccDir,
    env: { ...process.env, TWEAKCC_CC_INSTALLATION_PATH: args.target },
    stdio: 'inherit',
  });
  if (apply.status !== 0) {
    console.error(`\ntweakcc apply failed (exit ${apply.status}).`);
    process.exit(apply.status || 1);
  }
}

console.log(`\n${pkg.name} install complete.`);
console.log('Restart claude-cues to pick up the patched cli.js.');

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
  console.log('Usage: opencues-cc [--target <path>]');
  console.log('');
  console.log('  --target <path>   Path to claude-code cli.js (default: auto-detect)');
  console.log('  --help            Show this message');
}
