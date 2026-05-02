// `opencues debug on|off` — toggle `debug-mode` in opencues.md.
//
// Hot-reload picks this up; the runtime starts/stops emitting verbose
// logs to /tmp/opencues.log on the next keystroke.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

module.exports = function debug(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const positional = argv.filter(a => !a.startsWith('-'));
  const value = positional[0];
  const projectScope = argv.includes('--project');

  if (!value) {
    // Show current state across paths.
    return printCurrent(projectScope);
  }
  if (value !== 'on' && value !== 'off') {
    console.error(`opencues debug: value must be 'on' or 'off' (got "${value}")`);
    process.exit(2);
  }

  const baseDir = projectScope
    ? path.join(process.cwd(), '.cues')
    : path.join(os.homedir(), '.cues');
  const file = path.join(baseDir, 'opencues.md');

  fs.mkdirSync(baseDir, { recursive: true });

  let content = '';
  if (fs.existsSync(file)) content = fs.readFileSync(file, 'utf8');

  const updated = setFrontmatterScalar(content, 'debug-mode', value);
  fs.writeFileSync(file, updated);
  console.log(`Set debug-mode: ${value} in ${file}`);
  console.log('Effect: next keystroke triggers ConfigLoader hot-reload; runtime starts/stops verbose logging.');
  console.log(`Tail logs: opencues logs --tail`);
};

function printCurrent(projectScope) {
  const baseDir = projectScope
    ? path.join(process.cwd(), '.cues')
    : path.join(os.homedir(), '.cues');
  const file = path.join(baseDir, 'opencues.md');
  if (!fs.existsSync(file)) {
    console.log(`${file}: not present (debug-mode would default to 'off')`);
    return;
  }
  const content = fs.readFileSync(file, 'utf8');
  const m = content.match(/^debug-mode:\s*(on|off)\s*$/m);
  console.log(`${file}: debug-mode = ${m ? m[1] : '(unset; defaults to off)'}`);
}

function setFrontmatterScalar(content, key, value) {
  // Look for an existing line `key: <something>` inside frontmatter.
  // Insert if missing. Frontmatter is between two `---` lines at top.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const newLine = `${key}: ${value}`;
  if (fmMatch) {
    const fm = fmMatch[1];
    const re = new RegExp(`^${escapeRe(key)}:.*$`, 'm');
    const newFm = re.test(fm) ? fm.replace(re, newLine) : fm + '\n' + newLine;
    return content.replace(fmMatch[0], `---\n${newFm}\n---\n`);
  }
  // No frontmatter at all — prepend a minimal block.
  return `---\n${newLine}\n---\n${content}`;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function printHelp() {
  console.log('opencues debug [on|off] [--project]');
  console.log('');
  console.log('Toggle the runtime\'s debug-mode setting (lives in opencues.md frontmatter).');
  console.log('Hot-reload picks it up on the next keystroke. With no value: print the');
  console.log('current setting.');
  console.log('');
  console.log('  on / off     New value');
  console.log('  --project    Edit <cwd>/.cues/opencues.md instead of ~/.cues/');
  console.log('');
  console.log('Examples:');
  console.log('  opencues debug              # print current');
  console.log('  opencues debug on           # enable verbose logging');
  console.log('  opencues debug off          # quiet');
  console.log('');
  console.log('Tail what gets emitted: opencues logs --tail');
}
