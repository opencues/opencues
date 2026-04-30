// `opencues show <name>` — print the resolved config for a single
// cue / blank / control by name, with its source file.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

module.exports = function show(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let name = null;
  for (const a of argv) { if (!a.startsWith('-') && !name) name = a; }
  if (!name) {
    console.error('opencues show: missing <name>. Try `opencues list` to find one.');
    process.exit(2);
  }

  const HOME = os.homedir();
  const paths = [
    process.env.OPENCUES_HOME,
    path.join(process.cwd(), '.opencues'),
    path.join(HOME, '.opencues'),
  ].filter(Boolean).filter(p => fs.existsSync(p));

  // Search every kind across every path. Print all matches in priority
  // order so the user sees the override chain.
  const matches = [];
  for (const dir of paths) {
    for (const sub of ['cues', 'blanks']) {
      const candidate = path.join(dir, sub, name, 'cue.md');
      if (fs.existsSync(candidate)) {
        matches.push({ kind: sub.replace(/s$/, ''), source: candidate, scope: dir });
      }
    }
    for (const file of ['cues.md', 'blanks.md']) {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      // crude name match — `### name` or `name:` in controls block
      if (new RegExp(`^###\\s+${escapeRe(name)}\\b`, 'm').test(content)
       || new RegExp(`^\\s*${escapeRe(name)}:`, 'm').test(content)) {
        matches.push({ kind: file.replace(/\.md$/, '').replace(/s$/, ''), source: p, scope: dir });
      }
    }
  }

  if (matches.length === 0) {
    console.error(`opencues show: no cue/blank/control named "${name}" found.`);
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

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function printHelp() {
  console.log('opencues show <name>');
  console.log('');
  console.log('Print every config (across all search paths) for a single cue/blank/control');
  console.log('by name. Order is precedence — first match is what the runtime uses.');
  console.log('');
  console.log('Use `opencues list` to find available names.');
}
