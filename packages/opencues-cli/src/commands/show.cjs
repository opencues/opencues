// `opencues show <name>` — print the resolved config for a single
// cue / blank by name, with its source file.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { dim } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

module.exports = async function show(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let name = null;
  for (const a of argv) { if (!a.startsWith('-') && !name) name = a; }

  const HOME = os.homedir();
  const paths = [
    process.env.OPENCUES_HOME,
    path.join(process.cwd(), '.cues'),
    path.join(HOME, '.cues'),
  ].filter(Boolean).filter(p => fs.existsSync(p));

  // Interactive: pick from every defined cue/blank when no name is given.
  if (!name && prompt.isInteractive()) {
    const defined = enumerateNames(paths);
    if (defined.length === 0) {
      console.error('opencues show: no cues/blanks defined. Run `opencues list`.');
      process.exit(1);
    }
    const nameW = Math.max(4, ...defined.map(d => d.name.length));
    console.log(dim('Show which cue / blank?  ·  ↑↓ move · Enter select'));
    name = await prompt.select('', [
      ...defined.map(d => ({ label: `${d.name.padEnd(nameW)}   ${dim(d.kind)}`, value: d.name })),
      { spacer: true },
      { label: 'Cancel', value: null, dim: true },
    ]);
    if (!name) return;
    console.log('');
  }

  if (!name) {
    console.error('opencues show: missing <name>. Try `opencues list` to find one.');
    process.exit(2);
  }

  // Search every kind across every path. Print all matches in priority
  // order so the user sees the override chain. Per the standard the
  // per-folder file is uppercase (CUE.md / BLANK.md); tolerate the
  // lowercase legacy + the cross-type cue.md fallback so a half-
  // migrated user-level dir still resolves rather than 404s.
  const FILE_BY_SUB = { cues: 'CUE.md', blanks: 'BLANK.md' };
  const matches = [];
  for (const dir of paths) {
    for (const sub of ['cues', 'blanks']) {
      const primary = FILE_BY_SUB[sub];
      const candidate = [primary, primary.toLowerCase(), 'cue.md']
        .map(f => path.join(dir, sub, name, f))
        .find(p => fs.existsSync(p));
      if (candidate) {
        matches.push({ kind: sub.replace(/s$/, ''), source: candidate, scope: dir });
      }
    }
    for (const file of ['CUES.md', 'BLANKS.md']) {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      // crude name match — `### name` or `name:` in blanks block
      if (new RegExp(`^###\\s+${escapeRe(name)}\\b`, 'm').test(content)
       || new RegExp(`^\\s*${escapeRe(name)}:`, 'm').test(content)) {
        matches.push({ kind: file.replace(/\.md$/, '').replace(/s$/, ''), source: p, scope: dir });
      }
    }
  }

  if (matches.length === 0) {
    console.error(`opencues show: no cue/blank named "${name}" found.`);
    console.error('Run `opencues list` to see what\'s defined.');
    process.exit(1);
  }

  console.log(`Matches for "${name}" (in priority order; first wins):\n`);
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    console.log(`──── #${i + 1} (${m.kind}) ────`);
    console.log(`Source: ${m.source}`);
    console.log(`Scope:  ${m.scope}\n`);
    console.log(fs.readFileSync(m.source, 'utf8').trimEnd());
    console.log('');
  }
};

// Enumerate folder-based cue/blank names across every search path (deduped,
// sorted) — the pick list when `show` is run with no name.
function enumerateNames(paths) {
  const seen = new Set();
  const out = [];
  for (const dir of paths) {
    for (const sub of ['cues', 'blanks']) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true }); } catch {}
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const key = `${sub}:${e.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: e.name, kind: sub.replace(/s$/, '') });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function printHelp() {
  console.log('opencues show <name>');
  console.log('');
  console.log('Print every config (across all search paths) for a single cue/blank');
  console.log('by name. Order is precedence — first match is what the runtime uses.');
  console.log('');
  console.log('Use `opencues list` to find available names.');
}
