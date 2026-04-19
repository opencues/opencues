#!/usr/bin/env node
// @opencues/chrome installer.
//
// Usage:
//   From a clone (today):  pnpm --filter @opencues/chrome dev-install
//                          node integrations/chrome/bin/install.js
//   Post-publish:          npx @opencues/chrome
//
// Flags:
//   --target <path>   Where to deploy the unpacked extension
//                     (default: integrations/chrome/dist — load directly
//                      from the build dir; pass a path to copy elsewhere,
//                      e.g. /mnt/c/Users/USERNAME/Desktop/opencues-chrome
//                      for a WSL → Windows Chrome workflow)
//   --no-build        Skip the build step (use existing dist/)
//   --help            Print this and exit
//
// Chrome is the simplest of the three integrations: there's no host
// process to patch. The "install" is "build the extension and tell
// Chrome where to load it from."

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
  console.error('  pnpm --filter @opencues/chrome dev-install');
  process.exit(1);
}

// 1. Build (unless --no-build). Uses turbo via the workspace root so
//    @opencues/core + @opencues/runtime build first if needed.
if (!args.noBuild) {
  console.log('Building @opencues/chrome (and deps via turbo)...');
  const build = spawnSync('pnpm', ['--filter', '@opencues/chrome', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    console.error('\nBuild failed.');
    process.exit(build.status || 1);
  }
}

// 2. Deploy. If --target given, copy dist/ + manifest.json there;
//    otherwise leave the user to load directly from PKG_DIR (which is
//    fine for native Chrome on the same filesystem as the build).
const distDir = path.join(PKG_DIR, 'dist');
const manifest = path.join(PKG_DIR, 'manifest.json');
let loadPath;

if (args.target) {
  const target = path.resolve(args.target);
  console.log(`\nDeploying to ${target}/ ...`);
  fs.mkdirSync(path.join(target, 'dist'), { recursive: true });
  copyDirContents(distDir, path.join(target, 'dist'));
  fs.copyFileSync(manifest, path.join(target, 'manifest.json'));
  loadPath = target;
} else {
  loadPath = PKG_DIR;
}

// 3. Print Chrome reload instructions (we can't automate the reload —
//    Chrome doesn't expose an extension-reload API to scripts).
console.log(`\n${pkg.name} install complete.`);
console.log('');
console.log(`To load: open chrome://extensions, enable Developer mode,`);
console.log(`         click "Load unpacked", select:`);
console.log(`         ${loadPath}`);
console.log('');
console.log(`To reload after future builds: pnpm --filter @opencues/chrome build`);
console.log(`         (then click the reload button on the extension card)`);

if (args.target) {
  console.log('');
  console.log('Tip: re-run this installer after each rebuild to re-sync to the target,');
  console.log('     OR add a watch script that copies dist/ + manifest.json on change.');
}

// --- helpers --------------------------------------------------------------

function parseArgs(argv) {
  const out = { help: false, noBuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--no-build') out.noBuild = true;
    else if (a === '--target') out.target = argv[++i];
  }
  return out;
}

function formatCompat(c) {
  if (!c || typeof c !== 'object') return '(unspecified)';
  return Object.entries(c).map(([host, ver]) => `${host} ${ver}`).join(', ');
}

function copyDirContents(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyDirContents(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function printHelp() {
  console.log(`${pkg.name} v${pkg.version}`);
  console.log('');
  console.log('Usage: opencues-chrome [--target <path>] [--no-build]');
  console.log('');
  console.log('  --target <path>   Where to deploy unpacked extension (default: in-place)');
  console.log('  --no-build        Skip the build step (use existing dist/)');
  console.log('  --help            Show this message');
}
