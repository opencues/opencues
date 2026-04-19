#!/usr/bin/env node
// @opencues/chrome CLI — install / uninstall.
//
// Usage:
//   opencues-chrome                         # install (default)
//   opencues-chrome install
//   opencues-chrome uninstall               # remove built artefacts (and target dist if --target)
//
// Common flags:
//   --target <path>   Where to deploy unpacked extension (default: in-place)
//   --no-build        Skip the build step (use existing dist/)
//   --dry-run         Print the plan, don't execute
//   --help            Show usage
//
// Today this runs from a clone via `pnpm --filter @opencues/chrome dev-install`.
// Post-publish (Stage 8) it becomes the bin entry for `npx @opencues/chrome`.
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

const { command, args, unknown } = parseArgv(process.argv.slice(2));
warnUnknownFlags(unknown);
if (args.help || command === 'help') { printHelp(); process.exit(0); }

printBanner();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error(
    '\nPublished-package install path is not implemented yet (Stage 8 ships it).\n' +
    'For now, install from a clone:\n' +
    '  git clone https://github.com/opencues/opencues\n' +
    '  pnpm install\n' +
    '  pnpm --filter @opencues/chrome dev-install\n',
  );
  process.exit(1);
}

if (command === 'install') {
  doInstall();
} else if (command === 'uninstall') {
  doUninstall();
} else {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const distDir = path.join(PKG_DIR, 'dist');
  const manifest = path.join(PKG_DIR, 'manifest.json');
  const loadPath = args.target ? path.resolve(args.target) : PKG_DIR;

  if (args.dryRun) {
    console.log('\n[dry-run] Would:');
    if (!args.noBuild) console.log(`  pnpm --filter @opencues/chrome build  (typecheck + tests + esbuild)`);
    if (args.target) {
      console.log(`  mkdir -p ${loadPath}/dist`);
      console.log(`  cp -r ${distDir}/* ${loadPath}/dist/`);
      console.log(`  cp ${manifest} ${loadPath}/manifest.json`);
    }
    console.log(`  print: load unpacked from ${loadPath} at chrome://extensions`);
    return;
  }

  // 1. Build (unless --no-build).
  if (!args.noBuild) {
    console.log('Building @opencues/chrome (and deps via turbo)...');
    const build = spawnSync('pnpm', ['--filter', '@opencues/chrome', 'build'], {
      cwd: REPO_ROOT, stdio: 'inherit',
    });
    if (build.status !== 0) {
      console.error('\nBuild failed.');
      process.exit(build.status || 1);
    }
  }

  // 2. Deploy.
  if (args.target) {
    console.log(`\nDeploying to ${loadPath}/ ...`);
    fs.mkdirSync(path.join(loadPath, 'dist'), { recursive: true });
    copyDirContents(distDir, path.join(loadPath, 'dist'));
    fs.copyFileSync(manifest, path.join(loadPath, 'manifest.json'));
  }

  // 3. Print Chrome reload instructions.
  console.log(`\n${pkg.name} install complete.`);
  console.log('');
  console.log(`To load: open chrome://extensions, enable Developer mode,`);
  console.log(`         click "Load unpacked", select:`);
  console.log(`         ${loadPath}`);
  console.log('');
  console.log(`To reload after future builds: pnpm --filter @opencues/chrome dev-install ${args.target ? '-- --target ' + args.target : ''}`);
  console.log(`         (then click the reload button on the extension card)`);
  console.log('');
  console.log('To roll back: pnpm --filter @opencues/chrome dev-uninstall' + (args.target ? ' -- --target ' + args.target : ''));
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const distDir = path.join(PKG_DIR, 'dist');
  const targetDist = args.target ? path.join(path.resolve(args.target), 'dist') : null;
  const targetManifest = args.target ? path.join(path.resolve(args.target), 'manifest.json') : null;

  const plan = {
    rmDist: fs.existsSync(distDir) ? distDir : null,
    rmTargetDist: targetDist && fs.existsSync(targetDist) ? targetDist : null,
    rmTargetManifest: targetManifest && fs.existsSync(targetManifest) ? targetManifest : null,
  };

  console.log('Uninstall plan:');
  if (plan.rmDist) console.log(`  rm -rf ${plan.rmDist}/`);
  if (plan.rmTargetDist) console.log(`  rm -rf ${plan.rmTargetDist}/`);
  if (plan.rmTargetManifest) console.log(`  rm ${plan.rmTargetManifest}`);
  if (!plan.rmDist && !plan.rmTargetDist && !plan.rmTargetManifest) {
    console.log('  (no installed paths found — appears clean)');
  }
  console.log(`\nNote: also remove the extension from chrome://extensions manually (Chrome doesn't expose a reload/remove API to scripts).`);

  if (args.dryRun) {
    console.log('\n[dry-run] Nothing executed.');
    return;
  }

  console.log('');
  if (plan.rmDist) {
    fs.rmSync(plan.rmDist, { recursive: true, force: true });
    console.log(`  removed ${plan.rmDist}/`);
  }
  if (plan.rmTargetDist) {
    fs.rmSync(plan.rmTargetDist, { recursive: true, force: true });
    console.log(`  removed ${plan.rmTargetDist}/`);
  }
  if (plan.rmTargetManifest) {
    fs.rmSync(plan.rmTargetManifest, { force: true });
    console.log(`  removed ${plan.rmTargetManifest}`);
  }

  console.log(`\n${pkg.name} uninstall complete.`);
}

// --- helpers --------------------------------------------------------------

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

function parseArgv(argv) {
  const KNOWN_COMMANDS = new Set(['install', 'uninstall', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false, noBuild: false }, unknown: [] };
  let i = 0;
  if (argv[i] && !argv[i].startsWith('-')) {
    if (KNOWN_COMMANDS.has(argv[i])) { out.command = argv[i]; i++; }
    else { out.unknown.push(argv[i]); i++; }
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // pnpm/npm separator — skip silently
    if (a === '--help' || a === '-h') out.args.help = true;
    else if (a === '--dry-run') out.args.dryRun = true;
    else if (a === '--no-build') out.args.noBuild = true;
    else if (a === '--target') out.args.target = argv[++i];
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn(`Known commands: install, uninstall, help`);
  console.warn(`Known flags:    --target <path>, --no-build, --dry-run, --help`);
  console.warn('');
}

function printBanner() {
  console.log(`${pkg.name} v${pkg.version} — ${pkg.description}`);
  if (pkg.compatibility) {
    const compatStr = Object.entries(pkg.compatibility).map(([h, v]) => `${h} ${v}`).join(', ');
    console.log(`Compatible with: ${compatStr}`);
  }
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Build the extension; optionally deploy to --target');
  console.log('  uninstall           Remove dist/; optionally clean up --target deploy');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>     Where to deploy unpacked extension (default: in-place)');
  console.log('  --no-build          Skip the build step (use existing dist/)');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Blast radius:');
  console.log('  Repo state (gitignored):');
  console.log('    integrations/chrome/dist/      esbuild output');
  console.log('    packages/*/dist/, .turbo/      build cache');
  console.log('  If --target <path>:');
  console.log('    <path>/dist/                   mirror of integrations/chrome/dist/');
  console.log('    <path>/manifest.json           mirror of integrations/chrome/manifest.json');
  console.log('  Chrome state (not managed by this script):');
  console.log('    Chrome remembers the load path you gave it at chrome://extensions');
  console.log('    Remove the extension card manually after uninstalling');
  console.log('');
  console.log('No host system pollution outside the repo and (optionally) the --target directory.');
}
