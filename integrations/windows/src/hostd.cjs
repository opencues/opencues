#!/usr/bin/env node
'use strict';

// ─── OpenCues Windows host daemon (WSL side) ─────────────────────────────
//
// This is the "brain" half of the Windows integration and it runs in
// WSL (or any Linux/Node environment), NOT on Windows. It:
//
//   1. Boots @opencues/runtime through the `windows` adapter band using
//      WSL's OWN environment — the same ~/.cues config, the same
//      GROQ_API_KEY / etc., the same /tmp/opencues.log every other WSL
//      host uses. THIS is the concrete "plugged into WSL main OC" join:
//      there is no second config, no key re-entry, no sync. Edit a cue
//      folder for claude-cues and the Windows host hot-reloads it.
//
//   2. Listens on 127.0.0.1:<port> for the thin Windows-native UIA shim
//      (native/OpenCuesWindows.cs). WSL2 forwards a Linux localhost
//      listener to the Windows host's localhost, so the shim just dials
//      127.0.0.1:<port>.
//
//   3. Keeps a LOCAL MIRROR of the focused Windows field's text+cursor
//      (fed by the shim's `text`/`cursor` events) and pushes runtime
//      writes back out as `set-text` commands. getText() never blocks —
//      it reads the mirror — exactly the contract every host follows.
//
//   4. Publishes a presence file under /tmp/opencues-hosts/ so other
//      OpenCues processes on the machine can see it exists + what it's
//      attached to (seed for the cross-host precedence work).
//
// Wire protocol: integrations/windows/protocol.md.

const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn: nodeSpawn } = require('child_process');

// ─── Resolve the built runtime + core ────────────────────────────────────
// Prefer the staged node_modules (what setup.sh installs); fall back to
// the repo's package dirs for dev runs straight from the tree.
function pkgRoot(name, repoRel) {
  try { return path.dirname(require.resolve(`${name}/package.json`)); }
  catch { return path.resolve(__dirname, '..', repoRel); }
}
const RUNTIME_ROOT = pkgRoot('@opencues/runtime', '../../packages/opencues-runtime');
function rt(rel) { return require(path.join(RUNTIME_ROOT, 'dist', rel)); }

const { boot } = rt('adapters/windows/v1/boot.js');
const {
  createDefaultBlanksRegistry,
  createBlankInvoke,
} = rt('src/blanks/index.js');
const { validateScriptPath, appendAuditLog } = rt('src/security/spawn-sandbox.js');
const { wrapWithBwrap } = rt('src/security/sandbox-runner.js');
const { startConfigServer, KEY_ENVS } = require('./config-server.cjs');

// ─── Config ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.OPENCUES_WIN_PORT || '', 10) || 51789;
// Config/UI HTTP server (shared popup + keys/settings API). Defaults to
// the socket port + 1. Set OPENCUES_WIN_CONFIG_PORT=0 to disable.
const CONFIG_PORT = process.env.OPENCUES_WIN_CONFIG_PORT !== undefined
  ? parseInt(process.env.OPENCUES_WIN_CONFIG_PORT, 10)
  : PORT + 1;
const HOST_BIND = process.env.OPENCUES_WIN_BIND || '127.0.0.1';
const HOME = process.env.HOME || os.homedir();
const CUES_HOME = process.env.OPENCUES_HOME || path.join(HOME, '.cues');
// Cross-platform log + presence locations. On WSL/Linux we keep the
// canonical /tmp/opencues.log so the Windows-bridge daemon shows up in
// the SAME log as every other WSL host. On native Windows Node there is
// no /tmp — fall back to %TEMP% (os.tmpdir()). Overridable via
// OPENCUES_LOG for a tray app that wants a fixed path.
const IS_WINDOWS = process.platform === 'win32';
const TMP_BASE = IS_WINDOWS ? os.tmpdir() : '/tmp';
const LOG_FILE = process.env.OPENCUES_LOG || path.join(TMP_BASE, 'opencues.log');
const PRESENCE_DIR = path.join(TMP_BASE, 'opencues-hosts');
const PRESENCE_FILE = path.join(PRESENCE_DIR, `windows-${process.pid}.json`);

// Surface-discovery catalog: a deduplicated TSV of every DISTINCT focused
// surface the shim reports (proc|controlType|className) + how it can be read
// (uia-writable / uia-text / electron-msaa / winui-island / opaque). Lets
// surfaces be reviewed and allow/deny-filtered later instead of probing apps
// one at a time. Metadata ONLY — never field content, and the shim never
// reports password/sensitive fields. Dedup is persistent (loaded on start).
const SURFACES_FILE = process.env.OPENCUES_SURFACES || path.join(TMP_BASE, 'opencues-surfaces.tsv');
const seenSurfaces = new Set();
try {
  if (fs.existsSync(SURFACES_FILE)) {
    for (const line of fs.readFileSync(SURFACES_FILE, 'utf8').split('\n')) {
      const sig = line.split('\t')[0];
      if (sig && sig !== 'signature') seenSurfaces.add(sig);
    }
  } else {
    fs.writeFileSync(SURFACES_FILE,
      ['signature', 'kind', 'vp', 'tp', 'renderer', 'proc', 'controlType', 'className', 'name', 'firstSeen'].join('\t') + '\n');
  }
} catch { /* non-fatal: discovery is best-effort */ }

// Convert a path this daemon can see into one the Windows tray can open
// in Explorer. On native Windows it's already a Windows path. On WSL a
// Linux path like /home/wilfred/.cues becomes
// \\wsl.localhost\<distro>\home\wilfred\.cues — reachable from Windows.
function toWinPath(p) {
  if (IS_WINDOWS) return p;
  const distro = process.env.WSL_DISTRO_NAME;
  if (!distro || !p.startsWith('/')) return p;
  return `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}`;
}

function log(level, msg, data) {
  try {
    const ts = new Date().toISOString().slice(11, 23);
    let extra = '';
    if (data !== undefined && data !== null) {
      if (data instanceof Error) extra = `${data.name}: ${data.message}`;
      else if (typeof data === 'string') extra = data;
      else { try { extra = JSON.stringify(data).slice(0, 400); } catch { extra = String(data); } }
    }
    fs.appendFile(LOG_FILE, `[${ts}][windows][${level}] ${msg} ${extra}\n`, () => {});
  } catch { /* swallow */ }
}

// ─── Path helpers (mirror shell bootstrap) ──────────────────────────────
function cuesRoots() {
  const roots = [];
  if (process.env.OPENCUES_HOME) roots.push(process.env.OPENCUES_HOME);
  roots.push(path.join(process.cwd(), '.cues'));
  roots.push(path.join(HOME, '.cues'));
  return roots;
}
const opencuesMdPath = path.join(CUES_HOME, 'OPENCUES.md');
const identityMdPath = path.join(CUES_HOME, 'IDENTITY.md');
const notesMdPath = path.join(CUES_HOME, 'NOTES.md');

// ─── Blank registry (compute/system blanks + weave IO) ──────────────────
const blanksRegistry = createDefaultBlanksRegistry({
  finnhubApiKey: process.env.FINNHUB_API_KEY,
  opencuesMdIO: {
    readFile: async () => { try { return await fsp.readFile(opencuesMdPath, 'utf8'); } catch { return null; } },
    writeFile: async (c) => { await fsp.writeFile(opencuesMdPath, c, 'utf8'); },
  },
  identityMdIO: {
    readFile: async () => { try { return await fsp.readFile(identityMdPath, 'utf8'); } catch { return null; } },
    writeFile: async (c) => { await fsp.writeFile(identityMdPath, c, 'utf8'); },
  },
  notesMdIO: {
    readFile: async () => { try { return await fsp.readFile(notesMdPath, 'utf8'); } catch { return null; } },
    writeFile: async (c) => { await fsp.writeFile(notesMdPath, c, 'utf8'); },
  },
});
const blankInvoke = createBlankInvoke(blanksRegistry);

// ─── Sandboxed spawn (copied from shell bootstrap) ──────────────────────
function spawnProcess(spec) {
  const roots = cuesRoots();
  const rawArgs = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const safeArgs = [];
  for (const a of rawArgs) {
    const r = validateScriptPath(a, roots);
    if (!r.ok) {
      appendAuditLog('windows', spec, { exitCode: 126 }, roots);
      return {
        result: Promise.resolve({ exitCode: 126, stdout: '', stderr: r.reason || 'path outside CUES roots', timedOut: false }),
        kill: () => {},
      };
    }
    safeArgs.push(r.resolved || a);
  }
  const wrapped = wrapWithBwrap(spec.command, safeArgs, spec.sandbox, roots);
  const finalCommand = wrapped ? wrapped.command : spec.command;
  const finalArgs = wrapped ? wrapped.args : safeArgs;
  const startedAt = Date.now();
  const wantStdin = typeof spec.input === 'string' && spec.input.length > 0;
  const stdio = spec.detached ? 'ignore' : [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'];
  let child;
  try {
    child = nodeSpawn(finalCommand, finalArgs, { env: spec.env, cwd: spec.cwd, detached: !!spec.detached, stdio });
  } catch (err) {
    appendAuditLog('windows', spec, { exitCode: 127 }, roots);
    return {
      result: Promise.resolve({ exitCode: 127, stdout: '', stderr: String((err && err.message) || err), timedOut: false }),
      kill: () => {},
    };
  }
  if (wantStdin && child.stdin) { try { child.stdin.write(spec.input); child.stdin.end(); } catch {} }
  let stdout = '', stderr = '';
  child.stdout && child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr && child.stderr.on('data', (d) => { stderr += d.toString(); });
  const result = new Promise((resolve) => {
    let timedOut = false, killer = null;
    const timer = spec.timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
    }, spec.timeoutMs) : null;
    const finish = (code) => {
      if (timer) clearTimeout(timer);
      if (killer) clearTimeout(killer);
      const exit = code == null ? 0 : code;
      appendAuditLog('windows', spec, { exitCode: exit, timedOut }, roots, Date.now() - startedAt);
      resolve({ exitCode: exit, stdout, stderr, timedOut });
    };
    child.on('exit', finish);
    child.on('error', (err) => { stderr += String((err && err.message) || err); finish(127); });
  });
  if (spec.detached) child.unref();
  return { result, kill: (sig) => { try { child.kill(sig || 'SIGTERM'); } catch {} } };
}

// ─── Buffer mirror + connection state ────────────────────────────────────
let sock = null;               // the single connected Windows shim
let mirrorText = '';           // local copy of the remote field's text
let mirrorCursor = 0;
let attached = false;          // is an attachable field currently focused
let currentApp = null;         // foreground process name, for presence
let expectedEcho = null;       // text we just wrote; swallow its echo

function send(obj) {
  if (!sock || sock.destroyed) return;
  try { sock.write(JSON.stringify(obj) + '\n'); } catch (err) { log('warn', 'send failed', err); }
}

function countUnderscores(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '_') n += 1;
  return n;
}

// On every in-process host the editor fires a change event when the
// runtime writes (shell's textarea onContentChange), which keeps the
// band's previousText/lastSeenText fresh. This host's field is remote and
// the shim's write bracket rightly swallows write echoes, so the daemon —
// the layer that KNOWS what it wrote — feeds the write back itself as a
// runtime-source change event. Without this, previousText stays at the
// pre-substitution user text (which ends with `_`), the resolver's
// no-`_` → `_` transition gate never re-opens, and the SECOND consecutive
// blank silently dies — the Android R5 bug shape, pinned by
// tests/r5-consecutive-blanks.e2e.mjs. Deferred a tick to mirror real
// host-echo timing (never re-enters the resolver mid-substitution).
function echoRuntimeWrite(text, cursor) {
  setImmediate(() => {
    try { bootResult.notifyTextChange(text, cursor, 'runtime'); } catch { /* boot not ready */ }
  });
}

// Apps whose composer renders markdown markers itself at SEND time
// (Discord shows **bold** styled). For those, the runtime writes LLM
// markdown VERBATIM instead of stripping it — this host has no styling
// surface, so a strip would silently destroy the requested styling.
// Slack is deliberately NOT in the default set: its WYSIWYG composer
// only interprets markup typed live, so markers would land literal
// (users who enable Slack's "Format messages with markup" preference
// can add it via OPENCUES_MD_PASSTHROUGH_APPS).
const mdPassthroughApps = new Set(
  (process.env.OPENCUES_MD_PASSTHROUGH_APPS ?? 'discord')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
);

// ─── Boot the runtime once ───────────────────────────────────────────────
const bootResult = boot({
  hostVersion: '0.1.0',
  cwd: process.cwd(),
  getText: () => mirrorText,
  getCursorOffset: () => mirrorCursor,
  setText: (text) => {
    mirrorText = text;
    mirrorCursor = text.length;
    expectedEcho = text;
    send({ t: 'set-text', text, cursor: mirrorCursor });
    echoRuntimeWrite(text, mirrorCursor);
  },
  setCursorOffset: (offset) => {
    mirrorCursor = offset;
    send({ t: 'set-cursor', cursor: offset });
  },
  pushText: (text, cursor) => {
    mirrorText = text;
    mirrorCursor = typeof cursor === 'number' ? cursor : text.length;
    expectedEcho = text;
    send({ t: 'set-text', text, cursor: mirrorCursor });
    echoRuntimeWrite(text, mirrorCursor);
  },
  forceRender: () => { /* phase 1: no overlay surface to repaint */ },
  readFile: async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } },
  readDir: async (p) => {
    try {
      const ents = await fsp.readdir(p, { withFileTypes: true });
      return ents.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch { return null; }
  },
  writeFile: async (p, c) => { await fsp.writeFile(p, c); },
  spawnProcess,
  blankInvoke,
  blanks: blanksRegistry,
  supportsCycling: () => false,      // phase 1 — Universal-Integration profile
  markdownPassthrough: () => attached && mdPassthroughApps.has(String(currentApp || '').toLowerCase()),
  statusFilePath: `/tmp/opencues-status-windows-${process.pid}.json`,
  statusSnapshotHook: (payload) => { updatePresence({ status: summariseStatus(payload) }); },
  log,
  llmApiKey: process.env.GROQ_API_KEY,
  llmEndpoint: process.env.OPENCUES_LLM_ENDPOINT,
  llmDefaultModel: process.env.OPENCUES_LLM_MODEL,
  llmApiKeys: {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  },
});

function summariseStatus(payload) {
  try {
    if (payload && payload.active && payload.cueBlank) return payload.cueTip || 'blank';
    if (payload && payload.active && payload.highlightedWord) return payload.highlightedWord;
  } catch {}
  return null;
}

// ─── Incoming message handling ───────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.t) {
    case 'hello': {
      log('info', 'shim connected', { shimVersion: msg.version, os: msg.os });
      // Report config + log locations (Windows-openable) so the tray's
      // "Open config folder" / "View log" menu items resolve to the RIGHT
      // .cues — the daemon is the only party that knows where it reads.
      send({
        t: 'welcome', host: 'windows', hostVersion: '0.1.0', protocol: 1,
        cuesHome: CUES_HOME, cuesHomeWin: toWinPath(CUES_HOME),
        logFile: LOG_FILE, logFileWin: toWinPath(LOG_FILE),
      });
      return;
    }
    case 'focus': {
      // Shim reports a newly-focused ATTACHABLE field (already passed
      // its editable + sensitive + deny-list checks). Focus change is a
      // hard buffer boundary — wipe per-buffer state before adopting the
      // new field, or DynDefs from the prior field silently block the
      // new one (universal-integration.md canonical bug).
      bootResult.resetBufferState();
      attached = true;
      currentApp = msg.app || null;
      mirrorText = typeof msg.text === 'string' ? msg.text : '';
      mirrorCursor = typeof msg.cursor === 'number' ? msg.cursor : mirrorText.length;
      expectedEcho = null;
      updatePresence({ app: currentApp, attached: true });
      // Seed the runtime with the field's current contents (source=user,
      // no `_` synth — focusing a field is not typing an underscore).
      bootResult.notifyTextChange(mirrorText, mirrorCursor, 'user');
      return;
    }
    case 'blur': {
      // Left an attachable field for something we don't touch (browser,
      // terminal, password box, non-editable). Detach + reset.
      if (attached) bootResult.resetBufferState();
      attached = false;
      currentApp = msg.app || null;
      mirrorText = '';
      mirrorCursor = 0;
      expectedEcho = null;
      updatePresence({ app: currentApp, attached: false });
      return;
    }
    case 'text': {
      if (!attached) return;
      const text = typeof msg.text === 'string' ? msg.text : '';
      const cursor = typeof msg.cursor === 'number' ? msg.cursor : text.length;
      // Echo suppression: this is the read-back of a value WE just wrote.
      if (expectedEcho !== null && text === expectedEcho) {
        expectedEcho = null;
        mirrorText = text;
        mirrorCursor = cursor;
        return;
      }
      expectedEcho = null;
      const prevText = mirrorText;
      const prevCursor = mirrorCursor;
      mirrorText = text;
      mirrorCursor = cursor;
      // Fresh `_` inserted → synthesise the `_` keystroke first so the
      // resolver / BlankFill explicit-`_` gate fires, exactly like the
      // event-bridge `text:` command does.
      if (countUnderscores(text) > countUnderscores(prevText)) {
        bootResult.dispatchKey({
          key: '_',
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
          text: prevText,
          cursorOffset: prevCursor,
        });
      }
      bootResult.notifyTextChange(text, cursor, 'user');
      return;
    }
    case 'cursor': {
      if (!attached) return;
      const cursor = typeof msg.cursor === 'number' ? msg.cursor : mirrorCursor;
      mirrorCursor = cursor;
      bootResult.notifyCursorChange(mirrorText, cursor, 'user');
      return;
    }
    case 'key': {
      // Phase 2 (chord interception). Wired now so the shim can start
      // sending once the keyboard hook lands; harmless in phase 1.
      if (!attached) { send({ t: 'key-result', id: msg.id, consumed: false }); return; }
      const consumed = bootResult.dispatchKey({
        key: String(msg.key || '').toLowerCase(),
        modifiers: {
          ctrl: !!(msg.mods && msg.mods.ctrl),
          alt: !!(msg.mods && msg.mods.alt),
          shift: !!(msg.mods && msg.mods.shift),
          meta: !!(msg.mods && msg.mods.meta),
        },
        text: mirrorText,
        cursorOffset: mirrorCursor,
      });
      send({ t: 'key-result', id: msg.id, consumed });
      return;
    }
    case 'ping': { send({ t: 'pong' }); return; }
    case 'log': {
      // Shim-forwarded log line — surfaces the Windows-side UIA half in
      // the SAME /tmp/opencues.log as the daemon, tagged [windows][shim]
      // so hidden-tray runs are still diagnosable. Level clamped to the
      // known set; message length-capped so a chatty shim can't flood.
      const lvl = ['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'info';
      const text = typeof msg.msg === 'string' ? msg.msg.slice(0, 500) : String(msg.msg);
      log(lvl, `[shim] ${text}`);
      return;
    }
    case 'surface': {
      // A newly-seen focused surface (see SURFACES_FILE). Dedup persistently,
      // append one TSV row per unique signature. Metadata only.
      const sig = typeof msg.sig === 'string' ? msg.sig : '';
      if (!sig || seenSurfaces.has(sig)) return;
      seenSurfaces.add(sig);
      const clean = (s) => String(s == null ? '' : s).replace(/[\t\r\n]/g, ' ').slice(0, 80);
      const row = [
        sig, clean(msg.kind), clean(msg.vp), clean(msg.tp), clean(msg.renderer),
        clean(msg.proc), clean(msg.ct), clean(msg.cls), clean(msg.name),
        new Date().toISOString(),
      ].join('\t');
      try { fs.appendFileSync(SURFACES_FILE, row + '\n'); }
      catch (err) { log('warn', 'surface catalog write failed', err); }
      log('info', `[shim] new surface: ${clean(msg.kind)} | ${clean(msg.proc)} | ${clean(msg.ct)} | ${clean(msg.cls)}`);
      return;
    }
    default:
      log('debug', 'unknown message', msg.t);
  }
}

// ─── Presence (so other OpenCues processes know we exist) ────────────────
function updatePresence(patch) {
  try {
    fs.mkdirSync(PRESENCE_DIR, { recursive: true });
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8')); } catch {}
    const next = Object.assign({
      host: 'windows',
      pid: process.pid,
      hostVersion: '0.1.0',
      port: PORT,
      startedAt: cur.startedAt || new Date().toISOString(),
    }, cur, patch, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(PRESENCE_FILE, JSON.stringify(next, null, 2));
  } catch (err) { log('warn', 'presence write failed', err); }
}
function clearPresence() { try { fs.unlinkSync(PRESENCE_FILE); } catch {} }

// ─── TCP server ──────────────────────────────────────────────────────────
const server = net.createServer((conn) => {
  // MVP: one shim at a time. A new connection supersedes the old.
  if (sock && !sock.destroyed) { try { sock.destroy(); } catch {} }
  sock = conn;
  attached = false;
  mirrorText = '';
  mirrorCursor = 0;
  log('info', 'shim socket opened');

  let buf = '';
  conn.setEncoding('utf8');
  conn.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (err) { log('warn', 'bad json from shim', line.slice(0, 120)); continue; }
      try { handleMessage(msg); } catch (err) { log('error', 'handler threw', err); }
    }
  });
  conn.on('close', () => {
    if (sock === conn) { sock = null; attached = false; mirrorText = ''; mirrorCursor = 0; }
    updatePresence({ attached: false, app: null });
    log('info', 'shim socket closed');
  });
  conn.on('error', (err) => { log('warn', 'socket error', err); });
});

server.on('error', (err) => {
  log('error', 'server error', err);
  console.error(`[opencues][windows] server error: ${err && err.message}`);
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[opencues][windows] port ${PORT} already in use — another oc-windows daemon may be running. Set OPENCUES_WIN_PORT to override.`);
    process.exit(1);
  }
});

// Config/UI HTTP server — serves the shared popup + keys/settings API.
let configServer = null;
if (Number.isFinite(CONFIG_PORT) && CONFIG_PORT > 0) {
  const uiDir = path.join(__dirname, '..', 'ui');
  configServer = startConfigServer({
    cuesHome: CUES_HOME,
    bind: HOST_BIND,
    port: CONFIG_PORT,
    uiDir: fs.existsSync(uiDir) ? uiDir : undefined,
    status: () => ({
      shimConnected: !!(sock && !sock.destroyed),
      attached,
      app: currentApp,
      hostVersion: '0.1.0',
    }),
    log,
  });
}

server.listen(PORT, HOST_BIND, () => {
  updatePresence({ attached: false });
  log('info', 'daemon listening', { bind: HOST_BIND, port: PORT, cuesHome: CUES_HOME, configPort: CONFIG_PORT });
  const hasKey = !!(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.CEREBRAS_API_KEY
    || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
  console.log(`▸ OpenCues Windows daemon listening on ${HOST_BIND}:${PORT}`);
  console.log(`  config: ${CUES_HOME}   LLM key: ${hasKey ? 'present' : 'MISSING (set GROQ_API_KEY)'}`);
  console.log(`  now start the Windows shim (from Windows PowerShell):`);
  console.log(`      powershell -ExecutionPolicy Bypass -File <repo>\\integrations\\windows\\native\\OpenCuesWindows.ps1 -Port ${PORT}`);
  console.log(`  logs: tail -f /tmp/opencues.log | grep '\\[windows\\]'`);
  console.log(`  surfaces: ${SURFACES_FILE}  (unique focused surfaces, for allow/deny filtering)`);
});

function shutdown() {
  clearPresence();
  try { bootResult.dispose(); } catch {}
  try { server.close(); } catch {}
  try { if (configServer) configServer.close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', clearPresence);

// Parent-death watchdog. When the tray app spawns this daemon it passes
// its own PID as OPENCUES_PARENT_PID. If the tray exits or crashes, we
// exit too — so "Quit" (or a tray crash) never leaves an orphaned node
// process behind. Cross-platform: process.kill(pid, 0) throws ESRCH when
// the parent is gone. No-op when launched standalone (WSL dev mode).
const PARENT_PID = parseInt(process.env.OPENCUES_PARENT_PID || '', 10);
if (Number.isFinite(PARENT_PID) && PARENT_PID > 0) {
  setInterval(() => {
    try { process.kill(PARENT_PID, 0); }
    catch { log('info', 'parent gone — shutting down', { parent: PARENT_PID }); shutdown(); }
  }, 2000).unref();
}

// Heartbeat watchdog — the cross-boundary version of the parent-PID
// watchdog. When the tray runs on Windows and spawns this daemon inside
// WSL (via wsl.exe), a Windows PID is invisible to WSL's process.kill, so
// the tray instead keeps a file fresh (touch every ~2s). If it goes stale
// (tray quit or crashed), the daemon exits — no orphaned WSL process.
// The tray creates the file BEFORE spawning us; a 4s grace avoids a
// startup race.
const HB_FILE = process.env.OPENCUES_HEARTBEAT_FILE;
const HB_TIMEOUT = parseInt(process.env.OPENCUES_HEARTBEAT_TIMEOUT_MS || '', 10) || 8000;
if (HB_FILE) {
  setTimeout(() => {
    setInterval(() => {
      let fresh = false;
      try { fresh = (Date.now() - fs.statSync(HB_FILE).mtimeMs) < HB_TIMEOUT; } catch { fresh = false; }
      if (!fresh) { log('info', 'heartbeat stale/missing — shutting down', { file: HB_FILE }); shutdown(); }
    }, 2000).unref();
  }, 4000).unref();
}
