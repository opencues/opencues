// Pins set-key's registry-driven provider map — the June 2026 unification
// replaced a hardcoded duplicate of core's PROVIDERS table (which had
// already drifted: `ollama` was missing). Run: node --test src/commands/set-key.providermap.test.cjs

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const { providerMap } = require('./set-key.cjs');

describe('set-key providerMap', () => {
  it('derives from the core registry: every env-keyed provider present, CLI-transport excluded', () => {
    const map = providerMap({ REPO_ROOT });
    const { listProviders } = require(path.join(REPO_ROOT, 'packages/opencues-core/dist/llm-provider.js'));
    for (const p of listProviders()) {
      if (p.envKeyName && p.transport !== 'cli') {
        assert.strictEqual(map[p.id], p.envKeyName, `registry provider ${p.id} missing/wrong in set-key map`);
      } else {
        assert.ok(!(p.id in map), `${p.id} has no env key — must not be offered by set-key`);
      }
    }
    // The drift the unification fixed: ollama was absent from the old map.
    assert.strictEqual(map.ollama, 'OLLAMA_API_KEY');
  });

  it('leads with PROVIDER_AUTO_ORDER (cerebras first) and ends with finnhub', () => {
    const ids = Object.keys(providerMap({ REPO_ROOT }));
    assert.strictEqual(ids[0], 'cerebras');
    assert.strictEqual(ids[ids.length - 1], 'finnhub');
    assert.strictEqual(providerMap({ REPO_ROOT }).finnhub, 'FINNHUB_API_KEY');
  });

  it('falls back to the hardcoded snapshot (+ finnhub) when core is not built', () => {
    const map = providerMap({ REPO_ROOT: '/nonexistent-repo-root' });
    assert.strictEqual(map.cerebras, 'CEREBRAS_API_KEY');
    assert.strictEqual(map.finnhub, 'FINNHUB_API_KEY');
  });
});
