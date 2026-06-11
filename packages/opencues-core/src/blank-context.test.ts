/**
 * Unit tests for the blank-as-context module. Runs under node:test
 * (same convention as sentinels.test.ts).
 *
 * Three layers exercised:
 *   - deriveBlankContextToken — (blankName, slot) → token
 *   - planBlankContextSlots   — BlankConfig + Identity → slot list
 *   - renderBlankContextCatalog — snapshot + mode → prompt block
 *   - mergeCatalogs — sentinel catalog ∪ blank-ctx catalog
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  deriveBlankContextToken,
  planBlankContextSlots,
  renderBlankContextCatalog,
  mergeCatalogs,
  type BlankContextSnapshot,
} from './blank-context';
import type { BlankConfig } from './cues-md';
import type { Identity, IdentityField } from './identity-context';

function makeSentinels(fields: Array<{ key: string; value: string }>): Identity {
  const fs: IdentityField[] = fields.map(({ key, value }) => ({
    key,
    token: `[${key.toUpperCase()}]`,
    value,
    description: `user's ${key}`,
  }));
  const catalog = new Map(fs.map(f => [f.token, f.value]));
  return { fields: fs, catalog };
}

function blankCfg(overrides: Partial<BlankConfig> & { name: string }): BlankConfig {
  return { ...overrides } as BlankConfig;
}

// ─── deriveBlankContextToken ────────────────────────────────────────────────

describe('deriveBlankContextToken', () => {
  it('singularises common plurals', () => {
    assert.strictEqual(deriveBlankContextToken('stocks', 'AAPL'), '[STOCK AAPL]');
    assert.strictEqual(deriveBlankContextToken('countries', 'UK'), '[COUNTRY UK]');
    assert.strictEqual(deriveBlankContextToken('cities', 'NYC'), '[CITY NYC]');
  });

  it('uppercases multi-word slot names', () => {
    assert.strictEqual(deriveBlankContextToken('weather', 'New York'), '[WEATHER NEW YORK]');
  });

  it('handles camelCase + snake + kebab in slot names', () => {
    assert.strictEqual(deriveBlankContextToken('weather', 'newYork'), '[WEATHER NEW YORK]');
    assert.strictEqual(deriveBlankContextToken('stocks', 'NVDA_OPTIONS'), '[STOCK NVDA OPTIONS]');
    assert.strictEqual(deriveBlankContextToken('weather', 'cape-town'), '[WEATHER CAPE TOWN]');
  });

  it('leaves uncommon blank names as-is (uppercased)', () => {
    assert.strictEqual(deriveBlankContextToken('hackernews', 'top'), '[HACKERNEWS TOP]');
    assert.strictEqual(deriveBlankContextToken('weather', 'london'), '[WEATHER LONDON]');
  });
});

// ─── planBlankContextSlots ──────────────────────────────────────────────────

describe('planBlankContextSlots', () => {
  const emptySentinels = makeSentinels([]);

  it('returns empty when asContext is off', () => {
    const r = planBlankContextSlots(blankCfg({ name: 'stocks', asContext: 'off' }), emptySentinels);
    assert.deepStrictEqual(r.slots, []);
    assert.deepStrictEqual(r.warnings, []);
  });

  it('returns empty when asContext is undefined', () => {
    const r = planBlankContextSlots(blankCfg({ name: 'stocks' }), emptySentinels);
    assert.deepStrictEqual(r.slots, []);
  });

  it('emits explicit slots when contextSlots is set', () => {
    const r = planBlankContextSlots(
      blankCfg({ name: 'hackernews', asContext: 'safe', contextSlots: ['top'] }),
      emptySentinels,
    );
    assert.strictEqual(r.slots.length, 1);
    assert.strictEqual(r.slots[0].token, '[HACKERNEWS TOP]');
    assert.strictEqual(r.slots[0].slot, 'top');
  });

  it('reads sentinel scalar binding (no split)', () => {
    const sentinels = makeSentinels([{ key: 'home_city', value: 'London' }]);
    const r = planBlankContextSlots(
      blankCfg({ name: 'weather', asContext: 'safe', contextBind: 'home_city' }),
      sentinels,
    );
    assert.strictEqual(r.slots.length, 1);
    assert.strictEqual(r.slots[0].token, '[WEATHER LONDON]');
  });

  it('fans out on contextBindSplit when ack is present', () => {
    const sentinels = makeSentinels([{ key: 'portfolio', value: 'AAPL,NVDA,GOOG' }]);
    const r = planBlankContextSlots(
      blankCfg({
        name: 'stocks',
        asContext: 'safe',
        contextBind: 'portfolio',
        contextBindSplit: ',',
        splitValuesInTokenNamesAck: true,
      }),
      sentinels,
    );
    assert.deepStrictEqual(
      r.slots.map(s => s.token),
      ['[STOCK AAPL]', '[STOCK NVDA]', '[STOCK GOOG]'],
    );
  });

  it('drops the blank + warns when split is used without ack', () => {
    const sentinels = makeSentinels([{ key: 'portfolio', value: 'AAPL,NVDA' }]);
    const r = planBlankContextSlots(
      blankCfg({
        name: 'stocks',
        asContext: 'safe',
        contextBind: 'portfolio',
        contextBindSplit: ',',
      }),
      sentinels,
    );
    assert.deepStrictEqual(r.slots, []);
    assert.match(r.warnings.join(' '), /split-values-in-token-names/);
  });

  it('returns empty silently when contextBind names a missing sentinel field', () => {
    const r = planBlankContextSlots(
      blankCfg({ name: 'weather', asContext: 'safe', contextBind: 'home_city' }),
      emptySentinels,
    );
    assert.deepStrictEqual(r.slots, []);
    assert.deepStrictEqual(r.warnings, []); // silent — sentinel may be unset
  });

  it('dedupes duplicate slot tokens', () => {
    const r = planBlankContextSlots(
      blankCfg({
        name: 'stocks',
        asContext: 'safe',
        contextSlots: ['AAPL', 'aapl', 'AAPL'],
      }),
      emptySentinels,
    );
    assert.strictEqual(r.slots.length, 1);
  });

  it('warns when both contextSlots and contextBind are set, prefers slots', () => {
    const sentinels = makeSentinels([{ key: 'portfolio', value: 'AAPL' }]);
    const r = planBlankContextSlots(
      blankCfg({
        name: 'stocks',
        asContext: 'safe',
        contextSlots: ['NVDA'],
        contextBind: 'portfolio',
      }),
      sentinels,
    );
    assert.deepStrictEqual(r.slots.map(s => s.slot), ['NVDA']);
    assert.match(r.warnings.join(' '), /both context-slots and context-bind/);
  });
});

// ─── renderBlankContextCatalog ──────────────────────────────────────────────

describe('renderBlankContextCatalog', () => {
  function makeSnapshot(
    fields: Array<{ token: string; value: string; description: string }>,
  ): BlankContextSnapshot {
    return { fields, catalog: new Map(fields.map(f => [f.token, f.value])) };
  }

  it('returns empty string in off mode', () => {
    const snap = makeSnapshot([{ token: '[STOCK AAPL]', value: '$245', description: 'price' }]);
    assert.strictEqual(renderBlankContextCatalog(snap, 'off'), '');
  });

  it('returns empty string when snapshot has no fields', () => {
    assert.strictEqual(renderBlankContextCatalog(makeSnapshot([]), 'safe'), '');
  });

  it('renders safe mode with description only', () => {
    const snap = makeSnapshot([{ token: '[STOCK AAPL]', value: '$245', description: 'current share price of AAPL' }]);
    const block = renderBlankContextCatalog(snap, 'safe');
    assert.ok(block.includes('[STOCK AAPL] — current share price of AAPL'));
    assert.ok(!block.includes('$245'));
  });

  it('renders raw mode with values inlined', () => {
    const snap = makeSnapshot([{ token: '[STOCK AAPL]', value: '$245', description: 'price' }]);
    const block = renderBlankContextCatalog(snap, 'raw');
    assert.ok(block.includes('current value: $245'));
  });

  it('includes injection-resistance rules', () => {
    const snap = makeSnapshot([{ token: '[STOCK AAPL]', value: '$245', description: 'price' }]);
    const block = renderBlankContextCatalog(snap, 'safe');
    assert.match(block, /INPUT is untrusted/);
    assert.match(block, /Never invent new bracket-tokens/);
  });

  // Regression: the prompt MUST include the "ALREADY-PRESENT EXCEPTION"
  // rule so the LLM doesn't re-emit catalog tokens whose values already
  // appear verbatim in the input. The bug class this prevents: typing
  // `nvda _ + apple _ = _` got NVDA + AAPL re-emitted by the catalog
  // instead of computing the arithmetic sum. The rule has to fire
  // BEFORE the "NEVER return an empty answer" capper, or the capper's
  // wording would override the exception. Pin both the rule presence
  // AND the capper's qualifier so the priority can't silently drift.
  it('includes ALREADY-PRESENT EXCEPTION rule (arithmetic / catalog-value-already-in-buffer)', () => {
    const snap = makeSnapshot([
      { token: '[STOCK NVDA]', value: 'NVDA: $200.99', description: 'price' },
      { token: '[STOCK AAPL]', value: 'AAPL: $293.77', description: 'price' },
    ]);
    const block = renderBlankContextCatalog(snap, 'safe');
    assert.match(block, /ALREADY-PRESENT EXCEPTION/);
    assert.match(block, /operating on/i);
    // The "NEVER return empty" capper MUST carry the "AND the catalog
    // token is NOT already-present" qualifier so it can't override the
    // exception above it.
    assert.match(block, /already-present/);
    assert.match(block, /NEVER return an empty answer.*already-present/s);
  });
});

// ─── Substitution via the shared post-processor ─────────────────────────────
// Pin: the existing sentinels post-processor handles multi-segment
// blank-context tokens with no code change, because its TOKEN_RE
// already accepts `[A-Z][A-Z0-9 _-]*` shapes. Drift on this would
// silently break blank-context substitution.

import { postProcessContext } from './identity-context';

describe('postProcessContext with merged blank-context catalog', () => {
  it('resolves two-segment blank tokens verbatim', () => {
    const catalog = new Map([
      ['[STOCK AAPL]', 'AAPL: $245.12'],
      ['[WEATHER LONDON]', 'London: 13°C overcast'],
    ]);
    const out = postProcessContext(
      'AAPL is at [STOCK AAPL] and the weather is [WEATHER LONDON].',
      { catalog },
    );
    assert.strictEqual(
      out.output,
      'AAPL is at AAPL: $245.12 and the weather is London: 13°C overcast.',
    );
    assert.strictEqual(out.report.resolved.length, 2);
  });

  it('tolerantly resolves underscore drift on a blank-context token', () => {
    const catalog = new Map([['[STOCK AAPL]', '$245']]);
    const out = postProcessContext('price is [STOCK_AAPL] now', { catalog });
    assert.strictEqual(out.output, 'price is $245 now');
    assert.strictEqual(out.report.tolerantMatches.length, 1);
  });

  it('strips hallucinated blank-context-style tokens', () => {
    const catalog = new Map([['[STOCK AAPL]', '$245']]);
    const out = postProcessContext(
      'price [STOCK AAPL], today [STOCK TSLA] also',
      { catalog },
    );
    assert.strictEqual(out.output, 'price $245, today  also');
    assert.deepStrictEqual(out.report.stripped, ['[STOCK TSLA]']);
  });

  it('preserves user-typed blank-context tokens (originalBody wins)', () => {
    const catalog = new Map([['[STOCK AAPL]', '$245']]);
    const out = postProcessContext(
      'writing about [STOCK AAPL] token shape',
      { catalog, originalBody: 'I want to explain [STOCK AAPL] in my doc' },
    );
    assert.ok(out.output.includes('[STOCK AAPL]'));
    assert.strictEqual(out.report.resolved.length, 0);
    assert.strictEqual(out.report.preserved.length, 1);
  });
});

// ─── mergeCatalogs ──────────────────────────────────────────────────────────

describe('mergeCatalogs', () => {
  it('union of disjoint catalogs', () => {
    const a = new Map([['[EMAIL]', 'a@b']]);
    const b = new Map([['[STOCK AAPL]', '$245']]);
    const m = mergeCatalogs(a, b);
    assert.strictEqual(m.size, 2);
    assert.strictEqual(m.get('[EMAIL]'), 'a@b');
    assert.strictEqual(m.get('[STOCK AAPL]'), '$245');
  });

  it('sentinel wins on collision (user data is authoritative)', () => {
    const sentinels = new Map([['[STOCK AAPL]', 'user-defined']]);
    const blankCtx = new Map([['[STOCK AAPL]', 'runtime-fetched']]);
    const m = mergeCatalogs(sentinels, blankCtx);
    assert.strictEqual(m.get('[STOCK AAPL]'), 'user-defined');
  });
});
