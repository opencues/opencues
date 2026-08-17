// is-wsl — the one WSL predicate.
//
// WHY THIS EXISTS
//
// There were seven near-copies: `sync.cjs`, `which.cjs`, `install.cjs`,
// `openrouter-oauth.cjs`, chrome's `bin/install.cjs`, and FOUR inline
// anonymous functions inside `doctor.cjs`. They had already drifted — most
// read `/proc/sys/kernel/osrelease`, doctor's read `/proc/version`, and
// `openrouter-oauth.cjs` checked only the env vars and so answered false on a
// WSL machine that had not exported them.
//
// The drift also made the behaviour untestable, which is how it surfaced.
// `sync.test.cjs` and `which.test.cjs` both simulate "not under WSL" by
// deleting `WSL_DISTRO_NAME` and `WSL_INTEROP` — reasonable, and not enough,
// because the /proc read still returns the truth on a real WSL box. Those two
// tests therefore FAILED for every WSL developer and PASSED on CI's Linux
// runners: `pre-pr.sh` showed red on every change regardless of the change,
// which trains people to stop reading it.
//
// So detection lives here once, with a seam tests can drive — the same
// pattern `@opencues/core` uses for its CLI-binary probe
// (`setCliAvailabilityForTests`).

'use strict';

const fs = require('node:fs');

// Both files are checked because they disagree in practice: some kernels
// carry the marker in one and not the other, and the previous copies were
// split across the two with no stated reason.
const PROC_FILES = ['/proc/sys/kernel/osrelease', '/proc/version'];
const MARKER = /microsoft|wsl/i;

// Test override. `null` = ask the machine.
let _forced = null;

/**
 * Are we running under WSL?
 *
 * Env vars first (cheap, and set by WSL itself), then the /proc markers,
 * which are what make this true even in a shell that did not inherit them —
 * a login shell spawned by `wsl.exe -- node …`, for instance.
 */
function isWsl() {
  if (_forced !== null) return _forced;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  for (const f of PROC_FILES) {
    try {
      if (MARKER.test(fs.readFileSync(f, 'utf8'))) return true;
    } catch { /* absent on macOS and non-Linux — keep looking */ }
  }
  return false;
}

/**
 * Force the answer for a test.
 *
 * Clearing the env vars is NOT sufficient on a real WSL machine, because the
 * /proc markers still report the truth. Any test asserting the not-under-WSL
 * branch must use this, or it only passes on non-WSL hardware.
 *
 * Always restore in an `afterEach` — a leaked override silently changes every
 * later test in the process.
 */
function setWslForTests(value) {
  _forced = typeof value === 'boolean' ? value : null;
}

/** Hand detection back to the machine. */
function resetWslForTests() {
  _forced = null;
}

module.exports = { isWsl, setWslForTests, resetWslForTests };
