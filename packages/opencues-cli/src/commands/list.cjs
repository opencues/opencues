// `opencues list` — list cues / blanks / controls across search paths,
// with their source file. Useful for "what's actually going to fire?"

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

module.exports = function list(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const onlyKind =
    argv.includes('--cues')     ? 'cue'     :
    argv.includes('--blanks')   ? 'blank'   :
    argv.includes('--controls') ? 'control' :
    null;

  let parseCuesMd;
  try {
    parseCuesMd = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/index.js')).parseCuesMd;
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

  const results = { cue: [], blank: [], control: [] };
  for (const dir of paths) {
    collect(dir, parseCuesMd, results);
  }

  for (const kind of ['cue', 'blank', 'control']) {
    if (onlyKind && onlyKind !== kind) continue;
    const items = results[kind];
    console.log(`\n${kind.toUpperCase()}S (${items.length}):`);
    if (items.length === 0) { console.log('  (none)'); continue; }
    for (const it of items) {
      console.log(`  ${it.name.padEnd(20)} ← ${it.source}`);
    }
  }
};

function collect(dir, parseCuesMd, results) {
  for (const [filename, kind] of [['cues.md', 'cue'], ['blanks.md', 'blank'], ['controls.md', 'control']]) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = parseCuesMd(fs.readFileSync(p, 'utf8'));
      if (parsed && parsed.promptConfig && parsed.promptConfig.sources) {
        for (const name of Object.keys(parsed.promptConfig.sources)) {
          results[kind].push({ name, source: p });
        }
      }
      if (parsed && parsed.controls) {
        for (const name of Object.keys(parsed.controls)) {
          results.control.push({ name, source: p });
        }
      }
    } catch { /* validate command surfaces parse errors */ }
  }
  for (const [subdir, kind] of [['cues', 'cue'], ['blanks', 'blank'], ['controls', 'control']]) {
    const sub = path.join(dir, subdir);
    if (!fs.existsSync(sub)) continue;
    for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cueMd = path.join(sub, entry.name, 'cue.md');
      if (fs.existsSync(cueMd)) results[kind].push({ name: entry.name, source: cueMd });
    }
  }
}

function printHelp() {
  console.log('opencues list [--cues|--blanks|--controls]');
  console.log('');
  console.log('List every cue, blank, and control discovered across your search paths,');
  console.log('with the source file each came from. Folder-based entries override');
  console.log('monolithic .md sections of the same name (folder wins).');
  console.log('');
  console.log('  --cues        only cues');
  console.log('  --blanks      only blanks');
  console.log('  --controls    only controls');
  console.log('  --help        Show this message');
}
