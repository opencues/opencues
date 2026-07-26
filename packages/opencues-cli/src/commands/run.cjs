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
const prompt = require('../lib/prompt.cjs');
const { pickHost } = require('../lib/pick-host.cjs');
const { pickNavCombo } = require('../lib/nav-combo.cjs');

// Print the brand banner + a host/command/cwd tree + a one-line
// keybinding hint, then yield stdio to the spawned process. Output
// mirrors `seed-configs` / `install` styling so all CLI surfaces look
// like one product. The style module degrades to plain text when
// stdout isn't a TTY (NO_COLOR / pipes), so this is safe to always
// call.
//
// Default: banner is rendered in the **alt-screen buffer**
// (\x1b[?1049h), held visible for BANNER_DWELL_MS, then the alt-
// screen is exited (\x1b[?1049l) right before spawn handoff —
// restoring whatever main-screen content was there pre-run. The
// banner is NEVER left in scrollback. This is a deliberate trade-
// off: the persistent-scrollback experiment didn't survive contact
// with fast-boot hosts (shell via tmux is sub-100ms, opencode is
// 200-500ms warm) — by the time users wanted to scroll up to see
// the Keys line it was buried under a long host session.
//
// `--skip-banner` short-circuits the print entirely. Useful for
// scripted launches / repeat-runners where the banner is noise.
//
// `{ persistent: true }` is passed by no-spawn paths (chrome —
// prints reload-the-extension instructions the user needs to keep
// reading AFTER `opencues run chrome` exits). Persistent mode
// skips the alt-screen path; the banner + instructions stay on the
// main screen because there's no host handoff to coordinate with.

// Visible duration before clear-on-handoff. Long enough for the
// Keys line to be readable; short enough that repeat launches don't
// feel laggy. Tuning history: 1000ms → 2000ms → 3000ms. The banner
// has no scrollback fallback (we wipe it before handing off to the
// host), so this dwell is the only chance the user has to read it.
// Power users on repeat launches use `--skip-banner` to opt out
// entirely instead of begrudging an extra second per launch.
const BANNER_DWELL_MS = 3000;

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
  if (_skipBanner) return;
  const persistent = opts.persistent === true;
  // Alt-screen path is the default for every spawn-and-handoff host.
  // Gates:
  //   (a) NOT a no-spawn / persistent path (chrome stays main-screen
  //       because the user needs to keep reading after run exits).
  //   (b) Real TTY — piped output would smuggle \x1b sequences into
  //       the captured stream.
  //   (c) OPENCUES_NO_CLEAR=1 stays as a back-compat opt-out — power
  //       users who want the banner on main-screen (no dwell, no
  //       clear) can still set the env var.
  const useAltScreen = !persistent
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
  // Keys tree — "Keys" sits at column 0 as the section header, with
  // ├─/└─ branches hanging directly beneath it (one shortcut per
  // row). Hand-rendered rather than using style.tree's title mode
  // because that adds an intermediate `│` connector + extra spacing
  // from the label column that this section doesn't want.
  //
  // Only the actionable tokens (keystrokes + `<request> _`) are bold;
  // the trailing description prose is dim so the eye is drawn first
  // to the bits the user has to type. Token-pad width is computed
  // dynamically because `combo` varies by host (Ctrl+Alt vs
  // Ctrl+Shift — 8 vs 10 chars).
  // No-cycling hosts (universal profile — apple-notes) have no key
  // channel at all: printing Ctrl+Alt+arrow rows would advertise
  // chords that can never fire. Only the `<request> _` row applies.
  const combo = pickNavCombo(host);
  const navTok = `${combo}+←/→`;
  const cycleTok = `${combo}+↑/↓`;
  const blankTok = '<request> _';
  const tokWidth = Math.max(navTok.length, cycleTok.length, blankTok.length);
  const keyEntries = opts.noCycling
    ? [[blankTok, 'send a request to AI']]
    : [
      [navTok, 'navigate cues'],
      [cycleTok, 'cycle cues'],
      [blankTok, 'send a request to AI'],
    ];
  console.log(style.bold('Keys'));
  for (let i = 0; i < keyEntries.length; i++) {
    const last = i === keyEntries.length - 1;
    const branch = style.dim(last ? '└─' : '├─');
    const [tok, desc] = keyEntries[i];
    console.log(`${branch} ${style.bold(tok.padEnd(tokWidth))}  ${style.dim(desc)}`);
  }
  console.log('');
  _bannerPrintedAt = Date.now();
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

// Dwell + exit the alt-screen right before spawning the host. Called
// from every host's run* function immediately before its spawnSync,
// so the visibility window always exists regardless of how fast the
// host boots — shell (oc-shell via tmux) is sub-100ms on warm caches
// and was the canary for this design: without an enforced dwell the
// banner would flash past unreadably even in alt-screen mode.
//
// `Atomics.wait` blocks synchronously without busy-waiting and
// without depending on /bin/sleep. The buffer is throwaway; we never
// post a value to wake on, so the wait runs to its timeout.
//
// Skips the sleep entirely if --skip-banner was set (nothing was
// printed, so nothing to dwell on) or no alt-screen was entered
// (persistent / chrome paths, OPENCUES_NO_CLEAR=1, non-TTY runs).
//
// Why ordering "exit alt-screen *before* spawn" (not after):
//   - Avoids nested alt-screen state. Hosts that call \x1b[?1049h
//     themselves (CC, opencode, gemini, oc-shell via tmux) inside
//     our alt-screen would stack two layers; older terminals don't
//     unwind cleanly.
//   - Keeps the host's render in the normal main-screen + its-own-
//     alt-screen pattern it was designed for — no surprise that it's
//     rendering inside someone else's transient buffer.
function clearScreenForHandoff() {
  if (_skipBanner || !_enteredAltScreen) return;
  const elapsed = Date.now() - _bannerPrintedAt;
  const remaining = BANNER_DWELL_MS - elapsed;
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
      HOSTS: ['apple-notes', 'chrome', 'claude-code', 'gemini-cli', 'mac', 'opencode', 'shell', 'windows'],
      resolve: (n) => ({
        'apple-notes': 'apple-notes', 'applenotes': 'apple-notes', 'notes': 'apple-notes',
        'mac': 'mac', 'macos': 'mac', 'ax': 'mac',
        'claude-code': 'claude-code', 'claudecode': 'claude-code', 'claude': 'claude-code', 'cc': 'claude-code',
        'opencode': 'opencode', 'oc': 'opencode',
        'chrome': 'chrome',
        'gemini-cli': 'gemini-cli', 'geminicli': 'gemini-cli', 'gemini': 'gemini-cli',
        'shell': 'shell', 'term': 'shell', 'oc-edit': 'shell',
        'windows': 'windows', 'win': 'windows', 'oc-windows': 'windows',
      })[n?.toLowerCase?.()] ?? null,
    };
  }
}

module.exports = async function run(argv, ctx) {
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
  let skipRebuildCheck = false;
  const passthrough = [];
  for (const a of argv) {
    if (a === '--skip-banner') {
      // opencues-owned flag — consumed here, NOT forwarded to the
      // spawned host. Suppresses the launch banner entirely:
      // printLaunchBanner is a no-op, no alt-screen, no dwell, no
      // clear-on-handoff — straight to spawnSync. Useful for
      // scripted launches and repeat-runners.
      _skipBanner = true;
      continue;
    }
    if (a === '--no-rebuild-check') {
      // Skip the source-drift check + transparent rebuild before
      // launch. Use when (a) you're iterating on the CLI itself and
      // don't want to re-install the bundle each time, or (b) you
      // already know the bundle is fresh and want to shave ~30ms of
      // hash computation off the launch path.
      skipRebuildCheck = true;
      continue;
    }
    if (a === '--no-cleanup') {
      // opencues-owned flag — consumed here, NOT forwarded to the
      // spawned host. The predecessor-kill gate reads it from the
      // ORIGINAL argv (runOC's fullArgv), so consuming it here only
      // stops it leaking into the host's own CLI — opencode prints
      // its help and EXITS on an unknown flag, which killed every
      // agentic-harness pool shard silently ("0/N shards live").
      continue;
    }
    if (!a.startsWith('-') && !target) target = a;
    else passthrough.push(a);
  }

  if (!target && prompt.isInteractive()) {
    target = await pickHost(HOSTS, { verb: 'Run which host' });
    if (!target) return; // cancelled
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

  // Self-healing drift check — every `opencues run <host>` compares
  // the bundled @opencues/{core,runtime} against the current source.
  // If stale (source changed since the last install), transparently
  // re-run the host installer before launching. Replaces the silent-
  // drift trap where `git pull master` left forks running pre-pull
  // bytecode forever. See `ensureFreshBundle` for the full rationale.
  // Skipped on --no-rebuild-check.
  if (!skipRebuildCheck) ensureFreshBundle(folder, ctx);

  if (folder === 'claude-code') return runCC(passthrough, ctx);
  if (folder === 'opencode')    return runOC(passthrough, argv, ctx);
  if (folder === 'chrome') return runChrome(ctx);
  if (folder === 'gemini-cli') return runGemini(passthrough, argv, ctx);
  if (folder === 'shell') return runShell(passthrough, ctx);
  if (folder === 'apple-notes') return runAppleNotes(passthrough, ctx);
  if (folder === 'mac') return runMac(passthrough, ctx);
  if (folder === 'windows') return runWindows(passthrough, ctx);
};

/**
 * Self-healing pre-launch step. Reads `<host>/.cues/version.json` (or
 * the host's marker location), compares to the current source's
 * `srcHash` + version strings. If stale, re-runs the host installer
 * (`opencues install <host> --no-prompts --yes`) before returning so
 * the launched host gets the latest bundled runtime.
 *
 * Triggered for every `opencues run <host>` call by default. The
 * `--no-rebuild-check` flag opts out. Failure is non-fatal: if the
 * installer exits non-zero the launch continues with whatever the
 * fork currently has + a visible warning. The launch is the user-
 * facing action; rebuild is best-effort.
 *
 * Why this lives in `opencues run` rather than per-host bin scripts
 * (`claude-cues`, `oc-shell`, …): users who type `claude-cues`
 * directly bypass this path. The runtime-side advisory check in
 * `boot-common.ts` covers them with a warning. The strong guarantee
 * is reserved for the `opencues run` flow because that's where we
 * can synchronously rebuild before the host starts.
 */
function ensureFreshBundle(host, ctx) {
  const { checkDrift, enumerateInstalledHosts } = require('../lib/version-markers.cjs');
  const installed = enumerateInstalledHosts(ctx);
  const entry = installed.find(e => e.host === host);
  if (!entry) return; // host not yet installed — nothing to compare against
  const { drift } = entry;
  if (drift.status === 'fresh') return;
  if (drift.status === 'missing') return; // pre-marker install — let it be; user can `opencues update <host>` if curious

  // Downgrade guard: "stale" is direction-blind (srcHash mismatch says
  // DIFFERENT, not OLDER). When the installed bundle's packages are
  // NEWER than this clone's source — a second clone / git worktree /
  // an old branch checked out here — the transparent rebuild would
  // destroy the newer install, and (because installs copy without
  // deleting) leave a MIXED bundle. Refuse, launch the existing
  // bundle, and name the escape hatch. Explicit `opencues install`
  // still rebuilds from anywhere — deliberate downgrades stay possible.
  if (drift.downgrade) {
    const from = drift.marker && drift.marker.repoRoot && path.resolve(drift.marker.repoRoot) !== path.resolve(ctx.REPO_ROOT)
      ? ` (installed from ${drift.marker.repoRoot})`
      : '';
    console.log(`${style.tag('warn')} ${style.bold(host)} bundle is NEWER than this clone's source (runtime ${drift.marker.runtime || '?'} vs ${drift.source.runtime || '?'}, core ${drift.marker.core || '?'} vs ${drift.source.core || '?'})${from}.`);
    console.log(`${style.tag('warn')} Refusing the automatic downgrade — launching the installed bundle. To rebuild from THIS clone anyway: ${style.bold(`opencues install ${host}`)}`);
    console.log('');
    return;
  }

  // status === 'stale' — re-install transparently so the next launch
  // picks up the source changes. Message is one line so it doesn't
  // dominate the banner above.
  const reasonHint = drift.reason === 'srcHash'
    ? 'source files changed since last install'
    : drift.reason === 'runtime'
      ? `runtime ${drift.marker.runtime || '?'} → ${drift.source.runtime || '?'}`
      : drift.reason === 'core'
        ? `core ${drift.marker.core || '?'} → ${drift.source.core || '?'}`
        : 'source drift';
  console.log(`${style.tag('info')} ${style.bold(host)} bundle is stale (${style.dim(reasonHint)}). Rebuilding before launch — pass ${style.bold('--no-rebuild-check')} to skip.`);
  console.log('');
  const installResult = spawnSync('node', [
    path.join(ctx.REPO_ROOT, 'packages/opencues-cli/bin/cli.cjs'),
    'install', host, '--no-prompts', '--yes',
  ], { stdio: 'inherit' });
  if (installResult.status !== 0) {
    console.log(`${style.tag('warn')} rebuild exited ${installResult.status}. Continuing with stale bundle. Run \`opencues install ${host}\` manually if the host misbehaves.`);
  }
  console.log('');
}

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

  // Predecessor-kill: SIGTERM any prior OC instance for the same
  // project before we spawn. Avoids orphan-process pileup when a
  // previous `opencues run opencode` was killed without cleanup
  // (terminal closed, double-fork detached, etc.). Skippable via
  // --no-cleanup on the run command.
  if (!fullArgv.includes('--no-cleanup')) {
    const { preflightKill } = require('./cleanup.cjs');
    const { killed, found } = preflightKill({ host: 'opencode', project: userCwd });
    if (killed > 0) {
      console.error(`${style.tag('info')} SIGTERM'd ${killed} prior opencode instance${killed === 1 ? '' : 's'} for this project (${found} found, --no-cleanup to skip)`);
    }
  }

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

  // Predecessor-kill (see runOC for rationale).
  if (!fullArgv.includes('--no-cleanup')) {
    const { preflightKill } = require('./cleanup.cjs');
    const { killed } = preflightKill({ host: 'gemini-cli', project: process.cwd() });
    if (killed > 0) {
      console.error(`${style.tag('info')} SIGTERM'd ${killed} prior gemini-cli instance${killed === 1 ? '' : 's'} (--no-cleanup to skip)`);
    }
  }

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

function runAppleNotes(passthrough, ctx) {
  // `opencues run apple-notes` launches the JXA polling daemon in the
  // foreground. macOS-only (Notes.app + osascript). No key channel —
  // the banner's noCycling mode prints only the `<request> _` row.
  if (process.platform !== 'darwin') {
    console.error(`${style.tag('err')} apple-notes is macOS-only (Notes.app + osascript).`);
    process.exit(1);
  }
  const daemonJs = path.join(ctx.REPO_ROOT, 'integrations', 'apple-notes', 'dist', 'daemon.js');
  if (!fs.existsSync(daemonJs)) {
    console.error(`${style.tag('err')} apple-notes daemon not built at ${daemonJs}`);
    console.error(`     Install first: ${style.bold('opencues install apple-notes')}`);
    process.exit(1);
  }
  printLaunchBanner(ctx, 'apple-notes', [
    ['host', 'apple-notes  ' + style.dim('(JXA polling daemon — answers `_` cues inline in any unlocked note)')],
    ['command', `node ${path.basename(daemonJs)} ${passthrough.join(' ')}`.trim()],
    ['bin', style.fileLink(daemonJs, daemonJs)],
    ['logs', style.dim('tail -f /tmp/opencues.log | grep apple-notes')],
  ], { noCycling: true });
  clearScreenForHandoff();
  const result = spawnSync('node', [daemonJs, ...passthrough], { stdio: 'inherit', env: process.env });
  exitFromSpawn(result, 'apple-notes daemon');
}

function runMac(passthrough, ctx) {
  // `opencues run mac` launches the universal Accessibility-API daemon
  // in the foreground: answers `_` cues in the FOCUSED text element of
  // any app. macOS-only. No key channel — universal/no-cycling profile.
  if (process.platform !== 'darwin') {
    console.error(`${style.tag('err')} mac is macOS-only (Accessibility API).`);
    process.exit(1);
  }
  const daemonJs = path.join(ctx.REPO_ROOT, 'integrations', 'mac', 'dist', 'daemon.js');
  const bridge = path.join(ctx.REPO_ROOT, 'integrations', 'mac', 'dist', 'ax-bridge');
  if (!fs.existsSync(daemonJs) || !fs.existsSync(bridge)) {
    console.error(`${style.tag('err')} mac daemon not built at ${daemonJs}`);
    console.error(`     Install first: ${style.bold('opencues install mac')}`);
    process.exit(1);
  }
  printLaunchBanner(ctx, 'mac', [
    ['host', 'mac  ' + style.dim('(Accessibility daemon — answers `_` cues in the focused text element of any app)')],
    ['command', `node ${path.basename(daemonJs)} ${passthrough.join(' ')}`.trim()],
    ['bin', style.fileLink(daemonJs, daemonJs)],
    ['logs', style.dim('tail -f /tmp/opencues.log | grep mac')],
  ], { noCycling: true });
  clearScreenForHandoff();
  const result = spawnSync('node', [daemonJs, ...passthrough], { stdio: 'inherit', env: process.env });
  exitFromSpawn(result, 'mac daemon');
}

function runWindows(passthrough, ctx) {
  // `opencues run windows` launches `bin/oc-windows` — the WSL-side
  // daemon that boots the runtime and prints the PowerShell command to
  // run on Windows. The Windows-native shim is compiled + run separately
  // by the user on Windows (see the printed command / integrations/
  // windows/README.md), so this side is just the daemon.
  const ocWindows = path.join(ctx.REPO_ROOT, 'integrations', 'windows', 'bin', 'oc-windows');
  if (!fs.existsSync(ocWindows)) {
    console.error(`${style.tag('err')} oc-windows not found at ${ocWindows}`);
    console.error(`     Install first: ${style.bold('opencues install windows')}`);
    process.exit(1);
  }
  printLaunchBanner(ctx, 'windows', [
    ['host', 'windows  ' + style.dim('(WSL daemon + Windows UIA shim — type _ in any Windows text field)')],
    ['command', `oc-windows ${passthrough.join(' ')}`.trim()],
    ['bin', style.fileLink(ocWindows, ocWindows)],
  ]);
  clearScreenForHandoff();
  const env = { ...process.env, OPENCUES_USER_CWD: process.cwd() };
  const result = spawnSync(ocWindows, passthrough, { stdio: 'inherit', env });
  exitFromSpawn(result, 'oc-windows');
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
  console.log('  apple-notes   node integrations/apple-notes/dist/daemon.js  (macOS: answers `_` cues inline in Notes.app)');
  console.log('  mac           node integrations/mac/dist/daemon.js          (macOS: answers `_` cues in the focused text element of ANY app)');
  console.log('');
  console.log('Opencues-owned flags (consumed by `opencues run`, NOT forwarded):');
  console.log('  --bin <name>      (claude-code only) override which binary to exec');
  console.log('  --target <path>   (opencode/gemini-cli) fork dir (defaults: $HOME/opencode-cues, $HOME/gemini-cli-cues)');
  console.log('  --skip-banner     suppress the launch banner entirely (no alt-screen, no dwell, straight to spawn)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues run claude-code');
  console.log('  opencues run claude-code --continue              # forwarded to claude');
  console.log('  opencues run claude-code --resume <id> --print   # forwarded to claude');
  console.log('  opencues run claude --bin claude-cues');
  console.log('  opencues run opencode');
  console.log('  opencues run opencode --target /custom/fork      # --target is ours');
  console.log('  opencues run gemini-cli --model gemini-2.5-pro   # forwarded to gemini');
  console.log('  opencues run claude-code --skip-banner           # no banner — go straight to claude');
  console.log('');
  console.log('Banner behaviour:');
  console.log('  Default: banner with the Keys hint renders in the alt-screen buffer for');
  console.log('           3 seconds, then is wiped before the host TUI starts. The host');
  console.log('           inherits a clean main screen with your pre-run prompt under it.');
  console.log('           No scrollback footprint.');
  console.log('  --skip-banner: no banner at all — spawn the host immediately. Useful for');
  console.log('           scripted launches and repeat-runners.');
  console.log('');
  console.log('Env vars:');
  console.log('  OPENCUES_NO_CLEAR=1   render the banner on the main screen with no dwell (back-compat path)');
}
