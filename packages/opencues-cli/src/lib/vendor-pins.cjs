// Vendored-binary version pins — single source of truth for what
// version of tmux / bun / etc. we vendor at any given time.
//
// When we bump a pin (e.g. tmux 3.4 → 3.5):
//   1. Change the constant here.
//   2. Bump oc-install-tmux's TMUX_VERSION constant to match.
//   3. Doctor flags every existing install as stale; users get a
//      "your vendored tmux is 3.4 but opencues wants 3.5 — run
//       oc-install-tmux" finding the next time they invoke doctor.
//
// Marker file layout at ~/.opencues/vendor/<tool>/version.json:
//   { "tool": "tmux", "version": "3.4", "installedAt": "..." }
//
// The marker is written by the tool's installer (oc-install-tmux for
// tmux; the vendored-bun offer for bun). Reads happen in doctor +
// inside the installers themselves to skip no-op re-installs.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Expected versions of vendored binaries. These are the canonical pins
// we test against. When a pin bumps, the doctor surface lights up
// every install that hasn't run the re-install yet.
const PINS = {
  tmux: { version: '3.4' },
  // `bun: { version: '*' }` would accept any installed bun. Set a
  // specific version when we have a baseline tested combination.
  bun:  { version: '*' },
};

function vendorDir(tool) {
  return path.join(os.homedir(), '.opencues', 'vendor', tool);
}
function markerPath(tool) {
  return path.join(vendorDir(tool), 'version.json');
}

// Write a marker for a vendored tool. `installedVersion` is the actual
// version installed (e.g. read from `tmux -V`). Non-fatal on write
// failure (the tool itself still works, we just lose drift detection).
function writeVendorMarker(tool, installedVersion) {
  try {
    const dir = vendorDir(tool);
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      tool,
      version: installedVersion,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(markerPath(tool), JSON.stringify(data, null, 2) + '\n');
    return data;
  } catch { return null; }
}

function readVendorMarker(tool) {
  try { return JSON.parse(fs.readFileSync(markerPath(tool), 'utf8')); }
  catch { return null; }
}

// Compare a tool's vendored version against the pin.
// Returns:
//   { status: 'fresh' | 'stale' | 'missing', marker, expected }
function checkVendorDrift(tool) {
  const marker = readVendorMarker(tool);
  const expected = (PINS[tool] || { version: '*' }).version;
  if (!marker) {
    // Marker missing — but the binary may still be present from a
    // pre-marker install. Check that case explicitly.
    const binCandidate = path.join(vendorDir(tool), 'bin', tool);
    if (fs.existsSync(binCandidate)) {
      return { status: 'missing', marker: null, expected, binaryPresent: true };
    }
    return { status: 'missing', marker: null, expected, binaryPresent: false };
  }
  if (expected === '*' || marker.version === expected) {
    return { status: 'fresh', marker, expected };
  }
  return { status: 'stale', marker, expected };
}

module.exports = {
  PINS,
  vendorDir,
  markerPath,
  writeVendorMarker,
  readVendorMarker,
  checkVendorDrift,
};
