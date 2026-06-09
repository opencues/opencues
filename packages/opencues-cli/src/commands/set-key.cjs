// `opencues set-key <provider> <key>` — store an API key in
// ~/.cues/.env. Avoids the user editing their shell rc.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, fileLink, banner, cliVersion } = require('../lib/style.cjs');

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

module.exports = function setKey(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  console.log(banner({ version: cliVersion(ctx), tagline: 'store an API key' }));
  console.log('');

  const positional = argv.filter(a => !a.startsWith('-'));
  const [provider, key] = positional;
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

  const envFile = path.join(os.homedir(), '.cues', '.env');
  const envDir = path.dirname(envFile);
  fs.mkdirSync(envDir, { recursive: true });

  let preExistingMode = null;
  if (fs.existsSync(envFile)) {
    try { preExistingMode = fs.statSync(envFile).mode & 0o777; } catch {}
  }

  let lines = [];
  if (fs.existsSync(envFile)) {
    lines = fs.readFileSync(envFile, 'utf8').split('\n');
  }
  const newLine = `${envName}=${key}`;
  const idx = lines.findIndex(l => l.startsWith(`${envName}=`));
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(envFile, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });

  // writeFileSync's mode is only applied on creation. Apply unconditionally
  // so an existing file with looser perms gets tightened.
  try { fs.chmodSync(envFile, 0o600); } catch {}
  try { fs.chmodSync(envDir, 0o700); } catch {}

  if (preExistingMode !== null && (preExistingMode & 0o077) !== 0) {
    console.log(`${tag('warn')} previous ${fileLink(envFile, envFile)} mode was ${preExistingMode.toString(8).padStart(4, '0')} (group/other readable); tightened to 0600.`);
  }

  console.log(`${tag('ok')} stored ${bold(envName)} in ${fileLink(envFile, envFile)}`);
  console.log('');
  console.log(dim('Note: integrations currently read API keys from process env vars, not from'));
  console.log(dim('      ~/.cues/.env directly. Export in your shell to make it visible:'));
  console.log(`        ${bold(`export ${envName}=...`)}`);
  console.log('');
  console.log(dim('      Or source the env file in your shell rc:'));
  console.log(`        ${bold(`set -a && source ${envFile} && set +a`)}`);
};

function printHelp() {
  console.log('opencues set-key <provider> <key>');
  console.log('');
  console.log('Store an API key in ~/.cues/.env (chmod 600). Replaces any existing');
  console.log('value for the same provider.');
  console.log('');
  console.log(`Providers: ${Object.keys(PROVIDERS).join(', ')}`);
  console.log('');
  console.log('Examples:');
  console.log('  opencues set-key cerebras csk_...');
  console.log('  opencues set-key groq gsk_...');
  console.log('  opencues set-key finnhub abc123');
}
