// fork-paths.cjs — the SINGLE source of truth for where patched integration
// forks live on disk.
//
// Patched host forks (Claude Code, OpenCode, Gemini CLI) used to be scattered
// at the top of $HOME (`~/claude-code-cues`, `~/opencode-cues`,
// `~/gemini-cli-cues`), inconsistent with the other OpenCues-owned dirs that
// already live under `~/.opencues/` (vendored bun/tmux, the npm-path repo
// clone). They now live under `~/.opencues/forks/<host>/` — one folder to
// manage, matching the existing convention.
//
// EVERY path derivation goes through this module. `lint-fork-paths.sh` fails CI
// if any other file constructs a `~/<host>-cues` path, so a missed site can't
// silently point at the wrong place. During the transition, `resolveForkDir`
// falls back to a legacy top-level dir if the new one doesn't exist yet, so an
// existing install keeps working until the user's next `opencues install`.

'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/** Hosts that have an on-disk fork (shell + chrome are in-repo, not forks). */
const FORK_HOSTS = ['claude-code', 'opencode', 'gemini-cli'];

/** Per-host support subdir INSIDE the fork (statusline, tweakcc state, marker). */
const SUPPORT_SUBDIR = {
  'claude-code': '.cues',
  opencode: '.opencues',
  'gemini-cli': '.opencues',
};

/** Legacy top-level dir basename per host (pre-consolidation). Referenced only
 *  here — this is the one file allowed to name the old layout. */
const LEGACY_BASENAME = {
  'claude-code': 'claude-code-cues',
  opencode: 'opencode-cues',
  'gemini-cli': 'gemini-cli-cues',
};

function home() { return os.homedir(); }

/** `~/.opencues` — the OpenCues home (already holds vendor/ + repo/). */
function opencuesHome() { return path.join(home(), '.opencues'); }

/** `~/.opencues/forks` — the parent of every fork. */
function forksRoot() { return path.join(opencuesHome(), 'forks'); }

/** New canonical fork dir: `~/.opencues/forks/<host>` (or `<host>-<suffix>`
 *  for a dev fork, e.g. `claude-code-150`). */
function forkDir(host, suffix) {
  const name = suffix ? `${host}-${suffix}` : host;
  return path.join(forksRoot(), name);
}

/** Legacy top-level fork dir: `~/<host>-cues` (transition fallback only). */
function legacyForkDir(host, suffix) {
  const base = LEGACY_BASENAME[host];
  if (!base) return null;
  return path.join(home(), suffix ? `${base}-${suffix}` : base);
}

/** The support subdir path inside a fork dir (given the fork root). */
function supportDir(host, forkRoot) {
  return path.join(forkRoot, SUPPORT_SUBDIR[host] || '.opencues');
}

/**
 * Resolve the fork dir a READ-path command should use: the new location if it
 * exists on disk, else the legacy location if THAT exists, else the new
 * location (the default target for a fresh install). This keeps existing
 * installs working through the transition without a forced migration.
 */
function resolveForkDir(host, suffix) {
  const neu = forkDir(host, suffix);
  try { if (fs.existsSync(neu)) return neu; } catch { /* fall through */ }
  const legacy = legacyForkDir(host, suffix);
  try { if (legacy && fs.existsSync(legacy)) return legacy; } catch { /* fall through */ }
  return neu;
}

/** True when a legacy top-level fork dir still exists (doctor flags these). */
function legacyForkExists(host, suffix) {
  const legacy = legacyForkDir(host, suffix);
  try { return !!legacy && fs.existsSync(legacy); } catch { return false; }
}

/**
 * Every CC fork dir on disk (canonical + `<host>-<suffix>` dev forks), across
 * BOTH the new `~/.opencues/forks/` location and the legacy `~/claude-code-cues*`
 * layout — so the install fan-out and drift checks see them all during the
 * transition. Returns absolute dir paths; caller inspects them for a real
 * binary. Deduped by realpath.
 */
function enumerateForkDirs(host) {
  const base = host; // 'claude-code'
  const found = new Set();
  // New location: entries under ~/.opencues/forks/ starting with the host name.
  try {
    for (const e of fs.readdirSync(forksRoot(), { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith(base)) found.add(path.join(forksRoot(), e.name));
    }
  } catch { /* forks dir may not exist yet */ }
  // Legacy location: ~/<host>-cues*.
  const legacyBase = LEGACY_BASENAME[host];
  if (legacyBase) {
    try {
      for (const e of fs.readdirSync(home(), { withFileTypes: true })) {
        if (e.isDirectory() && e.name.startsWith(legacyBase)) found.add(path.join(home(), e.name));
      }
    } catch { /* HOME unreadable */ }
  }
  return [...found];
}

/**
 * Migrate a legacy top-level fork (`~/<host>-cues`) to the new
 * `~/.opencues/forks/<host>` location. Called at the START of an install so the
 * old dir never lingers as a multi-GB orphan (the whole point of the move):
 *   • new dir absent  → RENAME legacy → new (instant on the same fs; preserves
 *     the checkout so the install doesn't re-clone gigabytes).
 *   • new dir present → the legacy is a stale orphan (already reinstalled) →
 *     REMOVE it.
 * Best-effort + logged; never throws into the installer. Returns a short status
 * string (or null when there was nothing to do).
 */
function migrateLegacyFork(host, log) {
  const legacy = legacyForkDir(host);
  if (!legacy) return null;
  let legacyExists = false;
  try { legacyExists = fs.existsSync(legacy); } catch { /* unreadable */ }
  if (!legacyExists) return null;
  const neu = forkDir(host);
  try {
    if (!fs.existsSync(neu)) {
      fs.mkdirSync(path.dirname(neu), { recursive: true });
      fs.renameSync(legacy, neu);
      const msg = `migrated fork ${legacy} → ${neu}`;
      if (log) log(msg);
      return msg;
    }
    fs.rmSync(legacy, { recursive: true, force: true });
    const msg = `removed legacy fork orphan ${legacy}`;
    if (log) log(msg);
    return msg;
  } catch (e) {
    // A cross-device rename (legacy + new on different filesystems) or a
    // permission issue — degrade to leaving the legacy in place; doctor still
    // flags it. Never break the install for a cleanup.
    if (log) log(`legacy-fork migration skipped for ${host}: ${(e && e.message) || e}`);
    return null;
  }
}

module.exports = {
  FORK_HOSTS,
  SUPPORT_SUBDIR,
  home,
  opencuesHome,
  forksRoot,
  forkDir,
  legacyForkDir,
  supportDir,
  resolveForkDir,
  legacyForkExists,
  enumerateForkDirs,
  migrateLegacyFork,
};
