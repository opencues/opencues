// `opencues` (no args) — interactive launcher. On a terminal, a menu that
// routes into each command's own interactive flow. Non-TTY / piped falls back
// to the static status + command list (`help`), so scripting is unchanged.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { banner, cliVersion, dim, green, yellow, G } = require('../lib/style.cjs');
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
    // Compact status — recomputed each loop so it reflects prior actions
    // (e.g. after adding a key). green ● = keys set, yellow ● = none yet.
    const s = status(ctx);
    console.log(dim(`  ~/.cues  ·  ${s.cues} cues · ${s.blanks} blanks · ${s.auditors} auditors`));
    const keyRing = s.setKeys ? green(G.ringOn) : yellow(G.ringOn);
    console.log(`  ${keyRing} ${dim(s.setKeys ? `${s.setKeys}/${s.totalKeys} API keys set` : 'no API keys set — pick "API keys" below')}`);
    console.log('');
    console.log(dim('What would you like to do?  ·  ↑↓ move · Enter select'));

    const choices = ACTIONS.map((a, i) => ({ label: `${a[0].padEnd(w)}   ${dim(a[1])}`, value: i }));
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

// Compact launcher status: folder-based cue/blank/auditor counts + how many
// provider keys are configured (env or ~/.cues/.env).
function status(ctx) {
  const cuesDir = path.join(os.homedir(), '.cues');
  const countKind = (sub, primary) => {
    let n = 0;
    try {
      for (const e of fs.readdirSync(path.join(cuesDir, sub), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (fs.existsSync(path.join(cuesDir, sub, e.name, primary))
         || fs.existsSync(path.join(cuesDir, sub, e.name, primary.toLowerCase()))) n += 1;
      }
    } catch { /* dir absent → 0 */ }
    return n;
  };

  let keyNames = ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];
  try {
    const reg = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
    keyNames = reg.listProviders().map(p => p.envKeyName).filter(Boolean);
  } catch { /* core not built — use the fallback list */ }
  const envFile = path.join(cuesDir, '.env');
  const envContents = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const isSet = (k) => !!process.env[k] || new RegExp(`^${k}=\\S`, 'm').test(envContents);

  return {
    cues: countKind('cues', 'CUE.md'),
    blanks: countKind('blanks', 'BLANK.md'),
    auditors: countKind('auditors', 'AUDITOR.md'),
    setKeys: keyNames.filter(isSet).length,
    totalKeys: keyNames.length,
  };
}
