// `opencues install <host>` — dispatch to per-integration installer.
//
// This is a thin shell-out — the actual install logic lives in
// integrations/<host>/bin/install.cjs (which already supports
// install/uninstall/seed-configs/--dry-run/--target/etc.). Cross-cutting
// flags like `--all` are handled here.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tag, step, bold, dim, banner, cliVersion } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');
const { pickHost } = require('../lib/pick-host.cjs');

// Host name resolution comes from @opencues/core (HOSTS + HOST_ALIASES +
// resolveHost). 'chrome-host' is the lone special case kept local — it's
// a sub-action of chrome (the native-messaging host install), not a
// distinct host. Caught here and routed in subcommand dispatch.
function loadHostResolver(ctx) {
  try {
    const core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/host-compat.js'));
    return {
      HOSTS: core.HOSTS.slice().sort(),
      resolve: (name) => name === 'chrome-host' ? 'chrome' : core.resolveHost(name),
    };
  } catch {
    // Pre-build fallback — keep CLI usable.
    return {
      HOSTS: ['chrome', 'claude-code', 'gemini-cli', 'opencode', 'shell', 'vscode'],
      resolve: (name) => {
        const map = {
          'claude-code': 'claude-code', 'claudecode': 'claude-code',
          'claude': 'claude-code', 'cc': 'claude-code',
          'opencode': 'opencode', 'oc': 'opencode',
          'chrome': 'chrome', 'chrome-host': 'chrome',
          'gemini-cli': 'gemini-cli', 'geminicli': 'gemini-cli',
          'gemini': 'gemini-cli',
          'shell': 'shell', 'term': 'shell', 'oc-edit': 'shell',
          'vscode': 'vscode', 'code': 'vscode', 'vs-code': 'vscode',
        };
        return map[name?.toLowerCase?.()] ?? null;
      },
    };
  }
}

module.exports = async function install(argv, ctx) {
  // `opencues install skill <name> [--project] [--target <path>] [--force] [--link]`
  // is a separate code path from the host installers — skills aren't a
  // host integration, they're prompt-text files copied into Claude
  // Code's / opencode's skill directories. Dispatched here before the
  // help check + host resolver run (so "skill" doesn't get treated as
  // a host name and `install skill --help` doesn't fall through to the
  // top-level help).
  if (argv[0] === 'skill') {
    return installSkill(argv.slice(1), ctx);
  }

  // `opencues install plugin <name>` — install a host-plugin (currently
  // only opencode supported). Unlike skills (text the chat model
  // consults), plugins are CODE that hooks deterministic events. The
  // cues plugin uses opencode's chat.message hook to write CUES.md on
  // every user message — no model judgment needed.
  if (argv[0] === 'plugin') {
    return installPlugin(argv.slice(1), ctx);
  }

  if (argv.includes('--help') || argv.includes('-h')) return printHelp(ctx);

  const { HOSTS, resolve } = loadHostResolver(ctx);

  // Parse: first non-flag positional is the host. `--all` is a special
  // pseudo-host. Top-level prompt flags (`--yes` / `--no-prompts`) are
  // consumed here (they drive the preflight auto-install offer) — NOT
  // forwarded to per-host installers, which would warn about them.
  // Everything else flows through to the per-host installer.
  let target = null;
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') { target = '--all'; continue; }
    if (a === '--yes' || a === '-y' || a === '--no-prompts') { continue; }
    if (!a.startsWith('-') && !target) { target = a; continue; }
    passthrough.push(a);
  }

  if (!target && prompt.isInteractive()) {
    target = await pickHost(HOSTS, { verb: 'Install which host', allowAll: true });
    if (!target) return; // cancelled
  }
  if (!target) {
    console.error(`opencues install: missing <host>. One of: ${HOSTS.join(', ')}, --all`);
    console.error('Run `opencues install --help` for details.\n');
    process.exit(2);
  }

  // Resolve descriptive name → folder code; --all expands to all folders.
  const folders = target === '--all'
    ? HOSTS.slice()
    : [resolve(target)];
  if (folders[0] === undefined || folders[0] === null) {
    console.error(`opencues install: unknown host "${target}". Known: ${HOSTS.join(', ')}, --all`);
    process.exit(2);
  }

  // The chrome-host installer is a separate sub-action — it installs
  // the local native-messaging host that pushes ~/.cues/ into the
  // running extension. It does NOT need seed-configs (no writes to
  // ~/.cues/) and shares no install steps with the extension itself.
  const isChromeHost = target === 'chrome-host';
  const action = isChromeHost ? 'install-host' : 'install';

  // Preflight: surface platform-specific gotchas BEFORE the install runs
  // so the user isn't surprised by them after the install reports success.
  // Today this is macOS-only — see preflightChecks for the rationale.
  await preflightChecks(folders);

  // Workspace-deps gate: when invoked from a clone, any newly declared
  // dep in @opencues/{core,runtime,cli} that hasn't been `pnpm install`'d
  // makes every per-host installer fail at the tsc build step (the
  // June 2026 `isolated-vm` add was the canonical incident — five hosts
  // failed simultaneously with the same TS2307). Probe declared deps;
  // auto-run `pnpm install` if any are missing.
  ensureWorkspaceDeps(ctx);

  // Native-binding probe: `isolated-vm` ships prebuilt binaries for
  // common platforms (linux/darwin x64+arm64, win32 x64), but rare
  // arches fall back to `node-gyp rebuild` which silently fails when
  // no C++ toolchain is present. pnpm reports install success either
  // way; the per-host build then dies at `require('isolated-vm')`
  // with a confusing TS2307. Probe the load AFTER deps are installed
  // so users get actionable guidance early. Skip with
  // OPENCUES_SKIP_NATIVE_PROBE=1 if you know your env is fine.
  ensureNativeBindings(ctx);

  // Run seed-configs FIRST so the user-level ~/.cues/ tree is current
  // before any host installer runs. seed-configs handles all shared writes:
  // first-time copy, library-script sync, OPENCUES.md self-heal, .cs compile.
  // Per-host installers then do strictly host-specific work (patches, etc.).
  // --dry-run flows through; --silent keeps the output focused on host steps.
  if (!isChromeHost && !passthrough.includes('--dry-run')) {
    const seedConfigs = require('./seed-configs.cjs');
    seedConfigs(['--silent'], ctx);
  }

  console.log(banner({ version: cliVersion(ctx) }));
  console.log('');

  let exitCode = 0;
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    if (folders.length > 1) {
      console.log('');
      console.log(step(i + 1, folders.length, `installing ${bold('@opencues/' + folder)}`));
      console.log('');
    } else {
      console.log(`${tag('info')} installing ${bold('@opencues/' + folder)}`);
    }
    const code = runHostInstaller(folder, action, passthrough, ctx);
    if (code !== 0) {
      exitCode = code;
      console.log(`${tag('err')} ${folder} ${dim(`(exit ${code})`)}`);
    } else {
      console.log(`${tag('ok')} ${folder}`);
    }
  }

  // Surface `opencues doctor` so the user discovers it AT install time,
  // not the first time a feature mysteriously no-ops. Doctor covers the
  // gaps preflight can't (per-host runtime artefact checks, scalar/file
  // alignment, native-messaging host parity, sandbox confiner state).
  //
  // The update-check is run AFTER the install completes so a missing or
  // slow registry round-trip never blocks the real work. Failure-silent.
  if (exitCode === 0) {
    console.log('');
    console.log(`${tag('info')} verify your environment supports every feature: ${bold('opencues doctor')}`);
    await maybePrintUpdateNotice(ctx);
  }

  process.exit(exitCode);
};

// Non-blocking, fail-silent. The 2s timeout inside checkForUpdate caps
// the wait — and we run AFTER the install's primary output so a slow
// registry doesn't gum up the user's terminal.
async function maybePrintUpdateNotice(ctx) {
  try {
    const { checkForUpdate, formatNotice } = require('../lib/update-check.cjs');
    const notice = await checkForUpdate(cliVersion(ctx));
    const msg = formatNotice(notice);
    if (msg) console.log(`${tag('info')} ${msg}`);
  } catch { /* never let the notifier break a successful install */ }
}

// Platform preflight — warns about runtime gotchas that the install
// itself won't fail on but the user WILL hit the first time they use
// the affected feature.
//
// Pre-launch declarative gates (package.json `"os"` + `"engines"`) catch
// the wrong-OS / wrong-Node case before this runs. This layer covers the
// SOFTER gotchas:
//   - the right OS but a missing optional tool (volume backend, TTS
//     engine, sandbox confiner, bash version)
//   - the right OS but a sub-version that breaks a feature (tmux <3.2
//     on macOS / Linux)
//
// Warning here keeps the discovery path: "tried to install" → "told
// about gotchas up front" instead of "install looked fine" → "feature
// mysteriously broken weeks later".
async function preflightChecks(folders) {
  const os = require('node:os');
  const platform = os.platform();
  if (platform !== 'darwin' && platform !== 'linux') return;

  const { execSync } = require('node:child_process');
  const fs = require('node:fs');
  const warnings = [];

  // ── macOS: bash 4+ ────────────────────────────────────────────────
  // voice-mode (defaults/scripts/speak.sh used to need it; now portable)
  // and oc-popup (mapfile, now portable) and the shell helpers
  // (resolve_link uses POSIX-only constructs) all work on bash 3.2. But:
  // user shell snippets, future scripts, and third-party blank scripts
  // will likely assume bash 4 — warn upfront so the user knows.
  if (platform === 'darwin') {
    try {
      const out = execSync('/bin/bash --version 2>/dev/null', { encoding: 'utf8' });
      const m = out.match(/version (\d+)\./);
      const major = m ? parseInt(m[1], 10) : 0;
      if (major > 0 && major < 4) {
        warnings.push({
          item: `/bin/bash is ${major}.x`,
          impact: 'third-party blank scripts that use bash 4+ features (mapfile, declare -A, ${var^^}) will fail',
          fix: 'brew install bash  (then optionally `sudo sh -c "echo /opt/homebrew/bin/bash >> /etc/shells; chsh -s /opt/homebrew/bin/bash"`)',
        });
      }
    } catch { /* /bin/bash unavailable — unlikely on macOS; silent skip */ }
  }

  // ── tmux 3.2+ (shell integration only) ────────────────────────────
  // Skip entirely if `~/.opencues/vendor/tmux/bin/tmux` is already
  // present and >= 3.2 — oc-shell prefers the vendored binary, and
  // dragging the user through an apt/brew tmux install on top of that
  // is pure noise (and was the second of FOUR tmux mentions in one
  // `opencues install shell` run pre-2026-06). Mirrors doctor.cjs's
  // vendored-first check at the same precedence.
  if (folders.includes('shell')) {
    const vendoredTmux = path.join(os.homedir(), '.opencues', 'vendor', 'tmux', 'bin', 'tmux');
    const vendoredUsable = (() => {
      if (!fs.existsSync(vendoredTmux)) return false;
      try {
        const out = execSync(`${JSON.stringify(vendoredTmux)} -V 2>/dev/null`, { encoding: 'utf8' });
        const m = out.match(/tmux (\d+)\.(\d+)/);
        if (!m) return false;
        const maj = parseInt(m[1], 10), min = parseInt(m[2], 10);
        return maj > 3 || (maj === 3 && min >= 2);
      } catch { return false; }
    })();
    if (!vendoredUsable) {
      let tmuxInstall = platform === 'darwin' ? 'brew install tmux'
        : 'apt install tmux  (or `dnf install tmux` / `pacman -S tmux`)';
      const tmuxAuto = { apt: 'tmux', dnf: 'tmux', pacman: 'tmux', brew: 'tmux' };
      try {
        const out = execSync('tmux -V 2>/dev/null', { encoding: 'utf8' });
        const m = out.match(/tmux (\d+)\.(\d+)/);
        if (m) {
          const maj = parseInt(m[1], 10), min = parseInt(m[2], 10);
          if (maj < 3 || (maj === 3 && min < 2)) {
            warnings.push({
              item: `tmux ${maj}.${min}`,
              impact: 'oc-shell needs tmux 3.2+ for display-popup',
              fix: tmuxInstall,
              autoInstall: tmuxAuto,
            });
          }
        } else {
          warnings.push({
            item: 'tmux not found on PATH',
            impact: 'oc-shell needs tmux 3.2+ (will be vendored to ~/.opencues/vendor/tmux/ if you skip)',
            fix: tmuxInstall,
            autoInstall: tmuxAuto,
          });
        }
      } catch {
        warnings.push({
          item: 'tmux not found on PATH',
          impact: 'oc-shell needs tmux 3.2+ (will be vendored to ~/.opencues/vendor/tmux/ if you skip)',
          fix: tmuxInstall,
          autoInstall: tmuxAuto,
        });
      }
    }
  }

  // ── bun — needed by shell (oc-edit, oc-editd) and opencode ────────
  // We can install bun ourselves into ~/.opencues/vendor/bun/ (the
  // contained model) — bun's official installer honours BUN_INSTALL.
  // Uninstall then removes the dir cleanly. The host installers also
  // get PATH-prepended with that bin dir below, so a fresh-install
  // user who says "Y" to bun can immediately proceed without
  // re-sourcing rc.
  let needVendorBun = false;
  if (folders.includes('shell') || folders.includes('opencode')) {
    const vendoredBun = path.join(os.homedir(), '.opencues', 'vendor', 'bun', 'bin', 'bun');
    const haveSystem = (() => { try { execSync('bun --version 2>/dev/null', { encoding: 'utf8' }); return true; } catch { return false; } })();
    const haveVendored = fs.existsSync(vendoredBun);
    if (!haveSystem && !haveVendored) {
      warnings.push({
        item: 'bun not found on PATH',
        impact: `${folders.includes('shell') ? 'oc-edit / oc-editd' : 'opencode'} won't launch`,
        fix: 'we can install bun to ~/.opencues/vendor/bun/ (contained — `opencues uninstall` removes it cleanly)',
        // Marker for the post-warning offer below — not a regular pkg-mgr install.
        vendorBun: true,
      });
      needVendorBun = true;
    }
  }

  // ── Linux: sandbox confiner (bubblewrap) ──────────────────────────
  // Scripted blanks with `sandbox: strict` fall back to unwrapped exec
  // if bwrap is missing — features still work, sandbox doesn't.
  if (platform === 'linux' && !onPath('bwrap')) {
    warnings.push({
      item: 'bubblewrap (bwrap) not on PATH',
      impact: 'scripted blanks declared `sandbox: strict` will run unwrapped (no OS confinement)',
      fix: 'apt install bubblewrap  (or `dnf install bubblewrap` / `pacman -S bubblewrap`)',
      autoInstall: { apt: 'bubblewrap', dnf: 'bubblewrap', pacman: 'bubblewrap' },
    });
  }

  // ── TTS engine (voice-mode feature) ───────────────────────────────
  // macOS has built-in `say`; Linux needs espeak-ng or spd-say. Without
  // either, voice-mode is a silent no-op.
  if (platform === 'linux') {
    if (!onPath('espeak-ng') && !onPath('spd-say')) {
      warnings.push({
        item: 'no Linux TTS engine on PATH',
        impact: 'voice-mode is a silent no-op (no espeak-ng / spd-say found)',
        fix: 'apt install espeak-ng  (or `dnf install espeak-ng` / `pacman -S espeak-ng`)',
        autoInstall: { apt: 'espeak-ng', dnf: 'espeak-ng', pacman: 'espeak-ng' },
      });
    }
  }

  // ── volume blank backend ──────────────────────────────────────────
  // macOS osascript is built-in; Linux needs wpctl / pactl / amixer.
  // Without any, `volume _` reads + cycles to 50 silently.
  if (platform === 'linux') {
    if (!onPath('wpctl') && !onPath('pactl') && !onPath('amixer')) {
      warnings.push({
        item: 'no Linux audio control tool on PATH',
        impact: 'the `volume _` blank can read/cycle the displayed value but won\'t change system volume',
        fix: 'apt install pulseaudio-utils  (or wireplumber / alsa-utils — distro-dependent)',
      });
    }
  }

  // ── brightness blank backend ──────────────────────────────────────
  // Linux laptop backlight via brightnessctl. Optional — most users
  // never trigger `brightness _`. Linux-only check.
  if (platform === 'linux' && !onPath('brightnessctl') && !onPath('ddcutil')) {
    warnings.push({
      item: 'no Linux brightness tool on PATH',
      impact: 'the `brightness _` blank reads/cycles displayed value but won\'t change screen brightness',
      fix: 'apt install brightnessctl  (laptops) or `apt install ddcutil` (external DDC/CI monitors)',
      autoInstall: { apt: 'brightnessctl', dnf: 'brightnessctl', pacman: 'brightnessctl' },
    });
  }
  if (platform === 'darwin' && !onPath('brightness')) {
    warnings.push({
      item: 'macOS `brightness` cli not on PATH',
      impact: 'the `brightness _` blank reads/cycles displayed value but won\'t change screen brightness',
      fix: 'brew install brightness',
      autoInstall: { brew: 'brightness' },
    });
  }

  // ── WSL: warn about Chrome target path when installing chrome ─────
  if (folders.includes('chrome')) {
    const isWsl = (() => {
      if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
      try {
        return /microsoft|wsl/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
      } catch { return false; }
    })();
    if (isWsl) {
      warnings.push({
        item: 'WSL detected — Chrome is a Windows app',
        impact: 'loading the extension from the WSL filesystem (\\\\wsl.localhost\\…) is slow + flaky',
        fix: 're-run with: opencues install chrome -- --wsl  (mirrors dist/ to /mnt/c/Users/<you>/AppData/Local/opencues-chrome/)',
      });
    }
  }

  if (warnings.length === 0) return;

  const label = platform === 'darwin' ? 'macOS' : 'Linux';
  console.log('');
  console.log(`${tag('info')} ${label} preflight — runtime notes for this install:`);
  for (const w of warnings) {
    console.log(`  ${bold('•')} ${w.item}`);
    console.log(`    ${dim('impact:')} ${w.impact}`);
    console.log(`    ${dim('fix:')}    ${w.fix}`);
  }
  console.log(`  ${dim('(install will continue — these affect runtime features, not the install itself)')}`);
  console.log('');

  // ── Interactive install offers ──────────────────────────────────
  // Two passes:
  //   1. System-package auto-install (sudo apt / brew / etc.) — one
  //      command, one sudo prompt, batched across every dep with an
  //      autoInstall map.
  //   2. Vendored-bun install (curl|bash with BUN_INSTALL) — separate
  //      because it's a custom installer, not a package manager.
  //
  // Both gated on TTY + `--yes` / `--no-prompts`. Why TTY-gate: in CI
  // / scripts, blocking on prompts is a footgun — skip the offer
  // there. Users running interactively get the full benefit;
  // automation paths stay unblocked.
  //
  // What's NEVER auto-offered: audio tools (pactl/wpctl/amixer) —
  // multiple competing audio stacks, user picks. They appear in the
  // warning table only.
  await offerAutoInstall(warnings, platform);
  if (needVendorBun) await offerVendorBun();
}

async function offerVendorBun() {
  const argv = process.argv.slice(2);
  if (argv.includes('--no-prompts')) return;
  const autoYes = argv.includes('--yes') || argv.includes('-y');

  const HOME = require('os').homedir();
  const bunDir = path.join(HOME, '.opencues', 'vendor', 'bun');

  console.log(`${tag('info')} ${bold('Install bun?')} (target: ~/.opencues/vendor/bun/ — \`opencues uninstall\` removes it)`);
  console.log(`    ${dim('downloads:')} curl -fsSL https://bun.sh/install | BUN_INSTALL=~/.opencues/vendor/bun bash`);
  console.log('');

  let doInstall = true;
  if (!autoYes) {
    if (!process.stdin.isTTY) {
      console.log(`    ${dim('(non-interactive shell — skipping. Re-run with `--yes` to install.)')}`);
      console.log('');
      return;
    }
    doInstall = await prompt.confirm('Install bun now?', { default: true });
  }

  if (doInstall) {
    fs.mkdirSync(bunDir, { recursive: true });
    const cmd = `curl -fsSL https://bun.sh/install | BUN_INSTALL="${bunDir}" bash`;
    console.log(`  ${dim('running:')} ${cmd}`);
    const result = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
    if (result.status === 0 && fs.existsSync(path.join(bunDir, 'bin', 'bun'))) {
      console.log(`${tag('ok')} bun installed to ~/.opencues/vendor/bun/bin/bun`);
      console.log(`  ${dim('the rest of this install + every future `opencues …` invocation will find it automatically')}`);
    } else {
      console.log(`${tag('warn')} bun install failed (exit ${result.status}). Continuing — see https://bun.sh/install for manual steps.`);
    }
    console.log('');
  } else {
    console.log(`  ${dim('skipped — install manually any time:')} curl -fsSL https://bun.sh/install | bash`);
    console.log('');
  }
}

async function offerAutoInstall(warnings, platform) {
  // Respect non-interactive markers.
  const argv = process.argv.slice(2);
  if (argv.includes('--no-prompts')) return;
  const autoYes = argv.includes('--yes') || argv.includes('-y');

  // Filter to installables that have a key for the detected package manager.
  const pm = detectPackageManager(platform);
  if (!pm) return;
  const installable = warnings.filter(w => w.autoInstall && w.autoInstall[pm.name]);
  if (installable.length === 0) return;
  const packages = Array.from(new Set(installable.map(w => w.autoInstall[pm.name])));

  const cmd = pm.name === 'brew'
    ? `brew install ${packages.join(' ')}`
    : `sudo ${pm.cmd} ${packages.join(' ')}`;

  console.log(`${tag('info')} ${bold('I can install these for you')} (one command, one sudo prompt):`);
  console.log(`    ${cmd}`);
  console.log('');

  let doInstall = true;
  if (!autoYes) {
    if (!process.stdin.isTTY) {
      console.log(`    ${dim('(non-interactive shell — skipping. Re-run with `--yes` to install.)')}`);
      console.log('');
      return;
    }
    for (;;) {
      console.log(dim('  ↑↓ move · Enter select'));
      const choice = await prompt.select('', [
        { label: `Yes  ${dim('· run the command above')}`, value: 'yes' },
        { label: `Show details  ${dim('· what each package is + its impact')}`, value: 'details' },
        { label: 'No', value: 'no', dim: true },
      ]);
      if (choice === 'details') {
        for (const w of installable) {
          console.log(`    ${bold('•')} ${w.item}`);
          console.log(`      ${dim('package:')} ${w.autoInstall[pm.name]}`);
          console.log(`      ${dim('impact: ')} ${w.impact}`);
        }
        continue;
      }
      doInstall = choice === 'yes';
      break;
    }
  }

  if (doInstall) {
    console.log(`  ${dim('running:')} ${cmd}`);
    const result = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
    if (result.status === 0) {
      console.log(`${tag('ok')} system packages installed`);
    } else {
      console.log(`${tag('warn')} package install failed (exit ${result.status}). Continuing — re-run manually: ${cmd}`);
    }
    console.log('');
  } else {
    console.log(`  ${dim('skipped — re-run manually any time:')} ${cmd}`);
    console.log('');
  }
}

// Detect which OS package manager is available. Returns { name, cmd }
// where `name` is the key used in autoInstall maps and `cmd` is the
// install verb. Order matters — brew before apt (so a Linuxbrew install
// on Linux still picks apt for system tools, but macOS picks brew).
function detectPackageManager(platform) {
  if (platform === 'darwin') {
    if (onPath('brew')) return { name: 'brew', cmd: 'brew install' };
    return null;
  }
  if (onPath('apt-get')) return { name: 'apt', cmd: 'apt-get install -y' };
  if (onPath('dnf')) return { name: 'dnf', cmd: 'dnf install -y' };
  if (onPath('pacman')) return { name: 'pacman', cmd: 'pacman -S --noconfirm' };
  return null;
}

// Minimal synchronous prompt. Returns the user's typed line (without
// newline) or `defaultValue` if they hit Enter immediately. Used for
// the auto-install offer — small enough not to warrant a dep.

// `command -v <name>` returns 0 when the tool is on PATH. Quietly.
function onPath(name) {
  try {
    const { execSync } = require('node:child_process');
    execSync(`command -v ${name} >/dev/null 2>&1`, { shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

// Probe each workspace package's declared `dependencies` against the
// installed `node_modules/<dep>`. First missing dep → run `pnpm install`
// once, then proceed. Workspace-internal `workspace:*` deps are skipped
// (pnpm wires those via symlinks the install also creates). Only runs
// from a clone (detected via `pnpm-workspace.yaml`).
//
// Catches the failure shape where a PR adds an external dep but the
// next contributor hasn't re-run pnpm install yet — every per-host
// installer would then fail at tsc with TS2307 "Cannot find module".
// Skip with OPENCUES_SKIP_DEPS_GATE=1 for tight install-script iteration.
function ensureWorkspaceDeps(ctx) {
  if (process.env.OPENCUES_SKIP_DEPS_GATE === '1') return;
  const repoRoot = ctx.REPO_ROOT;
  if (!fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml'))) return;

  const packages = ['opencues-core', 'opencues-runtime', 'opencues-cli'];
  let stale = null;
  for (const pkg of packages) {
    const pkgJson = path.join(repoRoot, 'packages', pkg, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    let pj;
    try { pj = JSON.parse(fs.readFileSync(pkgJson, 'utf8')); } catch { continue; }
    const deps = pj.dependencies || {};
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) continue;
      const probe = path.join(repoRoot, 'packages', pkg, 'node_modules', name);
      if (!fs.existsSync(probe)) {
        stale = { pkg, missing: name };
        break;
      }
    }
    if (stale) break;
  }

  if (!stale) return;

  console.log('');
  console.log(`${tag('info')} workspace deps stale (packages/${stale.pkg}/node_modules/${stale.missing} missing) — running ${bold('pnpm install')}`);
  const r = spawnSync('pnpm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${tag('err')} pnpm install failed (exit ${r.status}) — fix workspace state and re-run`);
    process.exit(r.status ?? 1);
  }
  console.log('');
}

// Verify each declared native module loads. Today's only entry is
// `isolated-vm` (used by the user-blanks JS sandbox — INFOSEC F1, June
// 2026). When `pnpm install`'s postinstall hook drops back to
// `node-gyp rebuild` and that fails for lack of a C++ toolchain,
// pnpm's exit code can still report success but `require('isolated-vm')`
// throws ENOENT for the .node binding. Detect the failure mode here
// and print actionable platform-specific guidance instead of letting
// the per-host build die at TS2307 mid-stream.
function ensureNativeBindings(ctx) {
  if (process.env.OPENCUES_SKIP_NATIVE_PROBE === '1') return;
  const repoRoot = ctx.REPO_ROOT;
  const runtimeDir = path.join(repoRoot, 'packages/opencues-runtime');
  if (!fs.existsSync(path.join(runtimeDir, 'node_modules'))) return;

  const { createRequire } = require('node:module');
  const requireFromRuntime = createRequire(path.join(runtimeDir, 'package.json'));
  try {
    const ivm = requireFromRuntime('isolated-vm');
    if (!ivm || typeof ivm.Isolate !== 'function') {
      throw new Error('isolated-vm loaded but Isolate constructor missing');
    }
  } catch (err) {
    console.log('');
    console.error(`${tag('err')} native module ${bold('isolated-vm')} failed to load (${err.message})`);
    console.error('');
    console.error('   isolated-vm is a NATIVE C++ binding (required by the user-blanks');
    console.error('   sandbox — INFOSEC F1). pnpm tried prebuild-install for your');
    console.error('   platform; if no prebuilt binary matched, it fell back to compiling');
    console.error('   via node-gyp, which needs a working C++ toolchain.');
    console.error('');
    const platform = process.platform;
    if (platform === 'linux') {
      console.error('   On Debian/Ubuntu/WSL:');
      console.error('     sudo apt-get install build-essential python3');
    } else if (platform === 'darwin') {
      console.error('   On macOS:');
      console.error('     xcode-select --install   # installs Apple\'s clang toolchain');
    }
    console.error('   Then re-run:');
    console.error('     pnpm rebuild isolated-vm');
    console.error('     pnpm exec opencues install <host>');
    console.error('');
    console.error(`   ${dim('Skip this probe with OPENCUES_SKIP_NATIVE_PROBE=1 once you\'ve verified the binding loads from packages/opencues-runtime/.')}`);
    process.exit(1);
  }
}

function runHostInstaller(host, action, extraArgs, ctx) {
  const installer = path.join(ctx.REPO_ROOT, 'integrations', host, 'bin', 'install.cjs');
  if (!fs.existsSync(installer)) {
    console.error(`opencues install: installer not found for "${host}" (expected ${installer})`);
    return 1;
  }
  // PATH-prepend any vendored binaries we own (currently bun; tmux
  // when the prebuilt-binary scaffold lands). This is what makes the
  // "we just installed bun for you" path work without re-sourcing rc —
  // the per-host installer's `which bun` check finds our bun
  // immediately. Future vendored tools (tmux prebuild) plug in here.
  const env = vendoredPathEnv(process.env);
  const result = spawnSync('node', [installer, action, ...extraArgs], { stdio: 'inherit', env });
  return result.status ?? 1;
}

// Build an env where PATH has ~/.opencues/vendor/<tool>/bin/ prepended
// for every vendored tool that exists on disk. Safe to call when none
// exist — returns env unchanged.
function vendoredPathEnv(env) {
  const HOME = require('os').homedir();
  const vendorRoot = path.join(HOME, '.opencues', 'vendor');
  const extras = [];
  for (const tool of ['bun', 'tmux']) {
    const binDir = path.join(vendorRoot, tool, 'bin');
    if (fs.existsSync(binDir)) extras.push(binDir);
  }
  if (extras.length === 0) return env;
  return { ...env, PATH: extras.concat(env.PATH || '').join(path.delimiter) };
}

// `opencues install skill <name> [--project] [--target <path>] [--force] [--link]`
//
// Sources: defaults/skills/<name>/SKILL.md (canonical shipped version,
// promoted from tests/agentic/skills/ via scripts/release-skill.sh).
//
// Targets: writes to BOTH Claude Code's and opencode's skill directories
// when the parent install of either tool is detectable (so users with
// both tools get the skill in both; users with only one get it once).
//   Global (default): ~/.claude/skills/<name>/SKILL.md  +
//                     ~/.config/opencode/skills/<name>/SKILL.md
//   --project       : <cwd>/.claude/skills/<name>/SKILL.md +
//                     <cwd>/.config/opencode/skills/<name>/SKILL.md
//   --target <path> : explicit single-file override
//
// Won't overwrite an existing SKILL.md unless --force (avoids silently
// clobbering local tweaks).  --link symlinks instead of copying (for
// power users iterating on the skill from a repo clone).
function installSkill(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printSkillHelp();
  const os = require('node:os');

  let name = null;
  let mode = 'global'; // 'global' | 'project' | 'target'
  let explicitTarget = null;
  let force = false;
  let useLink = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') { mode = 'project'; continue; }
    if (a === '--global') { mode = 'global'; continue; }
    if (a === '--target') { mode = 'target'; explicitTarget = argv[++i]; continue; }
    if (a === '--force') { force = true; continue; }
    if (a === '--link') { useLink = true; continue; }
    if (!a.startsWith('-') && !name) { name = a; continue; }
    console.error(`opencues install skill: unknown arg "${a}"`);
    process.exit(2);
  }

  if (!name) {
    console.error('opencues install skill: missing <name>. Currently shipped: cues');
    console.error('Run `opencues install skill --help` for details.');
    process.exit(2);
  }

  const src = path.join(ctx.REPO_ROOT, 'defaults', 'skills', name, 'SKILL.md');
  if (!fs.existsSync(src)) {
    console.error(`opencues install skill: no such skill "${name}" (expected ${src})`);
    process.exit(2);
  }

  // Build the target list.
  let targets;
  if (mode === 'target') {
    targets = [{ path: explicitTarget, host: 'explicit' }];
  } else {
    const base = mode === 'project' ? process.cwd() : os.homedir();
    // Claude Code skills always go under .claude/skills/<name>/SKILL.md.
    const ccTarget = path.join(base, '.claude', 'skills', name, 'SKILL.md');
    // opencode skills go under .config/opencode/skills/<name>/SKILL.md
    // ONLY if the user has opencode installed (detected by the parent
    // directory existing). Without that, writing into a freshly-created
    // ~/.config/opencode/ would be confusing for users who don't run opencode.
    const ocBase = mode === 'project' ? path.join(base, '.config', 'opencode') : path.join(base, '.config', 'opencode');
    const ocTarget = path.join(ocBase, 'skills', name, 'SKILL.md');
    const ocExists = fs.existsSync(ocBase);
    targets = [{ path: ccTarget, host: 'claude-code' }];
    if (ocExists) targets.push({ path: ocTarget, host: 'opencode' });
  }

  let exitCode = 0;
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.path), { recursive: true });

    // Refuse to clobber an existing file unless --force.
    if (fs.existsSync(t.path) && !force) {
      const isSymlink = fs.lstatSync(t.path).isSymbolicLink();
      if (isSymlink && useLink) {
        // Re-pointing a symlink at the same source is fine — silently update.
        fs.unlinkSync(t.path);
      } else {
        console.log(`${tag('skip')} ${t.host}: ${t.path} already exists (use --force to overwrite)`);
        continue;
      }
    } else if (fs.existsSync(t.path) && force) {
      // Back up before overwriting.
      const backup = t.path + '.bak';
      fs.copyFileSync(t.path, backup);
      console.log(`${dim('backup → ' + backup)}`);
      fs.unlinkSync(t.path);
    }

    try {
      if (useLink) {
        fs.symlinkSync(src, t.path);
        console.log(`${tag('ok')} ${t.host}: linked ${t.path} → ${src}`);
      } else {
        fs.copyFileSync(src, t.path);
        console.log(`${tag('ok')} ${t.host}: ${t.path}`);
      }
    } catch (e) {
      console.error(`${tag('err')} ${t.host}: ${e.message}`);
      exitCode = 1;
    }
  }

  if (exitCode === 0 && targets.length > 0) {
    console.log('');
    console.log(`${dim('Restart Claude Code / opencode to pick up the skill.')}`);
  }
  process.exit(exitCode);
}

function printSkillHelp() {
  console.log('opencues install skill <name> [options]');
  console.log('');
  console.log('Install an OpenCues-shipped Claude skill into the host\'s skill directory.');
  console.log('Skills are prompt-text files that Claude Code / opencode auto-load on start.');
  console.log('');
  console.log('Currently shipped:');
  console.log('  cues          Ambient skill that writes .cues/CUES.md predicting next-turn vocabulary');
  console.log('');
  console.log('Locations:');
  console.log('  default (--global): ~/.claude/skills/<name>/SKILL.md');
  console.log('                      + ~/.config/opencode/skills/<name>/SKILL.md  (if opencode detected)');
  console.log('  --project         : <cwd>/.claude/skills/<name>/SKILL.md');
  console.log('                      + <cwd>/.config/opencode/skills/<name>/SKILL.md  (if opencode detected)');
  console.log('  --target <path>   : explicit single-file path');
  console.log('');
  console.log('Other flags:');
  console.log('  --force           Overwrite an existing SKILL.md (backs up to .bak first)');
  console.log('  --link            Symlink instead of copy (for dev iteration from a clone)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues install skill cues');
  console.log('  opencues install skill cues --project');
  console.log('  opencues install skill cues --force        # overwrite local tweaks');
}

// `opencues install plugin <name> [--target <path>] [--force]`
//
// Installs an OpenCues-shipped opencode plugin (TypeScript code that
// hooks an event in the opencode plugin system). Currently only the
// `cues` plugin ships — it hooks `chat.message` and writes
// .cues/CUES.md on every user submit (deterministic; doesn't depend on
// the chat model deciding to invoke a skill).
//
// Source: integrations/opencode/plugin/<name>.ts
// Default target: ~/.config/opencode/plugins/<name>.ts +
//   adds a "file://<absolute-path>" entry to ~/.config/opencode/config.json
//   under the `plugin: [...]` array.
function installPlugin(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printPluginHelp();
  const os = require('node:os');

  let name = null;
  let explicitTarget = null;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') { explicitTarget = argv[++i]; continue; }
    if (a === '--force') { force = true; continue; }
    if (!a.startsWith('-') && !name) { name = a; continue; }
    console.error(`opencues install plugin: unknown arg "${a}"`);
    process.exit(2);
  }

  if (!name) {
    console.error('opencues install plugin: missing <name>. Currently shipped: cues');
    process.exit(2);
  }

  const src = path.join(ctx.REPO_ROOT, 'integrations', 'opencode', 'plugin', `${name}.ts`);
  if (!fs.existsSync(src)) {
    console.error(`opencues install plugin: no such plugin "${name}" (expected ${src})`);
    process.exit(2);
  }

  const target = explicitTarget || path.join(os.homedir(), '.config', 'opencode', 'plugins', `${name}.ts`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target) && !force) {
    console.log(`${tag('skip')} ${target} already exists (use --force to overwrite)`);
  } else {
    if (fs.existsSync(target) && force) {
      const backup = target + '.bak';
      fs.copyFileSync(target, backup);
      console.log(`${dim('backup → ' + backup)}`);
    }
    fs.copyFileSync(src, target);
    console.log(`${tag('ok')} plugin file: ${target}`);
  }

  // Copy the prompt source alongside the plugin file. The cues plugin
  // (and any future plugin shipping a prompt) reads from <plugin-dir>/
  // <name>.SKILL.md. This makes the plugin self-contained — removing
  // the standalone skill via `opencues uninstall skill cues` doesn't
  // break the plugin's prompt source.
  const promptSrc = path.join(ctx.REPO_ROOT, 'defaults', 'skills', name, 'SKILL.md');
  if (fs.existsSync(promptSrc)) {
    const promptTarget = path.join(path.dirname(target), `${name}.SKILL.md`);
    fs.copyFileSync(promptSrc, promptTarget);
    console.log(`${tag('ok')} prompt source: ${promptTarget}`);
  }

  // Register the plugin in opencode's config.json so it loads on next launch.
  const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
  }
  if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
  const fileUrl = `file://${target}`;
  const already = cfg.plugin.some(p => (typeof p === 'string' ? p : p[0]) === fileUrl);
  if (already) {
    console.log(`${tag('skip')} plugin already registered in ${cfgPath}`);
  } else {
    cfg.plugin.push(fileUrl);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`${tag('ok')} registered in ${cfgPath}`);
  }

  console.log('');
  console.log(`${dim('Restart opencode to load the plugin.')}`);
  console.log(`${dim('Plugin fires on chat.message → writes <cwd>/.cues/CUES.md every turn.')}`);
  process.exit(0);
}

function printPluginHelp() {
  console.log('opencues install plugin <name> [options]');
  console.log('');
  console.log('Install an opencode plugin shipped with OpenCues.');
  console.log('Plugins hook opencode events (e.g. chat.message) deterministically — no LLM judgment.');
  console.log('');
  console.log('Currently shipped:');
  console.log('  cues          On chat.message: writes <cwd>/.cues/CUES.md using the cues prompt');
  console.log('');
  console.log('Default target: ~/.config/opencode/plugins/<name>.ts');
  console.log('Also registers the plugin in ~/.config/opencode/config.json under `plugin: [...]`.');
  console.log('');
  console.log('Flags:');
  console.log('  --target <path>   Override the install path');
  console.log('  --force           Overwrite existing plugin file (backs up to .bak)');
  console.log('');
  console.log('Example:');
  console.log('  opencues install plugin cues');
}

function printHelp(ctx) {
  console.log(`opencues install <host> [options]`);
  console.log('');
  console.log('Install a host integration. Each host has the same flags + behaviour as');
  console.log('its per-integration installer (see integrations/<host>/bin/install.cjs).');
  console.log('');
  console.log('Hosts:');
  console.log('  claude-code   Patches Claude Code\'s cli.js via tweakcc       (aliases: claudecode, claude, cc)');
  console.log('  opencode      Patches an OpenCode 1.4.x fork                 (alias: oc)');
  console.log('  chrome        Chrome MV3 extension');
  console.log('  gemini-cli    Patches a Gemini CLI 0.41.x fork               (aliases: geminicli, gemini)');
  console.log('  shell         Standalone Bun + OpenTUI shell wrapper        (aliases: term, terminal, oc-shell, oc-edit)');
  console.log('  --all         Install all five');
  console.log('');
  console.log('Special subcommands:');
  console.log('  skill <name>  Install a shipped Claude skill (see `opencues install skill --help`)');
  console.log('  plugin <name> Install an opencode plugin (see `opencues install plugin --help`)');
  console.log('');
  console.log('Common flags (passed through to the per-host installer):');
  console.log('  --target <path>   Host install path (cli.js for claude-code, fork dir for opencode/gemini-cli)');
  console.log('  --dry-run         Print plan, do not execute');
  console.log('  --clean           (claude-code) wipe install dir before reinstalling; (gemini-cli) accepted as no-op alias');
  console.log('  --no-build        (chrome only) skip build, use existing dist/');
  console.log('');
  console.log('Examples:');
  console.log('  opencues install claude-code');
  console.log('  opencues install claude-code --target ~/claude-code-cues/.../cli.js');
  console.log('  opencues install --all --dry-run');
  console.log('  opencues install skill cues');
}
