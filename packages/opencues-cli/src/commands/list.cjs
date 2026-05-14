// `opencues list` — list cues / blanks across search paths, with their
// source file. Useful for "what's actually going to fire?"

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { banner, cliVersion, fileLink, bold, dim, accent, G } = require('../lib/style.cjs');

module.exports = function list(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const onlyKind =
    argv.includes('--cues')   ? 'cue'   :
    argv.includes('--blanks') ? 'blank' :
    null;
  const showAll = argv.includes('--all') || argv.includes('-a');

  let parseCuesMd, parseSingleCueMd, inferHostCompat, formatHostList;
  try {
    const core = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js'));
    parseCuesMd = core.parseCuesMd;
    parseSingleCueMd = core.parseSingleCueMd;
    inferHostCompat = core.inferHostCompat;
    formatHostList = core.formatHostList;
  } catch (err) {
    console.error('opencues list: failed to load @opencues/core (run `pnpm build`):', err.message);
    process.exit(1);
  }

  const HOME = os.homedir();
  // Same precedence as ConfigLoader.
  const paths = [
    process.env.OPENCUES_HOME,
    path.join(process.cwd(), '.cues'),
    path.join(HOME, '.cues'),
  ].filter(Boolean).filter(p => fs.existsSync(p));

  const tools = { parseCuesMd, parseSingleCueMd, inferHostCompat, formatHostList };
  const results = { cue: [], blank: [] };
  // Track which root each entry came from — used for the per-root grouping
  // and to compute path-relative-to-root for display.
  for (const dir of paths) collect(dir, tools, results);

  // Banner — wordmark + version. One-time at the top.
  console.log('');
  console.log(banner({ version: cliVersion(ctx) }));
  console.log('');

  // Search paths — show every dir we read from, once. Replaces the
  // per-row path-prefix repetition.
  console.log(bold('Reading from'));
  for (const p of paths) console.log('  ' + dim(prettyPath(p, HOME)));
  console.log('');

  for (const kind of ['cue', 'blank']) {
    if (onlyKind && onlyKind !== kind) continue;
    const items = results[kind];
    const label = kind === 'cue' ? 'Cues' : 'Blanks';
    console.log(bold(label) + ' ' + dim('(' + items.length + ')'));
    if (items.length === 0) { console.log('  ' + dim('(none)')); console.log(''); continue; }

    // Longest name → column width for clean alignment.
    const nameW = items.reduce((m, it) => Math.max(m, it.name.length), 0);

    for (const it of items) {
      // Path: relative to the matching root, so the redundant
      // `~/.cues/` prefix doesn't repeat on every line.
      const rel = relativeToRoot(it.source, paths);
      // Host marker only when the entry is scoped to a subset of hosts.
      // "all" is the common case — silencing it removes the visual noise
      // that prompted this redesign. --all surfaces it for diagnostics.
      const hostMarker = (it.hosts && it.hosts !== 'all')
        ? '  ' + dim('[') + it.hosts + dim(']')
        : (showAll && it.hosts === 'all' ? '  ' + dim('[all]') : '');
      const linked = fileLink(rel, it.source);
      console.log(
        '  ' + it.name.padEnd(nameW) +
        '  ' + dim(G.arrow) + ' ' + dim(linked) +
        hostMarker,
      );
    }
    console.log('');
  }
};

function collect(dir, tools, results) {
  const { parseCuesMd, parseSingleCueMd, inferHostCompat, formatHostList } = tools;

  for (const [filename, kind] of [['CUES.md', 'cue'], ['BLANKS.md', 'blank']]) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = parseCuesMd(fs.readFileSync(p, 'utf8'));
      if (parsed && parsed.promptConfig && parsed.promptConfig.sources) {
        for (const [name, src] of Object.entries(parsed.promptConfig.sources)) {
          results[kind].push({ name, source: p, hosts: hostsLabel(src, inferHostCompat, formatHostList) });
        }
      }
      if (parsed && parsed.blanks) {
        // Inline `## Blanks` block in CUES.md / BLANKS.md.
        for (const [name, blk] of Object.entries(parsed.blanks)) {
          results.blank.push({ name, source: p, hosts: hostsLabel(blk, inferHostCompat, formatHostList) });
        }
      }
    } catch { /* validate command surfaces parse errors */ }
  }
  // Folder discoveries: per the open-standard, files are uppercase
  // (CUE.md inside cues/<name>/, BLANK.md inside blanks/<name>/).
  // Lowercase legacy names are migrated by seed-configs's HEAL pass —
  // we still tolerate them here so a half-migrated user-level dir
  // shows up in `list` rather than vanishing silently.
  for (const [subdir, kind, primaryFile] of [
    ['cues', 'cue', 'CUE.md'],
    ['blanks', 'blank', 'BLANK.md'],
  ]) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub)) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidates = [primaryFile, primaryFile.toLowerCase(), 'cue.md'];
      const cueMd = candidates
        .map(f => path.join(sub, entry.name, f))
        .find(p => fs.existsSync(p));
      if (!cueMd) continue;
      let hosts = '';
      try {
        const parsed = parseSingleCueMd(fs.readFileSync(cueMd, 'utf8'), path.dirname(cueMd));
        hosts = hostsLabel(parsed.frontmatter, inferHostCompat, formatHostList);
      } catch { /* fall through; show no marker */ }
      results[kind].push({ name: entry.name, source: cueMd, hosts });
    }
  }
}

// Format the host-compat result for one entry. Returns the joined host
// string ("all", "claude-code, gemini-cli, opencode", etc.).
function hostsLabel(input, inferHostCompat, formatHostList) {
  const r = inferHostCompat(input || {});
  return formatHostList(r.hosts);
}

// Resolve a source path against the first matching root, returning the
// path-relative-to-root. Falls back to the absolute path when no root
// matches (shouldn't happen in practice, but keep it safe).
function relativeToRoot(source, roots) {
  for (const r of roots) {
    if (source.startsWith(r + path.sep) || source === r) {
      return source.slice(r.length + 1);
    }
  }
  return source;
}

// `~/.cues/` for paths under HOME, absolute otherwise.
function prettyPath(p, home) {
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

function printHelp() {
  console.log('opencues list [--cues|--blanks] [--all]');
  console.log('');
  console.log('List every cue and blank discovered across your search paths,');
  console.log('with the source file each came from. Folder-based entries override');
  console.log('monolithic .md sections of the same name (folder wins).');
  console.log('');
  console.log('  --cues        only cues');
  console.log('  --blanks      only blanks');
  console.log('  --all, -a     show host-compat marker on every entry (including `all`)');
  console.log('  --help        Show this message');
}
