// `opencues list` — list cues / blanks across search paths, with their
// source file. Useful for "what's actually going to fire?"

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tree, fileLink, bold, dim } = require('../lib/style.cjs');

module.exports = function list(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const onlyKind =
    argv.includes('--cues')   ? 'cue'   :
    argv.includes('--blanks') ? 'blank' :
    null;

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
  // Same precedence as ConfigLoader; show source path for every entry.
  const paths = [
    process.env.OPENCUES_HOME,
    path.join(process.cwd(), '.cues'),
    path.join(HOME, '.cues'),
  ].filter(Boolean).filter(p => fs.existsSync(p));

  const tools = { parseCuesMd, parseSingleCueMd, inferHostCompat, formatHostList };
  const results = { cue: [], blank: [] };
  for (const dir of paths) {
    collect(dir, tools, results);
  }

  // Width of the host-compat marker (consistent across kinds).
  const allItems = [].concat(results.cue, results.blank);
  const maxHostLen = allItems.reduce((m, it) => Math.max(m, (it.hosts || '').length), 0);

  for (const kind of ['cue', 'blank']) {
    if (onlyKind && onlyKind !== kind) continue;
    const items = results[kind];
    console.log('');
    console.log(`${bold(kind.toUpperCase() + 'S')} ${dim('(' + items.length + ')')}`);
    if (items.length === 0) { console.log(dim('  (none)')); continue; }

    // Group items by source file, preserving discovery order. Each file
    // becomes a tree title; its entries are leaves under it.
    const bySource = new Map();
    for (const it of items) {
      if (!bySource.has(it.source)) bySource.set(it.source, []);
      bySource.get(it.source).push(it);
    }
    for (const [source, group] of bySource) {
      const linkedSource = fileLink(source, source);
      if (group.length === 1) {
        // Single-entry source — render inline so the visual weight matches
        // the data (a one-leaf tree is just noise).
        const it = group[0];
        const hostMarker = it.hosts ? '  ' + dim('[') + it.hosts.padEnd(maxHostLen) + dim(']') : '';
        console.log(`  ${it.name.padEnd(22)}${hostMarker}  ${dim(linkedSource)}`);
      } else {
        console.log('');
        const rows = group.map(it => {
          const hostMarker = it.hosts ? dim('[') + it.hosts.padEnd(maxHostLen) + dim(']') : '';
          return [it.name, '', hostMarker];
        });
        console.log(tree({ title: linkedSource, rows, labelWidth: 22 }));
      }
    }
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

function printHelp() {
  console.log('opencues list [--cues|--blanks]');
  console.log('');
  console.log('List every cue and blank discovered across your search paths,');
  console.log('with the source file each came from. Folder-based entries override');
  console.log('monolithic .md sections of the same name (folder wins).');
  console.log('');
  console.log('  --cues        only cues');
  console.log('  --blanks      only blanks');
  console.log('  --help        Show this message');
}
