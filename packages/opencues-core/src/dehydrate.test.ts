/**
 * Tests for the outbound dehydrator (value → [TOKEN] scrub).
 *
 * Pins the matching contract (longest-first, Unicode boundaries,
 * case-insensitivity, possessive/punctuation variants), the skip rules
 * (visible residual, never silent), determinism, the mapOffset snap
 * semantics used for [CURSOR] injection, the round-trip with
 * postProcessContext (hydration), and the per-catalog WeakMap cache.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { compileDehydrator, getDehydrator } from './dehydrate';
import { postProcessContext } from './identity-context';

const CATALOG = new Map<string, string>([
  ['[FULL NAME]', 'Wilfred Kasekende'],
  ['[FIRST NAME]', 'Wilfred'],
  ['[EMAIL]', 'wilfred@example.com'],
  ['[PHONE]', '+44 7700 900123'],
  ['[WORK CITY]', 'London'],
]);

describe('compileDehydrator — matching', () => {
  const d = compileDehydrator(CATALOG);

  it('substitutes a single value with its token', () => {
    const r = d.dehydrate('I am Wilfred and I code.');
    assert.strictEqual(r.text, 'I am [FIRST NAME] and I code.');
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual([...r.introduced], ['[FIRST NAME]']);
  });

  it('longest value wins at the same start position', () => {
    const r = d.dehydrate('Contact Wilfred Kasekende today');
    assert.strictEqual(r.text, 'Contact [FULL NAME] today');
    assert.deepStrictEqual([...r.introduced], ['[FULL NAME]']);
  });

  it('matches case-insensitively (typed lowercase is still PII)', () => {
    const r = d.dehydrate('ask wilfred about it');
    assert.strictEqual(r.text, 'ask [FIRST NAME] about it');
  });

  it('does NOT match inside a longer word (boundary)', () => {
    const r = d.dehydrate('the Wilfredian era');
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.text, 'the Wilfredian era');
  });

  it('matches values with non-word edges (email, phone)', () => {
    const r = d.dehydrate('mail wilfred@example.com or call +44 7700 900123.');
    assert.strictEqual(r.text, 'mail [EMAIL] or call [PHONE].');
  });

  it('possessive variant falls out of the boundary design', () => {
    const r = d.dehydrate("that is Wilfred's desk");
    assert.strictEqual(r.text, "that is [FIRST NAME]'s desk");
  });

  it('trailing punctuation adjacency matches', () => {
    const r = d.dehydrate('I live in London, mostly.');
    assert.strictEqual(r.text, 'I live in [WORK CITY], mostly.');
  });

  it('flexible internal whitespace in multi-word values', () => {
    const r = d.dehydrate('Wilfred  Kasekende wrote this');
    assert.strictEqual(r.text, '[FULL NAME] wrote this');
  });

  it('multiple occurrences all substitute', () => {
    const r = d.dehydrate('Wilfred said Wilfred would go to London');
    assert.strictEqual(r.text, '[FIRST NAME] said [FIRST NAME] would go to [WORK CITY]');
    assert.strictEqual(r.spans.length, 3);
  });

  it('is deterministic — same input, byte-identical output', () => {
    const a = d.dehydrate('Wilfred in London');
    const b = d.dehydrate('Wilfred in London');
    assert.strictEqual(a.text, b.text);
  });

  it('empty text and no-match text return unchanged', () => {
    assert.strictEqual(d.dehydrate('').changed, false);
    assert.strictEqual(d.dehydrate('nothing personal here').changed, false);
  });

  it('CJK-adjacent value matches (lookaround, not \\b)', () => {
    const cjk = compileDehydrator(new Map([['[FIRST NAME]', '維爾弗雷德']]));
    const r = cjk.dehydrate('請聯繫維爾弗雷德。');
    assert.strictEqual(r.text, '請聯繫[FIRST NAME]。');
  });
});

describe('compileDehydrator — skip rules (visible residual)', () => {
  it('skips too-short and common-word values, with a single warn', () => {
    const warns: string[] = [];
    const d = compileDehydrator(
      new Map([
        ['[INITIALS]', 'WK'],
        ['[FIRST NAME]', 'June'],
        ['[LAST NAME]', 'Kasekende'],
      ]),
      (m) => warns.push(m),
    );
    assert.strictEqual(d.size, 1); // only Kasekende is eligible
    assert.strictEqual(d.skipped.length, 2);
    assert.deepStrictEqual(
      d.skipped.map(s => s.reason).sort(),
      ['common-word', 'too-short'],
    );
    assert.strictEqual(warns.length, 1);
    // Redaction: the warn must not contain the raw values.
    assert.ok(!warns[0].includes('WK'));
    assert.ok(!warns[0].includes('June'));
  });

  it('skipped values pass through outbound text unmodified', () => {
    const d = compileDehydrator(new Map([['[FIRST NAME]', 'May']]));
    const r = d.dehydrate('May I go in May?');
    assert.strictEqual(r.changed, false);
  });

  it('bracket-token-shaped values are skipped', () => {
    const d = compileDehydrator(new Map([['[WEIRD]', '[NOT A VALUE]']]));
    assert.strictEqual(d.size, 0);
    assert.strictEqual(d.skipped[0].reason, 'bracket-token');
  });
});

describe('mapOffset — cursor snap semantics', () => {
  const d = compileDehydrator(CATALOG);
  // 'ask Wilfred now' → 'ask [FIRST NAME] now'
  const r = d.dehydrate('ask Wilfred now');

  it('offsets before the first span are unchanged', () => {
    assert.strictEqual(r.mapOffset(0), 0);
    assert.strictEqual(r.mapOffset(4), 4); // at span start
  });

  it('offsets inside a replaced value snap to the token boundary', () => {
    // 'Wil|fred' (offset 7) is mid-value.
    assert.strictEqual(r.mapOffset(7, 'left'), 4);   // '[FIRST NAME]' start
    assert.strictEqual(r.mapOffset(7, 'right'), 16); // '[FIRST NAME]' end
  });

  it('offsets after a span shift by the length delta', () => {
    // original ' now' begins at 11; token is 12 chars vs value 7 → +5.
    assert.strictEqual(r.mapOffset(11), 16);
    assert.strictEqual(r.mapOffset(15), 20); // end of string
  });

  it('unchanged result maps identity', () => {
    const u = d.dehydrate('no match');
    assert.strictEqual(u.mapOffset(5), 5);
  });
});

describe('round-trip with postProcessContext (hydration)', () => {
  const d = compileDehydrator(CATALOG);

  it('dehydrate → LLM echo → hydrate restores the original bytes', () => {
    const original = 'Tell Wilfred Kasekende that London is calling.';
    const out = d.dehydrate(original);
    // LLM echoes the tokens untouched (identity rewrite).
    const { output } = postProcessContext(out.text, {
      catalog: CATALOG,
      originalBody: original, // ALWAYS the pre-dehydration text
      preserveUnknown: true,
    });
    assert.strictEqual(output, original);
  });

  it('case-drift residual: lowercase typed value hydrates to canonical', () => {
    const original = 'ping wilfred later';
    const out = d.dehydrate(original);
    const { output } = postProcessContext(out.text, {
      catalog: CATALOG,
      originalBody: original,
      preserveUnknown: true,
    });
    assert.strictEqual(output, 'ping Wilfred later'); // documented, cosmetic
  });

  it('ambiguous both-present case: preserve wins + report.ambiguous records it', () => {
    // User typed the literal token (deliberate placeholder) AND their
    // real name elsewhere in the same buffer. After dehydration both
    // occurrences are the identical string — per-occurrence
    // disambiguation is impossible after an LLM rewrite. Preserve wins
    // (never inject PII into a deliberate placeholder); the conflict is
    // surfaced for callers to warn on.
    const original = 'template: dear [FIRST NAME] — signed, Wilfred';
    const out = d.dehydrate(original);
    const { output, report } = postProcessContext(out.text, {
      catalog: CATALOG,
      originalBody: original,
      preserveUnknown: true,
      introducedTokens: out.introduced,
    });
    assert.strictEqual(output, out.text); // both stay as tokens (fail-safe)
    assert.deepStrictEqual(report.ambiguous, ['[FIRST NAME]', '[FIRST NAME]']);
  });

  it('non-ambiguous introduced tokens hydrate even when introducedTokens is passed', () => {
    const original = 'ping Wilfred about London';
    const out = d.dehydrate(original);
    const { output, report } = postProcessContext(out.text, {
      catalog: CATALOG,
      originalBody: original,
      preserveUnknown: true,
      introducedTokens: out.introduced,
    });
    assert.strictEqual(output, original);
    assert.deepStrictEqual(report.ambiguous, []);
  });

  it('PINS the originalBody trap: passing dehydrated text as originalBody wrongly preserves tokens', () => {
    // This is the failure mode the doc-comment on
    // PostProcessOptions.originalBody guards against. If this test ever
    // "fixes itself", the precedence rules changed — re-read
    // docs/architecture/hydration-dehydration.md before touching.
    const original = 'ask Wilfred now';
    const out = d.dehydrate(original);
    const { output, report } = postProcessContext(out.text, {
      catalog: CATALOG,
      originalBody: out.text, // WRONG — dehydrated copy
      preserveUnknown: true,
    });
    assert.strictEqual(output, out.text); // token survives un-hydrated
    assert.deepStrictEqual(report.preserved, ['[FIRST NAME]']);
  });
});

describe('isPiiWord — word-cue withholding', () => {
  const d = compileDehydrator(CATALOG);

  it('flags each eligible word of multi-word values', () => {
    assert.strictEqual(d.isPiiWord('Wilfred'), true);
    assert.strictEqual(d.isPiiWord('Kasekende'), true);
    assert.strictEqual(d.isPiiWord('London'), true);
  });

  it('normalizes case, possessive, and edge punctuation', () => {
    assert.strictEqual(d.isPiiWord('wilfred'), true);
    assert.strictEqual(d.isPiiWord("Wilfred's"), true);
    assert.strictEqual(d.isPiiWord('(London),'), true);
  });

  it('does not flag ordinary words', () => {
    assert.strictEqual(d.isPiiWord('attorney'), false);
    assert.strictEqual(d.isPiiWord(''), false);
  });

  it('common words inside values do not poison the set', () => {
    const bank = compileDehydrator(new Map([['[COMPANY]', 'Bank of America']]));
    assert.strictEqual(bank.isPiiWord('of'), false);
    assert.strictEqual(bank.isPiiWord('Bank'), true);
    assert.strictEqual(bank.isPiiWord('America'), true);
  });
});

describe('getDehydrator — per-catalog cache', () => {
  it('same Map instance returns the same compiled dehydrator', () => {
    const catalog = new Map([['[FIRST NAME]', 'Wilfred']]);
    assert.strictEqual(getDehydrator(catalog), getDehydrator(catalog));
  });

  it('a fresh Map (hot reload) compiles a fresh instance', () => {
    const a = new Map([['[FIRST NAME]', 'Wilfred']]);
    const b = new Map([['[FIRST NAME]', 'Wilfred']]);
    assert.notStrictEqual(getDehydrator(a), getDehydrator(b));
  });
});

describe('collision + duplicate policies', () => {
  it('two tokens sharing a value: first catalog entry wins', () => {
    const d = compileDehydrator(new Map([
      ['[NICKNAME]', 'Wilfred'],
      ['[FIRST NAME]', 'Wilfred'],
    ]));
    const r = d.dehydrate('hi Wilfred');
    assert.strictEqual(r.text, 'hi [NICKNAME]');
  });
});
