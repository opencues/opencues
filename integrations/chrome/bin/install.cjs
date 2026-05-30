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
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

// Native-messaging constants (used by install-host / uninstall-host).
// Declared up here so they're initialised before the command dispatcher
// below runs (TDZ would bite otherwise).
const HOST_NAME = 'com.opencues.sync';
const HOST_SCRIPT = path.join(PKG_DIR, 'host', 'host.cjs');

// Quiet/verbose progress wrapper. Defined up here so the doInstall()
// call below resolves through the const initializers (TDZ).
const LOG_PATH = process.env.OPENCUES_INSTALL_LOG || '/tmp/opencues-install-chrome.log';
let _logFd = null;
function logFd() {
  if (_logFd == null) _logFd = fs.openSync(LOG_PATH, 'w');
  return _logFd;
}
function runStep(label, fn) {
  if (process.env.OPENCUES_INSTALL_VERBOSE === '1') {
    process.stdout.write(`  ▸ ${label}\n`);
    const ok = !!fn();
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
    return ok;
  }
  process.stdout.write(`  ▸ ${label}`);
  const ok = !!fn();
  process.stdout.write(ok ? ' ✓\n' : ' ✗\n');
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

// Resolve `/mnt/c/Users/<windows-user>/AppData/Local/opencues-chrome/`.
// Returns null if not on WSL or the Windows username can't be determined.
function resolveWslTarget() {
  if (!isWsl()) return null;
  const probe = spawnSync('cmd.exe', ['/c', 'echo %USERNAME%'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status !== 0) return null;
  const winUser = String(probe.stdout).trim().replace(/\r$/, '');
  if (!winUser) return null;
  return `/mnt/c/Users/${winUser}/AppData/Local/opencues-chrome`;
}

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

  // --wsl auto-resolves to a Windows-side path Chrome can read natively.
  // Refuses cleanly if not actually running under WSL.
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
    if (!args.noBuild) console.log(`  pnpm --filter @opencues/chrome build  (typecheck + tests + esbuild)`);
    if (args.target) {
      console.log(`  mkdir -p ${loadPath}/dist`);
      console.log(`  cp -r ${distDir}/* ${loadPath}/dist/`);
      console.log(`  cp ${manifest} ${loadPath}/manifest.json`);
    }
    console.log(`  print: load unpacked from ${toWindowsPathIfPossible(loadPath)} at chrome://extensions`);
    return;
  }

  // 1. Build (unless --no-build). Same quiet/verbose pattern as the
  //    OC installer: pipe to /tmp/opencues-install-chrome.log unless
  //    OPENCUES_INSTALL_VERBOSE=1.
  if (!args.noBuild) {
    if (!runStep('Building extension', () =>
      spawnSync('pnpm', ['--filter', '@opencues/chrome', 'build'], {
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

  // 2b. Detect WSL without --wsl/--target — flag the cross-fs slowness
  //     so the user knows there's a better path.
  if (!args.target && isWsl()) {
    console.log('');
    console.log('  Note: detected WSL. Loading the extension from the WSL filesystem');
    console.log('        (\\\\wsl.localhost\\...) is slow + flaky. Run with --wsl to');
    console.log('        mirror to a Windows-side path Chrome can read natively.');
  }

  // 3. Print Chrome reload instructions.
  // Chrome runs as a Windows process — when loading from a path under
  // /mnt/c/, it needs the native Windows form (C:\Users\…), not the
  // WSL mount form. Convert via wslpath -w if available.
  const oc = launchCommand();
  // Mirror the same flag form on uninstall: --wsl ↔ --wsl, --target ↔ --target.
  const uninstallSuffix = args.wsl ? ' --wsl' : (args.target ? ` --target ${args.target}` : '');
  const displayPath = toWindowsPathIfPossible(loadPath);
  // Version marker for drift detection. Marker sits inside dist/ —
  // gets removed automatically by `opencues uninstall chrome` along
  // with the rest of dist/.
  try {
    const { writeMarker } = require(path.join(REPO_ROOT, 'packages/opencues-cli/src/lib/version-markers.cjs'));
    writeMarker('chrome', distDir, { pkg, REPO_ROOT });
    if (args.target) writeMarker('chrome', loadPath, { pkg, REPO_ROOT });
  } catch { /* non-fatal */ }

  console.log('');
  console.log('Done. Load it in Chrome:');
  console.log('  1. open chrome://extensions');
  console.log('  2. enable Developer mode');
  console.log(`  3. Load unpacked → ${displayPath}`);
  console.log('');
  console.log('Reload after future rebuilds: click reload on the extension card');
  console.log(`Uninstall: ${oc} uninstall chrome${uninstallSuffix}`);
}

// Convert a WSL /mnt/<drive>/… path to the Windows-native form
// (C:\…) so "Load unpacked" accepts it. Returns the input unchanged
// when not on WSL or not a /mnt/ path.
function toWindowsPathIfPossible(p) {
  if (!/^\/mnt\/[a-z]\//i.test(p)) return p;
  // Prefer wslpath -w when available — handles edge cases (spaces, symlinks).
  const probe = spawnSync('wslpath', ['-w', p], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status === 0) {
    const out = String(probe.stdout).trim();
    if (out) return out;
  }
  // Fallback: manual rewrite. /mnt/c/Foo/Bar → C:\Foo\Bar
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}


// Prefer the short "opencues" form when the binary is on PATH; fall back
// to the always-works-from-a-clone form. Used in user-facing hint messages.
function launchCommand() {
  const probe = spawnSync('command', ['-v', 'opencues'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
  return probe.status === 0 ? 'opencues' : 'pnpm exec opencues';
}

// --- UNINSTALL ------------------------------------------------------------

function doUninstall() {
  // --wsl auto-resolves to the same path the install --wsl deployed to.
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

  // Under --wsl, filesystem ops have to use the /mnt/... mount path (Node
  // can't resolve C:\...), but the user sees their install at the Windows
  // path in Chrome + File Explorer. Always display the Windows form.
  const showPath = (p) => toWindowsPathIfPossible(p);

  console.log('Uninstall plan:');
  if (plan.rmDist) console.log(`  rm -rf ${showPath(plan.rmDist)}/`);
  if (plan.rmTargetDist) console.log(`  rm -rf ${showPath(plan.rmTargetDist)}/`);
  if (plan.rmTargetManifest) console.log(`  rm ${showPath(plan.rmTargetManifest)}`);
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
// Drop the local host process + manifest that Chrome reads to spawn it.
//
// Platforms:
//   - WSL → Chrome-on-Windows: write the manifest to %LOCALAPPDATA%\opencues\,
//     drop a .bat shim that re-enters WSL via wsl.exe, register the host
//     name in HKCU registry.
//   - macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
//   - Linux:   ~/.config/google-chrome/NativeMessagingHosts/
//
// The user supplies --extension-id <id> (visible at chrome://extensions
// in Developer mode). The manifest's allowed_origins gates which
// extensions Chrome will let connect to this host.

function doInstallHost() {
  const extensionId = args.extensionId;
  if (!extensionId) {
    console.error('install-host requires --extension-id <id>.');
    console.error('Find the ID at chrome://extensions (Developer mode → on the OpenCues card).');
    process.exit(2);
  }
  if (!/^[a-p]{32}$/.test(extensionId)) {
    console.error(`--extension-id "${extensionId}" does not look like a Chrome extension ID`);
    console.error('(should be 32 lowercase letters a-p). Continuing anyway.');
  }
  if (!fs.existsSync(HOST_SCRIPT)) {
    console.error(`host script missing: ${HOST_SCRIPT}`);
    console.error('Reinstall the extension package or check your clone is intact.');
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
  // Chrome (+ Chromium, Brave) read from per-browser dirs under HOME.
  // Write the manifest into every dir we know about; Chrome ignores
  // entries for browsers the user doesn't have.
  const home = os.homedir();
  const browserDirs = kind === 'macos'
    ? [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    ]
    : [
      path.join(home, '.config/google-chrome/NativeMessagingHosts'),
      path.join(home, '.config/chromium/NativeMessagingHosts'),
      path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    ];

  const manifest = {
    name: HOST_NAME,
    description: 'OpenCues config sync — pushes ~/.cues/ changes into the extension',
    path: HOST_SCRIPT,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
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
    console.error('No manifests written. Is Chrome installed?');
    process.exit(1);
  }
  console.log(`\nDone. Native-messaging host registered for extension ${extensionId}.`);
  console.log('Reload the extension at chrome://extensions to pick up the new port.');
}

function installHostWsl(extensionId) {
  // Chrome runs on the Windows side. It needs:
  //   1. A manifest file at a Windows-accessible path
  //   2. A registry entry pointing at that manifest
  //   3. The manifest's `path` field pointing at a Windows-executable
  //      (.bat shim) that re-enters WSL to launch the Node host.
  const winUserProbe = spawnSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (winUserProbe.status !== 0) {
    console.error('Could not resolve Windows USERPROFILE via cmd.exe. Is /mnt/c accessible?');
    process.exit(1);
  }
  const winUserProfileWin = String(winUserProbe.stdout).trim().replace(/\r$/, '');
  // C:\Users\<x>  →  /mnt/c/Users/<x>
  const m = winUserProfileWin.match(/^([A-Za-z]):\\(.*)$/);
  if (!m) {
    console.error(`Unexpected USERPROFILE form: ${winUserProfileWin}`);
    process.exit(1);
  }
  const wslUserProfile = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;

  const wslHostDir = `${wslUserProfile}/AppData/Local/opencues`;
  const winHostDir = `${winUserProfileWin}\\AppData\\Local\\opencues`;
  const manifestPathWsl = `${wslHostDir}/${HOST_NAME}.json`;
  const manifestPathWin = `${winHostDir}\\${HOST_NAME}.json`;
  const batPathWsl = `${wslHostDir}/sync-host.bat`;
  const batPathWin = `${winHostDir}\\sync-host.bat`;

  // The .bat shim re-enters WSL. wsl.exe routes stdio through the
  // Windows process Chrome spawned, so framed JSON flows through
  // unchanged. We pass HOST_SCRIPT as an absolute WSL path.
  //
  // `--shell-type login` so nvm / volta / asdf in the user's profile
  // is sourced — without it, wsl.exe spawns a non-interactive shell
  // that gets the system PATH only (often a stale system Node that
  // chokes on modern syntax like optional chaining).
  const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  const bat =
    '@echo off\r\n' +
    `wsl.exe -d ${distro} --shell-type login -- node ${HOST_SCRIPT}\r\n`;

  const manifest = {
    name: HOST_NAME,
    description: 'OpenCues config sync — pushes ~/.cues/ changes into the extension',
    path: batPathWin,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  if (args.dryRun) {
    console.log('\n[dry-run] Would:');
    console.log(`  mkdir -p ${wslHostDir}`);
    console.log(`  write ${batPathWsl}`);
    console.log(`  write ${manifestPathWsl}`);
    console.log(`  reg.exe add HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME} /ve /d "${manifestPathWin}" /f`);
    return;
  }

  fs.mkdirSync(wslHostDir, { recursive: true });
  fs.writeFileSync(batPathWsl, bat);
  fs.writeFileSync(manifestPathWsl, JSON.stringify(manifest, null, 2) + '\r\n');
  console.log(`  wrote ${batPathWin}`);
  console.log(`  wrote ${manifestPathWin}`);

  // Register the host name in HKCU. Chrome reads this registry key
  // first; if absent it falls back to file-based manifests in known
  // dirs, but on Windows the registry path is canonical.
  const regResult = spawnSync('reg.exe', [
    'add',
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    '/ve', '/t', 'REG_SZ', '/d', manifestPathWin, '/f',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (regResult.status !== 0) {
    console.error('reg.exe failed:');
    console.error(String(regResult.stderr || regResult.stdout));
    process.exit(1);
  }
  console.log(`  registered HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);

  console.log(`\nDone. Native-messaging host registered for extension ${extensionId}.`);
  console.log('Reload the extension at chrome://extensions to pick up the new port.');
  console.log('Check the service worker logs (chrome://extensions → inspect views: service worker)');
  console.log('for "native host port opened" — and the host should push an initial bundle within 1s.');
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
    ? [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    ]
    : [
      path.join(home, '.config/google-chrome/NativeMessagingHosts'),
      path.join(home, '.config/chromium/NativeMessagingHosts'),
      path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    ];
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

  if (args.dryRun) {
    console.log(`[dry-run] rm -rf ${wslHostDir}`);
    console.log(`[dry-run] reg.exe delete HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME} /f`);
    return;
  }
  if (fs.existsSync(wslHostDir)) {
    fs.rmSync(wslHostDir, { recursive: true, force: true });
    console.log(`  removed ${wslHostDir}`);
  }
  spawnSync('reg.exe', [
    'delete', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/f',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`  unregistered HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
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
  console.warn(`Known commands: install, uninstall, help`);
  console.warn(`Known flags:    --target <path>, --wsl, --no-build, --dry-run, --help`);
  console.warn('');
}

function printBanner() {
  console.log(`${pkg.name} v${pkg.version}`);
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
  console.log('  --wsl               Auto-resolve --target to a Windows-side path');
  console.log('                      (/mnt/c/Users/<user>/AppData/Local/opencues-chrome/)');
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
