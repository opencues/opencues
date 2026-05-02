// `opencues edit <file>` — opens the named config file in $EDITOR.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// `cues` covers everything that used to be split across cues.md /
// opencues.md / blanks.md: settings frontmatter, ignore list, project
// metadata. Legacy `opencues` and `blanks` aliases are gone post-
// migration — every user file ends up at ~/.cues/cues.md.
const VALID = new Set(['cues']);

module.exports = function edit(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let name = null;
  const projectScope = argv.includes('--project');
  for (const a of argv) { if (!a.startsWith('-') && !name) name = a; }

  if (!name) {
    console.error(`opencues edit: missing <file>. One of: ${[...VALID].join(', ')}`);
    process.exit(2);
  }
  if (!VALID.has(name)) {
    console.error(`opencues edit: unknown <file> "${name}". One of: ${[...VALID].join(', ')}`);
    process.exit(2);
  }

  const baseDir = projectScope
    ? path.join(process.cwd(), '.cues')
    : path.join(os.homedir(), '.cues');
  const file = path.join(baseDir, `${name}.md`);

  if (!fs.existsSync(file)) {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(file, `# ${name}.md (auto-created by opencues edit)\n`);
    console.log(`Created empty ${file}`);
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  console.log(`Opening ${file} in ${editor}...`);
  const result = spawnSync(editor, [file], { stdio: 'inherit' });
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
