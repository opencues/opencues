// `opencues debug [on|off]` — toggle `debug-mode` in OPENCUES.md.
//
//   opencues debug            interactive on/off picker (on a terminal)
//   opencues debug on|off     one-shot (scriptable)
//
// A friendly shortcut for the `debug-mode` scalar (also reachable via
// `opencues config` → Diagnostics). Hot-reload picks it up; the runtime
// starts/stops emitting verbose logs to /tmp/opencues.log on the next keystroke.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, green, banner, cliVersion, fileLink, G } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

module.exports = async function debug(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const positional = argv.filter(a => !a.startsWith('-'));
  const value = positional[0];
  const projectScope = argv.includes('--project');
  const file = ocFile(projectScope);

  if (!value && prompt.isInteractive()) return interactive(ctx, file);
  if (!value) return printCurrent(file);

  if (value !== 'on' && value !== 'off') {
    console.error(`opencues debug: value must be 'on' or 'off' (got "${value}")`);
    process.exit(2);
  }
  writeValue(file, value);
  console.log(`Set debug-mode: ${value} in ${file}`);
  console.log('Effect: next keystroke triggers ConfigLoader hot-reload; runtime starts/stops verbose logging.');
  console.log('Tail logs: opencues logs --tail');
};

// Arrow-UI on/off toggle — the current value carries a green ring + the cursor.
async function interactive(ctx, file) {
  const current = readCurrent(file);
  console.log(banner({ version: cliVersion(ctx), tagline: 'debug logging' }));
  console.log('');
  console.log(bold('debug-mode') + '  ' + dim('· ↑↓ move · Enter select · ') + fileLink(tilde(file), file));
  const pick = await prompt.select('', [
    { label: `on   ${dim('· verbose logs to /tmp/opencues.log')}`, ring: current === 'on', value: 'on' },
    { label: `off  ${dim('· quiet')}`, ring: current === 'off', value: 'off' },
    { spacer: true },
    { label: 'Cancel', value: null, dim: true },
  ], { initial: current === 'off' ? 1 : 0 });

  if (!pick) return;
  if (pick === current) { console.log(`${tag('info')} already ${bold(pick)} — nothing changed.`); return; }
  writeValue(file, pick);
  console.log('');
  console.log(`${tag('ok')} debug-mode = ${green(pick)}`);
  console.log(dim('next keystroke hot-reloads the runtime · tail with ') + bold('opencues logs --tail'));
}

function ocFile(projectScope) {
  const baseDir = projectScope ? path.join(process.cwd(), '.cues') : path.join(os.homedir(), '.cues');
  return path.join(baseDir, 'OPENCUES.md');
}

function readCurrent(file) {
  if (!fs.existsSync(file)) return 'off';
  const m = fs.readFileSync(file, 'utf8').match(/^debug-mode:\s*(on|off)\s*$/m);
  return m ? m[1] : 'off';
}

function writeValue(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, setFrontmatterScalar(content, 'debug-mode', value));
}

function printCurrent(file) {
  if (!fs.existsSync(file)) {
    console.log(`${file}: not present (debug-mode would default to 'off')`);
    return;
  }
  const m = fs.readFileSync(file, 'utf8').match(/^debug-mode:\s*(on|off)\s*$/m);
  console.log(`${file}: debug-mode = ${m ? m[1] : '(unset; defaults to off)'}`);
}

function setFrontmatterScalar(content, key, value) {
  // Existing line `key: <something>` inside frontmatter → replace; else insert.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const newLine = `${key}: ${value}`;
  if (fmMatch) {
    const fm = fmMatch[1];
    const re = new RegExp(`^${escapeRe(key)}:.*$`, 'm');
    const newFm = re.test(fm) ? fm.replace(re, newLine) : fm + '\n' + newLine;
    return content.replace(fmMatch[0], `---\n${newFm}\n---\n`);
  }
  return `---\n${newLine}\n---\n${content}`;
}

const tilde = (p) => { const h = os.homedir(); return p.startsWith(h) ? '~' + p.slice(h.length) : p; };
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function printHelp() {
  console.log('opencues debug [on|off] [--project]');
  console.log('');
  console.log('Toggle the runtime\'s debug-mode setting (lives in OPENCUES.md frontmatter).');
  console.log('With no value on a terminal: an interactive on/off picker; non-TTY prints');
  console.log('the current setting. Hot-reload picks it up on the next keystroke.');
  console.log('');
  console.log('  on / off     New value');
  console.log('  --project    Edit <cwd>/.cues/OPENCUES.md instead of ~/.cues/');
  console.log('');
  console.log('Examples:');
  console.log('  opencues debug              # interactive picker (or current, non-TTY)');
  console.log('  opencues debug on           # enable verbose logging');
  console.log('  opencues debug off          # quiet');
  console.log('');
  console.log('Tail what gets emitted: opencues logs --tail');
}
