// `opencues new <kind> <name>` — scaffold a single cue / blank / control.
//
// Default destination: ~/.opencues/<kind>s/<name>/cue.md.
// `--project` writes to <cwd>/.opencues/<kind>s/<name>/cue.md instead.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const KINDS = new Set(['cue', 'blank', 'control']);
const KIND_TO_DIR = { cue: 'cues', blank: 'blanks', control: 'controls' };

module.exports = function newCmd(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let kind = null, name = null;
  const projectScope = argv.includes('--project');
  const dryRun = argv.includes('--dry-run');
  for (const a of argv) {
    if (a.startsWith('-')) continue;
    if (!kind) kind = a;
    else if (!name) name = a;
  }

  if (!kind || !name) {
    console.error('opencues new: missing arguments. Usage: opencues new <kind> <name>');
    console.error(`<kind>: ${[...KINDS].join(' | ')}`);
    process.exit(2);
  }
  if (!KINDS.has(kind)) {
    console.error(`opencues new: unknown kind "${kind}". Known: ${[...KINDS].join(', ')}`);
    process.exit(2);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(`opencues new: name "${name}" must match /^[a-z][a-z0-9-]*$/ (lowercase, hyphens, no spaces).`);
    process.exit(2);
  }

  const baseDir = projectScope
    ? path.join(process.cwd(), '.opencues')
    : path.join(os.homedir(), '.opencues');
  const targetDir = path.join(baseDir, KIND_TO_DIR[kind], name);
  const targetFile = path.join(targetDir, 'cue.md');

  if (fs.existsSync(targetFile)) {
    console.error(`opencues new: refusing to overwrite existing ${targetFile}`);
    console.error(`Edit it directly or pick a different name.`);
    process.exit(1);
  }

  // Substitute {{NAME}} into the per-kind template.
  const templatePath = path.join(ctx.PKG_DIR, 'src/templates/new', `${kind}.md`);
  const template = fs.readFileSync(templatePath, 'utf8');
  const content = template.replace(/\{\{NAME\}\}/g, name);

  console.log(`Scaffold plan:`);
  console.log(`  CREATE ${targetFile}`);
  if (dryRun) { console.log('\n[dry-run] Nothing executed.'); return; }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, content);
  console.log(`\nCreated ${targetFile}`);
  console.log('Edit the frontmatter + prompt body, then hot-reload picks it up on the next keystroke.');
  console.log(`To validate: opencues validate ${projectScope ? '--project' : ''}`);
};

function printHelp() {
  console.log('opencues new <kind> <name> [--project] [--dry-run]');
  console.log('');
  console.log('Scaffold a single cue / blank / control with the right frontmatter');
  console.log('shape pre-filled. Refuses to overwrite existing files.');
  console.log('');
  console.log('  <kind>      cue | blank | control');
  console.log('  <name>      lowercase, hyphens, no spaces (e.g. legal-doc)');
  console.log('  --project   Scaffold under <cwd>/.opencues/ (default: ~/.opencues/)');
  console.log('  --dry-run   Print the plan; do not create anything');
  console.log('');
  console.log('Examples:');
  console.log('  opencues new cue legal-doc');
  console.log('  opencues new control my-api --project');
  console.log('  opencues new blank custom-mode');
}
