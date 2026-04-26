// `opencues update-configs` — pull new shipped defaults into ~/.opencues/.
//
// Discoverable name for the workflow: "I just pulled new opencues code,
// get any new shipped controls/cues/blanks onto my disk."
//
// Implementation is a thin wrapper around `seed-configs` (which has all
// four phases: SEED, ADDITIVE SEED, SYNC library files, HEAL empty
// opencues.md, COMPILE colocated .cs → .exe). seed-configs is always
// safe to re-run; this command exists so users don't have to know that
// keyword.
//
// Why not chain into `update`? Because `update` rebuilds + redeploys a
// host integration — that's a different concern. Mixing the two means a
// user running `update opencode` to debug a fork issue would also
// silently rewrite `~/.opencues/`, which is surprising. Keeping them
// separate makes each command's blast radius obvious.

'use strict';

const path = require('node:path');

module.exports = function updateConfig(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  // Dispatch to seed-configs with the same args. --project / --dry-run
  // / --silent flow through unchanged.
  const seedConfigs = require('./seed-configs.cjs');
  return seedConfigs(argv, ctx);
};

function printHelp() {
  console.log('opencues update-configs [--project] [--dry-run] [--silent]');
  console.log('');
  console.log('Pull new shipped defaults into ~/.opencues/. Run this after `git pull`');
  console.log('on the opencues repo to pick up any new controls, cues, or blanks');
  console.log('that landed in defaults/ since your last seed.');
  console.log('');
  console.log('Four phases (all idempotent + safe to re-run):');
  console.log('  1. SEED      first-time copy of cues.md / blanks.md / etc.');
  console.log('  2. ADDITIVE  copy any NEW subdirs from defaults/{cues,controls}/');
  console.log('  3. SYNC      refresh library files (.sh / .cs / .ps1) — never .md');
  console.log('  4. HEAL      re-seed a 0-byte opencues.md from defaults');
  console.log('  5. COMPILE   colocated .cs → .exe (WSL only)');
  console.log('');
  console.log('  --project   Run against <cwd>/.opencues/ instead of ~/.opencues/');
  console.log('  --dry-run   Print the plan; do not copy or compile anything');
  console.log('  --silent    Suppress non-error output');
  console.log('  --help      Show this message');
  console.log('');
  console.log('Note: this is the same code path as `opencues seed-configs` — that');
  console.log('command name still works. `update-configs` is the discoverable name');
  console.log('for the "I just pulled new opencues code" use case.');
}
