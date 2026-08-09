// `opencues dismissals` — see and undo the cues you have silenced.
//
// Dismissing a cue is the one gesture in OpenCues that makes something STOP
// appearing, so it needs a way back. Without one, a user who forgets a cue by
// accident has no route to it but a text editor and a guess at the filename.
//
// This is that route: the list of what you have forgotten, with a toggle per
// row. Turning a row back ON restores the cue. Nothing is written until you
// accept, and Esc changes nothing — so opening this to look is free.
//
// The runtime re-reads the file on a few-second timer, so a restore lands in
// the session you already have open. No restart.
//
// Subcommands:
//   opencues dismissals                → interactive toggle list
//   opencues dismissals list           → print what is forgotten
//   opencues dismissals list --json    → JSON (scriptable)
//   opencues dismissals restore <n|key> → bring one cue back
//   opencues dismissals clear          → bring them ALL back
//   opencues dismissals path           → print the file path
//   opencues dismissals --help         → this help

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, green, fileLink, banner, cliVersion } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

// Resolved per call, not at module load, so $OPENCUES_HOME and a test's HOME
// override are honoured — the convention every other command follows.
function dismissalsPath() {
  const home = process.env.OPENCUES_HOME || path.join(os.homedir(), '.cues');
  return path.join(home, 'dismissals.json');
}

// Lazy-load the pure helpers from built core, so parse/serialize live in ONE
// place and the CLI cannot drift from what the runtime reads. Same candidate
// walk as identity.cjs's validator loader (clone layout, then installed).
let _coreCache = null;
function loadCore() {
  if (_coreCache) return _coreCache;
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'opencues-core', 'dist', 'dismissals.js'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@opencues', 'core', 'dist', 'dismissals.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { _coreCache = require(c); return _coreCache; }
  }
  throw new Error(`opencues dismissals: cannot locate core helpers (tried: ${candidates.join(', ')})`);
}

function read() {
  const file = dismissalsPath();
  if (!fs.existsSync(file)) return [];
  try {
    return loadCore().parseDismissals(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`${tag('warn')} could not read ${file}: ${err.message}`);
    return [];
  }
}

function write(records) {
  const file = dismissalsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, loadCore().serializeDismissals(records));
}

/** "3 days ago" / "just now" — a dismissal's age matters more than its clock time. */
function ago(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The engine that raised it, in words. Sources arrive as def blankNames
 *  (`sentence-cue:calendar`), which is our vocabulary, not the reader's. */
function sourceLabel(source) {
  const s = String(source || '').replace(/^sentence-cue:/, '');
  if (s.includes('calendar')) return 'calendar';
  if (s.includes('contradiction')) return 'contradiction';
  if (s.includes('more-formal')) return 'formality';
  return s || 'cue';
}

module.exports = function dismissals(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const [sub = '', ...rest] = argv.filter((a) => a !== '--json');
  const json = argv.includes('--json');

  switch (sub) {
    case 'list':    return cmdList(json);
    case 'restore': return cmdRestore(rest);
    case 'clear':   return cmdClear();
    case 'path':    return void console.log(dismissalsPath());
    case '':        return cmdInteractive();
    default:
      console.error(`opencues dismissals: unknown subcommand "${sub}"`);
      console.error('Run `opencues dismissals --help` for usage.');
      process.exitCode = 2;
      return undefined;
  }
};

function cmdList(json) {
  const records = read();
  if (json) { console.log(JSON.stringify({ dismissed: records }, null, 2)); return; }
  banner(`dismissed cues ${dim(cliVersion())}`);
  if (records.length === 0) {
    console.log(`${tag('ok')} nothing dismissed — every cue is live.`);
    return;
  }
  records.forEach((r, i) => {
    console.log(`  ${dim(String(i + 1).padStart(2))}  ${r.label}`);
    console.log(`      ${dim(`${sourceLabel(r.source)} · forgotten ${ago(r.dismissedAt)}`)}`);
  });
  console.log('');
  console.log(dim(`  ${records.length} forgotten · ${fileLink(dismissalsPath())}`));
  console.log(dim('  Bring one back: opencues dismissals restore <number>'));
}

function cmdRestore(args) {
  const sel = args.join(' ').trim();
  if (!sel) {
    console.error('opencues dismissals restore: usage: opencues dismissals restore <number|key>');
    process.exitCode = 2;
    return;
  }
  const records = read();
  // A number is an index into `list`, which is what a user has in front of
  // them; anything else is matched against the key and then the label, so
  // copying a phrase off the list works too.
  const byIndex = /^\d+$/.test(sel) ? records[Number(sel) - 1] : undefined;
  const target = byIndex
    || records.find((r) => r.key === sel)
    || records.find((r) => r.label.toLowerCase().includes(sel.toLowerCase()));
  if (!target) {
    console.error(`${tag('warn')} no dismissed cue matching "${sel}". Run \`opencues dismissals list\`.`);
    process.exitCode = 1;
    return;
  }
  write(loadCore().removeDismissal(records, target.key));
  console.log(`${tag('ok')} restored ${bold(target.label)} — it can appear again.`);
  console.log(dim('  A running host picks this up within a few seconds; no restart.'));
}

function cmdClear() {
  const records = read();
  if (records.length === 0) { console.log(`${tag('ok')} nothing dismissed.`); return; }
  write([]);
  console.log(`${tag('ok')} restored ${bold(String(records.length))} cue(s) — all live again.`);
}

async function cmdInteractive() {
  const records = read();
  banner(`dismissed cues ${dim(cliVersion())}`);
  if (records.length === 0) {
    console.log(`${tag('ok')} nothing dismissed — every cue is live.`);
    console.log(dim('  Press `_` on a cue note to dismiss it: once to mute, twice to forget.'));
    return;
  }
  if (!prompt.isInteractive()) return cmdList(false);

  // Toggles are held here and applied on accept. Esc leaves without writing,
  // so opening the list to see what you silenced costs nothing.
  const live = new Set();
  for (;;) {
    const choices = records.map((r, i) => ({
      value: `t${i}`,
      ring: live.has(r.key),                       // ● green = live again
      label: `${r.label}  ${dim(`${sourceLabel(r.source)} · ${live.has(r.key) ? 'restored' : `forgotten ${ago(r.dismissedAt)}`}`)}`,
    }));
    choices.push({ spacer: true });
    choices.push({ value: 'accept', label: live.size > 0 ? `Accept — restore ${live.size}` : 'Done' });

    console.log(dim('  space or enter toggles a row · esc leaves it as it is'));
    const picked = await prompt.select('', choices, { cancelValue: 'cancel' });
    if (picked === 'cancel') { console.log(`${tag('ok')} nothing changed.`); return; }
    if (picked === 'accept') break;
    const idx = Number(String(picked).slice(1));
    const rec = records[idx];
    if (!rec) continue;
    if (live.has(rec.key)) live.delete(rec.key); else live.add(rec.key);
  }

  if (live.size === 0) { console.log(`${tag('ok')} nothing changed.`); return; }
  const core = loadCore();
  let next = records;
  for (const key of live) next = core.removeDismissal(next, key);
  write(next);
  console.log(`${tag('ok')} restored ${bold(String(live.size))} cue(s).`);
  console.log(dim('  A running host picks this up within a few seconds; no restart.'));
}

function printHelp() {
  banner(`opencues dismissals ${dim(cliVersion())}`);
  console.log(`  ${bold('opencues dismissals')}              ${dim('toggle list — turn a cue back on')}`);
  console.log(`  ${bold('opencues dismissals list')}         ${dim('print what is forgotten (--json to script it)')}`);
  console.log(`  ${bold('opencues dismissals restore <n>')}  ${dim('bring one back, by number or phrase')}`);
  console.log(`  ${bold('opencues dismissals clear')}        ${dim('bring them all back')}`);
  console.log(`  ${bold('opencues dismissals path')}         ${dim('print the file path')}`);
  console.log('');
  console.log(dim('  Cues are dismissed from the note itself: `_` once mutes it for a while,'));
  console.log(dim('  twice forgets it. Only the second grain is durable, and it is what this'));
  console.log(dim(`  command lists. ${green('Nothing is written until you accept.')}`));
}
