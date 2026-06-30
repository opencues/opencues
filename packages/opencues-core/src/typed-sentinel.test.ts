/**
 * Unit tests for the typed-sentinel language engine.
 *
 * Runs under node:test (same as the rest of opencues-core). Three layers:
 *   - renderTypedCatalog{,Line}  — catalog model → prompt block
 *   - parseTypedSentinels        — LLM string → token tree (incl. nested)
 *   - resolveTypedSentinels      — token tree → final string, with the
 *                                  validate-and-degrade contract
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  renderTypedCatalogLine,
  renderTypedCatalog,
  parseTypedToken,
  parseTypedSentinels,
  resolveTypedSentinels,
  type TypedCatalogEntry,
  type ResolveTypedOptions,
  collectParamSafeFetches as resolveImport,
} from './typed-sentinel';

// ────────────────────────────────────────────────────────────────────
// Renderer
// ────────────────────────────────────────────────────────────────────

describe('renderTypedCatalogLine', () => {
  it('renders a scalar as [NAME: returns]', () => {
    const e: TypedCatalogEntry = { displayName: 'WORK CITY', kind: 'scalar', returns: 'string', description: 'city the user works in' };
    assert.strictEqual(renderTypedCatalogLine(e), '- [WORK CITY: string] — city the user works in');
  });

  it('renders a parameterized fn with its signature', () => {
    const e: TypedCatalogEntry = {
      displayName: 'STOCK PRICE', kind: 'fn', returns: 'number',
      params: [{ name: 'ticker', type: 'string' }], description: 'current price',
    };
    assert.strictEqual(renderTypedCatalogLine(e), '- [STOCK PRICE(ticker: string): number] — current price');
  });

  it('appends a covers hint when present', () => {
    const e: TypedCatalogEntry = { displayName: 'EMAIL', kind: 'scalar', returns: 'string', description: 'work email', covers: 'my email, reach me at' };
    assert.match(renderTypedCatalogLine(e), /\(covers: my email, reach me at\)$/);
  });

  it('renders multi-param fn signature', () => {
    const e: TypedCatalogEntry = {
      displayName: 'CONVERT', kind: 'fn', returns: 'number',
      params: [{ name: 'amount', type: 'number' }, { name: 'from', type: 'string' }, { name: 'to', type: 'string' }],
      description: 'convert money',
    };
    assert.match(renderTypedCatalogLine(e), /\[CONVERT\(amount: number, from: string, to: string\): number\]/);
  });
});

describe('renderTypedCatalog', () => {
  it('returns empty string for an empty catalog', () => {
    assert.strictEqual(renderTypedCatalog('H', [], 'R'), '');
  });

  it('includes header, the nesting usage instruction, every line, and the rules', () => {
    const entries: TypedCatalogEntry[] = [
      { displayName: 'WORK CITY', kind: 'scalar', returns: 'string', description: 'work city' },
      { displayName: 'WEATHER TEMP', kind: 'fn', returns: 'number', params: [{ name: 'city', type: 'string' }], description: 'temp' },
    ];
    const block = renderTypedCatalog('THE HEADER', entries, 'THE RULES');
    assert.match(block, /THE HEADER/);
    assert.match(block, /INNERMOST token first/); // composition instruction
    assert.match(block, /\[WORK CITY: string\]/);
    assert.match(block, /\[WEATHER TEMP\(city: string\): number\]/);
    assert.match(block, /THE RULES/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────

describe('parseTypedToken', () => {
  it('parses a bare scalar', () => {
    const t = parseTypedToken('WORK CITY');
    assert.strictEqual(t.name, 'WORK CITY');
    assert.deepStrictEqual(t.args, {});
    assert.strictEqual(t.accessor, undefined);
  });

  it('strips a return annotation echoed on a scalar (EMAIL: string)', () => {
    const t = parseTypedToken('EMAIL: string');
    assert.strictEqual(t.name, 'EMAIL');
    assert.deepStrictEqual(t.args, {});
  });

  it('parses a single-arg fn with a literal', () => {
    const t = parseTypedToken('STOCK PRICE(ticker=NVDA)');
    assert.strictEqual(t.name, 'STOCK PRICE');
    assert.deepStrictEqual(t.args, { ticker: 'NVDA' });
  });

  it('strips quotes around literal args', () => {
    const t = parseTypedToken('STOCK PRICE(ticker="NVDA")');
    assert.deepStrictEqual(t.args, { ticker: 'NVDA' });
  });

  it('parses a nested token as an arg', () => {
    const t = parseTypedToken('WEATHER TEMP(city=[WORK CITY])');
    assert.strictEqual(t.name, 'WEATHER TEMP');
    const city = t.args.city;
    assert.ok(typeof city === 'object' && city !== null);
    assert.strictEqual((city as { name: string }).name, 'WORK CITY');
  });

  it('parses multi-arg mixing literal, scalar-nested', () => {
    const t = parseTypedToken('CONVERT(amount=[STOCK PRICE(ticker=NVDA)], from=USD, to=[HOME CURRENCY])');
    assert.strictEqual(t.name, 'CONVERT');
    assert.strictEqual(t.args.from, 'USD');
    assert.ok(typeof t.args.amount === 'object'); // nested fn
    assert.ok(typeof t.args.to === 'object');     // nested scalar
  });

  it('parses a return-selector accessor [NAME(args): field]', () => {
    const t = parseTypedToken('STOCK(ticker=NVDA): price');
    assert.strictEqual(t.name, 'STOCK');
    assert.strictEqual(t.args.ticker, 'NVDA');
    assert.strictEqual(t.accessor, 'price');
  });

  it('parses a dotted accessor on a scalar [NAME.field]', () => {
    const t = parseTypedToken('STOCK.price');
    assert.strictEqual(t.name, 'STOCK');
    assert.strictEqual(t.accessor, 'price');
  });

  it('does NOT split a multi-word scalar name on its space', () => {
    const t = parseTypedToken('WORK CITY');
    assert.strictEqual(t.name, 'WORK CITY');
    assert.strictEqual(t.accessor, undefined);
  });
});

describe('parseTypedSentinels', () => {
  it('finds multiple top-level spans and ignores prose', () => {
    const spans = parseTypedSentinels('Hi [FIRST NAME], it is [WEATHER TEMP(city=[WORK CITY])] today.');
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[0]!.token.name, 'FIRST NAME');
    assert.strictEqual(spans[1]!.token.name, 'WEATHER TEMP');
  });

  it('treats a nested bracket as part of its parent span, not a separate one', () => {
    const spans = parseTypedSentinels('[WEATHER TEMP(city=[WORK CITY])]');
    assert.strictEqual(spans.length, 1);
  });

  it('records correct start/end offsets', () => {
    const text = 'x [A] y';
    const spans = parseTypedSentinels(text);
    assert.strictEqual(text.slice(spans[0]!.start, spans[0]!.end + 1), '[A]');
  });

  it('is total on unbalanced brackets (does not throw)', () => {
    assert.doesNotThrow(() => parseTypedSentinels('[A(b=[C]'));
  });
});

// ────────────────────────────────────────────────────────────────────
// Resolver
// ────────────────────────────────────────────────────────────────────

const CATALOG = new Map<string, string>([
  ['WORK CITY', 'London'],
  ['WATCH TICKER', 'NVDA'],
  ['HOME CURRENCY', 'GBP'],
  ['FIRST NAME', 'Wilfred'],
]);

/** Toy fn resolver: STOCK PRICE / WEATHER TEMP keyed off the single arg. */
const FN = (name: string, args: Record<string, string>): string | undefined => {
  if (name === 'STOCK PRICE') return args.ticker === 'NVDA' ? '$880' : undefined;
  if (name === 'WEATHER TEMP') return args.city === 'London' ? '14°C' : undefined;
  if (name === 'CONVERT') return args.amount && args.to ? `${args.amount}→${args.to}` : undefined;
  if (name === 'STOCK') return args.ticker === 'NVDA' ? JSON.stringify({ price: '$880', change: '+2%' }) : undefined;
  return undefined;
};

const baseOpts = (over: Partial<ResolveTypedOptions> = {}): ResolveTypedOptions => ({
  scalarLookup: (n) => CATALOG.get(n),
  callFn: FN,
  ...over,
});

describe('resolveTypedSentinels — scalars', () => {
  it('resolves a scalar token', () => {
    const r = resolveTypedSentinels('Hi [FIRST NAME]!', baseOpts());
    assert.strictEqual(r.output, 'Hi Wilfred!');
    assert.strictEqual(r.report.resolved.length, 1);
  });

  it('resolves multiple tokens in one string preserving prose + offsets', () => {
    const r = resolveTypedSentinels('[FIRST NAME] in [WORK CITY]', baseOpts());
    assert.strictEqual(r.output, 'Wilfred in London');
  });

  it('strips an unknown scalar by default', () => {
    const r = resolveTypedSentinels('a [NOPE] b', baseOpts());
    assert.strictEqual(r.output, 'a  b');
    assert.strictEqual(r.report.degraded.length, 1);
  });

  it('preserves an unknown scalar when preserveUnknown', () => {
    const r = resolveTypedSentinels('a [NOPE] b', baseOpts({ preserveUnknown: true }));
    assert.strictEqual(r.output, 'a [NOPE] b');
  });
});

describe('resolveTypedSentinels — parameterized fns', () => {
  it('resolves a single-arg fn via callFn', () => {
    const r = resolveTypedSentinels('[STOCK PRICE(ticker=NVDA)]', baseOpts());
    assert.strictEqual(r.output, '$880');
  });

  it('degrades when the fn returns undefined', () => {
    const r = resolveTypedSentinels('[STOCK PRICE(ticker=ZZZZ)]', baseOpts({ preserveUnknown: true }));
    assert.strictEqual(r.output, '[STOCK PRICE(ticker=ZZZZ)]');
    assert.strictEqual(r.report.degraded.length, 1);
  });

  it('degrades every fn call when no callFn is supplied', () => {
    const r = resolveTypedSentinels('[STOCK PRICE(ticker=NVDA)]', { scalarLookup: (n) => CATALOG.get(n), preserveUnknown: true });
    assert.strictEqual(r.output, '[STOCK PRICE(ticker=NVDA)]');
  });
});

describe('resolveTypedSentinels — nested composition', () => {
  it('resolves a depth-1 nested call innermost-first', () => {
    const r = resolveTypedSentinels('[WEATHER TEMP(city=[WORK CITY])]', baseOpts());
    assert.strictEqual(r.output, '14°C'); // WORK CITY→London→WEATHER TEMP
  });

  it('resolves a depth-2 chain', () => {
    // CONVERT(amount=[STOCK PRICE(ticker=[WATCH TICKER])], to=[HOME CURRENCY])
    const r = resolveTypedSentinels(
      '[CONVERT(amount=[STOCK PRICE(ticker=[WATCH TICKER])], from=USD, to=[HOME CURRENCY])]',
      baseOpts(),
    );
    // STOCK PRICE(ticker=NVDA)→$880 ; HOME CURRENCY→GBP ; CONVERT→ "$880→GBP"
    assert.strictEqual(r.output, '$880→GBP');
  });

  it('degrades the WHOLE call when a nested arg is unresolvable', () => {
    const r = resolveTypedSentinels('[WEATHER TEMP(city=[UNKNOWN SCALAR])]', baseOpts({ preserveUnknown: true }));
    assert.strictEqual(r.output, '[WEATHER TEMP(city=[UNKNOWN SCALAR])]');
    assert.strictEqual(r.report.degraded.length, 1);
  });
});

describe('resolveTypedSentinels — field accessors (validate-and-degrade)', () => {
  const withAccessor = (over: Partial<ResolveTypedOptions> = {}) => baseOpts({
    applyAccessor: (value, field) => {
      try { const obj = JSON.parse(value); return obj[field]; } catch { return undefined; }
    },
    ...over,
  });

  it('applies a valid struct field accessor', () => {
    const r = resolveTypedSentinels('[STOCK(ticker=NVDA): price]', withAccessor());
    assert.strictEqual(r.output, '$880');
  });

  it('degrades a BAD accessor to the base value (resolve-rest, decision #1)', () => {
    const r = resolveTypedSentinels('[STOCK(ticker=NVDA): ymca]', withAccessor());
    assert.strictEqual(r.output, JSON.stringify({ price: '$880', change: '+2%' })); // base value, accessor dropped
    assert.strictEqual(r.report.badAccessors.length, 1);
  });

  it('drops the accessor (uses base value) when no applyAccessor is supplied', () => {
    const r = resolveTypedSentinels('[WORK CITY.somefield]', baseOpts());
    assert.strictEqual(r.output, 'London');
    assert.strictEqual(r.report.badAccessors.length, 1);
  });
});

describe('resolveTypedSentinels — safety + edge cases', () => {
  it('preserves a user-typed bracket present in originalBody', () => {
    const r = resolveTypedSentinels('keep [FIRST NAME] here', baseOpts({ originalBody: 'keep [FIRST NAME] here' }));
    assert.strictEqual(r.output, 'keep [FIRST NAME] here');
    assert.strictEqual(r.report.preserved.length, 1);
  });

  it('returns input unchanged when there are no brackets', () => {
    const r = resolveTypedSentinels('plain prose', baseOpts());
    assert.strictEqual(r.output, 'plain prose');
  });

  it('never throws on malformed / unbalanced input', () => {
    assert.doesNotThrow(() => resolveTypedSentinels('[A(b=[C] [D]', baseOpts()));
    assert.doesNotThrow(() => resolveTypedSentinels(']][[((==', baseOpts()));
  });

  it('leaves a genuinely unparseable trailing bracket alone', () => {
    // '[FIRST NAME]' resolves, the dangling '[' is not a complete span
    const r = resolveTypedSentinels('[FIRST NAME] and [', baseOpts());
    assert.strictEqual(r.output, 'Wilfred and [');
  });
});

describe('resolveTypedSentinels — buffer safety: non-token brackets untouched', () => {
  // The wider `[...]` grammar must NOT strip markdown / code / lowercase
  // brackets that aren't catalog tokens — same protection bare's
  // uppercase-only regex gives. Buffer-destruction guard.
  it('preserves a markdown link [label](url)', () => {
    const r = resolveTypedSentinels('see [docs](https://x.com) please', baseOpts({ preserveUnknown: false }));
    assert.strictEqual(r.output, 'see [docs](https://x.com) please');
  });

  it('preserves a numeric citation [1] and code index arr[0]', () => {
    const r = resolveTypedSentinels('item [1] in arr[0]', baseOpts({ preserveUnknown: false }));
    assert.strictEqual(r.output, 'item [1] in arr[0]');
  });

  it('preserves a markdown checkbox [ ] and a lowercase placeholder [your name]', () => {
    const r = resolveTypedSentinels('* [ ] todo for [your name]', baseOpts({ preserveUnknown: false }));
    assert.strictEqual(r.output, '* [ ] todo for [your name]');
  });

  it('still resolves a real uppercase token amid markdown', () => {
    const r = resolveTypedSentinels('Hi [FIRST NAME], see [docs](url)', baseOpts({ preserveUnknown: false }));
    assert.strictEqual(r.output, 'Hi Wilfred, see [docs](url)');
  });

  it('still resolves a parameterized call even with a lowercase-ish name (has args)', () => {
    const r = resolveTypedSentinels('[STOCK PRICE(ticker=NVDA)]', baseOpts());
    assert.strictEqual(r.output, '$880');
  });
});

describe('collectParamSafeFetches (Phase 4 on-demand pre-pass)', () => {
  const reg = new Map([
    ['STOCK', { blankName: 'stocks', tokenPrefix: 'STOCK' }],
    ['WEATHER', { blankName: 'weather', tokenPrefix: 'WEATHER' }],
  ]);
  const look = (n: string) => (n === 'WATCH TICKER' ? 'NVDA' : undefined);

  it('collects a literal-arg param-safe fn-call', () => {
    const f = resolveImport('[STOCK(ticker=TSLA)] today', reg, look);
    assert.deepStrictEqual(f, [{ blankName: 'stocks', arg: 'TSLA', instanceToken: '[STOCK TSLA]' }]);
  });

  it('SECURITY: a nested-token arg is NOT resolved (literal args only — no PII egress)', () => {
    // `[STOCK(ticker=[WATCH TICKER])]` must NOT route the identity/instance
    // scalar into the fetch. A nested arg is dropped, not resolved.
    assert.deepStrictEqual(resolveImport('[STOCK(ticker=[WATCH TICKER])]', reg, look), []);
  });

  it('CAPABILITY GATE: ignores a fn-call not in the param-safe registry', () => {
    assert.deepStrictEqual(resolveImport('[VOLUME(level=80)]', reg, look), []);
  });

  it('ignores plain scalars (not fn-calls)', () => {
    assert.deepStrictEqual(resolveImport('[FIRST NAME] [STOCK AAPL]', reg, look), []);
  });

  it('dedupes repeated (blank,arg)', () => {
    const f = resolveImport('[STOCK(ticker=NVDA)] and [STOCK(ticker=nvda)]', reg, look);
    assert.strictEqual(f.length, 1);
  });

  it('empty registry → no fetches', () => {
    assert.deepStrictEqual(resolveImport('[STOCK(ticker=NVDA)]', new Map(), look), []);
  });
});
