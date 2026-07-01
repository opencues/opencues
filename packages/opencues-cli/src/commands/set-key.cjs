// `opencues set-key [<provider>] [<key>]` — store an API key in
// ~/.cues/.env. Avoids the user editing their shell rc.
//
//   opencues set-key                  interactive: pick a provider → paste key (masked)
//   opencues set-key <provider>       interactive key entry for that provider
//   opencues set-key <provider> <key> one-shot (scriptable)

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, green, fileLink, banner, cliVersion, G } = require('../lib/style.cjs');
const prompt = require('../lib/prompt.cjs');

const PROVIDERS = {
  cerebras:     'CEREBRAS_API_KEY',
  groq:         'GROQ_API_KEY',
  gemini:       'GEMINI_API_KEY',
  anthropic:    'ANTHROPIC_API_KEY',
  openai:       'OPENAI_API_KEY',
  openrouter:   'OPENROUTER_API_KEY',
  'opencode-zen': 'OPENCODE_ZEN_API_KEY',
  finnhub:      'FINNHUB_API_KEY',
};

// Computed per-call, not at module load — tests (and OPENCUES_HOME users)
// override HOME after the module is required.
const envFilePath = () => path.join(os.homedir(), '.cues', '.env');

function keyIsSet(envName) {
  const ENV_FILE = envFilePath();
  const contents = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  return !!process.env[envName] || new RegExp(`^${envName}=\\S`, 'm').test(contents);
}

// Interactive provider picker. Each row shows the env var + a ring: green ●
// when a value is already stored, gray ● when not.
async function pickProvider() {
  const nameW = Math.max(...Object.keys(PROVIDERS).map(p => p.length));
  const choices = Object.entries(PROVIDERS).map(([p, envName]) => ({
    label: `${p.padEnd(nameW)}   ${dim(envName)}`,
    ring: keyIsSet(envName),
    value: p,
  }));
  choices.push({ spacer: true });
  choices.push({ label: 'Cancel', value: null, dim: true });
  console.log(dim('Which provider?  ·  ↑↓ move · Enter select · green ● = key already set'));
  return prompt.select('', choices);
}

module.exports = async function setKey(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  console.log(banner({ version: cliVersion(ctx), tagline: 'store an API key' }));
  console.log('');

  const positional = argv.filter(a => !a.startsWith('-'));
  let [provider, key] = positional;

  // Interactive provider pick when omitted on a real terminal.
  if (!provider && prompt.isInteractive()) {
    provider = await pickProvider();
    if (!provider) return; // cancelled
  }
  // Interactive masked key entry when the provider is known but the key isn't.
  if (provider && PROVIDERS[provider] && !key && prompt.isInteractive()) {
    key = await prompt.secret(`Paste the value for ${bold(PROVIDERS[provider])}`);
    if (!key) { console.log(`${tag('info')} cancelled — nothing stored.`); return; }
  }

  if (!provider || !key) {
    console.error('opencues set-key: usage: opencues set-key <provider> <key>');
    console.error(`Providers: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(2);
  }
  const envName = PROVIDERS[provider];
  if (!envName) {
    console.error(`opencues set-key: unknown provider "${provider}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(2);
  }

  writeKey(envName, key);
};

function writeKey(envName, key) {
  const ENV_FILE = envFilePath();
  const envDir = path.dirname(ENV_FILE);
  fs.mkdirSync(envDir, { recursive: true });

  let preExistingMode = null;
  if (fs.existsSync(ENV_FILE)) {
    try { preExistingMode = fs.statSync(ENV_FILE).mode & 0o777; } catch {}
  }

  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  }
  const newLine = `${envName}=${key}`;
  const idx = lines.findIndex(l => l.startsWith(`${envName}=`));
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(ENV_FILE, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });

  // writeFileSync's mode is only applied on creation. Apply unconditionally
  // so an existing file with looser perms gets tightened.
  try { fs.chmodSync(ENV_FILE, 0o600); } catch {}
  try { fs.chmodSync(envDir, 0o700); } catch {}

  if (preExistingMode !== null && (preExistingMode & 0o077) !== 0) {
    console.log(`${tag('warn')} previous ${fileLink(ENV_FILE, ENV_FILE)} mode was ${preExistingMode.toString(8).padStart(4, '0')} (group/other readable); tightened to 0600.`);
  }

  const nowSet = keyIsSet(envName) ? green(G.ringOn) : dim(G.ringOn);
  console.log(`${tag('ok')} stored ${bold(envName)} ${nowSet} in ${fileLink(ENV_FILE, ENV_FILE)}`);
  console.log('');
  console.log(dim('Note: integrations currently read API keys from process env vars, not from'));
  console.log(dim('      ~/.cues/.env directly. Export in your shell to make it visible:'));
  console.log(`        ${bold(`export ${envName}=...`)}`);
  console.log('');
  console.log(dim('      Or source the env file in your shell rc:'));
  console.log(`        ${bold(`set -a && source ${ENV_FILE} && set +a`)}`);
}

function printHelp() {
  console.log('opencues set-key [<provider>] [<key>]');
  console.log('');
  console.log('Store an API key in ~/.cues/.env (chmod 600). Replaces any existing');
  console.log('value for the same provider. With no arguments on a terminal, opens an');
  console.log('interactive provider picker + masked key entry.');
  console.log('');
  console.log(`Providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log('');
  console.log('Examples:');
  console.log('  opencues set-key                 # interactive');
  console.log('  opencues set-key cerebras csk_...');
  console.log('  opencues set-key groq gsk_...');
  console.log('  opencues set-key finnhub abc123');
}
