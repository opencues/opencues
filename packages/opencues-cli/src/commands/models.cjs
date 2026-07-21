// `opencues models` — effective LLM routing per bucket + the
// provider/model catalog. The routing section renders from
// @opencues/core's resolveEffectiveRouting — the SAME walk dispatch
// (build-sources / boot-common), doctor's LLM-routing section, and the
// in-editor `model` blank use — so what this command prints is what a
// real LLM call would do. The catalog is each provider's curated
// `knownModels` (what the config menu + fluid-config NL switching can
// select); any model string can still be hand-set in OPENCUES.md.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { bold, dim, green, yellow, banner, cliVersion, G } = require('../lib/style.cjs');
const { readScalars } = require('../lib/opencues-md.cjs');

module.exports = function models(argv, ctx) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();

  let providers, effectiveRouting, registry;
  try {
    providers = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
    effectiveRouting = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/effective-routing.js'));
    registry = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/feature-registry.js'));
  } catch (err) {
    console.error('opencues models: failed to load @opencues/core (run `pnpm build`):', err.message);
    return 1;
  }
  let envKeysMod = null;
  try {
    envKeysMod = require(path.join(ctx.REPO_ROOT, 'packages/opencues-core/dist/env-keys.js'));
  } catch { /* env-only fallback below */ }

  // Same inputs a native host boots with: OPENCUES.md scalars + the
  // shell-env + ~/.cues/.env key bag.
  const cuesDir = process.env.OPENCUES_HOME || path.join(os.homedir(), '.cues');
  const settingsFile = path.join(cuesDir, registry.CORE_SETTINGS_FILE);
  let scalars = new Map(); // readScalars returns a Map keyed by scalar name
  try {
    if (fs.existsSync(settingsFile)) scalars = readScalars(fs.readFileSync(settingsFile, 'utf8'));
  } catch { /* missing/unreadable settings file = empty scalars */ }
  let apiKeys;
  if (envKeysMod) {
    apiKeys = envKeysMod.buildBootApiKeys();
  } else {
    apiKeys = {};
    for (const adapter of providers.listProviders()) {
      if (adapter.envKeyName) apiKeys[adapter.envKeyName] = process.env[adapter.envKeyName];
    }
  }

  const routing = effectiveRouting.resolveEffectiveRouting({
    scalars: (name) => scalars.get(name),
    apiKeys,
  });

  if (argv.includes('--json')) {
    // Scriptable one-shot: routing rows minus the adapter object (it
    // carries functions), plus the catalog.
    const strip = (row) => ({
      bucket: row.bucket, providerId: row.providerId, model: row.model,
      providerSource: row.providerSource, modelSource: row.modelSource,
      keyPresent: row.keyPresent, trainsOnInputBlocked: row.trainsOnInputBlocked,
    });
    const catalog = providers.listProviders().map((a) => ({
      id: a.id,
      defaultModel: a.defaultModel,
      knownModels: a.knownModels ?? [a.defaultModel],
      transport: a.transport ?? 'http',
      keyPresent: a.transport === 'cli' ? null : (a.optionalAuth ? true : !!(a.envKeyName && apiKeys[a.envKeyName])),
    }));
    console.log(JSON.stringify({
      routing: { cues: strip(routing.cues), auditors: strip(routing.auditors), blanks: strip(routing.blanks) },
      providers: catalog,
    }, null, 2));
    return 0;
  }

  console.log(banner({ version: cliVersion(ctx), tagline: 'effective LLM routing + provider catalog' }));
  console.log('');

  // ── Effective routing (mirrors doctor's LLM-routing section) ────────
  console.log(bold('Effective routing') + '  ' + dim('what each bucket dispatches with (bucket scalar > global > auto)'));
  const SOURCE_TAGS = {
    global: 'llm-provider',
    'auto-key': 'auto (env key)',
    'auto-subscription': 'auto (subscription CLI)',
  };
  for (const bucket of effectiveRouting.LLM_BUCKETS) {
    const row = routing[bucket];
    const label = `${bucket}:`.padEnd(10);
    if (!row.provider) {
      const body = row.providerId
        ? `${row.providerId} ${dim('(unknown provider — LLM calls disabled)')}`
        : dim('(none — no key + no scalar set)');
      console.log(`  ${dim(G.ringOn)} ${label}${body}`);
      continue;
    }
    const ring = row.keyPresent && !row.trainsOnInputBlocked ? green(G.ringOn) : yellow(G.ringOn);
    const srcTag = SOURCE_TAGS[row.providerSource] ? dim(`  (← ${SOURCE_TAGS[row.providerSource]})`) : '';
    const notes = [];
    if (!row.keyPresent) notes.push(yellow('key missing'));
    if (row.trainsOnInputBlocked) notes.push(yellow('refused — trains on input'));
    const noteStr = notes.length ? `  ${notes.join('  ')}` : '';
    console.log(`  ${ring} ${label}${row.providerId} · ${row.model}${srcTag}${noteStr}`);
  }
  console.log('');

  // ── Provider / model catalog ────────────────────────────────────────
  console.log(bold('Providers · models') + '  ' + dim('knownModels — selectable via menu + NL switching; any model can be hand-set in OPENCUES.md'));
  const current = routing.blanks;
  const adapters = providers.listProviders();
  const keyState = (a) =>
    a.transport === 'cli' ? 'subscription CLI'
      : a.optionalAuth ? 'no key needed'
        : a.envKeyName && apiKeys[a.envKeyName] ? 'key set'
          : 'no key';
  const rank = (a) => a.id === current.providerId ? 0 : keyState(a) !== 'no key' ? 1 : 2;
  const ordered = [...adapters].sort((a, b) => rank(a) - rank(b));
  const idW = Math.max(...ordered.map((a) => a.id.length)) + 2;
  for (const a of ordered) {
    const modelList = (a.knownModels ?? [a.defaultModel])
      .map((m) => (a.id === current.providerId && m === current.model ? `${m}*` : m))
      .join(', ');
    const state = a.id === current.providerId ? 'current' : keyState(a);
    const ring = state === 'no key' ? dim(G.ringOn) : green(G.ringOn);
    console.log(`  ${ring} ${a.id.padEnd(idW)}${modelList}  ${dim(`· ${state}`)}`);
  }
  console.log('');
  console.log(dim('  * = model in effect (blanks bucket). Switch: `opencues config`, or in-editor'));
  console.log(dim('  natural language (`use gemma for blanks _`) / cycling (`opencues blanks-llm-model _`).'));
  return 0;
};

function printHelp() {
  console.log(`
${bold('opencues models')} — effective LLM routing + provider catalog

Shows, per bucket (cues / auditors / blanks), the provider · model a
real dispatch would use — same resolution the runtime, doctor, and the
in-editor \`whats my model _\` blank share — then each provider's
curated model catalog with key state.

Usage:
  opencues models            formatted report
  opencues models --json     machine-readable (routing + catalog)
`);
  return 0;
}
