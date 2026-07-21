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
const { mergeRenderDirectives } = require('./render-wire.cjs');

// ─── Config ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.OPENCUES_WIN_PORT || '', 10) || 51789;
// Phase 2 (cycling + overlay + real caret). ON by default on this branch;
// OPENCUES_WIN_PHASE2=0 restores the phase-1 Universal-Integration profile.
const PHASE2 = process.env.OPENCUES_WIN_PHASE2 !== '0';
// Overlay dim treatment, shipped to the shim in every `render` message so
// the looks can be compared without a Windows-side rebuild:
//   live      — DEFAULT. Per-span DWM thumbnails: a live, sharp, GPU-
//               composited mirror of the word itself at partial opacity
//               over a gray underlay. Caret blink / selections / edits
//               show through in real time — no capture, no cache, no
//               staleness by construction (spike-proven 2026-07-21).
//   capture   — snapshot fallback: PrintWindow/screen-grab the word and
//               redraw its pixels luminance-dimmed.
//   underline — thin gray line under cue words (Grammarly-style)
//   wash      — translucent gray rectangle over the word
const OVERLAY_STYLES = ['live', 'capture', 'underline', 'wash'];
const OVERLAY_STYLE_RAW = String(process.env.OPENCUES_WIN_OVERLAY_STYLE || 'live').toLowerCase();
const OVERLAY_STYLE = OVERLAY_STYLES.includes(OVERLAY_STYLE_RAW) ? OVERLAY_STYLE_RAW : 'live';
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
// Phase 2: shim-reported per-field capability — true when the focused
// field is UIA-attached with a TextPattern, i.e. the shim can intercept
// Ctrl+Alt+arrows and paint the overlay from bounding rects. Feeds the
// adapter's supportsCycling() (the resolver folds the answer into its
// build key, so a flip rebuilds the source set automatically).
let fieldCycling = false;
// Same-field resume across a blur (phase 2). The buffer-state reset is
// DEFERRED from blur to the next focus: if the user clicks away and
// straight back to the SAME field with UNCHANGED text, the runtime's
// spans (word-cue dims, substitution DynDefs, satellite pairs) survive
// and the overlay repaints instantly — no reset, no re-resolve, no
// LLM round-trip. Any different field or changed text on the next
// focus performs the full reset there instead. A→B→A does NOT resume
// (B's adoption reset A's state) — per-field snapshots are a possible
// later extension.
let attachedFieldId = null;    // shim-reported stable field id while attached
let lastBlurFieldId = null;    // field we were on when focus left
let lastBlurTextNorm = null;   // its text at blur (normBuf'd)

function send(obj) {
  if (!sock || sock.destroyed) return;
  try { sock.write(JSON.stringify(obj) + '\n'); } catch (err) { log('warn', 'send failed', err); }
}

function countUnderscores(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '_') n += 1;
  return n;
}

// ─── Self-heal 1: recent-writes registry ─────────────────────────────────
// The daemon writes EVERY byte the field shows during a resolve — each
// loading-animation frame AND the final substitution, all via
// setText/pushText. The Windows edit control hands those writes back to
// us mangled (CR for LF, injected zero-width U+FEFF, spinner-frame
// churn), so a naive equality echo-check misses them, the daemon treats
// its OWN output as fresh user typing, re-resolves it, and loops forever
// ("stuck mid animation"). Fix: record every write (normalized); any
// incoming text that matches a recent write is OUR echo — swallowed, never
// resolved. Because the daemon authored every frame, this catches all of
// them regardless of socket/poll timing (unlike the timing-based bracket).
const RECENT_WRITE_TTL_MS = 4000;
const recentWrites = [];   // { norm, at }
function normBuf(s) {
  return String(s)
    .replace(/[\ufeff\u200b\u200c]/g, '')   // zero-width chars the control injects
    .replace(/\r\n?/g, '\n');               // CR / CRLF the control returns for our LF
}
function noteWrite(text) {
  const now = Date.now();
  recentWrites.push({ norm: normBuf(text), at: now });
  // prune
  while (recentWrites.length && now - recentWrites[0].at > RECENT_WRITE_TTL_MS) recentWrites.shift();
  if (recentWrites.length > 64) recentWrites.splice(0, recentWrites.length - 64);
}
function isRecentWrite(text) {
  const now = Date.now();
  const n = normBuf(text);
  for (let i = recentWrites.length - 1; i >= 0; i--) {
    if (now - recentWrites[i].at > RECENT_WRITE_TTL_MS) break;
    if (recentWrites[i].norm === n) return true;
  }
  return false;
}

// ─── Self-heal 3: only a TYPED `_` fires a blank, not a reverted one ──────
// Ctrl+Z on a substitution restores the `_` command text; the underscore
// count rises again and the fresh-`_` synthesis below would RE-FIRE the blank
// (observed on Discord + Slack: undo lands on `_` then re-processes). Every
// host with native undo has the same shape.
//
// The distinguishing signal is STRUCTURAL and memoryless: a genuine
// invocation INSERTS `_` into the text you're editing — the prior buffer
// survives intact as the prefix+suffix around the inserted `_` (a "pure
// insertion"). An undo / redo / paste REVERTS the whole buffer, so the pre-`_`
// content is wholesale-replaced (the prior buffer is NOT preserved). We fire
// only on a pure insertion. This needs no record of prior results — so it's
// robust to apps like Slack that re-render the buffer (we never have to
// recognise a transformed result) — and a RE-RUN still fires, because
// retyping the command inserts `_` into a partial exactly like the first type.
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLen(a, b, prefix) {
  const n = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
// True when `text` is `prev` with content only INSERTED (nothing from `prev`
// removed) — a local edit at the cursor, not a wholesale buffer swap.
function isPureInsertion(prev, text) {
  const a = normBuf(prev), b = normBuf(text);
  const p = commonPrefixLen(a, b);
  const s = commonSuffixLen(a, b, p);
  return p + s >= a.length;   // all of `prev` survives as prefix+suffix
}

// ─── Self-heal 2: runaway circuit-breaker ────────────────────────────────
// Belt-and-braces: even if some write leaks the registry, a genuine
// runaway shows as many resolves on the SAME field with no human edit in
// between. Track resolve timestamps; if we exceed the threshold inside the
// window, trip the breaker — stop feeding the resolver until the field is
// quiet, then auto-reset. This is the "it heals itself" guarantee.
// A RUNAWAY resolves the SAME text over and over (our own output echoing
// back). Normal typing resolves DIFFERENT text on every keystroke, so it
// must NEVER trip the breaker — the earlier "count all resolves" version
// tripped on fast typing and swallowed the user's `_`. So: count only
// CONSECUTIVE resolves of the same normalized text; any genuinely new
// text resets the counter.
const BREAKER_SAME_TEXT_MAX = 6;   // same text resolved this many times → loop
const BREAKER_COOLDOWN_MS = 1500;
let breakerLastNorm = null;
let breakerSameCount = 0;
let breakerUntil = 0;
function breakerTrips(text) {
  const now = Date.now();
  if (now < breakerUntil) return true;   // cooling down after a real loop
  const n = normBuf(text);
  if (n === breakerLastNorm) {
    breakerSameCount += 1;
  } else {
    breakerLastNorm = n;
    breakerSameCount = 1;
    return false;                        // new text — never a loop
  }
  if (breakerSameCount > BREAKER_SAME_TEXT_MAX) {
    breakerUntil = now + BREAKER_COOLDOWN_MS;
    breakerSameCount = 0;
    log('warn', `runaway breaker TRIPPED — same text resolved ${BREAKER_SAME_TEXT_MAX}+ times; pausing ${BREAKER_COOLDOWN_MS}ms`);
    return true;
  }
  return false;
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
    // Drop superseded echoes. During a write burst (loading-animation
    // frames → underscore restore → final substitution) an echo queued
    // for an INTERMEDIATE state would deliver a STALE buffer to the
    // band's text-change handlers AFTER the final write landed —
    // stateful modules (selector-satellite clearOnEdit) read that as a
    // user edit into their span and destructively "clean up" (observed:
    // ConfigIntent's `debug-mode on` pair wiped to an empty buffer one
    // tick after substitution). Real editors can't do this to the other
    // bands — a change event always carries the buffer as it is AT
    // DELIVERY — so the daemon honours the same invariant: only the
    // newest write may echo.
    if (text !== mirrorText) return;
    try { bootResult.notifyTextChange(text, cursor, 'runtime'); } catch { /* boot not ready */ }
  });
}

// ─── Phase 2: render push (overlay dim/highlight spans) ──────────────────
// Collect the runtime's render directives against the current mirror and
// ship the flattened dim/highlight char ranges to the shim, which maps
// them to screen rects via UIA and paints the click-through overlay.
// Debounced to one collect per tick: every user event handler AND the
// adapter's forceRender (the runtime's render-kick after substitutions /
// DynDef registration) funnel through here, exactly like the other
// bands' repaint paths. On a non-cycling field the directives are empty
// (no cycleable sources were built) and the shim clears the overlay.
let renderQueued = false;
function pushRender() {
  if (!PHASE2 || renderQueued) return;
  renderQueued = true;
  setImmediate(() => {
    renderQueued = false;
    if (!sock || sock.destroyed) return;
    if (!attached) { send({ t: 'render', dim: [], hl: null, style: OVERLAY_STYLE }); return; }
    let dirs = [];
    try { dirs = bootResult.collectRenderDirectives(mirrorText, mirrorCursor); }
    catch (err) { log('warn', 'collectRenderDirectives failed', err); }
    const wire = mergeRenderDirectives(dirs);
    // Debug-level wire trace — one line per push with span counts, so
    // "marks didn't (re)appear" is diagnosable from the log alone: a
    // missing push means the runtime never re-registered (resolver
    // side); a push with dim>0 means the spans left the daemon and the
    // failure is shim-side (rect resolve / paint).
    if (wire.dim.length > 0 || wire.hl) {
      log('debug', `render push: dim=${wire.dim.length} hl=${wire.hl ? 1 : 0} textLen=${mirrorText.length}`);
    }
    send({ t: 'render', dim: wire.dim, hl: wire.hl, style: OVERLAY_STYLE });
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
    // Never ship a write with no attached field — an in-flight LLM
    // result completing after a blur would otherwise land in whatever
    // the user focused next (the shim guards its end too; this is the
    // braces half). The dropped write leaves runtime span state out of
    // sync with the real field, so poison the same-field resume — the
    // next focus does a full reset instead.
    if (!attached) {
      lastBlurFieldId = null;
      lastBlurTextNorm = null;
      log('debug', `setText dropped — no attached field (${text.length} chars; late in-flight result)`);
      return;
    }
    mirrorText = text;
    mirrorCursor = text.length;
    expectedEcho = text;
    noteWrite(text);
    send({ t: 'set-text', text, cursor: mirrorCursor });
    echoRuntimeWrite(text, mirrorCursor);
  },
  setCursorOffset: (offset) => {
    mirrorCursor = offset;
    send({ t: 'set-cursor', cursor: offset });
  },
  pushText: (text, cursor) => {
    if (!attached) {   // same drop-and-poison contract as setText above
      lastBlurFieldId = null;
      lastBlurTextNorm = null;
      log('debug', `pushText dropped — no attached field (${text.length} chars; late in-flight result)`);
      return;
    }
    mirrorText = text;
    mirrorCursor = typeof cursor === 'number' ? cursor : text.length;
    expectedEcho = text;
    noteWrite(text);
    send({ t: 'set-text', text, cursor: mirrorCursor });
    echoRuntimeWrite(text, mirrorCursor);
  },
  forceRender: () => { pushRender(); },   // phase 2: repaint = re-collect + ship spans to the overlay
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
  // Phase 2: per-field dynamic — the shim reports whether the focused
  // field can host the overlay + chord hook (UIA + TextPattern). MSAA/
  // Electron fields stay on the Universal-Integration profile.
  supportsCycling: () => PHASE2 && attached && fieldCycling,
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
      // its editable + sensitive + deny-list checks).
      const text = typeof msg.text === 'string' ? msg.text : '';
      const fieldId = typeof msg.fieldId === 'number' ? msg.fieldId : null;
      // Same-field RESUME (phase 2): the blur deferred its reset; if
      // focus returned to the exact field with unchanged text, keep the
      // runtime state (spans, satellite pairs, undo epoch) and just
      // repaint. See the lastBlurFieldId comment block.
      const resume = fieldId !== null && fieldId === lastBlurFieldId
        && lastBlurTextNorm !== null && normBuf(text) === lastBlurTextNorm;
      lastBlurFieldId = null;
      lastBlurTextNorm = null;
      if (!resume) {
        // Different field (or same field, changed text): hard buffer
        // boundary — wipe per-buffer state before adopting it, or
        // DynDefs from the prior field silently block the new one
        // (universal-integration.md canonical bug). This is also the
        // deferred half of the previous blur's reset.
        bootResult.resetBufferState();
      }
      attached = true;
      attachedFieldId = fieldId;
      currentApp = msg.app || null;
      // Phase 2: per-field cycling capability, decided by the shim at
      // attach (UIA + TextPattern → overlay + chords possible). Must be
      // set BEFORE notifyTextChange so the resolver's source (re)build
      // sees the right supportsCycling answer for this field.
      fieldCycling = msg.cycling === true;
      mirrorText = text;
      mirrorCursor = typeof msg.cursor === 'number' ? msg.cursor : mirrorText.length;
      expectedEcho = null;
      updatePresence({ app: currentApp, attached: true });
      if (resume) {
        log('debug', `focus resume — same field (${fieldId}) + unchanged text; spans preserved`);
      } else {
        // Seed the runtime with the field's current contents (source=user,
        // no `_` synth — focusing a field is not typing an underscore).
        bootResult.notifyTextChange(mirrorText, mirrorCursor, 'user');
      }
      pushRender();
      return;
    }
    case 'blur': {
      // Left an attachable field for something we don't touch (browser,
      // terminal, password box, non-editable). Detach, but DEFER the
      // buffer-state reset to the next focus so a click-away-and-back
      // to the same field can resume with its spans intact. While
      // detached, inbound text/key events are ignored (guards below)
      // and outbound writes are dropped (setText/pushText guard), so
      // the preserved state is inert until the resume/reset decision.
      if (attached) {
        lastBlurFieldId = attachedFieldId;
        lastBlurTextNorm = normBuf(mirrorText);
      }
      attached = false;
      attachedFieldId = null;
      fieldCycling = false;
      currentApp = msg.app || null;
      mirrorText = '';
      mirrorCursor = 0;
      expectedEcho = null;
      updatePresence({ app: currentApp, attached: false });
      pushRender();   // clears the overlay (attached=false → empty spans)
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
      // Self-heal 1: the read-back matches a RECENT WRITE of ours (the
      // substitution itself, mangled by the control's CR/zero-width churn).
      // It is our own output echoing back, NOT user typing — adopt it and
      // do NOT re-resolve. This stops the multi-line substitution feedback
      // loop (email → Japanese → …).
      //
      // CRITICAL GUARD: only suppress when the read-back does NOT add a `_`.
      // A substitution output removes the `_` (count can't rise), so this
      // never blocks the loop-break. But a fresh USER `_` always raises the
      // count — and the animation's own `_`-restore frame is byte-identical
      // to the user's command, so without this guard the registry would eat
      // the user's next genuine trigger ("sometimes `_` doesn't resolve").
      // Animation-frame echoes are caught by `expectedEcho` above anyway.
      if (isRecentWrite(text) && countUnderscores(text) <= countUnderscores(mirrorText)) {
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
      // Self-heal 2: circuit-breaker. Trips ONLY on the SAME text resolving
      // repeatedly (a runaway that leaked past the registry) — never on
      // normal typing (each keystroke is different text). Keeps the mirror
      // current so the next genuine edit still works.
      if (breakerTrips(text)) return;
      // Fresh `_` → synthesise the `_` keystroke so the resolver / BlankFill
      // explicit-`_` gate fires (exactly like the event-bridge `text:` command)
      // — but ONLY when the `_` was TYPED (a pure insertion into the current
      // buffer). If a `_` state was REVERTED to (undo / redo / paste wholesale-
      // replaces the buffer), do not re-fire: that's what stops Ctrl+Z on a
      // substitution from re-processing, on every app, with no result/command
      // bookkeeping. A genuine re-run inserts `_` into a partial → still fires.
      if (countUnderscores(text) > countUnderscores(prevText)) {
        if (isPureInsertion(prevText, text)) {
          bootResult.dispatchKey({
            key: '_',
            modifiers: { ctrl: false, alt: false, shift: false, meta: false },
            text: prevText,
            cursorOffset: prevCursor,
          });
        } else {
          // A `_` state was REVERTED to (undo / redo / paste wholesale-replaces
          // the buffer), not typed. Adopt the text (mirror is already updated)
          // but do NOT notifyTextChange — the resolver would re-resolve the
          // restored `_` command off its presence in the buffer (this is the
          // Ctrl+Z-re-fires-the-blank bug). getText() still returns the current
          // mirror, so the runtime's view stays correct; we just don't feed it
          // as a change event.
          log('debug', 'suppressed `_` re-fire — buffer reverted to a `_` state (undo/redo/paste), not a typed insertion');
          return;
        }
      }
      bootResult.notifyTextChange(text, cursor, 'user');
      pushRender();
      return;
    }
    case 'cursor': {
      if (!attached) return;
      const cursor = typeof msg.cursor === 'number' ? msg.cursor : mirrorCursor;
      mirrorCursor = cursor;
      bootResult.notifyCursorChange(mirrorText, cursor, 'user');
      pushRender();   // cursor-navigate mode re-picks the word under the caret
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
      pushRender();   // navigation/cycling chords move the highlight
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
  console.log(`  phase 2: ${PHASE2
    ? `on — overlay style '${OVERLAY_STYLE}' (OPENCUES_WIN_OVERLAY_STYLE=live|capture|underline|wash)`
    : 'off (OPENCUES_WIN_PHASE2=0)'}`);
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
