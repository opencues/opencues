#!/usr/bin/env node
'use strict';

// Live smoke for every (provider, model) combination the runtime ships
// with. Confirms each route ACTUALLY works against the live API with the
// keys the user has set in their env.
//
// Usage:
//   node tests/integration/llm-providers-smoke.cjs            # run with current env
//   node tests/integration/llm-providers-smoke.cjs --models   # list known combos
//
// Per-provider behaviour:
//   - HTTP providers (groq/anthropic/gemini/openai/openrouter/cerebras):
//     POSTs a one-token "say ok" prompt with temperature=0 (the failure
//     mode the user hit was specifically about temperature). Reports the
//     full error message on 4xx so we can surface API-level deprecations
//     before they kill blanks silently in production.
//   - CLI providers (claude-cli, openai-subscription): skipped unless the
//     binary is on PATH; reported as `skipped` not `failed` when missing.
//
// Why this is shaped as a runnable script rather than a vitest test:
//   - Uses live network + real API keys; never wants to run in `pnpm test`.
//   - Output is a human-readable table, not a green/red CI gate.
//   - The unit tests in `llm-provider.temperature.test.ts` pin the
//     request-building behaviour; this script verifies the live API still
//     ACCEPTS those bodies. Different concerns, different runners.

const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..', '..');

const distEntry = path.join(repoRoot, 'packages/opencues-core/dist/llm-provider.js');
let llm;
try {
  llm = require(distEntry);
} catch (err) {
  console.error('Could not load', distEntry);
  console.error('Run `pnpm --filter @opencues/core build` first.');
  process.exit(2);
}
const { getProvider } = llm;

// Curated (provider, model) combos to verify. Pulled from each provider's
// `knownModels:` list. CLI providers are excluded (separate path).
const COMBOS = [
  { provider: 'groq',       model: 'openai/gpt-oss-120b' },
  { provider: 'groq',       model: 'openai/gpt-oss-20b' },
  { provider: 'groq',       model: 'llama-3.3-70b-versatile' },
  { provider: 'cerebras',   model: 'gpt-oss-120b' },
  { provider: 'cerebras',   model: 'zai-glm-4.7' },
  { provider: 'gemini',     model: 'gemini-3.1-flash-lite' },
  { provider: 'gemini',     model: 'gemini-flash-latest' },
  { provider: 'gemini',     model: 'gemini-pro-latest' },
  { provider: 'anthropic',  model: 'claude-haiku-4-5-20251001' },
  { provider: 'anthropic',  model: 'claude-sonnet-4-6' },
  { provider: 'anthropic',  model: 'claude-opus-4-7' },
  { provider: 'openai',     model: 'gpt-5.4-mini' },
  { provider: 'openai',     model: 'gpt-5.4' },
  { provider: 'openai',     model: 'gpt-5.4-nano' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b:free' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
  { provider: 'openrouter', model: 'anthropic/claude-haiku-4-5' },
  { provider: 'openrouter', model: 'anthropic/claude-opus-4-7' },
  { provider: 'openrouter', model: 'google/gemini-3.1-flash-lite' },
];

if (process.argv.includes('--models')) {
  for (const { provider, model } of COMBOS) console.log(`${provider.padEnd(11)} ${model}`);
  process.exit(0);
}

async function probe({ provider, model }) {
  const adapter = getProvider(provider);
  if (!adapter) return { provider, model, status: 'skipped', reason: 'unknown provider id' };
  const apiKey = adapter.envKeyName ? process.env[adapter.envKeyName] : null;
  if (adapter.envKeyName && !apiKey) {
    return { provider, model, status: 'skipped', reason: `${adapter.envKeyName} not set` };
  }
  const req = {
    model,
    messages: [{ role: 'user', content: 'Reply with just the word OK and nothing else.' }],
    temperature: 0,
    maxTokens: 16,
  };
  let built;
  try {
    built = adapter.buildRequest(req, { apiKey: apiKey ?? '', endpoint: adapter.defaultEndpoint });
  } catch (err) {
    return { provider, model, status: 'failed', reason: `buildRequest threw: ${err.message}` };
  }
  const started = Date.now();
  try {
    const res = await fetch(built.url, { method: 'POST', headers: built.headers, body: built.body });
    const elapsed = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      // Surface the API error verbatim — this is the whole point of the smoke.
      return { provider, model, status: 'failed', reason: `HTTP ${res.status}: ${text.slice(0, 240)}`, ms: elapsed };
    }
    let content = '';
    try { content = adapter.parseResponse(text); } catch (err) {
      return { provider, model, status: 'failed', reason: `parseResponse threw: ${err.message}`, ms: elapsed };
    }
    const trimmed = content.trim().slice(0, 80);
    return { provider, model, status: 'ok', reply: trimmed, ms: elapsed };
  } catch (err) {
    return { provider, model, status: 'failed', reason: `network: ${err.message}`, ms: Date.now() - started };
  }
}

(async () => {
  const results = [];
  for (const combo of COMBOS) {
    process.stdout.write(`▸ ${combo.provider.padEnd(11)} ${combo.model.padEnd(38)} `);
    const r = await probe(combo);
    results.push(r);
    const tag = r.status === 'ok' ? '✓' : r.status === 'skipped' ? '·' : '✗';
    const detail = r.status === 'ok' ? `(${r.ms}ms) "${r.reply}"`
                 : r.status === 'skipped' ? `(skipped — ${r.reason})`
                 : `(${r.reason})`;
    console.log(`${tag} ${detail}`);
  }
  const pass = results.filter((r) => r.status === 'ok').length;
  const fail = results.filter((r) => r.status === 'failed').length;
  const skip = results.filter((r) => r.status === 'skipped').length;
  console.log(`\n${pass} ok · ${fail} failed · ${skip} skipped (of ${results.length})`);
  process.exit(fail === 0 ? 0 : 1);
})();
