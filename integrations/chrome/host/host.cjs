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
      return require(path.join(c, main));
    } catch { /* try next */ }
  }
  throw new Error('opencues-host: cannot locate @opencues/core; tried: ' + candidates.join(', '));
}

// ─── Bundle builder (mirrors sync.cjs walkSource) ────────────────────────
function buildBundle(dir, core) {
  const { parseCuesMd, parseSingleCueMd, inferHostCompat } = core;
  const files = {};
  if (!fs.existsSync(dir)) return files;

  // Top-level monolithic files. Include whole file when any section is
  // chrome-compatible (or sections empty).
  for (const filename of ['CUES.md', 'BLANKS.md']) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const parsed = parseCuesMd(content);
      const sources = (parsed?.promptConfig?.sources) || {};
      const blanks = parsed?.blanks || {};
      const all = [...Object.values(sources), ...Object.values(blanks)];
      const hasChromeCompat = all.length === 0
        || all.some(e => inferHostCompat(e || {}).hosts.includes('chrome'));
      if (hasChromeCompat) files[filename] = content;
    } catch { /* skip on parse error */ }
  }

  // Folder-based: cues/<name>/CUE.md, blanks/<name>/BLANK.md
  const FOLDER_FILENAME = { cues: 'CUE.md', blanks: 'BLANK.md' };
  for (const subdir of ['cues', 'blanks']) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) continue;
    const primary = FOLDER_FILENAME[subdir];

    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(sub, entry.name);
      const cueMd = [primary, primary.toLowerCase(), 'cue.md']
        .map(f => path.join(folderPath, f))
        .find(p => fs.existsSync(p));
      if (!cueMd) continue;
      try {
        const parsed = parseSingleCueMd(fs.readFileSync(cueMd, 'utf8'), folderPath);
        const fm = parsed.frontmatter || {};
        // Mask script: / blankScript: when inferring compat. The host
        // runs subprocess scripts on chrome's behalf via the exec
        // protocol, so the auto-detected "not chrome" exclusion for
        // .sh-bearing blanks doesn't apply here. Explicit
        // not-on-host: [chrome] is still honoured by inferHostCompat.
        const compat = inferHostCompat({ ...fm, script: undefined, blankScript: undefined });
        if (!compat.hosts.includes('chrome')) continue;
        walkFolder(folderPath, (file) => {
          // Scripts are NOT bundled; the host runs them directly from
          // disk on exec requests. Shipping them as bundle bytes would
          // be wasteful + the extension can't execute them anyway.
          if (/\.(sh|bash|ps1|bat|cmd|exe|py|rb|pl|cs)$/i.test(file)) return;
          const rel = path.posix.join(subdir, entry.name, path.relative(folderPath, file).split(path.sep).join('/'));
          files[rel] = fs.readFileSync(file, 'utf8');
        });
      } catch { /* skip on parse error */ }
    }
  }

  return files;
}

function walkFolder(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFolder(full, cb);
    else cb(full);
  }
}

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

// Whitelist env keys we accept from the wire. The runtime sends
// CUES_MODEL / CUES_API_URL / CUES_API_KEY_ENV / CUES_ALT_COUNT etc.
// Anything outside this prefix is rejected so a malicious cue pack
// can't smuggle PATH / LD_PRELOAD / DYLD_* through the message and
// influence the spawned process's environment.
function filterMessageEnv(msgEnv) {
  if (!msgEnv || typeof msgEnv !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(msgEnv)) {
    if (typeof k === 'string' && /^CUES_[A-Z0-9_]+$/.test(k)) {
      out[k] = String(v);
    }
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

  let child;
  try {
    child = spawn(safeCommand, args, {
      env: { ...process.env, ...filterMessageEnv(msg.env) },
      cwd: CUE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
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
    sendMessage({
      type: 'exec-result',
      requestId,
      exitCode: typeof code === 'number' ? code : (timedOut ? 124 : 1),
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
const API_KEY_VARS = [
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'FINNHUB_API_KEY',
];
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

// Watch with debounce.
let timer = null;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; buildAndPush('change'); }, 250);
}
try {
  if (fs.existsSync(CUE_ROOT)) {
    fs.watch(CUE_ROOT, { recursive: true }, schedule);
  }
} catch (e) {
  sendMessage({ type: 'error', message: 'watch failed: ' + (e && e.message || e) });
}
