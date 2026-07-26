'use strict';

// ─── Render-directive → wire mapping (phase 2 overlay) ───────────────────
//
// MOVED. The implementation now lives in the runtime at
// packages/opencues-runtime/src/render-wire.ts, because the mac overlay needs
// byte-identical flattening and CLAUDE.md's rule is to extract in the same PR
// that adds the second copy rather than let two hand-maintained copies drift.
//
// This file stays as a thin re-export so hostd's `require('./render-wire.cjs')`
// and tests/render-wire-invariants.mjs keep working unchanged.
//
// Wire shape (unchanged): { dim: [[start, end], ...], hl: [start, end] | null }
// — char offsets into the daemon's mirror text.
//
// Resolution mirrors hostd's pkgRoot: prefer the installed package, fall back
// to the repo-relative path. This integration has no node_modules/@opencues of
// its own (it runs from a clone), so a bare '@opencues/runtime/...' require
// resolves in a workspace and fails everywhere else.

const path = require('node:path');

function runtimeRoot() {
  try { return path.dirname(require.resolve('@opencues/runtime/package.json')); }
  catch { return path.resolve(__dirname, '../../../packages/opencues-runtime'); }
}

const { mergeRenderDirectives } = require(path.join(runtimeRoot(), 'dist/src/render-wire.js'));

module.exports = { mergeRenderDirectives };
