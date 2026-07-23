#!/usr/bin/env node
// @opencues/firefox CLI — install / uninstall.
//
// Usage:
//   opencues-firefox                        # install (default)
//   opencues-firefox install
//   opencues-firefox uninstall              # remove built artefacts (and target dist if --target)
//   opencues-firefox install-host --extension-id <gecko-id>
//   opencues-firefox uninstall-host
//
// Common flags:
//   --target <path>   Where to deploy unpacked add-on (default: in-place)
//   --no-build        Skip the build step (use existing dist/)
//   --dry-run         Print the plan, don't execute
//   --extension-id    Gecko add-on ID (for install-host)
//   --help            Show usage
//
// This is a near-clone of integrations/chrome/bin/install.cjs. The only
// Firefox-specific divergences:
//   - Firefox loads add-ons via about:debugging → "Load Temporary Add-on"
//     (points at manifest.json), not chrome://extensions.
//   - The native-messaging manifest uses `allowed_extensions: [<gecko-id>]`
//     instead of Chrome's `allowed_origins: ["chrome-extension://<id>/"]`,
//     is written under the Mozilla NativeMessagingHosts dirs, and (on
//     WSL/Windows) registered at HKCU\Software\Mozilla\...
//   - The native host itself is REUSED, not forked: `HOST_SCRIPT` points at
//     integrations/chrome/host/host.cjs (pure stdio framed-JSON, browser-
//     agnostic). Forking it would duplicate the security-sensitive sandbox
//     + secret-guard code the repo forbids mirroring.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

// Native-messaging constants (used by install-host / uninstall-host).
// The host name is shared with the Chrome integration — Firefox reads its
// OWN manifest dir, so there's no collision. The host SCRIPT is the reused
// Chrome host (see header).
const HOST_NAME = 'com.opencues.sync';
const HOST_SCRIPT = path.join(REPO_ROOT, 'integrations', 'chrome', 'host', 'host.cjs');

// Quiet/verbose progress wrapper.
const LOG_PATH = process.env.OPENCUES_INSTALL_LOG || '/tmp/opencues-install-firefox.log';
let _logFd = null;
function logFd() {
  if (_logFd == null) _logFd = fs.openSync(LOG_PATH, 'w');
  return _logFd;
}
function runStep(label, fn) {
  if (process.env.OPENCUES_INSTALL_VERBOSE === '1') {
    process.stdout.write(`  ▸ ${label}\n`);
    const ok = !!fn();
    process.stdout.write(`  ${ok ? '\x1b[32m●\x1b[0m' : '✗'} ${label}\n`);
    return ok;
  }
  process.stdout.write(`  ▸ ${label}`);
  const ok = !!fn();
  process.stdout.write(ok ? ' \x1b[32m●\x1b[0m\n' : ' ✗\n');
  return ok;
}
function reportFailure(label) {
  if (process.env.OPENCUES_INSTALL_VERBOSE === '1') return;
  console.error(`\n${label}. Last 30 lines of ${LOG_PATH}:`);
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
    process.stderr.write(lines.slice(-30).join('\n') + '\n');
  } catch { /* nothing logged */ }
  console.error(`\nFull log: ${LOG_PATH}  —  re-run with OPENCUES_INSTALL_VERBOSE=1 to stream live.`);
}

// ─── WSL detection + Windows-side deploy path resolution ────────────────
function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch { return false; }
}

// Resolve `/mnt/c/Users/<windows-user>/AppData/Local/opencues-firefox/`.
// Returns null if not on WSL or the Windows username can't be determined.
function resolveWslTarget() {
  if (!isWsl()) return null;
  const probe = spawnSync('cmd.exe', ['/c', 'echo %USERNAME%'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status !== 0) return null;
  const winUser = String(probe.stdout).trim().replace(/\r$/, '');
  if (!winUser) return null;
  return `/mnt/c/Users/${winUser}/AppData/Local/opencues-firefox`;
}

const { command, args, unknown } = parseArgv(process.argv.slice(2));
warnUnknownFlags(unknown);
if (args.help || command === 'help') { printHelp(); process.exit(0); }

printBanner();

const isClone = fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'));
if (!isClone) {
  console.error(
    '\nPublished-package install path is not implemented yet.\n' +
    'For now, install from a clone:\n' +
    '  git clone https://github.com/opencues/opencues\n' +
    '  pnpm install\n' +
    '  pnpm --filter @opencues/firefox dev-install\n',
  );
  process.exit(1);
}

if (command === 'install') {
  doInstall();
} else if (command === 'uninstall') {
  doUninstall();
} else if (command === 'install-host') {
  doInstallHost();
} else if (command === 'uninstall-host') {
  doUninstallHost();
} else {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

// --- INSTALL --------------------------------------------------------------

function doInstall() {
  const distDir = path.join(PKG_DIR, 'dist');
  const manifest = path.join(PKG_DIR, 'manifest.json');

  if (args.wsl) {
    const resolved = resolveWslTarget();
    if (!resolved) {
      console.error('--wsl requires running under WSL with /mnt/c/ accessible.');
      console.error('Use --target <path> for a custom location, or drop --wsl on Linux/macOS.');
      process.exit(1);
    }
    args.target = resolved;
  }

  const loadPath = args.target ? path.resolve(args.target) : PKG_DIR;

  if (args.dryRun) {
    console.log('\n[dry-run] Would:');
    if (!args.noBuild) console.log(`  pnpm --filter @opencues/firefox build  (typecheck + esbuild)`);
    if (args.target) {
      console.log(`  mkdir -p ${loadPath}/dist`);
      console.log(`  cp -r ${distDir}/* ${loadPath}/dist/`);
      console.log(`  cp ${manifest} ${loadPath}/manifest.json`);
    }
    console.log(`  print: Load Temporary Add-on from ${toWindowsPathIfPossible(loadPath)}/manifest.json at about:debugging`);
    return;
  }

  // 1. Build (unless --no-build).
  if (!args.noBuild) {
    if (!runStep('Building add-on', () =>
      spawnSync('pnpm', ['--filter', '@opencues/firefox', 'build'], {
        cwd: REPO_ROOT,
        stdio: process.env.OPENCUES_INSTALL_VERBOSE === '1' ? 'inherit' : ['ignore', logFd(), logFd()],
      }).status === 0
    )) {
      reportFailure('Build failed');
      process.exit(1);
    }
  }

  // 2. Deploy.
  if (args.target) {
    if (!runStep('Deploying to ' + toWindowsPathIfPossible(loadPath), () => {
      fs.mkdirSync(path.join(loadPath, 'dist'), { recursive: true });
      copyDirContents(distDir, path.join(loadPath, 'dist'));
      fs.copyFileSync(manifest, path.join(loadPath, 'manifest.json'));
      return true;
    })) {
      reportFailure('Deploy failed');
      process.exit(1);
    }
  }

  // 2b. Detect WSL without --wsl/--target — flag the cross-fs slowness.
  if (!args.target && isWsl()) {
    console.log('');
    console.log('  Note: detected WSL. Loading the add-on from the WSL filesystem');
    console.log('        (\\\\wsl.localhost\\...) is slow + flaky. Run with --wsl to');
    console.log('        mirror to a Windows-side path Firefox can read natively.');
  }

  // 3. Print Firefox reload instructions.
  const oc = launchCommand();
  const uninstallSuffix = args.wsl ? ' --wsl' : (args.target ? ` --target ${args.target}` : '');
  const displayPath = toWindowsPathIfPossible(loadPath);
  // Version marker for drift detection (mirrors the Chrome integration).
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('firefox', distDir, { pkg, REPO_ROOT });
    if (args.target) writeMarker('firefox', loadPath, { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  console.log('');
  console.log('Done. Load it in Firefox:');
  console.log('  1. open about:debugging#/runtime/this-firefox');
  console.log('  2. click "Load Temporary Add-on…"');
  console.log(`  3. select ${displayPath}${path.sep}manifest.json`);
  console.log('');
  console.log('Reload after future rebuilds: click "Reload" on the add-on card.');
  console.log('(Temporary add-ons are removed when Firefox restarts — reload after each restart.)');
  console.log(`Uninstall: ${oc} uninstall firefox${uninstallSuffix}`);
}

// Convert a WSL /mnt/<drive>/… path to the Windows-native form (C:\…).
function toWindowsPathIfPossible(p) {
  if (!/^\/mnt\/[a-z]\//i.test(p)) return p;
  const probe = spawnSync('wslpath', ['-w', p], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status === 0) {
    const out = String(probe.stdout).trim();
    if (out) return out;
  }
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}

// Prefer the short "opencues" form when the binary is on PATH.
function launchCommand() {
  const probe = spawnSync('command', ['-v', 'opencues'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  return probe.status === 0 ? 'opencues' : 'pnpm exec opencues';
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  if (args.wsl) {
    const resolved = resolveWslTarget();
    if (!resolved) {
      console.error('--wsl requires running under WSL with /mnt/c/ accessible.');
      process.exit(1);
    }
    args.target = resolved;
  }

  const distDir = path.join(PKG_DIR, 'dist');
  const targetDist = args.target ? path.join(path.resolve(args.target), 'dist') : null;
  const targetManifest = args.target ? path.join(path.resolve(args.target), 'manifest.json') : null;

  const plan = {
    rmDist: fs.existsSync(distDir) ? distDir : null,
    rmTargetDist: targetDist && fs.existsSync(targetDist) ? targetDist : null,
    rmTargetManifest: targetManifest && fs.existsSync(targetManifest) ? targetManifest : null,
  };

  const showPath = (p) => toWindowsPathIfPossible(p);

  console.log('Uninstall plan:');
  if (plan.rmDist) console.log(`  rm -rf ${showPath(plan.rmDist)}/`);
  if (plan.rmTargetDist) console.log(`  rm -rf ${showPath(plan.rmTargetDist)}/`);
  if (plan.rmTargetManifest) console.log(`  rm ${showPath(plan.rmTargetManifest)}`);
  if (!plan.rmDist && !plan.rmTargetDist && !plan.rmTargetManifest) {
    console.log('  (no installed paths found — appears clean)');
  }
  console.log(`\nNote: also remove the add-on from about:debugging manually (or restart Firefox — temporary add-ons don't persist).`);

  if (args.dryRun) {
    console.log('\n[dry-run] Nothing executed.');
    return;
  }

  console.log('');
  if (plan.rmDist) {
    fs.rmSync(plan.rmDist, { recursive: true, force: true });
    console.log(`  removed ${showPath(plan.rmDist)}/`);
  }
  if (plan.rmTargetDist) {
    fs.rmSync(plan.rmTargetDist, { recursive: true, force: true });
    console.log(`  removed ${showPath(plan.rmTargetDist)}/`);
  }
  if (plan.rmTargetManifest) {
    fs.rmSync(plan.rmTargetManifest, { force: true });
    console.log(`  removed ${showPath(plan.rmTargetManifest)}`);
  }

  console.log(`\n${pkg.name} uninstall complete.`);
}

// --- INSTALL-HOST (native-messaging) -------------------------------------
//
// Drop the local host process manifest that Firefox reads to spawn it.
//
// Platforms:
//   - WSL → Firefox-on-Windows: write the manifest to %LOCALAPPDATA%\opencues\,
//     drop a .bat shim that re-enters WSL via wsl.exe, register the host
//     name in HKCU\Software\Mozilla\NativeMessagingHosts.
//   - macOS:   ~/Library/Application Support/Mozilla/NativeMessagingHosts/
//   - Linux:   ~/.mozilla/native-messaging-hosts/
//
// The user supplies --extension-id <gecko-id> — the add-on ID declared in
// manifest.json's browser_specific_settings.gecko.id (default
// opencues@opencues.dev). The manifest's `allowed_extensions` gates which
// add-ons Firefox will let connect to this host.

function doInstallHost() {
  const extensionId = args.extensionId;
  if (!extensionId) {
    console.error('install-host requires --extension-id <gecko-id>.');
    console.error('This is manifest.json → browser_specific_settings.gecko.id (default opencues@opencues.dev).');
    console.error('Also visible at about:debugging → This Firefox → on the OpenCues card ("Extension ID").');
    process.exit(2);
  }
  // Gecko IDs are either an email-like string (x@y) or a GUID ({...}).
  if (!/^[^@{}\s]+@[^@{}\s]+$/.test(extensionId) && !/^\{[0-9a-fA-F-]{36}\}$/.test(extensionId)) {
    console.error(`--extension-id "${extensionId}" does not look like a Firefox add-on ID`);
    console.error('(expected an email-form id like opencues@opencues.dev or a {GUID}). Continuing anyway.');
  }
  if (!fs.existsSync(HOST_SCRIPT)) {
    console.error(`host script missing: ${HOST_SCRIPT}`);
    console.error('The Firefox integration reuses the Chrome native host. Check your clone is intact.');
    process.exit(1);
  }

  if (isWsl()) return installHostWsl(extensionId);
  if (process.platform === 'darwin') return installHostUnix(extensionId, 'macos');
  if (process.platform === 'linux') return installHostUnix(extensionId, 'linux');
  if (process.platform === 'win32') return installHostWindows(extensionId);

  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

function installHostUnix(extensionId, kind) {
  // Firefox reads native-messaging manifests from a single per-user dir.
  const home = os.homedir();
  const browserDirs = kind === 'macos'
    ? [path.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts')]
    : [path.join(home, '.mozilla/native-messaging-hosts')];

  const manifest = {
    name: HOST_NAME,
    description: 'OpenCues config sync — pushes ~/.cues/ changes into the add-on',
    path: HOST_SCRIPT,
    type: 'stdio',
    allowed_extensions: [extensionId],
  };

  if (args.dryRun) {
    console.log('\n[dry-run] Would:');
    for (const d of browserDirs) console.log(`  write ${path.join(d, HOST_NAME + '.json')}`);
    console.log(`  set executable bit on ${HOST_SCRIPT}`);
    return;
  }

  fs.chmodSync(HOST_SCRIPT, 0o755);
  let wrote = 0;
  for (const d of browserDirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const dst = path.join(d, HOST_NAME + '.json');
      fs.writeFileSync(dst, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`  wrote ${dst}`);
      wrote++;
    } catch (err) {
      console.warn(`  skipped ${d}: ${err.message}`);
    }
  }
  if (wrote === 0) {
    console.error('No manifests written. Is Firefox installed?');
    process.exit(1);
  }
  console.log(`\nDone. Native-messaging host registered for add-on ${extensionId}.`);
  console.log('Reload the add-on at about:debugging to pick up the new port.');
}

function installHostWsl(extensionId) {
  // Firefox runs on the Windows side. It needs:
  //   1. A manifest file at a Windows-accessible path
  //   2. A registry entry (HKCU\Software\Mozilla\NativeMessagingHosts) pointing at it
  //   3. The manifest's `path` field pointing at a .bat shim that re-enters WSL.
  const winUserProbe = spawnSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (winUserProbe.status !== 0) {
    console.error('Could not resolve Windows USERPROFILE via cmd.exe. Is /mnt/c accessible?');
    process.exit(1);
  }
  const winUserProfileWin = String(winUserProbe.stdout).trim().replace(/\r$/, '');
  const m = winUserProfileWin.match(/^([A-Za-z]):\\(.*)$/);
  if (!m) {
    console.error(`Unexpected USERPROFILE form: ${winUserProfileWin}`);
    process.exit(1);
  }
  const wslUserProfile = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;

  const wslHostDir = `${wslUserProfile}/AppData/Local/opencues`;
  const winHostDir = `${winUserProfileWin}\\AppData\\Local\\opencues`;
  // Firefox-specific manifest filename so it can coexist with the Chrome
  // integration's manifest in the same %LOCALAPPDATA%\opencues\ dir.
  const manifestPathWsl = `${wslHostDir}/${HOST_NAME}.firefox.json`;
  const manifestPathWin = `${winHostDir}\\${HOST_NAME}.firefox.json`;
  const batPathWsl = `${wslHostDir}/sync-host.bat`;
  const batPathWin = `${winHostDir}\\sync-host.bat`;

  // The .bat shim re-enters WSL. `--shell-type login` so nvm / volta in the
  // user's profile is sourced (system Node is often too old).
  const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  const bat =
    '@echo off\r\n' +
    `wsl.exe -d ${distro} --shell-type login -- node ${HOST_SCRIPT}\r\n`;

  const manifest = {
    name: HOST_NAME,
    description: 'OpenCues config sync — pushes ~/.cues/ changes into the add-on',
    path: batPathWin,
    type: 'stdio',
    allowed_extensions: [extensionId],
  };

  if (args.dryRun) {
    console.log('\n[dry-run] Would:');
    console.log(`  mkdir -p ${wslHostDir}`);
    console.log(`  write ${batPathWsl}`);
    console.log(`  write ${manifestPathWsl}`);
    console.log(`  reg.exe add HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME} /ve /d "${manifestPathWin}" /f`);
    return;
  }

  fs.mkdirSync(wslHostDir, { recursive: true });
  fs.writeFileSync(batPathWsl, bat);
  fs.writeFileSync(manifestPathWsl, JSON.stringify(manifest, null, 2) + '\r\n');
  console.log(`  wrote ${batPathWin}`);
  console.log(`  wrote ${manifestPathWin}`);

  // Register the host name in HKCU\Software\Mozilla (Firefox's key).
  const regResult = spawnSync('reg.exe', [
    'add',
    `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`,
    '/ve', '/t', 'REG_SZ', '/d', manifestPathWin, '/f',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (regResult.status !== 0) {
    console.error('reg.exe failed:');
    console.error(String(regResult.stderr || regResult.stdout));
    process.exit(1);
  }
  console.log(`  registered HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`);

  console.log(`\nDone. Native-messaging host registered for add-on ${extensionId}.`);
  console.log('Reload the add-on at about:debugging to pick up the new port.');
  console.log('Check the add-on background console (about:debugging → Inspect)');
  console.log('for "native host port opened" — the host pushes an initial bundle within 1s.');
}

function installHostWindows(_extensionId) {
  console.error('Native Windows install not wired yet. If you reach this branch from Powershell/cmd,');
  console.error('run inside WSL instead — that path is exercised and supported.');
  process.exit(1);
}

function doUninstallHost() {
  if (isWsl()) return uninstallHostWsl();
  if (process.platform === 'darwin') return uninstallHostUnix('macos');
  if (process.platform === 'linux') return uninstallHostUnix('linux');
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

function uninstallHostUnix(kind) {
  const home = os.homedir();
  const dirs = kind === 'macos'
    ? [path.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts')]
    : [path.join(home, '.mozilla/native-messaging-hosts')];
  for (const d of dirs) {
    const f = path.join(d, HOST_NAME + '.json');
    if (fs.existsSync(f)) {
      if (args.dryRun) { console.log(`[dry-run] rm ${f}`); continue; }
      fs.rmSync(f);
      console.log(`  removed ${f}`);
    }
  }
  console.log('\nDone.');
}

function uninstallHostWsl() {
  const winUserProbe = spawnSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (winUserProbe.status !== 0) { console.error('Could not resolve USERPROFILE via cmd.exe.'); process.exit(1); }
  const winUserProfileWin = String(winUserProbe.stdout).trim().replace(/\r$/, '');
  const m = winUserProfileWin.match(/^([A-Za-z]):\\(.*)$/);
  if (!m) { console.error(`Unexpected USERPROFILE form: ${winUserProfileWin}`); process.exit(1); }
  const wslUserProfile = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  const wslHostDir = `${wslUserProfile}/AppData/Local/opencues`;
  const manifestPathWsl = `${wslHostDir}/${HOST_NAME}.firefox.json`;

  if (args.dryRun) {
    console.log(`[dry-run] rm ${manifestPathWsl}`);
    console.log(`[dry-run] reg.exe delete HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME} /f`);
    return;
  }
  // Only remove the Firefox manifest — the shared .bat + dir may still be
  // used by the Chrome integration's host.
  if (fs.existsSync(manifestPathWsl)) {
    fs.rmSync(manifestPathWsl, { force: true });
    console.log(`  removed ${manifestPathWsl}`);
  }
  spawnSync('reg.exe', [
    'delete', `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`, '/f',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`  unregistered HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`);
  console.log('\nDone.');
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
  const KNOWN_COMMANDS = new Set(['install', 'uninstall', 'install-host', 'uninstall-host', 'help']);
  const out = { command: 'install', args: { help: false, dryRun: false, noBuild: false, wsl: false }, unknown: [] };
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
    else if (a === '--wsl') out.args.wsl = true;
    else if (a === '--target') out.args.target = argv[++i];
    else if (a === '--extension-id') out.args.extensionId = argv[++i];
    else out.unknown.push(a);
  }
  return out;
}

function warnUnknownFlags(unknown) {
  if (!unknown.length) return;
  console.warn(`WARNING: ignoring unknown argument(s): ${unknown.join(' ')}`);
  console.warn(`Known commands: install, uninstall, install-host, uninstall-host, help`);
  console.warn(`Known flags:    --target <path>, --wsl, --no-build, --dry-run, --extension-id <id>, --help`);
  console.warn('');
}

function printBanner() {
  console.log(`${pkg.name} v${pkg.version}`);
}

function printHelp() {
  printBanner();
  console.log('');
  console.log('Commands:');
  console.log('  install (default)   Build the add-on; optionally deploy to --target');
  console.log('  uninstall           Remove dist/; optionally clean up --target deploy');
  console.log('  install-host        Register the native-messaging host (needs --extension-id)');
  console.log('  uninstall-host      Remove the native-messaging host registration');
  console.log('  help                Show this message');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>     Where to deploy unpacked add-on (default: in-place)');
  console.log('  --wsl               Auto-resolve --target to a Windows-side path');
  console.log('                      (/mnt/c/Users/<user>/AppData/Local/opencues-firefox/)');
  console.log('  --no-build          Skip the build step (use existing dist/)');
  console.log('  --extension-id <id> Gecko add-on ID (for install-host; default opencues@opencues.dev)');
  console.log('  --dry-run           Print the plan; do not execute');
  console.log('  --help              Show this message');
  console.log('');
  console.log('Blast radius:');
  console.log('  Repo state (gitignored):');
  console.log('    integrations/firefox/dist/     esbuild output');
  console.log('    packages/*/dist/, .turbo/      build cache');
  console.log('  If --target <path>:');
  console.log('    <path>/dist/                   mirror of integrations/firefox/dist/');
  console.log('    <path>/manifest.json           mirror of integrations/firefox/manifest.json');
  console.log('  Native-messaging host:');
  console.log('    ~/.mozilla/native-messaging-hosts/com.opencues.sync.json (Linux)');
  console.log('    or the Mozilla NativeMessagingHosts dir / HKCU registry (macOS / WSL)');
  console.log('    The host SCRIPT is reused from integrations/chrome/host/host.cjs.');
}
