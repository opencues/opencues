#!/usr/bin/env node
// `opencues` — front door CLI.
//
// Runs two ways:
//   • from a clone (`pnpm exec opencues`, dev) — the repo is `../..`.
//   • standalone (`npm i -g opencues`) — the repo is resolved via
//     $OPENCUES_REPO or ~/.opencues/repo, fetched on demand (pinned to
//     this CLI's own version tag) the first time a repo-needing command
//     runs. See src/lib/repo-root.cjs.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const PKG_DIR = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

// Repo root: clone (dev) → $OPENCUES_REPO → ~/.opencues/repo → fetched on
// demand (REPO_NEEDING commands only). Light commands never clone; with no
// repo present they see the (absent) home path and their existsSync guards
// read it as not-installed.
const repoRootLib = require('../src/lib/repo-root.cjs');
const RESOLVED_REPO = repoRootLib.resolveRepoRoot(PKG_DIR);
const REPO_ROOT = RESOLVED_REPO.root || repoRootLib.homeRepoDir();

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
  calendar:       () => require('../src/commands/calendar.cjs'),
  launcher:       () => require('../src/commands/launcher.cjs'), // no-arg interactive menu
  config:         () => require('../src/commands/config.cjs'),
  cleanup:        () => require('../src/commands/cleanup.cjs'),
  'check-keys':   () => require('../src/commands/check-keys.cjs'),
  models:         () => require('../src/commands/models.cjs'),
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

// Commands that read the repo's contents (defaults/, integrations/, core
// dist/). Only these trigger the on-demand fetch; everything else works
// repo-less. `launcher` stays out — its menu entries route back through
// this same dispatch on selection.
const REPO_NEEDING = new Set([
  'install', 'uninstall', 'run', 'sync', 'update',
  'seed-configs', 'update-configs', 'validate', 'review', 'models',
]);

const ctx = { pkg, PKG_DIR, REPO_ROOT, repoSource: RESOLVED_REPO.source };

if (REPO_NEEDING.has(command) && !RESOLVED_REPO.root) {
  // Standalone install with no repo yet — fetch it (pinned to this CLI's
  // version tag) before the command runs. Sync on purpose: every
  // repo-needing command is long-running anyway. Fetch failures are
  // user-ready messages, not stack traces.
  try {
    ctx.REPO_ROOT = repoRootLib.ensureRepoRoot(PKG_DIR, pkg.version);
    ctx.repoSource = 'home';
  } catch (err) {
    console.error(`\nopencues: ${err && err.message || err}\n`);
    process.exit(1);
  }
}

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
