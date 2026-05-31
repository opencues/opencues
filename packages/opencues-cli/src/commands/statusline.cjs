// `opencues statusline <enable|disable|status> [--project] [--force]`
//
// Opt-in surface for CC's statusLine slot. Why this is a separate
// command instead of folded into `opencues install claude-code`:
// ~/.claude/ is Claude Code's directory; we're guests, and writing
// to it on every install would surprise users with custom statuslines
// AND users who didn't realise we'd touch CC's own config dir.
//
// Today only CC has a statusLine concept this fits. If a future host
// gets one, this command grows a --host flag (defaults to claude-code).

'use strict';

const path = require('node:path');
const { tag, bold, dim, banner, cliVersion } = require('../lib/style.cjs');
const lib = require('../lib/cc-statusline.cjs');

function printHelp() {
  console.log('opencues statusline <enable | disable | status> [--project] [--force]');
  console.log('');
  console.log('Manage the Claude Code statusLine slot — opt-in by design.');
  console.log('');
  console.log('Subcommands:');
  console.log('  enable               Write our statusLine.command into settings.json');
  console.log('  disable              Clear our statusLine.command from settings.json');
  console.log('  status               Show what\'s currently configured at user + project level');
  console.log('');
  console.log('Flags:');
  console.log('  --project            Operate on <cwd>/.claude/settings.json (project-scoped)');
  console.log('                       instead of ~/.claude/settings.json (user-scoped, default)');
  console.log('  --force              enable: overwrite a user-custom statusLine.command');
  console.log('                       (off by default — we refuse to clobber your starship.sh etc.)');
  console.log('  -h, --help           Show this message');
  console.log('');
  console.log('Examples:');
  console.log('  opencues statusline status              # what\'s configured where?');
  console.log('  opencues statusline enable              # turn it on at user level');
  console.log('  opencues statusline enable --project    # turn it on for THIS project only');
  console.log('  opencues statusline disable             # turn it off at user level');
  console.log('  opencues statusline enable --force      # replace your custom command');
  console.log('');
  console.log('Behavior rules:');
  console.log('  - We only ever touch a settings.json after you run this command.');
  console.log('  - We back up to settings.json.bak.cues-statusline before writing.');
  console.log('  - We refuse to overwrite a non-opencues statusLine.command (use --force).');
  console.log('  - We refuse to clear a non-opencues statusLine.command (manual edit only).');
  console.log('  - Project-level settings.json wins over user-level when CC reads it.');
}

module.exports = function statusline(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    return printHelp();
  }

  // First positional = subcommand.
  let sub = null;
  let scope = 'user';
  let force = false;
  for (const a of argv) {
    if (a === '--project') { scope = 'project'; continue; }
    if (a === '--user')    { scope = 'user';    continue; }
    if (a === '--force')   { force = true;      continue; }
    if (!a.startsWith('-') && !sub) { sub = a; continue; }
  }

  if (!sub) { printHelp(); return 2; }

  console.log(banner({ version: cliVersion(ctx), tagline: `statusline · ${sub}${scope === 'project' ? ' (project)' : ''}` }));
  console.log('');

  if (sub === 'status') return doStatus(ctx);
  if (sub === 'enable') return doEnable(scope, force);
  if (sub === 'disable') return doDisable(scope);

  console.error(`opencues statusline: unknown subcommand "${sub}". One of: enable, disable, status.`);
  return 2;
};

function doStatus(ctx) {
  const userInfo = lib.inspect('user');
  const projectInfo = lib.inspect('project');
  console.log(`Statusline script: ${userInfo.scriptPath || dim('(not installed — run `opencues install claude-code` first)')}`);
  console.log('');
  printScope('user', userInfo);
  console.log('');
  printScope('project', projectInfo);
  return 0;
}

function printScope(label, info) {
  console.log(`${bold(label === 'user' ? 'User-level' : 'Project-level (' + process.cwd() + ')')}`);
  console.log(`  file: ${info.file}`);
  if (info.state === 'missing') {
    console.log(`  state: ${dim('not configured')}`);
    console.log(`  enable: ${bold(`opencues statusline enable${label === 'project' ? ' --project' : ''}`)}`);
  } else if (info.state === 'opencues-ours') {
    console.log(`  state: ${tag('ok')} configured — points at our script`);
    console.log(`  command: ${info.currentCmd}`);
  } else if (info.state === 'opencues-stale') {
    console.log(`  state: ${tag('warn')} stale opencues path — needs re-enable`);
    console.log(`  current: ${info.currentCmd}`);
    console.log(`  fix: ${bold(`opencues statusline enable${label === 'project' ? ' --project' : ''}`)}`);
  } else if (info.state === 'user-custom') {
    console.log(`  state: ${tag('info')} user-custom — not ours`);
    console.log(`  current: ${info.currentCmd}`);
    console.log(`  to switch: ${bold(`opencues statusline enable${label === 'project' ? ' --project' : ''} --force`)} ${dim('(backs up the prior command)')}`);
  } else if (info.state === 'broken') {
    console.log(`  state: ${tag('err')} ${info.error}`);
  }
}

function doEnable(scope, force) {
  const r = lib.enable(scope, { force });
  printResult(r);
  return r.ok ? 0 : 1;
}

function doDisable(scope) {
  const r = lib.disable(scope);
  printResult(r);
  return r.ok ? 0 : 1;
}

function printResult(r) {
  const sigil = r.ok ? tag('ok') : tag('err');
  console.log(`${sigil} ${r.message}`);
  if (r.ok && (r.action === 'created' || r.action === 'updated' || r.action === 'replaced-stale')) {
    console.log(dim('  Restart Claude Code (or open a new session) to pick it up.'));
  }
}
