#!/usr/bin/env node
// @opencues/codex CLI — install / uninstall / seed-configs.
//
// Usage:
//   opencues-codex install              # default; clones fork if missing
//   opencues-codex uninstall            # rolls back fork patches
//   opencues-codex seed-configs         # populate ~/.opencues/
//
// Common flags:
//   --target <path>     Path to codex fork (default: $HOME/codex-cues)
//   --dry-run           Print plan, don't execute
//   --help              Show usage

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
const HOME = os.homedir();
const DEFAULT_FORK = path.join(HOME, 'codex-cues');

const { command, args, unknown } = parseArgv(process.argv.slice(2));
warnUnknownFlags(unknown);
if (args.help || command === 'help') { printHelp(); process.exit(0); }

printBanner();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error('\nPublished-package install path is not implemented yet (Stage 8 ships it).');
  console.error('For now, install from a clone.');
  process.exit(1);
}

if (command === 'install')      doInstall();
else if (command === 'uninstall')  doUninstall();
else if (command === 'seed-configs') doSeedConfigs();
else { console.error(`Unknown command: ${command}\n`); printHelp(); process.exit(1); }

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const fork = args.target || DEFAULT_FORK;
  console.log(`Target codex fork: ${fork}`);

  if (args.dryRun) {
    console.log('\n[dry-run] Would:');
    console.log(`  verify cargo is on PATH (rustup install if missing)`);
    console.log(`  clone openai/codex into ${fork} (if missing) at pinned SHA`);
    console.log(`  pnpm --filter @opencues/runtime build`);
    console.log(`  copy patches/opencues-bridge/ into ${fork}/codex-rs/opencues-bridge/`);
    console.log(`  add opencues-bridge to ${fork}/codex-rs/Cargo.toml workspace members`);
    console.log(`  cargo build --release in ${fork}/codex-rs/  (slow first time, ~5 min)`);
    console.log(`  drop launch-helper at ${fork}/launch.sh`);
    return;
  }

  // Pre-flight: cargo on PATH (also looks at the default rustup install
  // location, since shells that don't source ~/.cargo/env still find it).
  const cargo = spawnSync('cargo', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const cargoEnv = path.join(HOME, '.cargo', 'env');
  if (cargo.status !== 0 && !fs.existsSync(cargoEnv)) {
    console.error('\nopencues-codex install: cargo not found on PATH.');
    console.error('Install rust + cargo (https://rustup.rs) and re-run:');
    console.error('  curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh');
    console.error('  source "$HOME/.cargo/env"');
    process.exit(127);
  }
  if (cargo.status === 0) console.log(`cargo: ${cargo.stdout.toString().trim()}`);

  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  // Source ~/.cargo/env if cargo wasn't on PATH but rustup is installed,
  // so the spawned setup.sh sees cargo too.
  const env = cargo.status === 0 ? process.env : {
    ...process.env,
    PATH: `${path.join(HOME, '.cargo', 'bin')}:${process.env.PATH || ''}`,
  };
  const result = spawnSync(setupSh, [fork], { stdio: 'inherit', env });
  if (result.status !== 0) {
    console.error(`\n${pkg.name} install failed (setup.sh exited ${result.status}).`);
    process.exit(result.status || 1);
  }

  console.log(`\n${pkg.name} install complete.`);
  console.log('Note: this is the INFRASTRUCTURE install — the TUI patches that wire');
  console.log('OpenCues into Codex\'s ChatComposer are not yet implemented.');
  console.log('See integrations/codex/HANDOFF.md for what remains.');
  console.log('');
  console.log('To run the patched TUI (after HANDOFF items land):');
  console.log(`  ${launchCommand()} run codex`);
}

// Prefer the short "opencues" form when the binary is on PATH
// (published, aliased, or wrapper-shimmed); fall back to the
// always-works-from-a-clone form otherwise.
function launchCommand() {
  const probe = spawnSync('command', ['-v', 'opencues'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  return probe.status === 0 ? 'opencues' : 'pnpm exec opencues';
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  const fork = args.target || DEFAULT_FORK;
  if (!fs.existsSync(fork)) {
    console.log(`No codex fork at ${fork} — nothing to uninstall.`);
    return;
  }

  const isGitRepo = fs.existsSync(path.join(fork, '.git'));
  const bridgeDir = path.join(fork, 'codex-rs', 'opencues-bridge');
  const cargoToml = path.join(fork, 'codex-rs', 'Cargo.toml');
  const launchHelper = path.join(fork, 'launch.sh');

  console.log('Uninstall plan:');
  if (isGitRepo) {
    console.log(`  cd ${fork} && git checkout -- codex-rs/Cargo.toml`);
    console.log(`  cd ${fork} && git checkout -- codex-rs/tui/src/...  (if patched)`);
  } else {
    console.log(`  WARNING: ${fork} is not a git repo — manual revert needed`);
  }
  if (fs.existsSync(bridgeDir)) console.log(`  rm -rf ${bridgeDir}`);
  if (fs.existsSync(launchHelper)) console.log(`  rm ${launchHelper}`);
  console.log(`\nNote: leaves the codex fork dir itself in place. To remove it entirely:`);
  console.log(`  rm -rf ${fork}`);

  if (args.dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  console.log('');
  if (isGitRepo) {
    for (const f of ['codex-rs/Cargo.toml']) {
      if (!fs.existsSync(path.join(fork, f))) continue;
      const r = spawnSync('git', ['checkout', '--', f], { cwd: fork, stdio: 'inherit' });
      if (r.status === 0) console.log(`  reverted ${f}`);
    }
  }
  if (fs.existsSync(bridgeDir)) {
    fs.rmSync(bridgeDir, { recursive: true, force: true });
    console.log(`  removed ${bridgeDir}`);
  }
  if (fs.existsSync(launchHelper)) {
    fs.rmSync(launchHelper, { force: true });
    console.log(`  removed ${launchHelper}`);
  }

  console.log(`\n${pkg.name} uninstall complete.`);
}

// --- SEED CONFIGS (shared shape with cc/oc) ------------------------------

function doSeedConfigs() {
  const userConfigDir = path.join(HOME, '.opencues');
  const repoConfigDir = path.join(REPO_ROOT, '.opencues');
  const sources = ['cues.md', 'blanks.md', 'controls.md', 'opencues.md', 'cues', 'controls'];

  console.log(`Seeding user-level configs to: ${userConfigDir}/`);
  console.log(`Sources: ${repoConfigDir}\n`);

  if (args.dryRun) {
    for (const s of sources) {
      const src = path.join(repoConfigDir, s);
      const dst = path.join(userConfigDir, s);
      if (!fs.existsSync(src)) console.log(`  (no source) ${s}`);
      else if (fs.existsSync(dst)) console.log(`  SKIP (exists) ${dst}`);
      else console.log(`  COPY ${src} → ${dst}`);
    }
    console.log('\n[dry-run] Nothing executed.');
    return;
  }

  fs.mkdirSync(userConfigDir, { recursive: true });
  let copied = 0, skipped = 0;
  for (const s of sources) {
    const src = path.join(repoConfigDir, s);
    const dst = path.join(userConfigDir, s);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) { skipped++; continue; }
    if (fs.statSync(src).isDirectory()) copyDir(src, dst);
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
    copied++;
    console.log(`  copied ${s}`);
  }
  console.log(`\nSeeded ${copied} configs, skipped ${skipped} (already present).`);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// --- helpers --------------------------------------------------------------

function parseArgv(argv) {
  const KNOWN = new Set(['install', 'uninstall', 'seed-configs', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false }, unknown: [] };
  let i = 0;
  if (argv[i] && !argv[i].startsWith('-')) {
    if (KNOWN.has(argv[i])) { out.command = argv[i]; i++; }
    else { out.unknown.push(argv[i]); i++; }
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--help' || a === '-h') out.args.help = true;
    else if (a === '--dry-run') out.args.dryRun = true;
    else if (a === '--target') out.args.target = argv[++i];
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
}

function printBanner() {
  console.log(`${pkg.name} v${pkg.version} — ${pkg.description}`);
  if (pkg.compatibility) {
    console.log(`Compatible with: ${Object.entries(pkg.compatibility).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Clone codex fork, build runtime, add bridge crate');
  console.log('  uninstall           git checkout patched files, rm bridge crate');
  console.log('  seed-configs        Copy repo defaults to ~/.opencues/');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>     Codex fork dir (default: $HOME/codex-cues)');
  console.log('  --dry-run           Print plan, do not execute');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Status: pre-alpha. The TUI patches that hook OpenCues into Codex\'s');
  console.log('ChatComposer are NOT yet implemented; install only sets up the');
  console.log('infrastructure. See integrations/codex/HANDOFF.md.');
}
