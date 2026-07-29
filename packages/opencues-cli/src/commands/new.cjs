// `opencues new <kind> <name>` — scaffold a single cue / blank.
//
// Default destination: ~/.cues/<kind>s/<name>/{CUE,BLANK}.md.
// `--project` writes to <cwd>/.cues/<kind>s/<name>/{CUE,BLANK}.md instead.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, fileLink, banner, cliVersion } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

const KINDS = new Set(['cue', 'blank']);
const KIND_TO_DIR = { cue: 'cues', blank: 'blanks' };
// Per the open standard, the per-folder file is uppercase + type-specific:
// cues/<name>/CUE.md, blanks/<name>/BLANK.md. New scaffolds use the
// canonical name; older lowercase forms are tolerated by readers.
const KIND_TO_FILENAME = { cue: 'CUE.md', blank: 'BLANK.md' };
const KIND_TEMPLATE = { cue: 'cue', blank: 'blank' };

module.exports = async function newCmd(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let kind = null, name = null;
  const projectScope = argv.includes('--project');
  const dryRun = argv.includes('--dry-run');
  for (const a of argv) {
    if (a.startsWith('-')) continue;
    if (!kind) kind = a;
    else if (!name) name = a;
  }

  // Interactive on a terminal when args are omitted.
  if (!kind && prompt.isInteractive()) {
    console.log(banner({ version: cliVersion(ctx), tagline: 'scaffold a cue / blank' }));
    console.log('');
    console.log(dim('What kind?  ·  ↑↓ move · Enter select'));
    kind = await prompt.select('', [
      { label: `cue     ${dim('· LLM word / sentence alternatives')}`, value: 'cue' },
      { label: `blank   ${dim('· `_`-gated fill-in')}`, value: 'blank' },
      { spacer: true },
      { label: 'Cancel', value: null, dim: true },
    ]);
    if (!kind) return;
  }
  if (kind && !name && prompt.isInteractive()) {
    name = await prompt.input(`Name for the ${kind} ${dim('(lowercase, hyphens)')}`);
    if (!name) { console.log(`${tag('info')} cancelled — nothing created.`); return; }
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
    ? path.join(process.cwd(), '.cues')
    : path.join(os.homedir(), '.cues');
  const targetDir = path.join(baseDir, KIND_TO_DIR[kind], name);
  const targetFile = path.join(targetDir, KIND_TO_FILENAME[kind]);

  if (fs.existsSync(targetFile)) {
    console.error(`opencues new: refusing to overwrite existing ${targetFile}`);
    console.error(`Edit it directly or pick a different name.`);
    process.exit(1);
  }

  // Substitute {{NAME}} into the per-kind template.
  const templateName = KIND_TEMPLATE[kind] || kind;
  const templatePath = path.join(ctx.PKG_DIR, 'src/templates/new', `${templateName}.md`);
  const template = fs.readFileSync(templatePath, 'utf8');
  const content = template.replace(/\{\{NAME\}\}/g, name);

  console.log(banner({ version: cliVersion(ctx), tagline: `scaffold a ${kind}` }));
  console.log('');
  console.log(bold('Scaffold plan:'));
  console.log(`  ${tag('ok')} ${dim('CREATE')} ${fileLink(targetFile, targetFile)}`);
  if (dryRun) { console.log(`\n${tag('info')} ${dim('[dry-run] Nothing executed.')}`); return; }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, content);
  console.log('');
  console.log(`${tag('ok')} created ${fileLink(targetFile, targetFile)}`);
  console.log(dim('  Edit the frontmatter + prompt body. Hot-reload picks it up on the next keystroke.'));
  console.log(dim(`  To validate: opencues validate ${projectScope ? '--project' : ''}`));
};

function printHelp() {
  console.log('opencues new <kind> <name> [--project] [--dry-run]');
  console.log('');
  console.log('Scaffold a single cue / blank with the right frontmatter');
  console.log('shape pre-filled. Refuses to overwrite existing files.');
  console.log('');
  console.log('  <kind>      cue | blank');
  console.log('  <name>      lowercase, hyphens, no spaces (e.g. my-cue)');
  console.log('  --project   Scaffold under <cwd>/.cues/ (default: ~/.cues/)');
  console.log('  --dry-run   Print the plan; do not create anything');
  console.log('');
  console.log('Examples:');
  console.log('  opencues new cue my-cue');
  console.log('  opencues new blank my-api --project');
  console.log('  opencues new blank custom-mode');
}
