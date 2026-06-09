// `opencues check-keys` — verify configured API keys actually work
// by hitting each provider's lightest endpoint.

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tag, bold, dim, banner, cliVersion } = require('../lib/style.cjs');

module.exports = async function checkKeys(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  console.log(banner({ version: cliVersion(ctx), tagline: 'verify configured API keys' }));
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

  // Map provider id → live-probe function. Each function hits the
  // provider's lightest endpoint (model list, free) using the user's
  // key, surfacing 401/403/network errors. Keep keyed by provider id
  // since each probe is unique per-provider's auth shape.
  const PROBE_FN = {
    groq: checkGroq, cerebras: checkCerebras, openai: checkOpenAI,
    anthropic: checkAnthropic, openrouter: checkOpenRouter, gemini: checkGemini,
  };

  // Provider list sourced from @opencues/core's PROVIDERS registry —
  // adding a provider auto-flows into check-keys (just add a PROBE_FN
  // entry above). Falls back to the hardcoded list if core isn't built.
  let registry = null;
  try {
    registry = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
  } catch { /* core not built — fall back below */ }
  const llmChecks = registry
    ? registry.listProviders().map(p => ({
        provider: p.id, env: p.envKeyName, fn: PROBE_FN[p.id],
      })).filter(c => c.fn)  // skip any provider missing a probe
    : [
        { provider: 'groq',       env: 'GROQ_API_KEY',       fn: checkGroq },
        { provider: 'cerebras',   env: 'CEREBRAS_API_KEY',   fn: checkCerebras },
        { provider: 'openai',     env: 'OPENAI_API_KEY',     fn: checkOpenAI },
        { provider: 'anthropic',  env: 'ANTHROPIC_API_KEY',  fn: checkAnthropic },
        { provider: 'openrouter', env: 'OPENROUTER_API_KEY', fn: checkOpenRouter },
        { provider: 'gemini',     env: 'GEMINI_API_KEY',     fn: checkGemini },
      ];
  // Finnhub is non-LLM (stocks blank); kept hardcoded as the lone
  // non-LLM service-key check.
  const checks = [...llmChecks, { provider: 'finnhub', env: 'FINNHUB_API_KEY', fn: checkFinnhub }];
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

// Each provider's lightest read-only endpoint (model list, free).
// 401 / 403 surface as descriptive errors via the HTTP wrapper.
function checkGroq(key) {
  return httpJson('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` })
    .then(j => `${(j.data || []).length} models available`);
}
function checkCerebras(key) {
  return httpJson('https://api.cerebras.ai/v1/models', { Authorization: `Bearer ${key}` })
    .then(j => `${(j.data || []).length} models available`);
}
function checkOpenAI(key) {
  return httpJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` })
    .then(j => `${(j.data || []).length} models available`);
}
function checkAnthropic(key) {
  // Anthropic uses x-api-key + a versioned header (per Messages API docs).
  return httpJson('https://api.anthropic.com/v1/models', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  }).then(j => `${(j.data || []).length} models available`);
}
function checkOpenRouter(key) {
  return httpJson('https://openrouter.ai/api/v1/models', { Authorization: `Bearer ${key}` })
    .then(j => `${(j.data || []).length} models available`);
}
function checkGemini(key) {
  // INFOSEC F8: x-goog-api-key header instead of `?key=` to keep the
  // secret out of URL access logs / browser history / referrer.
  return httpJson('https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': key })
    .then(j => `${(j.models || []).length} models available`);
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
  console.log('  - groq:       GET /openai/v1/models  (free, read-only)');
  console.log('  - cerebras:   GET /v1/models');
  console.log('  - openai:     GET /v1/models');
  console.log('  - anthropic:  GET /v1/models  (x-api-key + anthropic-version header)');
  console.log('  - openrouter: GET /api/v1/models');
  console.log('  - gemini:     GET /v1beta/models  (x-goog-api-key header)');
  console.log('  - finnhub:    GET /quote?symbol=AAPL  (free tier, 1 req)');
  console.log('');
  console.log('Reads keys from process.env first, then ~/.cues/.env. Exits 1 if any');
  console.log('configured key fails. Unset keys print a "ENV unset" info line and');
  console.log('do not count as failures.');
}
