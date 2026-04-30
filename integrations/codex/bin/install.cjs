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
    console.log('\n[dry-run] Would (8 steps):');
    console.log(`  ▸ verify cargo is on PATH (rustup install if missing)`);
    console.log(`  ▸ clone or reuse codex fork at ${fork} (pinned SHA, idempotent)`);
    console.log(`  ▸ pnpm --filter @opencues/runtime build`);
    console.log(`  ▸ verify daemon.js produced (sanity check)`);
    console.log(`  ▸ copy patches/opencues-bridge/ into ${fork}/codex-rs/opencues-bridge/`);
    console.log(`  ▸ add opencues-bridge to ${fork}/codex-rs/Cargo.toml workspace members`);
    console.log(`  ▸ cargo build -p opencues-bridge --release  (~2 min first time; bridge crate only, NOT full TUI)`);
    console.log(`  ▸ bridge ↔ daemon smoke test  (spawns daemon, sends boot RPC, verifies handshake)`);
    console.log(`  ▸ drop launch-helper at ${fork}/launch.sh`);
    console.log('');
    console.log('Set OPENCUES_INSTALL_VERBOSE=1 for live streaming; default is quiet + log to /tmp/opencues-install-codex.log.');
    return;
  }

  // Pre-flight: pick a cargo. Prefer the rustup-managed one at
  // ~/.cargo/bin/cargo when it exists (it's always newer + correctly
  // versioned), even if a different cargo is on PATH (e.g. apt's
  // /usr/bin/cargo, which is often pinned to an old version).
  const rustupCargo = path.join(HOME, '.cargo', 'bin', 'cargo');
  const useRustupCargo = fs.existsSync(rustupCargo);
  const cargoBin = useRustupCargo ? rustupCargo : 'cargo';
  const cargo = spawnSync(cargoBin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (cargo.status !== 0) {
    console.error('\nopencues-codex install: cargo not found on PATH and not at ~/.cargo/bin/cargo.');
    console.error('Install rust + cargo (https://rustup.rs) and re-run:');
    console.error('  curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y');
    console.error('  source "$HOME/.cargo/env"');
    process.exit(127);
  }
  console.log(`cargo: ${cargo.stdout.toString().trim()}${useRustupCargo ? '  (rustup)' : ''}`);

  // Pre-flight: cargo version. codex-rs's workspace contains members
  // declaring `edition = "2024"`, which was stabilized in Rust 1.85
  // (Feb 2025). Older toolchains can't even *parse* the workspace,
  // let alone build the bridge crate. Fail fast with a clear message
  // instead of letting setup.sh hit an opaque cargo manifest error.
  // See REPAIR.md § IL-3 for the underlying gotcha.
  if (cargo.status === 0) {
    const m = String(cargo.stdout).match(/cargo (\d+)\.(\d+)\.(\d+)/);
    if (m) {
      const [maj, min] = [Number(m[1]), Number(m[2])];
      const ok = maj > 1 || (maj === 1 && min >= 85);
      if (!ok) {
        console.error('');
        console.error(`opencues-codex install: cargo ${m[0].slice(6)} is too old.`);
        console.error("openai/codex's workspace requires Rust 1.85+ (edition2024).");
        console.error('Update with:');
        console.error('  rustup update stable');
        console.error('Or, if you don\'t have rustup:');
        console.error('  curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh');
        console.error('  source "$HOME/.cargo/env"');
        process.exit(1);
      }
    }
  }

  const setupSh = path.join(PKG_DIR, 'patches', 'setup.sh');
  // Make sure setup.sh's `cargo` invocations resolve to the same one
  // we just verified above. If we picked the rustup-managed cargo
  // (or fell back because cargo wasn't on PATH at all), prepend
  // ~/.cargo/bin so the spawned shell sees it before any system cargo.
  const env = useRustupCargo ? {
    ...process.env,
    PATH: `${path.join(HOME, '.cargo', 'bin')}:${process.env.PATH || ''}`,
  } : process.env;
  const result = spawnSync(setupSh, [fork], { stdio: 'inherit', env });
  if (result.status !== 0) {
    console.error(`\n${pkg.name} install failed (setup.sh exited ${result.status}).`);
    process.exit(result.status || 1);
  }

  console.log(`\n${pkg.name} install complete.`);
  console.log('TUI patches applied to chat_composer.rs (pinned to d58d3cc).');
  console.log('See integrations/codex/reintegration/parity-review.md for the');
  console.log('OC-vs-codex feature matrix + what\'s verified end-to-end.');
  console.log('');
  console.log('To run the patched TUI:');
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
  const repoConfigDir = path.join(REPO_ROOT, 'defaults');
  const sources = ['cues.md', 'blanks.md', 'opencues.md', 'cues', 'blanks'];

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
  console.log('Status: alpha — TUI patches landed (pinned to codex-rs d58d3cc).');
  console.log('Full cargo build needs libcap-dev (sudo apt install -y libcap-dev).');
  console.log('See reintegration/parity-review.md for OC parity status.');
}
