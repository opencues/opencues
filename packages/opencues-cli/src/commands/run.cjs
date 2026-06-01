// `opencues run <host>` — launch the patched host with sensible defaults.
//
// claude-code: exec the patched binary (claude-cues if present, else claude)
// opencode:    cd into fork dir + bun run dev
// chrome:      no-op + remind the user to load unpacked at chrome://extensions
// gemini-cli:  node packages/cli/dist/index.js inside ~/gemini-cli-cues fork

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const style = require('../lib/style.cjs');

// Print the brand banner + a host/command/cwd tree + a one-line
// keybinding hint, then yield stdio to the spawned process. Output
// mirrors `seed-configs` / `install` styling so all CLI surfaces look
// like one product. The style module degrades to plain text when
// stdout isn't a TTY (NO_COLOR / pipes), so this is safe to always
// call.
//
// Default (persistent mode): banner is printed on the **main screen**
// so it persists in the terminal scrollback after the host TUI takes
// over. Hosts like CC / opencode / gemini-cli enter their own alt-
// screens for the duration of the session; when the user exits the
// host, the terminal restores the main screen with our banner still
// right above the shell prompt — a scroll-up-able reference for the
// keys + try-this prompt + log path + doctor pointer.
//
// `--skip-banner` flips into the legacy **alt-screen** behaviour: the
// banner is shown inside the alt-screen buffer (\x1b[?1049h),
// guaranteed visible for >= MIN_BANNER_DWELL_MS, then the alt-screen
// is exited (\x1b[?1049l) right before spawn handoff — restoring the
// pre-run scrollback so the banner is NEVER left in history. Useful
// for piped runs / scripted automation / repeat-launchers where the
// banner is just noise. "Skip" here means "skip leaving it in
// scrollback", not "skip showing it" — the 1s minimum dwell makes
// the keybinding hint actually readable on the way past.
//
// Pass `{ persistent: true }` for paths that do NOT spawn a host
// (chrome, which prints reload-the-extension instructions the user
// needs to act on AFTER `opencues run chrome` exits). Persistent +
// non-skip both end up on main screen; the option is kept as an
// explicit marker for the no-spawn paths.

// Minimum visible duration for the alt-screen `--skip-banner` mode.
// The pre-2026-05 flash was sub-100ms in practice (spawnSync to host
// boot is fast on warm caches), too short to read the keys line. 1s
// is the floor; the actual visibility window is max(1s, host-boot-
// time). Bigger numbers feel laggy on every launch.
const MIN_BANNER_DWELL_MS = 1000;

let _skipBanner = false;
let _bannerPrintedAt = 0;
let _enteredAltScreen = false;

// Process-exit safety net: if a throw escapes between alt-screen
// entry (in printLaunchBanner) and clearScreenForHandoff, the user's
// terminal would otherwise be stuck on an empty alt-screen — `reset`
// or terminal-close to recover. The check is cheap enough to always
// run.
process.on('exit', () => {
  if (_enteredAltScreen) {
    try { process.stdout.write('\x1b[?1049l'); } catch { /* terminal gone */ }
  }
});

function printLaunchBanner(ctx, host, rows, opts = {}) {
  const persistent = opts.persistent === true;
  // Alt-screen path is gated on (a) the user opted in with
  // --skip-banner, (b) we have a real TTY (piped output would smuggle
  // \x1b sequences into the captured stream), and (c) this isn't a
  // no-spawn / persistent path. OPENCUES_NO_CLEAR=1 stays as a back-
  // compat opt-out — same semantics as the new default now that the
  // default is "main screen".
  const useAltScreen = _skipBanner
    && !persistent
    && process.stdout.isTTY
    && process.env.OPENCUES_NO_CLEAR !== '1';
  if (useAltScreen) {
    // Enter alt-screen and home the cursor in one write so the first
    // thing the user sees in the alt buffer is our banner — no flash
    // of leftover content from before we started.
    process.stdout.write('\x1b[?1049h\x1b[H');
    _enteredAltScreen = true;
  }
  console.log(style.banner({
    version: style.cliVersion(ctx),
    tagline: `launching ${host}`,
  }));
  console.log('');
  console.log(style.tree({ rows }));
  console.log('');
  // Proof-of-life pointer for first-time users: the host TUI is about
  // to take over stdio, after which OpenCues activity is only visible
  // via the statusline + /tmp/opencues.log. Tell the user where to
  // look BEFORE that handoff so silent-failure looks like silent-
  // failure instead of "I guess it just doesn't do anything".
  //
  // The Keys line is the first hint because muscle memory is what
  // people forget — they remember `_` triggers blanks but not the
  // navigation combo, especially on a mac terminal where the default
  // ctrl+alt+arrow is stripped by Apple's Terminal.app.
  const combo = pickNavCombo(host);
  console.log(style.dim(`  Keys: ${combo}+←/→ navigate · ${combo}+↑/↓ cycle · \`<request> _\` to fire a blank`));
  console.log(style.dim('  Try:  `improve prompt _`  (after typing some text — the runtime rewrites it inline)'));
  console.log(style.dim(`  Logs: tail -f /tmp/opencues.log${host ? ` | grep '\\[${shortPrefix(host)}\\]'` : ''}`));
  console.log(style.dim('  Stuck? Run `opencues doctor` in another shell'));
  console.log('');
  _bannerPrintedAt = Date.now();
}

// Pick the navigation modifier combo to display in the banner's Keys
// line. Mirrors the runtime's `resolveNavKeymap(configured, hostName)`
// in `@opencues/runtime/src/modules/nav-keymap.ts` — kept inline here
// so the CLI doesn't need to load the runtime build to print one
// hint line. Drift risk is low: this only decides what STRING to
// print; the actual key dispatch is owned by the runtime, which has
// its own (canonical) resolver.
//
//   - chrome: always Ctrl+Alt — the browser owns Ctrl+Shift+arrow
//     for "extend text selection by word" and the runtime hard-pins
//     chrome to ctrl-alt regardless of the user's OPENCUES.md scalar.
//   - macOS Terminal.app (TERM_PROGRAM=Apple_Terminal): Ctrl+Shift
//     — Apple's Terminal.app strips Ctrl+Alt+arrow before the running
//     app sees it, so the runtime auto-switches and so does this hint.
//   - Everything else: Ctrl+Alt.
//
// Does NOT read the user's explicit `nav-keymap: ctrl-alt|ctrl-shift`
// override in ~/.cues/OPENCUES.md — the banner is informational and
// the auto-default covers ~every shipped setup. If we ever need to
// honour explicit overrides here, a 5-line regex grep against the
// file is enough; no need to import the full ConfigLoader.
function pickNavCombo(host) {
  if (host === 'chrome') return 'Ctrl+Alt';
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'Ctrl+Shift';
  return 'Ctrl+Alt';
}

// Synchronous sleep for the dwell window. Atomics.wait blocks the
// event loop without busy-waiting and without depending on /bin/sleep.
// The buffer + array are throwaway; we never set a value to wake on,
// so the wait runs to timeout.
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    // SharedArrayBuffer disabled in some hardened-Node profiles;
    // fall through with no sleep. Banner just appears briefly as it
    // did pre-2026-05 — acceptable degradation, not a fail.
  }
}

// Pick the navigation modifier combo to display in the banner's Keys
// line. Mirrors the runtime's `resolveNavKeymap(configured, hostName)`
// in `@opencues/runtime/src/modules/nav-keymap.ts` — kept inline here
// so the CLI doesn't need to load the runtime build to print one
// hint line. Drift risk is low: this only decides what STRING to
// print; the actual key dispatch is owned by the runtime, which has
// its own (canonical) resolver.
//
//   - chrome: always Ctrl+Alt — the browser owns Ctrl+Shift+arrow
//     for "extend text selection by word" and the runtime hard-pins
//     chrome to ctrl-alt regardless of the user's OPENCUES.md scalar.
//   - macOS Terminal.app (TERM_PROGRAM=Apple_Terminal): Ctrl+Shift
//     — Apple's Terminal.app strips Ctrl+Alt+arrow before the running
//     app sees it, so the runtime auto-switches and so does this hint.
//   - Everything else: Ctrl+Alt.
//
// Does NOT read the user's explicit `nav-keymap: ctrl-alt|ctrl-shift`
// override in ~/.cues/OPENCUES.md — the banner is informational and
// the auto-default covers ~every shipped setup. If we ever need to
// honour explicit overrides here, a 5-line regex grep against the
// file is enough; no need to import the full ConfigLoader.
function pickNavCombo(host) {
  if (host === 'chrome') return 'Ctrl+Alt';
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'Ctrl+Shift';
  return 'Ctrl+Alt';
}

// Map full host name → the short prefix used in /tmp/opencues.log so the
// printed `grep` filter actually matches the lines that host writes.
function shortPrefix(host) {
  return ({ 'claude-code': 'cc', 'opencode': 'oc', 'gemini-cli': 'gemini', 'shell': 'term' })[host] ?? host;
}

// Exit the alt-screen buffer (if we entered one in printLaunchBanner)
// right before spawning the host. The terminal restores whatever was
// on the main screen pre-banner — so the host TUI inherits a clean
// main screen and the user's original prompt is what's underneath it.
//
// Default mode (no alt-screen entered): this is a no-op. The banner
// was printed inline on the main screen, host TUI takes over the
// visible area for its session, and when the user exits the host the
// terminal restores the main screen with the banner still in
// scrollback. Nothing to clean up.
//
// --skip-banner mode (alt-screen entered): wait until the banner has
// been visible for at least MIN_BANNER_DWELL_MS (the keybinding hint
// is unreadable otherwise — the original "flash" before this change
// was sub-100ms on warm host launches), then exit the alt-screen.
// The sleep is synchronous because spawnSync below is synchronous;
// `Atomics.wait` blocks without busy-waiting.
//
// Why ordering "exit alt-screen *before* spawn" (not after):
//   - It avoids nested alt-screen state. Hosts that call \x1b[?1049h
//     themselves (CC, opencode, gemini, tmux) inside our alt-screen
//     would stack two layers; older terminals don't unwind cleanly.
//   - It keeps the host's render in the normal main-screen + its-own-
//     alt-screen pattern it was designed for — no surprise that it's
//     rendering inside someone else's transient buffer.
function clearScreenForHandoff() {
  if (!_enteredAltScreen) return;
  const elapsed = Date.now() - _bannerPrintedAt;
  const remaining = MIN_BANNER_DWELL_MS - elapsed;
  sleepSync(remaining);
  if (process.stdout.isTTY) process.stdout.write('\x1b[?1049l');
  _enteredAltScreen = false;
}

// Host name resolution — sourced from @opencues/core.
function loadHostResolver(ctx) {
  try {
    const core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/host-compat.js'));
    return { HOSTS: core.HOSTS.slice().sort(), resolve: core.resolveHost };
  } catch {
    return {
      HOSTS: ['chrome', 'claude-code', 'gemini-cli', 'opencode', 'shell'],
      resolve: (n) => ({
        'claude-code': 'claude-code', 'claudecode': 'claude-code', 'claude': 'claude-code', 'cc': 'claude-code',
        'opencode': 'opencode', 'oc': 'opencode',
        'chrome': 'chrome',
        'gemini-cli': 'gemini-cli', 'geminicli': 'gemini-cli', 'gemini': 'gemini-cli',
        'shell': 'shell', 'term': 'shell', 'oc-edit': 'shell',
      })[n?.toLowerCase?.()] ?? null,
    };
  }
}

module.exports = function run(argv, ctx) {
  // --help / -h is intercepted ONLY when it appears before the host
  // name (or there is no host). Once a host has been named, every
  // remaining flag — including --help, --version, --continue, --resume,
  // --print, --model, etc. — is forwarded to the spawned binary so
  // `opencues run claude-code --help` shows claude's help, not ours.
  // This is the curl/git/sudo pattern: the wrapper owns its own flags
  // until a positional appears, then it's a pure passthrough.
  const firstPosIdx = argv.findIndex(a => !a.startsWith('-'));
  const helpIdx = argv.findIndex(a => a === '--help' || a === '-h');
  if (helpIdx >= 0 && (firstPosIdx < 0 || helpIdx < firstPosIdx)) return printHelp();

  const { HOSTS, resolve } = loadHostResolver(ctx);

  let target = null;
  const passthrough = [];
  for (const a of argv) {
    if (a === '--skip-banner') {
      // opencues-owned flag — consumed here, NOT forwarded to the
      // spawned host. Flips printLaunchBanner into alt-screen mode
      // (banner shown for >= MIN_BANNER_DWELL_MS, then wiped on
      // handoff so it doesn't pollute scrollback).
      _skipBanner = true;
      continue;
    }
    if (!a.startsWith('-') && !target) target = a;
    else passthrough.push(a);
  }

  if (!target) {
    console.error(`opencues run: missing <host>. One of: ${HOSTS.join(', ')}`);
    console.error('Run `opencues run --help` for details.\n');
    process.exit(2);
  }

  const folder = resolve(target);
  if (!folder) {
    console.error(`opencues run: unknown host "${target}". Known: ${HOSTS.join(', ')}`);
    process.exit(2);
  }

  // Cached-only update notice — never blocks the launch. If the cache
  // is empty or stale, the notice waits for the next `install`/`doctor`
  // to refresh it. The point on `run` is just to surface what we
  // already know, not to introduce latency before the integration spawns.
  printCachedUpdateNotice(ctx);

  if (folder === 'claude-code') return runCC(passthrough, ctx);
  if (folder === 'opencode')    return runOC(passthrough, argv, ctx);
  if (folder === 'chrome') return runChrome(ctx);
  if (folder === 'gemini-cli') return runGemini(passthrough, argv, ctx);
  if (folder === 'shell') return runShell(passthrough, ctx);
};

function printCachedUpdateNotice(ctx) {
  try {
    const { getCachedNotice, formatNotice } = require('../lib/update-check.cjs');
    const { tag, cliVersion } = require('../lib/style.cjs');
    const notice = getCachedNotice(cliVersion(ctx));
    const msg = formatNotice(notice);
    if (msg) console.log(`${tag('info')} ${msg}`);
  } catch { /* fail-silent */ }
}

function runCC(passthrough, ctx) {
  // SINGLE canonical fork at ~/claude-code-cues/. Auto-detect whichever
  // shape (cli.js or native binary) the pinned CC version ships in.
  // Upgrading the version happens via `opencues update claude-code
  // --to <ver>` in this same fork — no parallel fork dirs.
  //
  // --bin always wins for explicit overrides.
  const binFlag = passthrough.indexOf('--bin');
  if (binFlag >= 0 && passthrough[binFlag + 1]) {
    const explicit = passthrough[binFlag + 1];
    passthrough.splice(binFlag, 2);
    printLaunchBanner(ctx, 'claude-code', [
      ['host',    'claude-code  ' + style.dim('(--bin override)')],
      ['command', `${explicit} ${passthrough.join(' ')}`.trim()],
    ]);
    clearScreenForHandoff();
    exitFromSpawn(spawnSync(explicit, passthrough, { stdio: 'inherit' }), explicit);
    return;
  }

  const forkRoot = path.join(os.homedir(), 'claude-code-cues');
  const nativeBin = path.join(forkRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const cliJs    = path.join(forkRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

  // Native binary wins when present — that's CC 2.1.113+ (current).
  if (fs.existsSync(nativeBin)) {
    printLaunchBanner(ctx, 'claude-code', [
      ['host',    'claude-code  ' + style.dim('(patched, native binary)')],
      ['command', `claude.exe ${passthrough.join(' ')}`.trim()],
      ['fork',    style.fileLink(nativeBin, nativeBin)],
    ]);
    clearScreenForHandoff();
    const result = spawnSync(nativeBin, passthrough, { stdio: 'inherit' });
    exitFromSpawn(result, nativeBin);
    return;
  }

  // cli.js shape — CC ≤ 2.1.111.
  if (fs.existsSync(cliJs)) {
    printLaunchBanner(ctx, 'claude-code', [
      ['host',    'claude-code  ' + style.dim('(patched, cli.js)')],
      ['command', `node cli.js ${passthrough.join(' ')}`.trim()],
      ['fork',    style.fileLink(cliJs, cliJs)],
    ]);
    clearScreenForHandoff();
    const result = spawnSync('node', [cliJs, ...passthrough], { stdio: 'inherit' });
    exitFromSpawn(result, cliJs);
    return;
  }

  // Fallback: PATH-based lookup. `claude-cues` shell alias won't
  // resolve via `which` — only a real binary on PATH works.
  console.warn(`${style.tag('warn')} patched install not found at ${forkRoot}/`);
  console.warn(`     Install with: ${style.bold('opencues install claude-code')}`);
  console.warn(`     Falling back to PATH lookup (likely UNPATCHED — cues will not work):`);
  for (const c of ['claude-cues', 'claude']) {
    const which = spawnSync('which', [c], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (which.status === 0) {
      const resolved = which.stdout.toString().trim();
      printLaunchBanner(ctx, 'claude-code', [
        ['host',    'claude-code  ' + style.yellow('(unpatched fallback)')],
        ['command', `${resolved} ${passthrough.join(' ')}`.trim()],
      ]);
      clearScreenForHandoff();
      exitFromSpawn(spawnSync(resolved, passthrough, { stdio: 'inherit' }), resolved);
      return;
    }
  }
  console.error(`${style.tag('err')} no binary found`);
  process.exit(127);
}

function runOC(passthrough, fullArgv, ctx) {
  const targetIdx = fullArgv.indexOf('--target');
  const fork = (targetIdx >= 0 && fullArgv[targetIdx + 1])
    || process.env.OPENCODE_CUES_DIR
    || path.join(os.homedir(), 'opencode-cues');

  if (!fs.existsSync(path.join(fork, 'packages', 'opencode'))) {
    console.error(`${style.tag('err')} ${fork} doesn't look like an opencode checkout.`);
    console.error(`     Install first: ${style.bold('opencues install opencode')}`);
    console.error('     Or pass --target /path/to/your/opencode-fork');
    process.exit(1);
  }

  // bun is required to launch the dev server. Pre-flight so the user
  // gets a clear error rather than the spawn silently failing later.
  const bunCheck = spawnSync('which', ['bun'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (bunCheck.status !== 0) {
    console.error(`${style.tag('err')} bun is not on PATH`);
    console.error(`     Install bun first: ${style.link('https://bun.sh/', 'https://bun.sh/')}`);
    console.error(`     Then re-run: opencues run opencode${targetIdx >= 0 ? ` --target ${fork}` : ''}`);
    process.exit(127);
  }

  // Drop --target if it was passed; it's ours, not bun's.
  const cleaned = passthrough.filter((a, i, arr) => a !== '--target' && arr[i - 1] !== '--target');

  // Forward the caller's cwd as opencode's --project. Without this,
  // bun's --cwd in the fork's `dev` script discards the user's
  // working directory and opencode starts inside ~/opencode-cues/
  // packages/opencode/ — never the project they typed `opencues run
  // opencode` from. We append rather than prepend so a user-supplied
  // --project (last-one-wins on opencode's CLI parser) still overrides.
  const userCwd = process.cwd();
  const hasUserProject = cleaned.some((a, i, arr) => a === '--project' || a.startsWith('--project='));
  const projectArgs = hasUserProject ? [] : ['--project', userCwd];

  // Force the DB path to ~/.local/share/opencode/opencode.db. Without
  // this, OpenCode's channel-aware path resolver writes to
  // opencode-local.db (because Installation.isLocal() is true for our
  // dev checkout), but its migration marker check in src/index.ts is
  // hard-coded to opencode.db — they never match, so the "one time"
  // migration runs on EVERY launch. Setting OPENCODE_DISABLE_CHANNEL_DB
  // collapses both paths onto opencode.db and the marker check works.
  // See packages/opencode/src/storage/db.ts:30 (getChannelPath).
  const env = { ...process.env, OPENCODE_DISABLE_CHANNEL_DB: '1' };

  printLaunchBanner(ctx, 'opencode', [
    ['host',    'opencode  ' + style.dim('(patched fork)')],
    ['command', `bun run dev ${[...projectArgs, ...cleaned].join(' ')}`.trim()],
    ['cwd',     style.fileLink(userCwd, userCwd)],
  ]);
  clearScreenForHandoff();
  // --silent suppresses bun's `$ bun run --cwd ... src/index.ts` echo
  // — we already printed the command above; the echo is just noise.
  const result = spawnSync('bun', ['run', '--silent', 'dev', ...projectArgs, ...cleaned], { cwd: fork, stdio: 'inherit', env });
  exitFromSpawn(result, 'bun');
}

// Translate a spawnSync result into a process exit. spawnSync sets
// `error` (and `status === null`) when the child can't be launched at
// all (ENOENT, EACCES, …). The previous `process.exit(status ?? 0)`
// pattern silently exited 0 in those cases, which let "bun missing" /
// "binary unfindable" failures look like clean runs.
function exitFromSpawn(result, what) {
  if (result.error) {
    console.error(`opencues run: failed to launch ${what}: ${result.error.message}`);
    process.exit(127);
  }
  process.exit(result.status ?? 0);
}

function runGemini(passthrough, fullArgv, ctx) {
  const targetIdx = fullArgv.indexOf('--target');
  const fork = (targetIdx >= 0 && fullArgv[targetIdx + 1])
    || process.env.GEMINI_CLI_CUES_DIR
    || path.join(os.homedir(), 'gemini-cli-cues');

  if (!fs.existsSync(path.join(fork, 'packages', 'cli'))) {
    console.error(`${style.tag('err')} ${fork} doesn't look like a gemini-cli checkout.`);
    console.error(`     Install first: ${style.bold('opencues install gemini-cli')}`);
    console.error('     Or pass --target /path/to/your/gemini-cli-fork');
    process.exit(1);
  }

  const builtCli = path.join(fork, 'packages', 'cli', 'dist', 'index.js');
  if (!fs.existsSync(builtCli)) {
    console.error(`${style.tag('err')} built CLI not found at ${builtCli}`);
    console.error(`     Run setup again: ${style.bold('opencues install gemini-cli')}`);
    process.exit(1);
  }

  // Drop --target if it was passed; it's ours, not gemini's.
  const cleaned = passthrough.filter((a, i, arr) => a !== '--target' && arr[i - 1] !== '--target');

  // Launch from the user's cwd, not the fork dir. The fork ships its
  // own .gemini/settings.json (devtools + experimental flags) which
  // Gemini picks up cwd-locally and renders the input box with a
  // blue background. Running from the user's cwd uses their own
  // settings.json (or none).
  printLaunchBanner(ctx, 'gemini-cli', [
    ['host',    'gemini-cli  ' + style.dim('(patched fork)')],
    ['command', `node packages/cli/dist/index.js ${cleaned.join(' ')}`.trim()],
    ['fork',    style.fileLink(fork, fork)],
    ['cwd',     style.fileLink(process.cwd(), process.cwd())],
  ]);
  clearScreenForHandoff();
  const result = spawnSync('node', [builtCli, ...cleaned], { stdio: 'inherit' });
  exitFromSpawn(result, 'node');
}

function runShell(passthrough, ctx) {
  // `opencues run shell` launches `bin/oc-shell` — the bash script
  // that wraps the user's $SHELL in a private tmux session and
  // exposes the OpenCues input box on Alt+Shift+↑. NOT `oc-edit`
  // (the internal Bun host that oc-shell lazy-spawns inside the
  // tmux pane on activation — running it standalone via bun would
  // try to read its bash-script bin/ shim as JS and error).
  const ocShell = path.join(ctx.REPO_ROOT, 'integrations', 'shell', 'bin', 'oc-shell');
  if (!fs.existsSync(ocShell)) {
    console.error(`${style.tag('err')} oc-shell not found at ${ocShell}`);
    console.error(`     Install first: ${style.bold('opencues install shell')}`);
    process.exit(1);
  }
  printLaunchBanner(ctx, 'shell', [
    ['host', 'shell  ' + style.dim('(standalone Bun + OpenTUI shell wrapper — slide-pane input box)')],
    ['command', `oc-shell ${passthrough.join(' ')}`.trim()],
    ['bin', style.fileLink(ocShell, ocShell)],
  ]);
  clearScreenForHandoff();
  // oc-shell handles its own prereq checks (vendored tmux at
  // ~/.opencues/vendor/tmux/, bun availability) and prints actionable
  // errors if anything's missing. Pass OPENCUES_USER_CWD so the
  // runtime knows where the user actually invoked from — the script
  // itself cds into integrations/shell/ for bunfig discovery.
  const env = { ...process.env, OPENCUES_USER_CWD: process.cwd() };
  const result = spawnSync(ocShell, passthrough, { stdio: 'inherit', env });
  exitFromSpawn(result, 'oc-shell');
}

function runChrome(ctx) {
  // Chrome's `run` doesn't spawn anything — we print instructions for
  // the user to load the unpacked extension in their browser. Use the
  // persistent banner mode so the banner + instructions stay visible
  // on the main screen after `opencues run chrome` exits (alt-screen
  // would yank them the moment we return to the shell).
  printLaunchBanner(ctx, 'chrome', [
    ['host', 'chrome  ' + style.dim('(extensions are loaded by chrome itself)')],
  ], { persistent: true });
  console.log(style.bold('Load the extension in chrome://extensions:'));
  console.log('');
  console.log(`  ${style.dim('1.')} Open ${style.cyan('chrome://extensions')}`);
  console.log(`  ${style.dim('2.')} Enable ${style.bold('Developer mode')}`);
  console.log(`  ${style.dim('3.')} Click ${style.bold('Load unpacked')}`);
  console.log(`  ${style.dim('4.')} Select the path printed by ${style.bold('opencues install chrome')}`);
  console.log('');
  console.log(style.dim('If already loaded, reload the page you want OpenCues active on.'));
}

function printHelp() {
  console.log('opencues run <host> [opencues-flags] [-- host-flags]');
  console.log('');
  console.log('Launch the patched host integration. Any flag that follows the host');
  console.log('name (and isn\'t one of the opencues-owned flags below) is forwarded');
  console.log('to the spawned binary — so `opencues run claude-code --continue` runs');
  console.log('`claude --continue`, `opencues run claude-code --help` shows claude\'s');
  console.log('help (not ours), etc. To see opencues\'s help, put --help before the');
  console.log('host name: `opencues run --help`.');
  console.log('');
  console.log('Hosts:');
  console.log('  claude-code   exec the patched CC binary (claude-cues or claude)');
  console.log('  opencode      cd into the fork dir + bun run dev');
  console.log('  chrome        print Chrome reload instructions (no programmatic launch)');
  console.log('  gemini-cli    node packages/cli/dist/index.js inside the fork (default: $HOME/gemini-cli-cues)');
  console.log('  shell         integrations/shell/bin/oc-shell  (wraps $SHELL in tmux; Alt+Shift+↑ for the input box)');
  console.log('');
  console.log('Opencues-owned flags (consumed by `opencues run`, NOT forwarded):');
  console.log('  --bin <name>      (claude-code only) override which binary to exec');
  console.log('  --target <path>   (opencode/gemini-cli) fork dir (defaults: $HOME/opencode-cues, $HOME/gemini-cli-cues)');
  console.log('  --skip-banner     show the launch banner in alt-screen for ~1s, then wipe — keeps scrollback clean');
  console.log('');
  console.log('Examples:');
  console.log('  opencues run claude-code');
  console.log('  opencues run claude-code --continue              # forwarded to claude');
  console.log('  opencues run claude-code --resume <id> --print   # forwarded to claude');
  console.log('  opencues run claude --bin claude-cues');
  console.log('  opencues run opencode');
  console.log('  opencues run opencode --target /custom/fork      # --target is ours');
  console.log('  opencues run gemini-cli --model gemini-2.5-pro   # forwarded to gemini');
  console.log('  opencues run claude-code --skip-banner           # transient banner instead of persistent');
  console.log('');
  console.log('Banner behaviour:');
  console.log('  Default: banner with key hints prints on the main screen and persists');
  console.log('           in scrollback after you exit the host TUI — a scroll-up-able');
  console.log('           reference for the navigation combo + log path.');
  console.log('  --skip-banner: banner shows in alt-screen for ~1s, then is wiped before');
  console.log('           the host starts. Useful for scripted launches.');
  console.log('');
  console.log('Env vars:');
  console.log('  OPENCUES_NO_CLEAR=1   (back-compat) force the default behaviour even when --skip-banner is set');
}
