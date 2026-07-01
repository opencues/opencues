// `opencues show [<name>]` — inspect the resolved config for a cue / blank.
//
//   opencues show            explore: pick a cue/blank → formatted detail → back
//   opencues show <name>     print the formatted detail for one name (scriptable)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, green, fileLink, banner, cliVersion, tree } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

module.exports = async function show(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let name = null;
  for (const a of argv) { if (!a.startsWith('-') && !name) name = a; }

  const paths = searchPaths();

  if (!name && prompt.isInteractive()) return explore(paths, ctx);

  if (!name) {
    console.error('opencues show: missing <name>. Try `opencues list` to find one.');
    process.exit(2);
  }

  const matches = findMatches(name, paths);
  if (matches.length === 0) {
    console.error(`opencues show: no cue/blank named "${name}" found.`);
    console.error('Run `opencues list` to see what\'s defined.');
    process.exit(1);
  }
  if (matches.length > 1) console.log(dim(`${matches.length} matches (priority order — first wins):`) + '\n');
  matches.forEach((m, i) => renderMatch(name, m, i, matches.length));
};

// ── interactive explorer: list → detail → back ──────────────────────────────
async function explore(paths, ctx) {
  for (;;) {
    const defined = enumerateNames(paths);
    if (defined.length === 0) {
      console.error('opencues show: no cues/blanks defined. Run `opencues list`.');
      process.exit(1);
    }
    const cues = defined.filter(d => d.kind === 'cue').map(d => d.name);
    const blanks = defined.filter(d => d.kind === 'blank').map(d => d.name);

    // Grouped into Cues / Blanks sections rather than one flat alpha list.
    const choices = [];
    if (cues.length) {
      choices.push({ heading: bold('Cues') });
      for (const n of cues) choices.push({ label: n, value: { name: n } });
    }
    if (blanks.length) {
      if (cues.length) choices.push({ spacer: true }); // breathing room between sections
      choices.push({ heading: bold('Blanks') });
      for (const n of blanks) choices.push({ label: n, value: { name: n } });
    }
    choices.push({ spacer: true });
    choices.push({ label: 'Done', value: { done: true }, dim: true });

    if (process.stdout.isTTY) console.clear();
    console.log(banner({ version: cliVersion(ctx), tagline: 'explore cues + blanks' }));
    console.log('');
    console.log(dim('↑↓ move · Enter open · view source, scope, and every field'));
    const pick = await prompt.select('', choices);
    if (!pick || pick.done) return;

    // Detail view for the picked name.
    const matches = findMatches(pick.name, paths);
    if (process.stdout.isTTY) console.clear();
    console.log(banner({ version: cliVersion(ctx), tagline: 'explore cues + blanks' }));
    console.log('');
    if (matches.length === 0) {
      console.log(`${tag('warn')} no readable config for "${pick.name}".`);
    } else {
      if (matches.length > 1) console.log(dim(`${matches.length} matches (priority order — first wins):`) + '\n');
      matches.forEach((m, i) => renderMatch(pick.name, m, i, matches.length));
    }
    const nav = await prompt.select('', [
      { label: 'Back to list', value: 'back' },
      { label: 'Done', value: 'done', dim: true },
    ]);
    if (nav === 'done' || nav == null) return;
  }
}

// ── formatted detail for one match ──────────────────────────────────────────
function renderMatch(name, m, i, total) {
  const { fields, body } = parseFrontmatter(readSafe(m.source));
  if (total > 1) console.log(dim(`── #${i + 1} ──`));
  const rows = [
    ['source', fileLink(tildify(m.source), m.source)],
    ['scope', scopeLabel(m.scope)],
    ...fields.map(([k, v]) => [k, truncate(v)]),
  ];
  console.log(tree({ title: `${bold(name)}  ${dim(`(${m.kind})`)}`, rows }));

  const trimmed = body.trim();
  if (trimmed) {
    const lines = trimmed.split('\n');
    const shown = lines.slice(0, 40);
    console.log('');
    console.log(dim('content:'));
    for (const l of shown) console.log('  ' + dim(l));
    if (lines.length > shown.length) console.log('  ' + dim(`… ${lines.length - shown.length} more line(s)`));
  }
  console.log('');
}

// ── helpers ─────────────────────────────────────────────────────────────────
function searchPaths() {
  const raw = [
    process.env.OPENCUES_HOME,
    path.join(process.cwd(), '.cues'),
    path.join(os.homedir(), '.cues'),
  ].filter(Boolean).filter(p => fs.existsSync(p));
  // Dedup by real path so e.g. OPENCUES_HOME === ~/.cues doesn't double-count.
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    let r; try { r = fs.realpathSync(p); } catch { r = p; }
    if (!seen.has(r)) { seen.add(r); out.push(p); }
  }
  return out;
}

const FILE_BY_SUB = { cues: 'CUE.md', blanks: 'BLANK.md' };

// Every match for a name across search paths, in priority order (first wins).
function findMatches(name, paths) {
  const matches = [];
  for (const dir of paths) {
    for (const sub of ['cues', 'blanks']) {
      const primary = FILE_BY_SUB[sub];
      const candidate = [primary, primary.toLowerCase(), 'cue.md']
        .map(f => path.join(dir, sub, name, f))
        .find(p => fs.existsSync(p));
      if (candidate) matches.push({ kind: sub.replace(/s$/, ''), source: candidate, scope: dir });
    }
    for (const file of ['CUES.md', 'BLANKS.md']) {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) continue;
      const content = readSafe(p);
      if (new RegExp(`^###\\s+${escapeRe(name)}\\b`, 'm').test(content)
       || new RegExp(`^\\s*${escapeRe(name)}:`, 'm').test(content)) {
        matches.push({ kind: file.replace(/\.md$/, '').replace(/s$/, ''), source: p, scope: dir });
      }
    }
  }
  return matches;
}

// Folder-based cue/blank names across every search path (deduped, sorted).
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

// Split the first `---` frontmatter block into [key, value] rows + the body.
function parseFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fields: [], body: content };
  const fields = [];
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue; // blank / comment
    const kv = line.match(/^([A-Za-z][\w.-]*)\s*:\s*(.*)$/);
    if (kv) fields.push([kv[1], kv[2].trim()]);
  }
  return { fields, body: m[2] || '' };
}

function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function tildify(p) { const h = os.homedir(); return p.startsWith(h) ? '~' + p.slice(h.length) : p; }
function scopeLabel(dir) {
  const h = os.homedir();
  if (dir === path.join(h, '.cues')) return `${green('user')}  ${dim('(~/.cues)')}`;
  if (dir === path.join(process.cwd(), '.cues')) return `${green('project')}  ${dim(tildify(dir))}`;
  return dim(tildify(dir));
}
function truncate(v) { return v.length > 66 ? v.slice(0, 63) + dim('…') : v; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function printHelp() {
  console.log('opencues show [<name>]');
  console.log('');
  console.log('Inspect the resolved config for a cue/blank across all search paths');
  console.log('(priority order — first match is what the runtime uses).');
  console.log('');
  console.log('  (no name)   explore: pick a cue/blank, view a formatted detail, go back');
  console.log('  <name>      print the formatted detail for one name (scriptable)');
  console.log('');
  console.log('Use `opencues list` to see what\'s defined.');
}
