// `opencues edit <file>` — opens the named config file in $EDITOR.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const VALID = new Set(['cues', 'blanks', 'controls', 'opencues']);
// One-version backwards-compat alias: `opencues edit controls` silently
// resolves to blanks.md (controls.md was renamed to blanks.md).
const ALIASES = { controls: 'blanks' };

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
  // Resolve aliases silently (backwards-compat for the rename window).
  const resolved = ALIASES[name] || name;

  const baseDir = projectScope
    ? path.join(process.cwd(), '.opencues')
    : path.join(os.homedir(), '.opencues');
  const file = path.join(baseDir, `${resolved}.md`);

  if (!fs.existsSync(file)) {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(file, `# ${resolved}.md (auto-created by opencues edit)\n`);
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
  console.log('Open a .opencues/ config file in $EDITOR (or $VISUAL, or vi as fallback).');
  console.log('Auto-creates the file with a stub header if it doesn\'t exist.');
  console.log('');
  console.log('  <file>      cues | blanks | controls | opencues');
  console.log('  --project   Edit <cwd>/.opencues/<file>.md instead of ~/.opencues/<file>.md');
  console.log('');
  console.log('Examples:');
  console.log('  opencues edit cues');
  console.log('  opencues edit opencues --project');
}
