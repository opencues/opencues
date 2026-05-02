// Helpers for seed-configs target-state classification, extracted from
// install.cjs so vitest can exercise the rules directly.
//
// The single rule that matters for users: a 0-byte FILE counts as missing.
// The runtime parses an empty config file as "no config" and silently no-ops
// (e.g. an empty ~/.opencuesrc makes "opencues ___" / "config ___"
// blank-fills look broken on every native host). Re-seeding 0-byte files
// makes that failure mode impossible. Directories always count as present —
// fs.stat.size on a directory reports the entry size, not contents.

'use strict';
const fs = require('node:fs');

/**
 * Decide whether the user-level seed target should be skipped (already
 * present with content) or re-seeded from the repo source.
 *
 *   true  → skip   (file exists with content, OR directory exists)
 *   false → seed   (missing OR file is 0 bytes)
 */
function targetExistsWithContent(dst) {
  if (!fs.existsSync(dst)) return false;
  const st = fs.statSync(dst);
  return st.isDirectory() || st.size > 0;
}

module.exports = { targetExistsWithContent };
