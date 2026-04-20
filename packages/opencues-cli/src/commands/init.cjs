// `opencues init` — scaffold <cwd>/.opencues/ with templates.
// Idempotent: skips files that already exist.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = function init(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const dryRun = argv.includes('--dry-run');
  const minimal = argv.includes('--minimal');

  const cwd = process.cwd();
  const targetDir = path.join(cwd, '.opencues');
  const templateDir = path.join(ctx.PKG_DIR, 'src/templates');

  // Files we scaffold. README is informational; .md files are usable
  // templates with comment-only schema docs (or empty if --minimal).
  //
  // Note: opencues.md is NOT scaffolded here. Its schema (voice-mode,
  // tips-mode, debug-mode, …) is defined by the OpenCues runtime — not
  // by users or projects — and it lives only at user-level (~/.opencues/
  // opencues.md), auto-managed by OpenCuesSettingsControl on first
  // settings write.
  const files = ['cues.md', 'blanks.md', 'controls.md', 'README.md'];

  console.log(`Initialising .opencues/ in ${cwd}\n`);
  console.log('Plan:');
  const plan = files.map(name => ({
    name,
    src: path.join(templateDir, name),
    dst: path.join(targetDir, name),
    exists: fs.existsSync(path.join(targetDir, name)),
  }));
  for (const p of plan) {
    if (p.exists) console.log(`  SKIP (exists) ${p.dst}`);
    else console.log(`  CREATE ${p.dst}`);
  }

  if (dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  console.log('');
  fs.mkdirSync(targetDir, { recursive: true });
  let created = 0, skipped = 0;
  for (const p of plan) {
    if (p.exists) { skipped++; continue; }
    const content = minimal && p.name !== 'README.md' ? '' : fs.readFileSync(p.src, 'utf8');
    fs.writeFileSync(p.dst, content);
    created++;
    console.log(`  created ${p.name}`);
  }

  console.log(`\nCreated ${created} files, skipped ${skipped} (already present).`);
  console.log('');
  console.log('Next:');
  console.log('  Edit .opencues/cues.md (or use `opencues new cue <name> --project`)');
  console.log('  Run `opencues validate --project` to lint your config');
  console.log('  Launch: `opencues run <host>` (or whichever you have installed)');
};

function printHelp() {
  console.log('opencues init [--minimal] [--dry-run]');
  console.log('');
  console.log('Scaffold a `.opencues/` directory in the current working directory with');
  console.log('comment-only template files explaining each schema. Idempotent — files');
  console.log('that already exist are skipped, never overwritten.');
  console.log('');
  console.log('  --minimal    Empty .md files instead of comment-heavy templates');
  console.log('  --dry-run    Print the plan; do not create anything');
  console.log('  --help       Show this message');
}
