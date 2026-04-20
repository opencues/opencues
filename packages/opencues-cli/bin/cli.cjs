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
  'seed-configs': () => require('../src/commands/seed-configs.cjs'),
  init:           () => require('../src/commands/init.cjs'),
  new:            () => require('../src/commands/new.cjs'),
  run:            () => require('../src/commands/run.cjs'),
  validate:       () => require('../src/commands/validate.cjs'),
  import:         () => require('../src/commands/import.cjs'),
  doctor:         () => require('../src/commands/doctor.cjs'),
  edit:           () => require('../src/commands/edit.cjs'),
  logs:           () => require('../src/commands/logs.cjs'),
  list:           () => require('../src/commands/list.cjs'),
  show:           () => require('../src/commands/show.cjs'),
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
if (!command || !COMMANDS[command]) command = 'help';

const ctx = { pkg, PKG_DIR, REPO_ROOT };

try {
  COMMANDS[command]()(rest, ctx);
} catch (err) {
  console.error(`opencues ${command}: ${err && err.stack || err}`);
  process.exit(1);
}
