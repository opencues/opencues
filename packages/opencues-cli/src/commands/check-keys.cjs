// `opencues check-keys` — verify configured API keys actually work
// by hitting each provider's lightest endpoint.

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, banner } = require('../lib/style.cjs');

module.exports = async function checkKeys(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  console.log(banner({ version: ctx.pkg.version, tagline: 'verify configured API keys' }));
  console.log('');

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

  const checks = [
    { provider: 'groq',    env: 'GROQ_API_KEY',    fn: checkGroq },
    { provider: 'finnhub', env: 'FINNHUB_API_KEY', fn: checkFinnhub },
  ];
  let bad = 0;
  for (const c of checks) {
    const key = get(c.env);
    if (!key) {
      console.log(`  ${tag('info')} ${bold(c.provider.padEnd(8))} ${dim(`${c.env} unset`)}`);
      continue;
    }
    const isTty = process.stdout.isTTY;
    if (isTty) process.stdout.write(`  ${tag('info')} ${bold(c.provider.padEnd(8))} ${dim('checking…')}`);
    try {
      const res = await c.fn(key);
      const line = `  ${tag('ok')} ${bold(c.provider.padEnd(8))} ${dim(res || 'ok')}\n`;
      process.stdout.write(isTty ? `\r\x1b[K${line}` : line);
    } catch (err) {
      const line = `  ${tag('err')} ${bold(c.provider.padEnd(8))} ${dim(err.message)}\n`;
      process.stdout.write(isTty ? `\r\x1b[K${line}` : line);
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
