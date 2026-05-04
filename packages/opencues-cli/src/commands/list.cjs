// `opencues list` — list cues / blanks across search paths, with their
// source file. Useful for "what's actually going to fire?"

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
    path.join(process.cwd(), '.opencues'),
    path.join(HOME, '.opencues'),
  ].filter(Boolean).filter(p => fs.existsSync(p));

  const tools = { parseCuesMd, parseSingleCueMd, inferHostCompat, formatHostList };
  const results = { cue: [], blank: [] };
  for (const dir of paths) {
    collect(dir, tools, results);
  }

  // Compute host-compat column width so the right column aligns.
  const allItems = [].concat(results.cue, results.blank);
  const maxHostLen = allItems.reduce((m, it) => Math.max(m, (it.hosts || '').length), 0);

  for (const kind of ['cue', 'blank']) {
    if (onlyKind && onlyKind !== kind) continue;
    const items = results[kind];
    console.log(`\n${kind.toUpperCase()}S (${items.length}):`);
    if (items.length === 0) { console.log('  (none)'); continue; }
    for (const it of items) {
      const hostMarker = it.hosts ? `[${it.hosts.padEnd(maxHostLen)}]  ` : '';
      console.log(`  ${it.name.padEnd(20)} ${hostMarker}← ${it.source}`);
    }
  }
};

function collect(dir, tools, results) {
  const { parseCuesMd, parseSingleCueMd, inferHostCompat, formatHostList } = tools;

  for (const [filename, kind] of [['cues.md', 'cue'], ['blanks.md', 'blank']]) {
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
        // Inline `## Blanks` block in cues.md / blanks.md.
        for (const [name, blk] of Object.entries(parsed.blanks)) {
          results.blank.push({ name, source: p, hosts: hostsLabel(blk, inferHostCompat, formatHostList) });
        }
      }
    } catch { /* validate command surfaces parse errors */ }
  }
  for (const [subdir, kind] of [['cues', 'cue'], ['blanks', 'blank']]) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub)) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cueMd = path.join(sub, entry.name, 'cue.md');
      if (!fs.existsSync(cueMd)) continue;
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
// string ("all", "claude-code, opencode", etc.).
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
