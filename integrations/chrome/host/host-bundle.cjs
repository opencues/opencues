// The bundle the native-messaging host pushes into chrome.storage: every
// file the extension's runtime reads out of the cues dir, by its path
// relative to the dir. Extracted from host.cjs so it can be tested over a
// temp dir without spawning the host (host-bundle.test.cjs).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The 1.0 settings and identity files, pushed verbatim. */
const ROOT_FILES_1_0 = ['settings.yaml', 'identity.yaml'];
/** A 1.0 row file: `rows/<anything>.yaml` (or `.yml`, `.json`), found by its `kind`. */
const ROW_FILE = /\.(ya?ml|json)$/i;

function buildBundle(dir, core) {
  const { parseCuesMd, parseSingleCueMd, inferHostCompat, chromeHostFileList } = core;
  const files = {};
  if (!fs.existsSync(dir)) return files;

  // The full set of basenames we must push lives in @opencues/core's
  // FEATURES registry — chromeHostFileList() returns CORE_CONFIG_FILES
  // (OPENCUES.md / CUES.md / AUDITORS.md) plus every feature-gated
  // file whose FeatureSpec declares pushedBy: ['chrome-host']. Adding a
  // new pushed-by-chrome feature is one PR to feature-registry.ts;
  // this loop picks it up automatically.
  const allPushed = chromeHostFileList();

  // CUES.md (and the legacy BLANKS.md for migration-period users) need
  // host-compat filtering — their entries may carry on-host /
  // not-on-host markers that exclude chrome. Every other registry file
  // is host-neutral schema (settings / auditor configs / user data)
  // and passes through verbatim.
  const FILTERED_FILES = new Set(['CUES.md', 'BLANKS.md']);
  const passThroughList = allPushed.filter(f => !FILTERED_FILES.has(f));
  const filteredList = ['CUES.md', 'BLANKS.md'];  // BLANKS.md is legacy, not in registry

  // Filtered pass — include the file when any section is chrome-compatible
  // (or sections empty).
  for (const filename of filteredList) {
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

  // Pass-through pass — every registry-pushed file that isn't filtered.
  // Today: OPENCUES.md, AUDITORS.md, IDENTITY.md. Tomorrow: whatever you
  // add to feature-registry.ts with pushedBy: ['chrome-host'].
  for (const filename of passThroughList) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try { files[filename] = fs.readFileSync(p, 'utf8'); } catch { /* skip */ }
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

  // 1.0: settings.yaml and identity.yaml verbatim, as OPENCUES.md and
  // IDENTITY.md are; every row file under rows/ (any depth), the rows
  // scoping themselves by `hosts:` in the runtime's loader. A command's
  // script and its data stay on disk: the host runs them by exec.
  for (const filename of ROOT_FILES_1_0) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try { files[filename] = fs.readFileSync(p, 'utf8'); } catch { /* skip */ }
  }
  const rows = path.join(dir, 'rows');
  if (fs.existsSync(rows) && fs.statSync(rows).isDirectory()) {
    walkFolder(rows, (file) => {
      if (!ROW_FILE.test(file)) return;
      try { files[path.posix.join('rows', path.relative(rows, file).split(path.sep).join('/'))] = fs.readFileSync(file, 'utf8'); } catch { /* skip */ }
    });
  }

  // The reference tables and transforms a dir declares before 1.0:
  // tables/<name>/TABLE.md, transforms/<name>/TRANSFORM.md.
  for (const [subdir, filename] of [['tables', 'TABLE.md'], ['transforms', 'TRANSFORM.md']]) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(sub, entry.name, filename);
      if (!fs.existsSync(p)) continue;
      try { files[`${subdir}/${entry.name}/${filename}`] = fs.readFileSync(p, 'utf8'); } catch { /* skip */ }
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

module.exports = { buildBundle, ROOT_FILES_1_0 };
