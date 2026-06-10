#!/usr/bin/env node
// build-shipped-manifest.cjs — emit a SHA-256 manifest of every file
// under `defaults/blanks/<name>/` so the doctor can tell whether the
// user's `~/.cues/blanks/<name>/` is the shipped artefact untouched
// or has been modified (locally or by a pack masquerading under a
// shipped name).
//
// Why: blanks like `volume` and `brightness` can't run under a strict
// sandbox — they need system-binary access (Core Audio on Windows,
// xrandr on Linux) that bubblewrap can't grant. They legitimately
// declare `sandbox: off`. Without this manifest, the doctor's F9
// check flags them indefinitely AND the warning becomes noise: users
// learn to ignore the line, hiding any genuinely user-modified
// `sandbox: off` blank that DOES warrant attention.
//
// With the manifest: doctor categorises each scripted blank as
// `strict` (declared) / `shipped-intact` (hash-matches every file
// we shipped) / `user-modified`. The user-modified count is the one
// that triggers the warning. A malicious pack that ships a hostile
// `volume-blank.sh` doesn't get the exemption because its content
// hash won't match.
//
// Threat model: the manifest is shipped from the same git history
// as the runtime + the scripts themselves, so a repo compromise
// invalidates everything in lockstep. The exemption rests on the
// same trust the user gave when they ran `opencues install`.
// See docs/architecture/security-audit.md row for the audit entry.
//
// Output: packages/opencues-core/dist/shipped-manifest.json
// Schema: { version: 1, generatedAt, blanks: { <name>: { <file>: <sha256> } } }

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULTS_BLANKS = path.join(REPO_ROOT, 'defaults', 'blanks');
const OUT = path.join(REPO_ROOT, 'packages/opencues-core/dist/shipped-manifest.json');

// Files we DON'T include in the manifest:
//   - .exe (compiled from .cs at install time, not shipped verbatim)
//   - hidden (.gitignore artefacts, .DS_Store, etc.)
const EXCLUDE_EXT = new Set(['.exe']);
const EXCLUDE_BASENAMES = new Set(['.DS_Store']);

function sha256(absPath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(absPath));
  return h.digest('hex');
}

function shouldInclude(name) {
  if (name.startsWith('.')) return false;
  if (EXCLUDE_BASENAMES.has(name)) return false;
  const ext = path.extname(name).toLowerCase();
  if (EXCLUDE_EXT.has(ext)) return false;
  return true;
}

function buildManifest() {
  if (!fs.existsSync(DEFAULTS_BLANKS)) {
    console.error(`build-shipped-manifest: ${DEFAULTS_BLANKS} not found`);
    process.exit(1);
  }

  const blanks = {};
  const folders = fs.readdirSync(DEFAULTS_BLANKS, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const name of folders) {
    const dir = path.join(DEFAULTS_BLANKS, name);
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && shouldInclude(d.name))
      .map(d => d.name)
      .sort();
    if (files.length === 0) continue;
    blanks[name] = {};
    for (const f of files) {
      blanks[name][f] = sha256(path.join(dir, f));
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    blanks,
  };
}

const manifest = buildManifest();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`build-shipped-manifest: ${Object.keys(manifest.blanks).length} blank(s), ${OUT}`);
