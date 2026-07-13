/**
 * Effective-routing tests — the shared bucket→global→auto walk behind
 * doctor, the `model` blank, and `opencues models`, plus the dispatch
 * collapse (`collapseBucketTier`) used by build-sources/boot-common.
 *
 * Two layers:
 *   1. Ladder matrix — every precedence rung and sentinel gets a pin.
 *   2. Dispatch equivalence — for key-present fixtures, the display
 *      walk's (provider, model) MUST equal what `resolveLLM` (the real
 *      dispatch function) resolves from the same collapsed tier. This
 *      is the "what's my model? can never lie" contract.
 *
 * Run with: node --test dist/effective-routing.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import {
  collapseBucketTier,
  normalizeBucketProviderScalar,
  normalizeModelScalar,
  resolveEffectiveRouting,
  LLM_BUCKETS,
} from './effective-routing';
import { resolveLLM, setCoreWarn, _resetWarnDedupForTesting } from './llm-provider';

const noCli = () => false;

function routing(
  scalarMap: Record<string, string>,
  apiKeys: Record<string, string | undefined>,
  isCliAvailable: (id: string) => boolean = noCli,
) {
  return resolveEffectiveRouting({ scalars: (n) => scalarMap[n], apiKeys, isCliAvailable });
}

beforeEach(() => {
  // Unknown-provider fixtures fire the one-time core warning — keep the
  // test output clean and the dedup state fresh per test.
  setCoreWarn(() => {});
  _resetWarnDedupForTesting();
});
afterEach(() => setCoreWarn(null));

describe('normalizeModelScalar', () => {
  it('treats empty / default / inherit (any case) as unset', () => {
    for (const raw of ['', '  ', 'default', 'DEFAULT', 'inherit', ' Inherit ']) {
      assert.strictEqual(normalizeModelScalar(raw), undefined, `raw=${JSON.stringify(raw)}`);
    }
  });
  it('passes real model names through trimmed', () => {
    assert.strictEqual(normalizeModelScalar(' gemma-4-31b '), 'gemma-4-31b');
  });
});

describe('normalizeBucketProviderScalar', () => {
  it('accepts exact known provider ids, case-insensitively', () => {
    assert.strictEqual(normalizeBucketProviderScalar('Cerebras'), 'cerebras');
  });
  it('collapses inherit / empty / unknown ids (mirrors config-loader bucketProvider)', () => {
    for (const raw of ['inherit', '', 'nopeai', 'claude-cli' /* alias, not an id */]) {
      assert.strictEqual(normalizeBucketProviderScalar(raw), undefined, `raw=${JSON.stringify(raw)}`);
    }
  });
});

describe('collapseBucketTier — pairing rules', () => {
  it('pinned bucket: bucket model rides, global model NEVER leaks in', () => {
    const t = collapseBucketTier({
      bucketProvider: 'anthropic',
      globalProvider: 'groq',
      globalModel: 'openai/gpt-oss-120b',
    });
    assert.deepStrictEqual(t, { globalProvider: 'anthropic', globalModel: undefined, bucketPinned: true });
  });
  it('pinned bucket with bucket model: both ride', () => {
    const t = collapseBucketTier({ bucketProvider: 'cerebras', bucketModel: 'gemma-4-31b' });
    assert.deepStrictEqual(t, { globalProvider: 'cerebras', globalModel: 'gemma-4-31b', bucketPinned: true });
  });
  it('inherited bucket: bucket model still WINS over global model (menu-pick fix)', () => {
    const t = collapseBucketTier({
      bucketProvider: 'inherit',
      bucketModel: 'zai-glm-4.7',
      globalProvider: 'cerebras',
      globalModel: 'gpt-oss-120b',
    });
    assert.deepStrictEqual(t, { globalProvider: 'cerebras', globalModel: 'zai-glm-4.7', bucketPinned: false });
  });
  it('inherited bucket, no bucket model: global pair passes through', () => {
    const t = collapseBucketTier({ globalProvider: 'groq', globalModel: 'openai/gpt-oss-20b' });
    assert.deepStrictEqual(t, { globalProvider: 'groq', globalModel: 'openai/gpt-oss-20b', bucketPinned: false });
  });
  it('model sentinels are unset at every position', () => {
    const t = collapseBucketTier({
      bucketProvider: 'cerebras',
      bucketModel: 'default',
      globalModel: 'inherit',
    });
    assert.strictEqual(t.globalModel, undefined);
  });
});

describe('resolveEffectiveRouting — ladder matrix', () => {
  it('nothing set, no keys, no CLI binary → none on every bucket', () => {
    const r = routing({}, {});
    for (const bucket of LLM_BUCKETS) {
      assert.strictEqual(r[bucket].providerSource, 'none');
      assert.strictEqual(r[bucket].providerId, null);
      assert.strictEqual(r[bucket].model, null);
      assert.strictEqual(r[bucket].keyPresent, false);
    }
  });

  it('nothing set + CEREBRAS key → auto-key cerebras · provider default', () => {
    const r = routing({}, { CEREBRAS_API_KEY: 'k' });
    for (const bucket of LLM_BUCKETS) {
      assert.strictEqual(r[bucket].providerId, 'cerebras');
      assert.strictEqual(r[bucket].model, 'gpt-oss-120b');
      assert.strictEqual(r[bucket].providerSource, 'auto-key');
      assert.strictEqual(r[bucket].modelSource, 'provider-default');
      assert.strictEqual(r[bucket].keyPresent, true);
    }
  });

  it('global llm-provider → every bucket inherits with source=global', () => {
    const r = routing({ 'llm-provider': 'groq' }, { GROQ_API_KEY: 'k' });
    for (const bucket of LLM_BUCKETS) {
      assert.strictEqual(r[bucket].providerId, 'groq');
      assert.strictEqual(r[bucket].model, 'openai/gpt-oss-120b');
      assert.strictEqual(r[bucket].providerSource, 'global');
    }
  });

  it('global llm-model is canonicalized into the provider namespace', () => {
    const r = routing({ 'llm-provider': 'groq', 'llm-model': 'gpt-oss-20b' }, { GROQ_API_KEY: 'k' });
    assert.strictEqual(r.cues.model, 'openai/gpt-oss-20b');
    assert.strictEqual(r.cues.modelSource, 'global');
  });

  it('Case A: pinned bucket does NOT inherit the global llm-model', () => {
    const r = routing(
      { 'blanks-llm-provider': 'anthropic', 'llm-provider': 'groq', 'llm-model': 'openai/gpt-oss-120b' },
      { ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'k' },
    );
    assert.strictEqual(r.blanks.providerId, 'anthropic');
    assert.strictEqual(r.blanks.providerSource, 'bucket');
    assert.strictEqual(r.blanks.model, 'claude-haiku-4-5-20251001');
    assert.strictEqual(r.blanks.modelSource, 'provider-default');
    // Unpinned buckets keep the global pair.
    assert.strictEqual(r.cues.providerId, 'groq');
    assert.strictEqual(r.cues.model, 'openai/gpt-oss-120b');
  });

  it('Case B: bucket model on an inherited provider is honored (menu-pick fix)', () => {
    const r = routing(
      { 'cues-llm-model': 'gemma-4-31b', 'llm-provider': 'cerebras' },
      { CEREBRAS_API_KEY: 'k' },
    );
    assert.strictEqual(r.cues.providerId, 'cerebras');
    assert.strictEqual(r.cues.providerSource, 'global');
    assert.strictEqual(r.cues.model, 'gemma-4-31b');
    assert.strictEqual(r.cues.modelSource, 'bucket');
    // Other buckets unaffected by cues' model scalar.
    assert.strictEqual(r.blanks.model, 'gpt-oss-120b');
  });

  it('model sentinels (default / inherit) fall through to the provider default', () => {
    const r = routing(
      { 'auditors-llm-provider': 'cerebras', 'auditors-llm-model': 'default', 'blanks-llm-model': 'inherit' },
      { CEREBRAS_API_KEY: 'k' },
    );
    assert.strictEqual(r.auditors.model, 'gpt-oss-120b');
    assert.strictEqual(r.auditors.modelSource, 'provider-default');
    assert.strictEqual(r.blanks.model, 'gpt-oss-120b');
  });

  it('legacy singular blank-llm-* is read for the blanks bucket; plural wins', () => {
    const legacyOnly = routing({ 'blank-llm-provider': 'groq' }, { GROQ_API_KEY: 'k', CEREBRAS_API_KEY: 'k' });
    assert.strictEqual(legacyOnly.blanks.providerId, 'groq');
    assert.strictEqual(legacyOnly.blanks.providerSource, 'bucket');
    // cues/auditors don't read the legacy blank scalar.
    assert.strictEqual(legacyOnly.cues.providerId, 'cerebras');
    const bothSet = routing(
      { 'blank-llm-provider': 'groq', 'blanks-llm-provider': 'cerebras' },
      { GROQ_API_KEY: 'k', CEREBRAS_API_KEY: 'k' },
    );
    assert.strictEqual(bothSet.blanks.providerId, 'cerebras');
  });

  it('trainsOnInput provider flags prose buckets, not blanks', () => {
    const r = routing(
      { 'cues-llm-provider': 'opencode-zen', 'blanks-llm-provider': 'opencode-zen' },
      {},
    );
    assert.strictEqual(r.cues.trainsOnInputBlocked, true);
    assert.strictEqual(r.blanks.trainsOnInputBlocked, false);
    // optionalAuth: routable with zero keys.
    assert.strictEqual(r.blanks.keyPresent, true);
  });

  it('unknown bucket scalar collapses to inherit and is surfaced', () => {
    const r = routing({ 'cues-llm-provider': 'nopeai', 'llm-provider': 'cerebras' }, { CEREBRAS_API_KEY: 'k' });
    assert.strictEqual(r.cues.providerId, 'cerebras');
    assert.strictEqual(r.cues.providerSource, 'global');
    assert.strictEqual(r.cues.ignoredBucketProviderScalar, 'nopeai');
    assert.strictEqual(r.blanks.ignoredBucketProviderScalar, undefined);
  });

  it('unknown GLOBAL provider yields a dead route (mirrors resolveLLM null)', () => {
    const r = routing({ 'llm-provider': 'nopeai' }, { CEREBRAS_API_KEY: 'k' });
    assert.strictEqual(r.cues.provider, null);
    assert.strictEqual(r.cues.providerId, 'nopeai');
    assert.strictEqual(r.cues.providerSource, 'global');
    assert.strictEqual(r.cues.model, null);
  });

  it('configured provider with missing key: route shown, keyPresent false', () => {
    const r = routing({ 'llm-provider': 'gemini' }, {});
    assert.strictEqual(r.cues.providerId, 'gemini');
    assert.strictEqual(r.cues.keyPresent, false);
  });

  it('zero keys + subscription binary → auto-subscription rung', () => {
    const r = routing({}, {}, (id) => id === 'claude-code-cli');
    for (const bucket of LLM_BUCKETS) {
      assert.strictEqual(r[bucket].providerId, 'claude-code-cli');
      assert.strictEqual(r[bucket].providerSource, 'auto-subscription');
      assert.strictEqual(r[bucket].keyPresent, true);
      assert.strictEqual(r[bucket].model, 'haiku');
    }
  });
});

describe('resolveEffectiveRouting — dispatch equivalence', () => {
  // The core contract: for any fixture where dispatch would succeed,
  // the display walk resolves the SAME (provider, model) that
  // resolveLLM resolves from the same collapsed bucket tier. A failure
  // here means "what's my model?" would lie about a real dispatch.
  const KEYS = {
    GROQ_API_KEY: 'k', CEREBRAS_API_KEY: 'k', GEMINI_API_KEY: 'k',
    ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
  };
  const FIXTURES: Array<Record<string, string>> = [
    {},
    { 'llm-provider': 'groq' },
    { 'llm-provider': 'groq', 'llm-model': 'openai/gpt-oss-20b' },
    { 'llm-provider': 'cerebras', 'llm-model': 'openai/gpt-oss-120b' }, // cross-namespace heal
    { 'blanks-llm-provider': 'anthropic', 'llm-model': 'openai/gpt-oss-120b' },
    { 'cues-llm-provider': 'cerebras', 'cues-llm-model': 'gemma-4-31b' },
    { 'cues-llm-model': 'zai-glm-4.7', 'llm-provider': 'cerebras' }, // Case B
    { 'auditors-llm-provider': 'gemini', 'auditors-llm-model': 'default' },
    { 'cues-llm-provider': 'nopeai', 'llm-provider': 'groq' }, // bucket typo → inherit
  ];

  it('display (provider, model) === dispatch (provider, model) across the grid', () => {
    for (const scalars of FIXTURES) {
      const get = (n: string) => scalars[n];
      const r = resolveEffectiveRouting({ scalars: get, apiKeys: KEYS, isCliAvailable: noCli });
      for (const bucket of LLM_BUCKETS) {
        const tier = collapseBucketTier({
          bucketProvider: get(`${bucket}-llm-provider`) ?? (bucket === 'blanks' ? get('blank-llm-provider') : undefined),
          bucketModel: get(`${bucket}-llm-model`) ?? (bucket === 'blanks' ? get('blank-llm-model') : undefined),
          globalProvider: get('llm-provider'),
          globalModel: get('llm-model'),
        });
        const dispatched = resolveLLM({
          globalProvider: tier.globalProvider,
          globalModel: tier.globalModel,
          apiKeys: KEYS,
        });
        const label = `${bucket} @ ${JSON.stringify(scalars)}`;
        assert.ok(dispatched, `dispatch resolved: ${label}`);
        assert.strictEqual(r[bucket].providerId, dispatched!.provider.id, `provider: ${label}`);
        assert.strictEqual(r[bucket].model, dispatched!.model, `model: ${label}`);
      }
    }
  });
});
