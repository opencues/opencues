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

// Print the brand banner + a host/command/cwd tree, then yield stdio
// to the spawned process. Output mirrors `seed-configs` / `install`
// styling so all CLI surfaces look like one product. The style module
// degrades to plain text when stdout isn't a TTY (NO_COLOR / pipes),
// so this is safe to always call.
//
// Banner is rendered into the **alt-screen buffer** (\x1b[?1049h) by
// default so it never touches the user's main-screen scrollback.
// clearScreenForHandoff exits alt-screen (\x1b[?1049l), restoring the
// main screen to its pre-banner state right before the host TUI takes
// over. The host then inherits a clean main screen and an empty
// scrollback above it — same pattern vim / less / htop / tmux use for
// transient full-screen UI that the user shouldn't be able to scroll
// back to.
//
// Pass `{ persistent: true }` for paths that do NOT spawn a host
// (chrome, which prints reload-the-extension instructions the user
// needs to act on AFTER `opencues run chrome` exits). Persistent
// banners go straight to the main screen — clearScreenForHandoff is a
// no-op for them because no spawn handoff is happening.
// Tracks whether we've entered alt-screen so the process-exit safety
// net below knows to restore main. Without this, a throw between
// printLaunchBanner and clearScreenForHandoff (or a future spawn path
// that forgets to call the latter) would leave the user's terminal
// stuck on an empty alt-screen — `reset` or terminal-close to recover.
let _enteredAltScreen = false;
process.on('exit', () => {
  if (_enteredAltScreen) {
    try { process.stdout.write('\x1b[?1049l'); } catch { /* terminal gone */ }
  }
});

function printLaunchBanner(ctx, host, rows, opts = {}) {
  const persistent = opts.persistent === true;
  if (!persistent && process.stdout.isTTY && process.env.OPENCUES_NO_CLEAR !== '1') {
    // Enter alt-screen and home the cursor in one write so the very
    // first thing the user sees in the alt buffer is our banner — no
    // flash of leftover content from before we started.
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
  console.log(style.dim('  Try: `[Your prompt] improve prompt _` (the runtime rewrites it inline)'));
  console.log(style.dim(`  Logs: tail -f /tmp/opencues.log${host ? ` | grep '\\[${shortPrefix(host)}\\]'` : ''}`));
  console.log(style.dim('  Stuck? Run `opencues doctor` in another shell'));
  console.log('');
}

// Map full host name → the short prefix used in /tmp/opencues.log so the
// printed `grep` filter actually matches the lines that host writes.
function shortPrefix(host) {
  return ({ 'claude-code': 'cc', 'opencode': 'oc', 'gemini-cli': 'gemini', 'shell': 'term' })[host] ?? host;
}

// Exit the alt-screen buffer we entered in printLaunchBanner, right
// before spawning the host. The terminal restores the main-screen
// contents that were there before \x1b[?1049h — so the host TUI
// inherits a clean main screen and the user's original prompt is
// what's underneath it.
//
// Timing: called *before* spawnSync, not after. The visibility window
// for the banner is whatever natural latency exists between the alt-
// screen enter (in printLaunchBanner) and the host's first render —
// in practice that's tree-render time + sync printing + the spawn
// syscall + the host's own boot (e.g. ~1s for opencode's bun startup,
// shorter for claude). The brief banner flash is enough for "yes, we
// started launching the right thing"; the host TUI is what the user
// reads from there on.
//
// Why this ordering instead of "exit alt-screen *after* spawn":
//   - It avoids nested alt-screen state. Hosts that call \x1b[?1049h
//     themselves (tmux, vim-style) inside our alt-screen would stack
//     two layers; older terminals don't handle that cleanly.
//   - It keeps the host's render in the normal main-screen + its-own-
//     alt-screen pattern it was designed for — no surprise that it's
//     rendering inside someone else's transient buffer.
//
// Gated on isTTY so piped runs (`opencues run cc | tee log`) don't
// have escape sequences smuggled into the captured output.
// OPENCUES_NO_CLEAR=1 opts out (keeps banner inline on main screen —
// useful for debugging or if the user's terminal mis-handles ?1049).
function clearScreenForHandoff() {
  if (process.env.OPENCUES_NO_CLEAR === '1') return;
  if (!process.stdout.isTTY) return;
  process.stdout.write('\x1b[?1049l');
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
  // Preferred binary: ~/claude-code-cues-150/.../bin/claude.exe — the
  // 2.1.150 native bun-compile install. That's the current default
  // pin (compat.json current-pin=2.1.150). Falls back to the older
  // cli.js install at ~/claude-code-cues/ for users still on 2.1.110.
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

  // 2.1.150 native bun-binary (the new default).
  const native150 = path.join(os.homedir(), 'claude-code-cues-150', 'node_modules',
    '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (fs.existsSync(native150)) {
    printLaunchBanner(ctx, 'claude-code', [
      ['host',    'claude-code  ' + style.dim('(patched, native 2.1.150)')],
      ['command', `claude.exe ${passthrough.join(' ')}`.trim()],
      ['fork',    style.fileLink(native150, native150)],
    ]);
    clearScreenForHandoff();
    const result = spawnSync(native150, passthrough, { stdio: 'inherit' });
    exitFromSpawn(result, native150);
    return;
  }

  // 2.1.110 cli.js (legacy fork, kept for users who haven't migrated).
  const patchedCli = path.join(os.homedir(), 'claude-code-cues', 'node_modules',
    '@anthropic-ai', 'claude-code', 'cli.js');
  if (fs.existsSync(patchedCli)) {
    printLaunchBanner(ctx, 'claude-code', [
      ['host',    'claude-code  ' + style.dim('(patched, cli.js 2.1.110)')],
      ['command', `node cli.js ${passthrough.join(' ')}`.trim()],
      ['fork',    style.fileLink(patchedCli, patchedCli)],
    ]);
    clearScreenForHandoff();
    const result = spawnSync('node', [patchedCli, ...passthrough], { stdio: 'inherit' });
    exitFromSpawn(result, patchedCli);
    return;
  }

  // Fallback: PATH-based lookup. `claude-cues` shell alias won't
  // resolve via `which` — only a real binary on PATH works.
  console.warn(`${style.tag('warn')} patched install not found at ~/claude-code-cues-150 or ~/claude-code-cues`);
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
  console.log('');
  console.log('Examples:');
  console.log('  opencues run claude-code');
  console.log('  opencues run claude-code --continue              # forwarded to claude');
  console.log('  opencues run claude-code --resume <id> --print   # forwarded to claude');
  console.log('  opencues run claude --bin claude-cues');
  console.log('  opencues run opencode');
  console.log('  opencues run opencode --target /custom/fork      # --target is ours');
  console.log('  opencues run gemini-cli --model gemini-2.5-pro   # forwarded to gemini');
  console.log('');
  console.log('Env vars:');
  console.log('  OPENCUES_NO_CLEAR=1   keep the launch banner visible (skip screen clear)');
}
