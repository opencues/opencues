// `opencues init` — scaffold <cwd>/.cues/ with templates.
// Idempotent: skips files that already exist.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tag, bold, dim, fileLink, banner, cliVersion } = require('../lib/style.cjs');

module.exports = function init(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const dryRun = argv.includes('--dry-run');
  const minimal = argv.includes('--minimal');

  const cwd = process.cwd();
  const targetDir = path.join(cwd, '.cues');
  const templateDir = path.join(ctx.PKG_DIR, 'src/templates');

  // Files we scaffold. README is informational; .md files are usable
  // templates with comment-only schema docs (or empty if --minimal).
  //
  // Note: OPENCUES.md is NOT scaffolded here. Its schema (voice-mode,
  // tips-mode, debug-mode, …) is defined by the OpenCues runtime — not
  // by users or projects — and it lives only at user-level
  // (~/.cues/OPENCUES.md), auto-managed by OpenCuesSettingsBlank on
  // first settings write.
  const files = ['CUES.md', 'BLANKS.md', 'AUDITORS.md', 'README.md'];

  console.log(banner({ version: cliVersion(ctx), tagline: 'scaffold a project .cues/' }));
  console.log('');
  console.log(`${bold('Initialising .cues/')} in ${fileLink(cwd, cwd)}`);
  console.log('');
  console.log(bold('Plan:'));
  const plan = files.map(name => ({
    name,
    src: path.join(templateDir, name),
    dst: path.join(targetDir, name),
    exists: fs.existsSync(path.join(targetDir, name)),
  }));
  for (const p of plan) {
    if (p.exists) console.log(`  ${tag('info')} ${dim('SKIP (exists)')} ${fileLink(p.dst, p.dst)}`);
    else console.log(`  ${tag('ok')} ${dim('CREATE')} ${fileLink(p.dst, p.dst)}`);
  }

  if (dryRun) { console.log(`\n${tag('info')} ${dim('[dry-run] Nothing executed.')}`); return; }

  console.log('');
  fs.mkdirSync(targetDir, { recursive: true });
  let created = 0, skipped = 0;
  for (const p of plan) {
    if (p.exists) { skipped++; continue; }
    // Defensive: a listed file whose template is missing falls back to an
    // empty scaffold rather than throwing ENOENT mid-loop and leaving
    // `.cues/` half-created. (AUDITORS.md now ships a template; this guard
    // keeps a future added-to-`files`-but-no-template entry from crashing
    // the whole command the same way.)
    const useEmpty = (minimal && p.name !== 'README.md') || !fs.existsSync(p.src);
    const content = useEmpty ? '' : fs.readFileSync(p.src, 'utf8');
    fs.writeFileSync(p.dst, content);
    created++;
    console.log(`  ${tag('ok')} created ${bold(p.name)}`);
  }

  console.log('');
  console.log(`${tag('ok')} created ${bold(created)} files, skipped ${bold(skipped)} ${dim('(already present)')}`);
  console.log('');
  console.log('Next:');
  console.log('  Edit CUES.md (or use `opencues new cue <name> --project`)');
  console.log('  Run `opencues validate --project` to lint your config');
  console.log('  Launch: `opencues run <host>` (or whichever you have installed)');
};

function printHelp() {
  console.log('opencues init [--minimal] [--dry-run]');
  console.log('');
  console.log('Scaffold a `.cues/` directory in the current working directory with');
  console.log('comment-only template files explaining each schema. Idempotent — files');
  console.log('that already exist are skipped, never overwritten.');
  console.log('');
  console.log('  --minimal    Empty .md files instead of comment-heavy templates');
  console.log('  --dry-run    Print the plan; do not create anything');
  console.log('  --help       Show this message');
}
