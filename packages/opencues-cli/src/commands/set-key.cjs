// `opencues set-key <provider> <key>` — store an API key in
// ~/.cues/.env. Avoids the user editing their shell rc.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROVIDERS = {
  groq:    'GROQ_API_KEY',
  finnhub: 'FINNHUB_API_KEY',
  openai:  'OPENAI_API_KEY',
};

module.exports = function setKey(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

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
  fs.mkdirSync(path.dirname(envFile), { recursive: true });

  // Read existing, replace or append the line for this var.
  let lines = [];
  if (fs.existsSync(envFile)) {
    lines = fs.readFileSync(envFile, 'utf8').split('\n');
  }
  const newLine = `${envName}=${key}`;
  const idx = lines.findIndex(l => l.startsWith(`${envName}=`));
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(envFile, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });

  console.log(`Stored ${envName} in ${envFile}`);
  console.log('');
  console.log('Note: integrations (CC, OC, chrome) currently read API keys from process env vars,');
  console.log(`not from ~/.cues/.env directly. Until they're updated to load this file, you'll`);
  console.log('still need to export the key in your shell:');
  console.log(`  export ${envName}=...`);
  console.log('');
  console.log('Or source the env file in your shell rc:');
  console.log(`  set -a && source ${envFile} && set +a`);
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
  console.log('  opencues set-key groq gsk_...');
  console.log('  opencues set-key finnhub abc123');
}
