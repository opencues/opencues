#!/usr/bin/env node
// `opencues` — front door CLI.
//
// Today this runs from a clone via `node packages/opencues-cli/bin/cli.cjs`
// or `pnpm exec opencues`. Post-publish (Stage 8) it becomes the bin
// entry for `npx opencues` / `npm i -g opencues`.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const PKG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

// Lazy-load command modules so `opencues --help` doesn't pay for the
// whole tree.
const COMMANDS = {
  install:        () => require('../src/commands/install.cjs'),
  uninstall:      () => require('../src/commands/uninstall.cjs'),
  'seed-configs':  () => require('../src/commands/seed-configs.cjs'),
  'update-configs': () => require('../src/commands/update-configs.cjs'),
  init:           () => require('../src/commands/init.cjs'),
  new:            () => require('../src/commands/new.cjs'),
  run:            () => require('../src/commands/run.cjs'),
  sync:           () => require('../src/commands/sync.cjs'),
  validate:       () => require('../src/commands/validate.cjs'),
  review:         () => require('../src/commands/review.cjs'),
  import:         () => require('../src/commands/import.cjs'),
  doctor:         () => require('../src/commands/doctor.cjs'),
  edit:           () => require('../src/commands/edit.cjs'),
  logs:           () => require('../src/commands/logs.cjs'),
  list:           () => require('../src/commands/list.cjs'),
  show:           () => require('../src/commands/show.cjs'),
  'set-key':      () => require('../src/commands/set-key.cjs'),
  identity:       () => require('../src/commands/identity.cjs'),
  context:        () => require('../src/commands/context.cjs'),
  launcher:       () => require('../src/commands/launcher.cjs'), // no-arg interactive menu
  config:         () => require('../src/commands/config.cjs'),
  cleanup:        () => require('../src/commands/cleanup.cjs'),
  'check-keys':   () => require('../src/commands/check-keys.cjs'),
  update:         () => require('../src/commands/update.cjs'),
  statusline:     () => require('../src/commands/statusline.cjs'),
  debug:          () => require('../src/commands/debug.cjs'),
  completion:     () => require('../src/commands/completion.cjs'),
  which:          () => require('../src/commands/which.cjs'),
  version:        () => require('../src/commands/version.cjs'),
  help:           () => require('../src/commands/help.cjs'),
};
// One-letter and convenience aliases.
const ALIASES = {
  '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version',
};

const argv = process.argv.slice(2);
let command = argv[0] && (ALIASES[argv[0]] || argv[0]);
const rest = (argv[0] && (ALIASES[argv[0]] || COMMANDS[argv[0]])) ? argv.slice(1) : argv;
// No args at all → the interactive launcher (falls back to help in a non-TTY).
// An unknown command → help (usage).
if (!command || !COMMANDS[command]) command = (argv.length === 0) ? 'launcher' : 'help';

const ctx = { pkg, PKG_DIR, REPO_ROOT };

try {
  // Commands may be sync OR async (return a Promise — e.g. `update --check`
  // queries upstream registries). Handle both shapes uniformly.
  // Commands MAY return a numeric exit code; we honour it. Commands that
  // return undefined (the long-standing default) keep their exit-0
  // behaviour. Letting commands return a code instead of calling
  // process.exit from deep in their body keeps them testable.
  const result = COMMANDS[command]()(rest, ctx);
  if (result && typeof result.then === 'function') {
    result.then(code => {
      if (typeof code === 'number' && code !== 0) process.exit(code);
    }).catch(err => {
      console.error(`opencues ${command}: ${err && err.stack || err}`);
      process.exit(1);
    });
  } else if (typeof result === 'number' && result !== 0) {
    process.exit(result);
  }
} catch (err) {
  console.error(`opencues ${command}: ${err && err.stack || err}`);
  process.exit(1);
}
