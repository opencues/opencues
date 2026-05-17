// `opencues edit <file>` — opens the named config file in $EDITOR.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const style = require('../lib/style.cjs');

// `cues` shorthand for editing the cue master config
// (~/.cues/CUES.md). Runtime settings live in OPENCUES.md and have
// their own editor path via `opencues debug` + the
// selector-satellite cycling menu; this command intentionally
// doesn't expose them (one less footgun for hand-editing scalars
// the runtime auto-manages).
const VALID = new Set(['cues']);

module.exports = function edit(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let name = null;
  const projectScope = argv.includes('--project');
  for (const a of argv) { if (!a.startsWith('-') && !name) name = a; }

  if (!name) {
    console.error(`${style.tag('err')} missing <file>. One of: ${[...VALID].join(', ')}`);
    process.exit(2);
  }
  if (!VALID.has(name)) {
    console.error(`${style.tag('err')} unknown <file> "${name}". One of: ${[...VALID].join(', ')}`);
    process.exit(2);
  }

  const baseDir = projectScope
    ? path.join(process.cwd(), '.cues')
    : path.join(os.homedir(), '.cues');
  const file = path.join(baseDir, `${name}.md`);

  const created = !fs.existsSync(file);
  if (created) {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(file, `# ${name}.md (auto-created by opencues edit)\n`);
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';

  console.log(style.banner({
    version: style.cliVersion(ctx),
    tagline: `editing ${name}${projectScope ? '  (project scope)' : ''}`,
  }));
  console.log('');
  console.log(style.tree({
    rows: [
      ['file',   style.fileLink(file, file) + (created ? '  ' + style.dim('(created)') : '')],
      ['editor', editor],
      ['scope',  projectScope ? 'project  ' + style.dim(`(${baseDir})`) : 'user-level  ' + style.dim(`(~/.cues)`)],
    ],
  }));
  console.log('');

  const result = spawnSync(editor, [file], { stdio: 'inherit' });
  if (result.error) {
    console.error(`${style.tag('err')} failed to launch ${editor}: ${result.error.message}`);
    process.exit(127);
  }
  process.exit(result.status ?? 0);
};

function printHelp() {
  console.log('opencues edit <file> [--project]');
  console.log('');
  console.log('Open a .cues/ config file in $EDITOR (or $VISUAL, or vi as fallback).');
  console.log('Auto-creates the file with a stub header if it doesn\'t exist.');
  console.log('');
  console.log('  <file>      cues   (the only top-level config — settings + ignore list + tips/blanks live in folders)');
  console.log('  --project   Edit <cwd>/.cues/<file>.md instead of ~/.cues/<file>.md');
  console.log('');
  console.log('Examples:');
  console.log('  opencues edit cues');
  console.log('  opencues edit cues --project');
}
