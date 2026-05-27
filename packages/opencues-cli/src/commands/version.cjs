// `opencues version` — print CLI version + per-integration versions
// + their declared compatibility ranges. Pure inspection.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { banner, tree, dim, cliVersion } = require('../lib/style.cjs');

const HOSTS = ['claude-code', 'opencode', 'chrome', 'gemini-cli', 'shell'];

module.exports = function version(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  console.log(banner({ version: cliVersion(ctx) }));
  console.log('');

  const integRows = [];
  for (const h of HOSTS) {
    const pkgPath = path.join(ctx.REPO_ROOT, 'integrations', h, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      integRows.push([`@opencues/${h}`, dim('(not found)'), '']);
      continue;
    }
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const compat = p.compatibility
      ? Object.entries(p.compatibility).map(([k, v]) => `${k} ${v}`).join(', ')
      : dim('(unspecified)');
    integRows.push([p.name || `@opencues/${h}`, `v${p.version || '?'}`, compat]);
  }
  console.log(tree({
    title: 'Integrations',
    description: 'host editor integrations and their declared compatibility',
    rows: integRows,
  }));
  console.log('');

  const libRows = [];
  for (const lib of ['opencues-core', 'opencues-runtime']) {
    const pkgPath = path.join(ctx.REPO_ROOT, 'packages', lib, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    libRows.push([p.name || lib, `v${p.version || '?'}`]);
  }
  console.log(tree({
    title: 'Internal libraries',
    description: 'shared core + runtime packages every integration depends on',
    rows: libRows,
  }));
};

function printHelp() {
  console.log('opencues version');
  console.log('');
  console.log('Print the CLI version, every integration\'s version + declared host compatibility,');
  console.log('and the internal library versions. Reads from package.json files in the workspace');
  console.log('— what you see is what would be installed if you ran `opencues install` right now.');
}
