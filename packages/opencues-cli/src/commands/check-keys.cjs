// `opencues check-keys` — verify configured API keys actually work
// by hitting each provider's lightest endpoint.

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

module.exports = async function checkKeys(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  // Load ~/.cues/.env into a local map (process.env wins if both set).
  const envFile = path.join(os.homedir(), '.cues', '.env');
  const fileEnv = {};
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) fileEnv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  const get = (k) => process.env[k] || fileEnv[k];

  console.log('Checking configured API keys...\n');
  const checks = [
    { provider: 'groq',    env: 'GROQ_API_KEY',    fn: checkGroq },
    { provider: 'finnhub', env: 'FINNHUB_API_KEY', fn: checkFinnhub },
  ];
  let bad = 0;
  for (const c of checks) {
    const key = get(c.env);
    if (!key) { console.log(`  -  ${c.provider} (${c.env} unset)`); continue; }
    // In a TTY: print a "checking…" line, then \r-overwrite with the
    // final ✓/✗. In a pipe (CI / capture): just print the verdict
    // once when it's known, since \r doesn't physically erase in a
    // non-TTY output stream and the user would see both halves.
    const isTty = process.stdout.isTTY;
    if (isTty) process.stdout.write(`  …  ${c.provider} ...`);
    try {
      const res = await c.fn(key);
      const line = `  ✓  ${c.provider} ... ${res || 'ok'}\n`;
      process.stdout.write(isTty ? `\r${line}` : line);
    } catch (err) {
      const line = `  ✗  ${c.provider} ... ${err.message}\n`;
      process.stdout.write(isTty ? `\r${line}` : line);
      bad++;
    }
  }
  console.log('');
  if (bad > 0) process.exit(1);
};

function checkGroq(key) {
  // Models endpoint is read-only + free.
  return httpJson('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` })
    .then(j => `${(j.data || []).length} models available`);
}
function checkFinnhub(key) {
  return httpJson(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(key)}`)
    .then(j => `AAPL=$${j.c ?? '?'}`);
}

function httpJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'opencues-cli', accept: 'application/json', ...headers } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 100)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function printHelp() {
  console.log('opencues check-keys');
  console.log('');
  console.log('Verify each configured API key by hitting the provider\'s cheapest endpoint:');
  console.log('  - groq:    GET /openai/v1/models  (free, read-only)');
  console.log('  - finnhub: GET /quote?symbol=AAPL (free tier, 1 req)');
  console.log('');
  console.log('Reads keys from process.env first, then ~/.cues/.env. Exits 1 if any');
  console.log('configured key fails (unset keys are fine — they print "-").');
}
