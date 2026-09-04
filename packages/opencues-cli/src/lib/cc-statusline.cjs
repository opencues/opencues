// CC statusline helpers — JSON-safe enable/disable/status against
// either ~/.claude/settings.json (user) or <cwd>/.claude/settings.json
// (project).
//
// Why a separate lib: both `opencues statusline <subcommand>` and
// `opencues doctor` need to inspect the same files with the same
// recognise-our-path rules. Drift between them would surface as
// doctor saying "configured" when statusline says "not configured"
// (or vice versa). Single source of truth.
//
// Design rules (the "graceful guest" model):
//   1. Never write to a settings.json without an explicit user action
//      — every write happens through this lib, and every entry point
//      to this lib is a command the user typed.
//   2. Always back up before writing (settings.json + suffix .bak.cues-statusline).
//   3. Don't clobber a user's custom statusLine.command — if it's
//      already set to something we don't recognise, refuse with a clear
//      message + suggest --force.
//   4. Recognise our own paths broadly (current install root +
//      historic layouts) so a re-enable correctly identifies a stale
//      opencues path and overwrites it.
//   5. Disable restores nothing — we never save a "prior" command, so
//      the slot is left empty after disable. Users who had a custom
//      command before --force should know to re-set it themselves.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { enumerateForkDirs, supportDir } = require('./fork-paths.cjs');

// Resolve the absolute path to the statusline.sh script we want to
// register. Walks every CC fork on disk (new ~/.opencues/forks/ layout +
// legacy ~/claude-code-cues*), returning the first fork's statusline.sh.
// Returns null if no CC fork is installed (caller should tell the user to
// install first).
function resolveStatuslineScript() {
  const HOME = os.homedir();
  const candidates = enumerateForkDirs('claude-code').map((dir) =>
    path.join(supportDir('claude-code', dir), 'statusline.sh'),
  );
  // Pre-compact-footprint legacy layout — mirror the rules in setup.sh.
  candidates.push(path.join(HOME, '.claude', 'opencues', 'statusline.sh'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Returns true if `cmd` looks like any opencues statusline path —
// current install root OR historic layouts. Used to recognise our
// own writes without false-positives on user customisations. Covers both
// the new fork layout (`~/.opencues/forks/claude-code/.cues/statusline.sh`)
// and the legacy one (`~/claude-code-cues/.cues/statusline.sh`) via the
// `/.cues/statusline.sh` shape both share.
function isOpenCuesPath(cmd) {
  if (typeof cmd !== 'string') return false;
  return cmd.includes('.claude/highlight-statusline.sh') ||
         cmd.includes('.claude/opencues/statusline.sh') ||
         (cmd.endsWith('/statusline.sh') && cmd.includes('/.cues/'));
}

// Resolve which settings.json a given scope writes to.
//   'user'    → ~/.claude/settings.json
//   'project' → <cwd>/.claude/settings.json
function settingsPathFor(scope, cwd) {
  if (scope === 'project') {
    return path.join(cwd || process.cwd(), '.claude', 'settings.json');
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// Read JSON safely. Returns { ok, data, error }. `data` is {} when
// the file doesn't exist (a no-op merge target for write).
function readSettings(file) {
  if (!fs.existsSync(file)) return { ok: true, data: {} };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { return { ok: false, error: `read failed: ${err.message}` }; }
  if (!raw.trim()) return { ok: true, data: {} };
  try { return { ok: true, data: JSON.parse(raw) }; }
  catch (err) { return { ok: false, error: `invalid JSON: ${err.message}` }; }
}

// Atomically write JSON. Backs up to .bak.cues-statusline first if
// the file already exists. Caller is responsible for the merge.
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, file + '.bak.cues-statusline');
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// Inspect status for a single settings.json. Returns:
//   { state: 'missing'      , file, scriptPath: null }   — file doesn't exist OR no statusLine field
//   { state: 'opencues-ours', file, currentCmd, scriptPath } — already pointing at our path
//   { state: 'opencues-stale', file, currentCmd, scriptPath } — opencues path but not the current install
//   { state: 'user-custom'  , file, currentCmd, scriptPath } — user has their own command
//   { state: 'broken'       , file, error, scriptPath }   — JSON parse error
function inspect(scope, cwd) {
  const file = settingsPathFor(scope, cwd);
  const scriptPath = resolveStatuslineScript();
  const r = readSettings(file);
  if (!r.ok) return { state: 'broken', file, error: r.error, scriptPath };
  const cmd = r.data?.statusLine?.command;
  if (typeof cmd !== 'string' || !cmd) {
    return { state: 'missing', file, scriptPath };
  }
  if (cmd === scriptPath) {
    return { state: 'opencues-ours', file, currentCmd: cmd, scriptPath };
  }
  if (isOpenCuesPath(cmd)) {
    return { state: 'opencues-stale', file, currentCmd: cmd, scriptPath };
  }
  return { state: 'user-custom', file, currentCmd: cmd, scriptPath };
}

// Enable for a scope. Returns { ok, action, message }.
//   action: 'created' | 'updated' | 'replaced-stale' | 'no-op' | 'refused' | 'no-script'
function enable(scope, opts = {}) {
  const { force = false, cwd } = opts;
  const info = inspect(scope, cwd);
  if (!info.scriptPath) {
    return {
      ok: false,
      action: 'no-script',
      message: 'No installed CC fork found. Run `opencues install claude-code` first.',
    };
  }
  if (info.state === 'broken') {
    return { ok: false, action: 'refused', message: `${info.file} is unreadable (${info.error}). Fix the file or remove it, then retry.` };
  }
  if (info.state === 'opencues-ours') {
    return { ok: true, action: 'no-op', message: `Already enabled — ${info.file} statusLine.command already points at ${info.scriptPath}` };
  }
  if (info.state === 'user-custom' && !force) {
    return {
      ok: false,
      action: 'refused',
      message:
        `${info.file} has a custom statusLine.command:\n` +
        `  ${info.currentCmd}\n` +
        `Refusing to overwrite. Re-run with --force to replace it, OR set it back to your custom path after running enable.`,
    };
  }
  // Merge our statusLine into existing settings (preserve every other field).
  //
  // refreshInterval: 1 — required for CC 2.1.150+ (native binary).
  // On those versions CC's debounced statusline-refresh hook (the S6
  // seam our patch captured pre-2.1.113) is gone, so the runtime can't
  // push tip updates on demand — we're entirely dependent on CC's
  // polling. CC's default poll cadence is too slow: the active-highlight
  // window (cursor on a cued word) closes within ~1-2 seconds as the
  // user types, so a 5-30s poll misses the tip almost every time.
  // 1s is CC's minimum + makes polling indistinguishable from event-
  // driven. The script is ~5ms to run, so polling cost is negligible.
  const r = readSettings(info.file);
  const data = r.ok ? r.data : {};
  data.statusLine = { type: 'command', command: info.scriptPath, refreshInterval: 1 };
  writeSettings(info.file, data);
  if (info.state === 'missing') {
    return { ok: true, action: 'created', message: `Wrote statusLine.command to ${info.file} → ${info.scriptPath}` };
  }
  if (info.state === 'opencues-stale') {
    return { ok: true, action: 'replaced-stale', message: `Updated stale statusLine.command in ${info.file} → ${info.scriptPath} (was: ${info.currentCmd})` };
  }
  // 'user-custom' + --force
  return { ok: true, action: 'updated', message: `Replaced custom statusLine.command in ${info.file} → ${info.scriptPath} (was: ${info.currentCmd}; backup at ${info.file}.bak.cues-statusline)` };
}

// Disable for a scope. Removes the statusLine field entirely if it
// points at our path. Refuses if it points elsewhere (user's own).
function disable(scope, opts = {}) {
  const { cwd } = opts;
  const info = inspect(scope, cwd);
  if (info.state === 'missing') {
    return { ok: true, action: 'no-op', message: `Already disabled — ${info.file} has no statusLine field.` };
  }
  if (info.state === 'broken') {
    return { ok: false, action: 'refused', message: `${info.file} is unreadable (${info.error}).` };
  }
  if (info.state === 'user-custom') {
    return {
      ok: false,
      action: 'refused',
      message: `${info.file} statusLine.command points at a non-opencues script (${info.currentCmd}). Refusing to remove — not ours to touch.`,
    };
  }
  // opencues-ours OR opencues-stale → remove the field, write back.
  const r = readSettings(info.file);
  const data = r.ok ? r.data : {};
  delete data.statusLine;
  writeSettings(info.file, data);
  return { ok: true, action: 'cleared', message: `Cleared statusLine from ${info.file} (was: ${info.currentCmd}; backup at ${info.file}.bak.cues-statusline)` };
}

// Does the script a statusLine.command points at actually exist?
// The command is a shell string ("bash /path/x.sh", "/path/x.sh --flag"),
// so we stat every absolute-path token. Tri-state:
//   'exists'  — at least one absolute-path token resolves
//   'missing' — absolute-path token(s) present, none resolve (the
//               dead-script class: a retired fork layout like
//               ~/claude-code-cues left settings pointing at nothing,
//               and CC silently paints NO statusline — Sep 2026)
//   'unknown' — no absolute-path token (bare command on $PATH); not ours
//               to judge, never flag.
function commandScriptExists(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return 'unknown';
  const home = os.homedir();
  const tokens = cmd.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
  const pathTokens = tokens
    .map((t) => (t.startsWith('~/') ? path.join(home, t.slice(2)) : t))
    .filter((t) => path.isAbsolute(t));
  if (pathTokens.length === 0) return 'unknown';
  return pathTokens.some((t) => fs.existsSync(t)) ? 'exists' : 'missing';
}

// Machine-wide sweep for dead statusLine commands. CC registers every
// project dir it has run in under ~/.claude.json `projects`; each may
// carry its own .claude/settings.json whose statusLine SHADOWS the
// user-level one for sessions launched there. A stale entry (e.g. the
// retired ~/claude-code-cues layout) means "no statusline, only in this
// one directory" — invisible to a cwd-scoped doctor run. Returns only
// the broken rows: { dir, file, cmd, opencues } with cmd's script missing.
function auditProjectStatuslines() {
  const out = [];
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  } catch {
    return out; // no registry / unreadable — nothing to sweep
  }
  for (const dir of Object.keys(reg?.projects ?? {})) {
    const file = path.join(dir, '.claude', 'settings.json');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // no project settings / unreadable — the cwd-scoped row covers parse errors
    }
    const cmd = data?.statusLine?.command;
    if (typeof cmd !== 'string' || !cmd) continue;
    if (commandScriptExists(cmd) === 'missing') {
      out.push({ dir, file, cmd, opencues: isOpenCuesPath(cmd) });
    }
  }
  return out;
}

module.exports = {
  resolveStatuslineScript,
  isOpenCuesPath,
  settingsPathFor,
  inspect,
  enable,
  disable,
  commandScriptExists,
  auditProjectStatuslines,
};
