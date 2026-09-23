#!/usr/bin/env node
// OpenCues Chrome native-messaging host.
//
// Spawned by Chrome when the extension calls
//   chrome.runtime.connectNative('com.opencues.sync')
//
// Protocol: stdio framed JSON — 4-byte LE length, then UTF-8 payload.
// We only push host → extension; the extension never sends anything back
// (other than disconnect, which closes stdin and we exit).
//
// Behaviour:
//   1. On connect: build the current bundle from ~/.cues (or $OPENCUES_HOME)
//      and push it.
//   2. Watch the same dir; on change, debounce 250ms and push again.
//
// Filtering mirrors `opencues sync chrome` — host-compat 'chrome' only,
// scripts excluded.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ─── Sources ─────────────────────────────────────────────────────────────
function resolveCueRoot() {
  if (process.env.OPENCUES_HOME) return process.env.OPENCUES_HOME;
  return path.join(os.homedir(), '.cues');
}
const CUE_ROOT = resolveCueRoot();

// Tracks which env vars were set from ~/.cues/.env on a prior load.
// On reload (file change), file-sourced keys MUST be overwritable so
// `opencues set-key` rotation flows through to the next sendHostConfig.
// Real shell-env vars are recorded on the first load and never get
// clobbered, so explicit exports keep priority.
const ENV_FILE_KEYS = new Set();
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return; }
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // First load of a key: only set if shell didn't already export it
    // (real env wins). Subsequent loads: overwrite if WE set it last
    // time, so rotated keys flow through. A shell export at startup
    // permanently wins over the .env file.
    if (!(key in process.env) || ENV_FILE_KEYS.has(key)) {
      process.env[key] = value;
      ENV_FILE_KEYS.add(key);
    }
  }
}
loadEnvFile(path.join(CUE_ROOT, '.env'));

// ─── @opencues/core loader ───────────────────────────────────────────────
// Resolve relative to this script's location. Layout depends on where the
// host runs from:
//   - Dev (this repo):  ../node_modules/@opencues/core OR ../../../packages/opencues-core
//   - Installed user-side: a copy alongside the host (`./vendor/core`)
function loadCore() {
  const candidates = [
    path.resolve(__dirname, 'vendor/core'),
    path.resolve(__dirname, '../node_modules/@opencues/core'),
    path.resolve(__dirname, '../../../node_modules/@opencues/core'),
    path.resolve(__dirname, '../../../packages/opencues-core'),
  ];
  for (const c of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(c, 'package.json'), 'utf8'));
      const main = pkg.main || 'dist/index.js';
      const mod = require(path.join(c, main));
      loadCore.dir = c;
      return mod;
    } catch { /* try next */ }
  }
  throw new Error('opencues-host: cannot locate @opencues/core; tried: ' + candidates.join(', '));
}

// ─── @opencues/runtime loader (for user-blank registry) ─────────────────
function loadRuntime() {
  const candidates = [
    path.resolve(__dirname, 'vendor/runtime'),
    path.resolve(__dirname, '../node_modules/@opencues/runtime'),
    path.resolve(__dirname, '../../../node_modules/@opencues/runtime'),
    path.resolve(__dirname, '../../../packages/opencues-runtime'),
  ];
  for (const c of candidates) {
    try {
      // Direct submodule require — we only need buildUserBlankRegistry +
      // loadUserBlank from the user-blanks dir, not the whole runtime.
      return require(path.join(c, 'dist/src/user-blanks/registry'));
    } catch { /* try next */ }
  }
  return null;  // runtime unavailable → user-blank invokes fail with 'no-loader'
}

// ─── Bundle builder: host-bundle.cjs (unit-tested there) ─────────────────
const { buildBundle } = require('./host-bundle.cjs');

// ─── Native-messaging framed-stdio ───────────────────────────────────────
function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// stdin reader. Native messaging frames each message as 4-byte LE length
// prefix + UTF-8 JSON payload. Chunks can split or coalesce messages;
// buffer until we have a full message before dispatching.
let stdinBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const payload = stdinBuf.slice(4, 4 + len);
    stdinBuf = stdinBuf.slice(4 + len);
    try { handleMessage(JSON.parse(payload.toString('utf8'))); }
    catch (e) { sendMessage({ type: 'error', message: 'bad frame: ' + (e && e.message || e) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'exec') return handleExec(msg);
  if (msg.type === 'user-blank-invoke') return handleUserBlankInvoke(msg);
  if (msg.type === 'log') return handleLog(msg);
  if (msg.type === 'write-file') return handleWriteFile(msg);
  if (msg.type === 'decision') return handleDecision(msg);
}

// ─── Decision legs (host-side, core's decisions/bridge.ts) ──────────────
//
// The page has no decision package and no key: chrome's content script
// bridges every decision leg here (background.ts relays `opencues:decision`
// as `decision`). The package (`@opencues/decisions`, private) and
// TYPESAFE_API_KEY live in THIS process — the key is deliberately NOT in
// API_KEY_VARS, so it never reaches chrome.storage or the page. The page
// runs its own PII floor over the leg arguments before they leave it; the
// package's `dispatchDecision` runs the meter + the [decision] log here.
// Loaded once per `which`; a load failure is a typed reply the page's
// breaker classifies, never a crash of the host.
const decisionLegsByProvider = new Map();
function decisionLegsFor(which) {
  if (decisionLegsByProvider.has(which)) return decisionLegsByProvider.get(which);
  let legs = null;
  try {
    const { NodeHttpAdapter } = require(path.join(loadCore.dir, 'node-http-adapter.js'));
    legs = core.loadDecisionLegs({
      which,
      apiKeys: process.env,
      httpAdapter: new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 }),
      log: (m) => handleLog({ level: 'debug', msg: `[chrome-host] ${m}` }),
    }) || null;
  } catch (e) {
    handleLog({ level: 'warn', msg: `[chrome-host] decision package failed to load: ${e && e.message || e}` });
  }
  decisionLegsByProvider.set(which, legs);
  return legs;
}
function handleDecision(msg) {
  const requestId = msg.requestId;
  if (typeof requestId !== 'string') return;
  const reply = (body) => sendMessage({ type: 'decision-result', requestId, reply: body });
  const which = typeof msg.which === 'string' ? msg.which : 'off';
  if (which === 'off') { reply({ ok: false, error: { kind: 'shape', message: 'decisions-provider is off' } }); return; }
  const legs = decisionLegsFor(which);
  if (!legs) { reply({ ok: false, error: { kind: 'auth', message: `no decision package / key for ${which} in the chrome-host (see /tmp/opencues.log)` } }); return; }
  const leg = typeof msg.leg === 'string' ? msg.leg : '';
  const args = Array.isArray(msg.args) ? msg.args : [];
  core.serveDecisionLeg(legs, { leg, args }, (m) => handleLog({ level: 'debug', msg: `[chrome-host] ${m}` }))
    .then(reply)
    .catch((e) => reply({ ok: false, error: { kind: 'transport', message: String(e && e.message || e) } }));
}

// Write a file under CUE_ROOT on chrome's behalf. Used by the in-page
// settings blank — when the user cycles `opencues settings _` and
// flips a scalar, the content-script settings blank routes the new
// OPENCUES.md content here. The host sandbox-checks the path
// (must resolve under CUE_ROOT after realpath) and writes via
// `fs.writeFile`. fs.watch picks up the change → bundle pushed back
// to chrome.storage → content-script ConfigLoader reloads. Storage
// is just a cache of the file; the file is the single source of truth.
//
// Without this handler, chrome's in-page cycling would only write to
// chrome.storage and would silently diverge from the file (the bug
// that chrome.storage's stale overlay used to mask). With the handler,
// chrome writes to the FILE first, falling back to chrome.storage
// only when the host is disconnected.
// F3 (INFOSEC) validators live in host-validators.cjs so they're unit-
// testable in isolation. Reviewers: don't expand WRITABLE_BASENAMES /
// INTERPRETER_ALLOWLIST without re-reading docs/architecture/
// security-audit.md row #15 + the F3 finding in security-findings.md.
const {
  WRITABLE_BASENAMES,
  ROOT_ONLY_BASENAMES,
  isWritableTarget,
  validateExec: _validateExec,
} = require('./host-validators.cjs');

function handleWriteFile(msg) {
  const requestId = msg.requestId;
  if (typeof requestId !== 'string') return;
  const reply = (body) => sendMessage({ type: 'write-file-result', requestId, ...body });
  const pathArg = typeof msg.path === 'string' ? msg.path : '';
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!pathArg) { reply({ ok: false, error: 'missing path' }); return; }
  // Path-form translation + sandbox: same rules as handleExec's
  // sandboxArg. Chrome-runtime virtual paths (`/chrome-storage/.cues/...`)
  // translate to `${CUE_ROOT}/...`; absolute paths are honored only when
  // they resolve (via realpath) under CUE_ROOT.
  const safe = sandboxArg(pathArg);
  if (safe === null) {
    reply({ ok: false, error: `path outside CUE_ROOT: ${pathArg}` });
    return;
  }
  // F3: refuse writes outside the configured-file allow-list. The
  // earlier "any path under CUE_ROOT" model let a single trusted
  // frame create a `blanks/x/blank.js` that the registry would
  // auto-load + execute. Restrict to the exact file basenames
  // OPENCUES.md (today) and IDENTITY.md / CUES.md
  // (forward-compat for the in-editor identity write surface), and the
  // 1.0 settings.yaml / identity.yaml at the root only.
  if (!isWritableTarget(safe, CUE_ROOT_RESOLVED)) {
    reply({
      ok: false,
      error: `write target not in allow-list (F3): ${path.basename(safe)}. ` +
        `Permitted basenames: ${[...WRITABLE_BASENAMES, ...ROOT_ONLY_BASENAMES].sort().join(', ')} (the .yaml at the root only)`,
    });
    return;
  }
  try {
    fs.writeFileSync(safe, content, 'utf8');
    reply({ ok: true });
  } catch (e) {
    reply({ ok: false, error: 'write failed: ' + (e && e.message || e) });
  }
}

// Mirror the OC/CC/gemini log-line shape so chrome's runtime events
// (Resolver build, BlankFill substitutions, transform-blank passes,
// markdown.styled apply trace, etc.) land in /tmp/opencues.log
// alongside every other host. Unifies the debug surface — one
// `tail -f /tmp/opencues.log` works across all four integrations.
function handleLog(msg) {
  const level = typeof msg.level === 'string' ? msg.level : 'info';
  const text = typeof msg.msg === 'string' ? msg.msg : '';
  const data = msg.data;
  try {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}][${level}] ${text} ${data ? JSON.stringify(data).slice(0, 400) : ''}\n`;
    fs.appendFile('/tmp/opencues.log', line, () => {});
  } catch { /* swallow — log writes must not block runtime path */ }
}

// ─── User-blank registry (host-side execution) ──────────────────────────
//
// Custom user-blanks (JS files at CUE_ROOT/blanks/<name>/blank.js
// with `impl: ./blank.js` in BLANK.md) run HERE rather than in a
// content-script Worker. Two reasons:
//
//   1. CSP — strict pages (Gmail, banks) refuse blob: Workers from
//      content scripts; running here bypasses page CSP entirely.
//   2. Sandbox — Node's `vm` with permission proxy is the same
//      isolation CC/OC/gemini use. The browser Worker was weaker.
//
// The chrome-host becomes a HARD dependency for custom user-blanks.
// Shipped TS-class blanks (weather, stocks, …) still register
// upstream in createBlanks() and don't need this path.
let userBlankRegistry = new Map();
const runtime = loadRuntime();   // null when runtime submodule not available

function rebuildUserBlankRegistry() {
  if (!runtime) return;
  const { parseSingleCueMd } = core;
  const blanksDir = path.join(CUE_ROOT, 'blanks');
  if (!fs.existsSync(blanksDir)) {
    userBlankRegistry = new Map();
    return;
  }
  // Walk CUE_ROOT/blanks/<name>/BLANK.md and collect configs whose
  // `impl:` is a relative path (the user-blank shape — bare names
  // fall through to the built-in registry, scripts go through exec).
  const configs = [];
  for (const entry of fs.readdirSync(blanksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(blanksDir, entry.name);
    const blankMd = ['BLANK.md', 'blank.md'].map(n => path.join(folder, n)).find(p => fs.existsSync(p));
    if (!blankMd) continue;
    try {
      const parsed = parseSingleCueMd(fs.readFileSync(blankMd, 'utf8'), folder);
      const cfg = parsed.blanks && parsed.blanks[entry.name];
      if (!cfg || !cfg.impl) continue;
      // parseSingleCueMd resolves `impl: ./blank.js` to an absolute
      // path under `folder`. A path-shaped impl is the discriminator
      // for "this is a JS user-blank". Bare names indicate built-in
      // registry lookup which doesn't apply on the host.
      if (!cfg.impl.includes('/')) continue;
      configs.push(cfg);
    } catch { /* parse error → skip this blank */ }
  }
  try {
    userBlankRegistry = runtime.buildUserBlankRegistry(configs, {
      storageRoot: path.join(CUE_ROOT, '.user-blank-storage'),
      // Host's process.env IS the secret source. The runtime loader
      // filters per-blank to only the names declared in `secrets:`.
      secrets: process.env,
      log: (level, msg) => sendMessage({ type: 'log', level, msg: '[user-blank] ' + msg }),
    });
  } catch (e) {
    userBlankRegistry = new Map();
    sendMessage({ type: 'error', message: 'user-blank rebuild failed: ' + (e && e.message || e) });
  }
}

async function handleUserBlankInvoke(msg) {
  const requestId = msg.requestId;
  if (typeof requestId !== 'string') return;
  const reply = (body) => sendMessage({ type: 'user-blank-result', requestId, ...body });

  if (!runtime) {
    reply({ ok: false, error: 'host has no runtime loader — reinstall chrome-host' });
    return;
  }
  const blank = userBlankRegistry.get(msg.name);
  if (!blank) {
    reply({ ok: false, error: `user blank "${msg.name}" not registered on host` });
    return;
  }
  const method = msg.method === 'set' ? 'set' : 'get';
  const args = Array.isArray(msg.args) ? msg.args.map(String) : [];
  try {
    let output;
    if (method === 'get') {
      output = await blank.get(args[0] || '', args.slice(1));
    } else {
      // The runtime wraps user blanks that don't export `set` with
      // `set: undefined`. Cycling Down on a readOnly blank lands here
      // — treat it as a no-op so the proxy doesn't surface a confusing
      // "method not callable" stack to BlankFill.
      if (typeof blank.set !== 'function') {
        reply({ ok: true, output: '' });
        return;
      }
      await blank.set(args[0] || '', args[1] || '');
      output = '';
    }
    reply({ ok: true, output: String(output ?? '') });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message || e) });
  }
}

// Sandbox: every script path the host runs must live under CUE_ROOT
// (~/.cues/ or $OPENCUES_HOME). A malicious cue pack writing
// `blankScript: /etc/passwd` (or any absolute path outside CUE_ROOT)
// must NOT be honoured.
//
// Three input shapes:
//   1. Chrome-runtime-built virtual paths (/chrome-storage/.cues/...) →
//      translate to ${CUE_ROOT}/..., then verify resolved path stays
//      under CUE_ROOT.
//   2. Absolute filesystem paths (/home/.../foo.sh) → verify directly.
//   3. Non-path args (plain words, flags like '-c', strings without a
//      leading slash) → pass through unchanged.
const CHROME_STORAGE_PREFIX = '/chrome-storage/.cues/';
const CUE_ROOT_RESOLVED = path.resolve(CUE_ROOT);

function withinCueRoot(absPath) {
  return absPath === CUE_ROOT_RESOLVED || absPath.startsWith(CUE_ROOT_RESOLVED + path.sep);
}

// Returns the safe path to pass through, or null if it would escape.
// Non-absolute args are returned unchanged.
//
// Uses realpath to resolve every symlink along the path. A cue pack
// that places `blanks/foo/script.sh -> /etc/passwd` inside CUE_ROOT
// passes path.resolve (the symlink itself is under CUE_ROOT) but
// realpath returns /etc/passwd, which fails withinCueRoot. The
// realpath check is the difference between path-shaped enforcement
// and actual-file-shaped enforcement.
//
// If the path doesn't exist yet (ENOENT), there's no symlink to
// follow and no security risk — spawn will fail naturally. Fall back
// to the lexical path check.
function sandboxArg(a) {
  if (typeof a !== 'string') return a;
  let abs;
  if (a.startsWith(CHROME_STORAGE_PREFIX)) {
    abs = path.resolve(CUE_ROOT, a.slice(CHROME_STORAGE_PREFIX.length));
  } else if (a.startsWith('/')) {
    abs = path.resolve(a);
  } else {
    return a;  // non-absolute → not a path we need to sandbox
  }
  let real;
  try { real = fs.realpathSync(abs); }
  catch { real = abs; }  // ENOENT — no symlink to follow
  return withinCueRoot(real) ? real : null;
}

// Append one line to ${CUE_ROOT}/.opencues-log for each script
// invocation. Mirrors the SHOULD-4 audit-log behaviour the native
// hosts implement via packages/opencues-runtime/src/security/
// spawn-sandbox.ts. Best-effort: write failures are swallowed.
function appendAuditLine(hostName, spec, result, durationMs) {
  try {
    const ts = new Date().toISOString();
    const argsStr = (spec.args || []).join(',');
    const dur = durationMs !== undefined ? `  ms=${durationMs}` : '';
    const flag = result.timedOut ? '  timedOut=true' : '';
    const line = `${ts}\t${hostName}\t${spec.command}\t${argsStr}\texit=${result.exitCode}${dur}${flag}\n`;
    fs.appendFileSync(path.join(CUE_ROOT_RESOLVED, '.opencues-log'), line);
  } catch { /* */ }
}

// INFOSEC F2: deny-by-default env construction.
//
// Pre-F2 the spawn call was `{ ...process.env, ...filterMessageEnv(msg.env) }`,
// which spread EVERY *_API_KEY the host process had loaded — including
// keys never declared by the running blank. A `blankScript:`-bearing
// pack could `curl` them out without any frontmatter `secrets:`.
//
// Now: the host starts from its own tight base allow-list (PATH, HOME,
// locale, desktop-integration vars) and trusts the runtime to put
// declared-secret values into msg.env. The runtime's
// `buildSafeScriptEnv` already validates names + declared-secret shapes
// before they land on the wire; the host applies a second-line
// deny-list (LD_PRELOAD / DYLD_* / NODE_OPTIONS / …) as belt-and-braces.
const HOST_BASE_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TMPDIR', 'SHELL',
  'TERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
  'WSL_DISTRO_NAME', 'WSLENV',
]);
const HOST_DANGEROUS_ENV_PATTERN = /^(?:LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_OPTS|JDK_JAVA_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|GTK_MODULES|GIO_USE_VFS|GST_PLUGIN_PATH)$/;

function buildBaseHostEnv() {
  const out = {};
  for (const k of HOST_BASE_ENV_ALLOWLIST) {
    if (typeof process.env[k] === 'string') out[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('LC_')) out[k] = v;
  }
  return out;
}

// Trust the runtime's wire env (it constructed it via buildSafeScriptEnv).
// Still apply the dangerous-name deny-list as a second line of defence.
function filterMessageEnv(msgEnv) {
  if (!msgEnv || typeof msgEnv !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(msgEnv)) {
    if (typeof k !== 'string') continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue;
    if (HOST_DANGEROUS_ENV_PATTERN.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

const { spawn } = require('node:child_process');

function handleExec(msg) {
  const requestId = msg.requestId;
  if (typeof requestId !== 'string') return;

  const command = typeof msg.command === 'string' ? msg.command : '';
  const rawArgs = Array.isArray(msg.args) ? msg.args.map(String) : [];
  const timeoutMs = typeof msg.timeoutMs === 'number' ? msg.timeoutMs : 10_000;

  // Sandbox: absolute paths must stay under CUE_ROOT. The command
  // itself is also checked when it's an absolute path (relative
  // commands like 'bash' or 'node' resolve via PATH and are fine).
  const safeCommand = command.startsWith('/') ? sandboxArg(command) : command;
  if (safeCommand === null) {
    sendMessage({
      type: 'exec-result', requestId,
      exitCode: 126, stdout: '', stderr: `command outside CUE_ROOT: ${command}`, timedOut: false,
    });
    return;
  }
  // F3 (INFOSEC): interpreter allow-list + inline-code flag refusal +
  // args[0] must be a script path. Validators in host-validators.cjs.
  const isAbsoluteUnderCueRoot = command.startsWith('/') && safeCommand !== null;
  const validationErr = _validateExec({
    command: safeCommand,
    args: rawArgs,
    isAbsoluteUnderCueRoot,
  });
  if (validationErr) {
    sendMessage({
      type: 'exec-result', requestId,
      exitCode: 126, stdout: '', stderr: validationErr, timedOut: false,
    });
    return;
  }
  // F3: when bash/sh, also require args[0] to resolve under CUE_ROOT
  // (the runtime's only call shape is `bash <scriptPath> ...`).
  if (rawArgs[0] && (safeCommand === 'bash' || safeCommand === 'sh')) {
    if (sandboxArg(rawArgs[0]) === null) {
      sendMessage({
        type: 'exec-result', requestId,
        exitCode: 126, stdout: '',
        stderr: `args[0] does not resolve under CUE_ROOT (F3): ${rawArgs[0]}`,
        timedOut: false,
      });
      return;
    }
  }
  const args = [];
  for (const a of rawArgs) {
    const safe = sandboxArg(a);
    if (safe === null) {
      sendMessage({
        type: 'exec-result', requestId,
        exitCode: 126, stdout: '', stderr: `arg outside CUE_ROOT: ${a}`, timedOut: false,
      });
      return;
    }
    args.push(safe);
  }

  // OS-level sandbox: when the runtime sets spec.sandbox.mode==='strict',
  // wrap the spawn with whichever mechanism the current platform
  // supports — bwrap on Linux/WSL, sandbox-exec on macOS. Falls
  // through unwrapped when sandbox is off, the mechanism is missing,
  // or we're on an unsupported platform (Windows native).
  let finalCommand = safeCommand;
  let finalArgs = args;
  if (msg.sandbox && msg.sandbox.mode === 'strict') {
    try {
      const { wrapForPlatform } = require(path.join(
        __dirname, '..', 'node_modules', '@opencues', 'runtime',
        'dist', 'src', 'security', 'sandbox-runner.js',
      ));
      const wrapped = wrapForPlatform(safeCommand, args, msg.sandbox, [CUE_ROOT_RESOLVED]);
      if (wrapped) {
        finalCommand = wrapped.command;
        finalArgs = wrapped.args;
      }
    } catch { /* sandbox-runner not bundled — fall through unwrapped */ }
  }

  const startedAt = Date.now();
  let child;
  try {
    child = spawn(finalCommand, finalArgs, {
      env: { ...buildBaseHostEnv(), ...filterMessageEnv(msg.env) },
      cwd: CUE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    appendAuditLine('chrome', { command, args: rawArgs }, { exitCode: 127 });
    sendMessage({
      type: 'exec-result', requestId,
      exitCode: 127, stdout: '', stderr: 'spawn failed: ' + (e && e.message || e), timedOut: false,
    });
    return;
  }

  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch { /* */ }
  }, timeoutMs);

  child.on('close', (code) => {
    clearTimeout(timer);
    const exit = typeof code === 'number' ? code : (timedOut ? 124 : 1);
    appendAuditLine('chrome', { command, args: rawArgs }, { exitCode: exit, timedOut }, Date.now() - startedAt);
    sendMessage({
      type: 'exec-result',
      requestId,
      exitCode: exit,
      stdout, stderr, timedOut,
    });
  });
  child.on('error', (err) => {
    clearTimeout(timer);
    sendMessage({
      type: 'exec-result', requestId,
      exitCode: 127, stdout, stderr: stderr + (err && err.message ? err.message : String(err)),
      timedOut,
    });
  });
}

// ─── Push pipeline ───────────────────────────────────────────────────────
let core;
try { core = loadCore(); }
catch (e) {
  sendMessage({ type: 'fatal', message: String(e && e.message || e) });
  process.exit(1);
}

let lastJson = '';
function buildAndPush(reason) {
  let files = {};
  try { files = buildBundle(CUE_ROOT, core); }
  catch (e) {
    sendMessage({ type: 'error', message: String(e && e.message || e) });
    return;
  }
  const payload = { type: 'bundle', root: CUE_ROOT, files };
  const json = JSON.stringify(payload);
  if (json === lastJson) return;  // dedupe identical pushes
  lastJson = json;
  sendMessage({ ...payload, reason });
}

// Push the host's known API keys (read from its own env) once at
// startup. Replaces the bake-time inlining of GROQ_API_KEY /
// FINNHUB_API_KEY into the extension bundle — the published JS no
// longer ships secrets.
//
// Keys NOT set in env aren't sent (the field is omitted). The
// extension layers these between the bake-time defaults (now empty)
// and the popup-set values (which still win as user-overrides).
//
// Cycle: user updates ~/.bashrc → restarts WSL → next host spawn
// reads the new value → sends → SW writes to chrome.storage →
// content-script onChanged listener picks it up live.
// LLM API keys sourced from @opencues/core's PROVIDERS registry —
// adding a provider auto-flows into chrome's storage. FINNHUB is the
// lone non-LLM service key (stocks blank). Re-use the same core
// loader the bundle builder uses.
const API_KEY_VARS = (function () {
  try {
    const core = loadCore();
    return [...core.listProviders().map(p => p.envKeyName), 'FINNHUB_API_KEY'];
  } catch {
    return [
      'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'FINNHUB_API_KEY',
    ];
  }
})();
function sendHostConfig() {
  const apiKeys = {};
  for (const v of API_KEY_VARS) {
    const value = process.env[v];
    if (typeof value === 'string' && value.length > 0) apiKeys[v] = value;
  }
  sendMessage({ type: 'config', apiKeys });
}
sendHostConfig();

// Initial push.
buildAndPush('initial');
rebuildUserBlankRegistry();

// Watch with debounce.
let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    loadEnvFile(path.join(CUE_ROOT, '.env'));
    sendHostConfig();
    buildAndPush('change');
    rebuildUserBlankRegistry();   // re-register user-blanks on disk change
  }, 250);
}
try {
  if (fs.existsSync(CUE_ROOT)) {
    fs.watch(CUE_ROOT, { recursive: true }, schedule);
  }
} catch (e) {
  sendMessage({ type: 'error', message: 'watch failed: ' + (e && e.message || e) });
}

// ── Calendar feed refresh (resource-on-a-timer model) ─────────────────
// chrome-only users have no native host running, so the chrome-host
// process is their producer: every 5 min ask core's due-check whether
// the shared snapshot is older than the 15-min TTL, and refresh via the
// SAME core syncCalendarFeeds the CLI + runtime scheduler use (one
// implementation — a hand-copied sync is the mirrored-guard drift
// class). Writing calendar.json trips fs.watch above, which pushes the
// fresh bundle to the extension — no extra plumbing.
setInterval(() => {
  try {
    const core = loadCore();
    if (!core || typeof core.calendarSyncDue !== 'function') return;
    if (!core.calendarSyncDue(fs, CUE_ROOT)) return;
    core.syncCalendarFeeds({ fs, cuesDir: CUE_ROOT, log: () => {} })
      .catch(() => { /* keep last-good snapshot; retried when next due */ });
  } catch { /* never take the host down over calendar freshness */ }
}, 5 * 60_000).unref?.();
