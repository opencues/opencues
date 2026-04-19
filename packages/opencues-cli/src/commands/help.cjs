// `opencues help [<command>]` — discoverable help.
//
// Without args: print the top-level overview + command list.
// With a command name: defer to that command's --help (each subcommand
// implements its own).

'use strict';

const path = require('node:path');

module.exports = function help(argv, ctx) {
  if (argv.length > 0) {
    // Forward to subcommand help.
    const sub = argv[0];
    try {
      require(path.join(ctx.PKG_DIR, 'src/commands', `${sub}.cjs`))(['--help'], ctx);
      return;
    } catch (err) {
      console.error(`opencues: unknown command "${sub}"\n`);
    }
  }

  const { pkg } = ctx;
  console.log(`${pkg.name} v${pkg.version} — ${pkg.description}`);
  console.log('');
  console.log('Usage: opencues <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  install <host>          Install a host integration. <host>=cc|oc|chrome|--all');
  console.log('  uninstall <host>        Roll back an installation. <host>=cc|oc|chrome|--all');
  console.log('  seed-configs            Copy repo defaults into ~/.opencues/');
  console.log('  which                   Print every relevant path (installs, configs, logs)');
  console.log('  version                 Print CLI version + per-integration versions/compat');
  console.log('  help [<command>]        Show help. With <command>: that subcommand\'s help.');
  console.log('');
  console.log('Per-host details:');
  console.log('  cc      OpenCues for Claude Code (patches cli.js via tweakcc)');
  console.log('  oc      OpenCues for OpenCode (patches a fork)');
  console.log('  chrome  OpenCues Chrome MV3 extension');
  console.log('');
  console.log('Configs:');
  console.log('  Project-level: <cwd>/.opencues/');
  console.log('  User-level:    ~/.opencues/');
  console.log('  Override:      $OPENCUES_HOME (top priority)');
  console.log('');
  console.log('Examples:');
  console.log('  opencues install cc                          # install for Claude Code');
  console.log('  opencues install --all                       # install all integrations');
  console.log('  opencues seed-configs                        # populate ~/.opencues/');
  console.log('  opencues which                               # show "where does X live?"');
  console.log('  opencues uninstall cc -- --target /path      # forwards to cc\'s installer');
};
