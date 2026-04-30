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
  console.log('Setup:');
  console.log('  install <host>          Install a host integration (claude-code|opencode|codex|chrome|--all)');
  console.log('  uninstall <host>        Roll back an installation');
  console.log('  seed-configs            Copy repo defaults into ~/.opencues/ (first-time + sync)');
  console.log('  update-configs          Pull new shipped cues/blanks into ~/.opencues/ (after a `git pull`)');
  console.log('  update                  Pull, rebuild, redeploy installed integrations');
  console.log('  set-key <provider>      Store an API key in ~/.opencues/.env');
  console.log('  check-keys              Verify configured API keys against provider endpoints');
  console.log('');
  console.log('Authoring:');
  console.log('  init                    Scaffold <cwd>/.opencues/ with templates');
  console.log('  new <kind> <name>       Scaffold a single cue / blank');
  console.log('  validate                Lint configs across search paths');
  console.log('  import <source>         Download a community config pack (gist/github/url/local)');
  console.log('');
  console.log('Run / inspect:');
  console.log('  run <host>              Launch the patched host (claude-code | opencode | codex | chrome)');
  console.log('  sync <host>             Bundle .opencues/ into a host that doesn\'t auto-discover (chrome)');
  console.log('  which                   Print every relevant path (installs, configs, logs)');
  console.log('  version                 Print CLI version + per-integration versions/compat');
  console.log('  doctor                  Cross-host diagnostics + suggested fixes');
  console.log('  list                    List every defined cue / blank with source path');
  console.log('  show <name>             Print full config for one cue / blank by name');
  console.log('  edit <file>             Open ~/.opencues/<file>.md in $EDITOR');
  console.log('  logs [--tail]           Show /tmp/opencues.log (last 50 lines, or follow with --tail)');
  console.log('  debug [on|off]          Toggle runtime debug-mode (~/.opencues/opencues.md; no arg = print current)');
  console.log('  completion <shell>      Print shell completion script (bash | zsh | fish)');
  console.log('  help [<command>]        Show help. With <command>: that subcommand\'s help.');
  console.log('');
  console.log('Per-host details:');
  console.log('  claude-code  OpenCues for Claude Code (patches cli.js via tweakcc)');
  console.log('  opencode     OpenCues for OpenCode (patches a TS fork)');
  console.log('  codex        OpenCues for OpenAI Codex (Rust TUI; pre-alpha — see HANDOFF.md)');
  console.log('  chrome       OpenCues Chrome MV3 extension');
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
