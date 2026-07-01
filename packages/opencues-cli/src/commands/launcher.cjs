// `opencues` (no args) — interactive launcher. On a terminal, a menu that
// routes into each command's own interactive flow. Non-TTY / piped falls back
// to the static status + command list (`help`), so scripting is unchanged.

'use strict';

const { banner, cliVersion, dim } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

// Each row runs a command with no args → its interactive flow. `[label, desc,
// module, argv]`. Order groups the "control panel" first, then content, hosts,
// diagnostics, help.
const ACTIONS = [
  ['Settings',              'browse + change OpenCues settings',    './config.cjs',     []],
  ['API keys',              'store a provider API key (masked)',    './set-key.cjs',    []],
  ['Identity',              'manage personal-data tokens',          './identity.cjs',   []],
  ['Debug logging',         'toggle verbose runtime logs',          './debug.cjs',      []],
  ['Explore cues & blanks', 'inspect what will fire',               './show.cjs',       []],
  ['Install a host',        'claude-code · opencode · chrome · …',   './install.cjs',    []],
  ['Run a host',            'launch a patched host',                './run.cjs',        []],
  ['Diagnostics',           'doctor — check the install',           './doctor.cjs',     []],
  ['Check API keys',        'verify keys against providers',        './check-keys.cjs', []],
  ['All commands',          'the full reference',                   './help.cjs',       []],
];

module.exports = async function launcher(argv, ctx) {
  // Non-TTY (pipe / CI): the static status + command list.
  if (!prompt.isInteractive()) return require('./help.cjs')(argv, ctx);

  const w = Math.max(...ACTIONS.map(a => a[0].length));
  for (;;) {
    if (process.stdout.isTTY) console.clear();
    console.log(banner({ version: cliVersion(ctx) }));
    console.log('');
    console.log(dim('What would you like to do?  ·  ↑↓ move · Enter select'));

    const choices = ACTIONS.map((a, i) => ({ label: `${a[0].padEnd(w)}   ${dim('· ' + a[1])}`, value: i }));
    choices.push({ spacer: true });
    choices.push({ label: 'Quit', value: 'quit', dim: true });

    const pick = await prompt.select('', choices);
    if (pick === 'quit' || pick == null) return;

    if (process.stdout.isTTY) console.clear();
    const [, , mod, args] = ACTIONS[pick];
    const code = await require(mod)(args, ctx);
    if (typeof code === 'number' && code !== 0) return code;

    // Pause so printed output survives the next clear; interactive actions
    // (which manage their own screen) just get a clean Menu / Quit chooser.
    console.log('');
    const after = await prompt.select('', [
      { label: 'Back to menu', value: 'menu' },
      { label: 'Quit', value: 'quit', dim: true },
    ]);
    if (after !== 'menu') return;
  }
};
