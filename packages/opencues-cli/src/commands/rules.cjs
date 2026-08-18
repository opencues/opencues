// `opencues rules` — see, add, and remove the watchlist rules in RULES.md.
//
// The rules files are plain markdown a user can edit by hand — this command
// exists because "open the right file, find the right bullet" is exactly the
// friction that stops someone deleting a default they don't want. It shows
// the MERGED view the runtime actually uses (project file first, then user,
// duplicates marked), and edits surgically: removing a rule deletes one
// bullet line and nothing else, so prose written around the bullets survives.
//
// Subcommands:
//   opencues rules                    → list the merged rule set
//   opencues rules list --json        → JSON (scriptable)
//   opencues rules add "<rule>"       → append to the user file
//   opencues rules add "<rule>" --project → append to <cwd>/.cues/RULES.md
//   opencues rules remove <n|text>    → delete one rule (index from list, or
//                                        a unique substring)
//   opencues rules path               → print the file paths
//   opencues rules --help             → this help
//
// Parsing and editing live in @opencues/core (parseRulesMd / addRuleToMd /
// removeRuleFromMd) — the same functions the runtime ingest uses — so this
// command cannot drift from what the watchlist actually loads.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, fileLink, banner, cliVersion } = require('../lib/style.cjs');

// Resolved per call so $OPENCUES_HOME and a test's env override are honoured.
function userFile() {
  const home = process.env.OPENCUES_HOME || path.join(os.homedir(), '.cues');
  return path.join(home, 'RULES.md');
}
function projectFile() {
  return path.join(process.cwd(), '.cues', 'RULES.md');
}

// Same candidate walk as dismissals.cjs — clone layout, then installed.
let _coreCache = null;
function loadCore() {
  if (_coreCache) return _coreCache;
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'opencues-core', 'dist', 'session-commitments.js'),
    path.resolve(__dirname, '..', '..', 'node_modules', '@opencues', 'core', 'dist', 'session-commitments.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { _coreCache = require(c); return _coreCache; }
  }
  throw new Error(`opencues rules: cannot locate core helpers (tried: ${candidates.join(', ')})`);
}

/**
 * The merged view, in the runtime's own order: project rules first, then
 * user. `duplicate: true` marks a rule the ingest's dedupe will drop — shown
 * rather than hidden, because "why doesn't my rule fire" is answered by
 * seeing that an earlier file already has it.
 */
function collect() {
  const core = loadCore();
  const rows = [];
  const seen = new Set();
  for (const [scope, file] of [['project', projectFile()], ['user', userFile()]]) {
    if (!fs.existsSync(file)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const statement of core.parseRulesMd(text)) {
      const key = core.commitmentDedupeKey(statement);
      const duplicate = seen.has(key);
      if (!duplicate) seen.add(key);
      rows.push({ index: rows.length + 1, scope, file, statement, duplicate });
    }
  }
  return rows;
}

function printHelp() {
  console.log(banner('rules', cliVersion()));
  console.log('See, add, and remove the always-on watchlist rules (RULES.md).');
  console.log('');
  console.log(`  ${bold('opencues rules')}                       list the merged rule set (project first, then user)`);
  console.log(`  ${bold('opencues rules list --json')}           machine-readable list`);
  console.log(`  ${bold('opencues rules add "<rule>"')}          append to your user file (${dim('~/.cues/RULES.md')})`);
  console.log(`  ${bold('opencues rules add "<rule>" --project')} append to <cwd>/.cues/RULES.md instead`);
  console.log(`  ${bold('opencues rules remove <n|text>')}       delete one rule by list index or unique substring`);
  console.log(`  ${bold('opencues rules path')}                  print the file paths`);
  console.log('');
  console.log(dim('Rules flag, they never block. Each cue dismisses with `_`; the watchlist'));
  console.log(dim('caps at 24 entries and precision degrades as it bloats — keep it curated.'));
  return 0;
}

function cmdList(json) {
  const rows = collect();
  if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  if (rows.length === 0) {
    console.log(`${tag('info')} no rules on the watchlist — run ${bold('opencues seed-configs')} for the defaults, or ${bold('opencues rules add "<rule>"')}`);
    return 0;
  }
  console.log(banner('rules', cliVersion()));
  for (const r of rows) {
    const dup = r.duplicate ? `  ${dim('(duplicate — ignored at runtime)')}` : '';
    console.log(`  ${dim(String(r.index).padStart(2))}  ${dim(`[${r.scope}]`.padEnd(9))} ${r.statement}${dup}`);
  }
  console.log('');
  const active = rows.filter((r) => !r.duplicate).length;
  console.log(dim(`  ${active} active rule(s) of 24 watchlist slots; the rest hold session decisions.`));
  console.log(dim(`  remove one: opencues rules remove <n>   ·   files: opencues rules path`));
  return 0;
}

function cmdAdd(statement, toProject) {
  if (!statement) { console.error(`${tag('err')} usage: opencues rules add "<rule>" [--project]`); return 1; }
  const core = loadCore();
  const key = core.commitmentDedupeKey(statement.trim().replace(/\s+/g, ' '));
  const existing = collect().find((r) => core.commitmentDedupeKey(r.statement) === key);
  if (existing) {
    console.error(`${tag('warn')} an equivalent rule already exists (${existing.scope} #${existing.index}): ${existing.statement}`);
    return 1;
  }
  const file = toProject ? projectFile() : userFile();
  let text = null;
  try { if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8'); } catch { /* treat as new */ }
  let next;
  try { next = core.addRuleToMd(text, statement); } catch (err) {
    console.error(`${tag('err')} ${err.message}`);
    return 1;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  console.log(`${tag('ok')} added to ${fileLink(file, file)} — live within seconds in running hosts`);
  return 0;
}

function cmdRemove(selector) {
  if (!selector) { console.error(`${tag('err')} usage: opencues rules remove <n|text>`); return 1; }
  const rows = collect();
  if (rows.length === 0) { console.error(`${tag('err')} no rules to remove`); return 1; }
  let target;
  if (/^\d+$/.test(selector)) {
    target = rows.find((r) => r.index === Number(selector));
    if (!target) { console.error(`${tag('err')} no rule #${selector} — run ${bold('opencues rules')} for the list`); return 1; }
  } else {
    const needle = selector.toLowerCase();
    const hits = rows.filter((r) => r.statement.toLowerCase().includes(needle));
    if (hits.length === 0) { console.error(`${tag('err')} no rule matching "${selector}"`); return 1; }
    if (hits.length > 1) {
      console.error(`${tag('err')} "${selector}" matches ${hits.length} rules — use the index instead:`);
      for (const h of hits) console.error(`    ${h.index}  [${h.scope}] ${h.statement}`);
      return 1;
    }
    target = hits[0];
  }
  const core = loadCore();
  const text = fs.readFileSync(target.file, 'utf8');
  const next = core.removeRuleFromMd(text, target.statement);
  if (next === null) { console.error(`${tag('err')} could not find that bullet in ${target.file} — edited since listing?`); return 1; }
  fs.writeFileSync(target.file, next);
  console.log(`${tag('ok')} removed from ${fileLink(target.file, target.file)}: ${target.statement}`);
  console.log(dim('  (an edited file is never re-seeded; the runtime picks this up within seconds)'));
  return 0;
}

function cmdPath() {
  for (const [scope, file] of [['project', projectFile()], ['user', userFile()]]) {
    const exists = fs.existsSync(file);
    console.log(`  ${dim(`[${scope}]`.padEnd(9))} ${exists ? fileLink(file, file) : dim(`${file} (absent)`)}`);
  }
  return 0;
}

module.exports = function rules(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const positional = argv.filter((a) => !a.startsWith('--'));
  const sub = positional[0] ?? 'list';
  switch (sub) {
    case 'list':   return cmdList(argv.includes('--json'));
    case 'add':    return cmdAdd(positional[1], argv.includes('--project'));
    case 'remove': return cmdRemove(positional[1]);
    case 'path':   return cmdPath();
    default:
      console.error(`${tag('err')} unknown subcommand "${sub}" — see opencues rules --help`);
      return 1;
  }
};
