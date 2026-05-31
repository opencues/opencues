/**
 * Unit tests for the sentinels module.
 *
 * Runs under node:test (same as the rest of opencues-core tests; see
 * fluid-blank-source.test.ts etc.). Three layers exercised:
 *   - deriveToken      — key → canonical sentinel
 *   - parseSentinelsMd      — frontmatter → Sentinels
 *   - renderSentinelsCatalog — Sentinels + mode → prompt block
 *   - postProcessSentinels — LLM output → final string
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  deriveToken,
  parseSentinelsMd,
  renderSentinelsCatalog,
  renderSentinelsCatalogForTransform,
  postProcessSentinels,
} from './sentinels';

// ─── deriveToken ────────────────────────────────────────────────────────────

describe('deriveToken', () => {
  it('camelCase splits on word boundaries', () => {
    assert.strictEqual(deriveToken('firstName'), '[FIRST NAME]');
    assert.strictEqual(deriveToken('workCityHome'), '[WORK CITY HOME]');
    assert.strictEqual(deriveToken('homePostcode'), '[HOME POSTCODE]');
  });

  it('snake_case + kebab-case both flatten to spaces', () => {
    assert.strictEqual(deriveToken('first_name'), '[FIRST NAME]');
    assert.strictEqual(deriveToken('first-name'), '[FIRST NAME]');
    assert.strictEqual(deriveToken('home_postcode'), '[HOME POSTCODE]');
  });

  it('SCREAMING_SNAKE survives uppercase', () => {
    assert.strictEqual(deriveToken('FIRST_NAME'), '[FIRST NAME]');
  });

  it('mixed numeric + letter cluster stays together', () => {
    assert.strictEqual(deriveToken('phoneE164'), '[PHONE E164]');
  });

  it('multi-space + leading/trailing whitespace collapse', () => {
    assert.strictEqual(deriveToken('first  name '), '[FIRST NAME]');
  });
});

// ─── parseSentinelsMd ────────────────────────────────────────────────────────────

describe('parseSentinelsMd — empty / missing inputs', () => {
  it('null returns empty Sentinels', () => {
    const ctx = parseSentinelsMd(null);
    assert.deepStrictEqual(ctx.fields, []);
    assert.strictEqual(ctx.catalog.size, 0);
  });

  it('undefined returns empty Sentinels', () => {
    const ctx = parseSentinelsMd(undefined);
    assert.deepStrictEqual(ctx.fields, []);
  });

  it('empty string returns empty Sentinels', () => {
    const ctx = parseSentinelsMd('');
    assert.deepStrictEqual(ctx.fields, []);
  });

  it('content with no frontmatter returns empty Sentinels', () => {
    const ctx = parseSentinelsMd('# Just markdown\n\nNo frontmatter here.');
    assert.deepStrictEqual(ctx.fields, []);
  });

  it('empty frontmatter returns empty Sentinels', () => {
    const ctx = parseSentinelsMd('---\n---\n\nBody.');
    assert.deepStrictEqual(ctx.fields, []);
  });
});

describe('parseSentinelsMd — basic frontmatter', () => {
  it('parses a single camelCase field', () => {
    const ctx = parseSentinelsMd('---\nfirstName: Wilfred\n---');
    assert.strictEqual(ctx.fields.length, 1);
    assert.deepStrictEqual(ctx.fields[0], {
      key: 'firstName',
      token: '[FIRST NAME]',
      value: 'Wilfred',
      description: "user's first name",
    });
    assert.strictEqual(ctx.catalog.get('[FIRST NAME]'), 'Wilfred');
  });

  it('parses multiple fields preserving declaration order', () => {
    const ctx = parseSentinelsMd('---\nfirstName: A\nlastName: B\nemail: c@d.e\n---');
    assert.deepStrictEqual(
      ctx.fields.map(f => f.token),
      ['[FIRST NAME]', '[LAST NAME]', '[EMAIL]'],
    );
  });

  it('strips quoted values', () => {
    const ctx = parseSentinelsMd('---\ntwitter: "@wkasekende"\n---');
    assert.strictEqual(ctx.catalog.get('[TWITTER]'), '@wkasekende');
  });

  it('strips single-quoted values', () => {
    const ctx = parseSentinelsMd("---\ntwitter: '@wk'\n---");
    assert.strictEqual(ctx.catalog.get('[TWITTER]'), '@wk');
  });

  it('skips empty values', () => {
    const ctx = parseSentinelsMd('---\nfirstName:\nlastName: K\n---');
    assert.strictEqual(ctx.fields.length, 1);
    assert.strictEqual(ctx.fields[0].key, 'lastName');
  });

  it('skips commented-out lines', () => {
    const ctx = parseSentinelsMd('---\n# firstName: Wilfred\nemail: w@e\n---');
    assert.strictEqual(ctx.fields.length, 1);
    assert.strictEqual(ctx.fields[0].token, '[EMAIL]');
  });

  it('skips indented lines', () => {
    const ctx = parseSentinelsMd('---\nfirstName: W\n  nested: ignored\nemail: w@e\n---');
    assert.deepStrictEqual(
      ctx.fields.map(f => f.token),
      ['[FIRST NAME]', '[EMAIL]'],
    );
  });
});

describe('parseSentinelsMd — description comments', () => {
  it('inline `# description: ...` overrides the auto-derived description', () => {
    const ctx = parseSentinelsMd('---\nwork: Acme Corp  # description: where i work\n---');
    assert.strictEqual(ctx.fields[0].description, 'where i work');
    assert.strictEqual(ctx.fields[0].value, 'Acme Corp');
  });

  it('falls back to auto-description when no comment', () => {
    const ctx = parseSentinelsMd('---\njobTitle: SWE\n---');
    assert.strictEqual(ctx.fields[0].description, "user's job title");
  });

  it('strips arbitrary trailing `# comment` from the value', () => {
    // Real bite: the shipped template uses `# → [TOKEN NAME]` hints
    // after each key as documentation. Users copy the template,
    // uncomment a line, and the hint stays attached. Without this
    // strip the value becomes "Wilfred                   # → [FIRST NAME]"
    // and the catalog entry resolves to that garbage.
    const ctx = parseSentinelsMd('---\nfirstName: Wilfred   # → [FIRST NAME]\n---');
    assert.strictEqual(ctx.fields[0].value, 'Wilfred');
    assert.strictEqual(ctx.catalog.get('[FIRST NAME]'), 'Wilfred');
  });

  it('preserves `#` inside a quoted value', () => {
    // CSS hex colour, IRC channel, etc. — `#` inside quotes is data,
    // not a comment. Pin so the comment-stripper doesn't over-reach.
    const ctx = parseSentinelsMd('---\nfavoriteColor: "#FF0000"  # → [FAVORITE COLOR]\n---');
    assert.strictEqual(ctx.fields[0].value, '#FF0000');
  });

  it('handles `value#comment` (no space before #) as one token', () => {
    // Matches YAML: a comment must be space-prefixed. `a@b.c#frag`
    // is one value, not value + comment.
    const ctx = parseSentinelsMd('---\nemail: a@b.c#frag\n---');
    assert.strictEqual(ctx.fields[0].value, 'a@b.c#frag');
  });
});

describe('parseSentinelsMd — collision handling', () => {
  it('duplicate-token collision: first wins', () => {
    // `firstName` and `first_name` both derive to `[FIRST NAME]`.
    const ctx = parseSentinelsMd('---\nfirstName: First\nfirst_name: Second\n---');
    assert.strictEqual(ctx.fields.length, 1);
    assert.strictEqual(ctx.fields[0].key, 'firstName');
    assert.strictEqual(ctx.catalog.get('[FIRST NAME]'), 'First');
  });
});

// ─── renderSentinelsCatalog ──────────────────────────────────────────────────────

describe('renderSentinelsCatalog', () => {
  const SAMPLE = parseSentinelsMd('---\nfirstName: Wilfred\nemail: w@e\n---');

  it('returns empty string when mode is off', () => {
    assert.strictEqual(renderSentinelsCatalog(SAMPLE, 'off'), '');
  });

  it('returns empty string when fields are empty', () => {
    const empty = parseSentinelsMd(null);
    assert.strictEqual(renderSentinelsCatalog(empty, 'safe'), '');
  });

  it('safe mode emits tokens + descriptions only (no values)', () => {
    const block = renderSentinelsCatalog(SAMPLE, 'safe');
    assert.match(block, /\[FIRST NAME\] — user's first name/);
    assert.match(block, /\[EMAIL\] — user's email/);
    assert.doesNotMatch(block, /Wilfred/);
    assert.doesNotMatch(block, /w@e/);
  });

  it('raw mode emits tokens + descriptions + values', () => {
    const block = renderSentinelsCatalog(SAMPLE, 'raw');
    assert.match(block, /\[FIRST NAME\] — user's first name \(value: Wilfred\)/);
    assert.match(block, /\[EMAIL\] — user's email \(value: w@e\)/);
  });

  it('includes the strict-rules block in both modes', () => {
    for (const mode of ['safe', 'raw'] as const) {
      const block = renderSentinelsCatalog(SAMPLE, mode);
      assert.match(block, /RULES for these tokens/);
      assert.match(block, /ONLY use tokens from the list above/);
    }
  });
});

// ─── postProcessSentinels ────────────────────────────────────────────────

describe('postProcessSentinels', () => {
  const CATALOG = new Map([
    ['[FIRST NAME]', 'Wilfred'],
    ['[EMAIL]', 'wilfred@example.com'],
    ['[WORK CITY]', 'London'],
  ]);

  it('resolves a verbatim token', () => {
    const r = postProcessSentinels('[EMAIL]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'wilfred@example.com');
    assert.strictEqual(r.report.resolved.length, 1);
  });

  it('tolerant matches underscore form to space form', () => {
    const r = postProcessSentinels('[WORK_CITY]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'London');
    assert.strictEqual(r.report.tolerantMatches.length, 1);
    assert.strictEqual(r.report.tolerantMatches[0].canonical, '[WORK CITY]');
  });

  it('strips a hallucinated unlisted token', () => {
    const r = postProcessSentinels('Born on [DATE OF BIRTH] in [WORK CITY]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'Born on  in London');
    assert.deepStrictEqual(r.report.stripped, ['[DATE OF BIRTH]']);
  });

  it('preserves user-typed tokens via originalBody', () => {
    const body = 'The [FIRST NAME] sentinel is documented here.';
    const r = postProcessSentinels(body, { catalog: CATALOG, originalBody: body });
    assert.strictEqual(r.output, body);
    assert.deepStrictEqual(r.report.preserved, ['[FIRST NAME]']);
  });

  it('preserves user-typed [WORK_CITY] over tolerant match', () => {
    const body = 'See [WORK_CITY] placeholder.';
    const r = postProcessSentinels(body, { catalog: CATALOG, originalBody: body });
    assert.strictEqual(r.output, body);
    assert.deepStrictEqual(r.report.tolerantMatches, []);
  });

  it('no-op when catalog is empty', () => {
    const r = postProcessSentinels('hello world', { catalog: new Map() });
    assert.strictEqual(r.output, 'hello world');
  });

  it('does not match lowercase / prose brackets', () => {
    const r = postProcessSentinels('see [note] and [1]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'see [note] and [1]');
    assert.strictEqual(r.report.resolved.length, 0);
    assert.strictEqual(r.report.stripped.length, 0);
  });

  it('preserveUnknown: unresolved uppercase tokens survive in output', () => {
    const r = postProcessSentinels(
      'Hi [RECIPIENT NAME], from [FIRST NAME] at [SIGNATURE].',
      { catalog: CATALOG, preserveUnknown: true },
    );
    assert.strictEqual(r.output, 'Hi [RECIPIENT NAME], from Wilfred at [SIGNATURE].');
    assert.deepStrictEqual(r.report.resolved.map(x => x.token), ['[FIRST NAME]']);
    // stripped report still flags them (so callers can log) but they survive.
    assert.deepStrictEqual(r.report.stripped, ['[RECIPIENT NAME]', '[SIGNATURE]']);
  });

  it('preserveUnknown false (default): unresolved uppercase tokens removed', () => {
    const r = postProcessSentinels(
      'Hi [RECIPIENT NAME], from [FIRST NAME].',
      { catalog: CATALOG },
    );
    assert.strictEqual(r.output, 'Hi , from Wilfred.');
  });
});

// ─── renderSentinelsCatalogForTransform ──────────────────────────────────────────

describe('renderSentinelsCatalogForTransform', () => {
  const SAMPLE = parseSentinelsMd('---\nfirstName: Wilfred\ncompany: Command Stick\n---');

  it('returns empty string when mode is off', () => {
    assert.strictEqual(renderSentinelsCatalogForTransform(SAMPLE, 'off'), '');
  });

  it('returns empty string when fields are empty', () => {
    const empty = parseSentinelsMd(null);
    assert.strictEqual(renderSentinelsCatalogForTransform(empty, 'safe'), '');
  });

  it('safe mode: tokens + descriptions only, no values', () => {
    const block = renderSentinelsCatalogForTransform(SAMPLE, 'safe');
    assert.match(block, /\[FIRST NAME\] — user's first name/);
    assert.match(block, /\[COMPANY\] — user's company/);
    assert.doesNotMatch(block, /Wilfred/);
    assert.doesNotMatch(block, /Command Stick/);
  });

  it('raw mode: includes values inline', () => {
    const block = renderSentinelsCatalogForTransform(SAMPLE, 'raw');
    assert.match(block, /\[FIRST NAME\] — user's first name \(value: Wilfred\)/);
    assert.match(block, /\[COMPANY\] — user's company \(value: Command Stick\)/);
  });

  it('rules scope tokens to SENDER and explicitly allow other placeholders', () => {
    const block = renderSentinelsCatalogForTransform(SAMPLE, 'safe');
    assert.match(block, /SENDER/);
    assert.match(block, /OTHER people or entities/);
    assert.match(block, /natural placeholder/);
  });

  it('rule set differs from FluidBlank renderer (no form-field rules)', () => {
    const transformBlock = renderSentinelsCatalogForTransform(SAMPLE, 'safe');
    assert.doesNotMatch(transformBlock, /UNTRUSTED_FIELD_CONTEXT/);
    assert.doesNotMatch(transformBlock, /form field/i);
  });

  it('custom user-defined sentinel (arbitrary key) makes it into the catalog block', () => {
    // The catalog is open: any YAML key becomes a sentinel. Verify
    // a user-defined field (here `signOff`) rides through verbatim.
    const ctx = parseSentinelsMd('---\nfirstName: Wilfred\nsignOff: Best from sunny London\nfavoriteEditor: vim\n---');
    const block = renderSentinelsCatalogForTransform(ctx, 'safe');
    assert.match(block, /\[SIGN OFF\] — user's sign off/);
    assert.match(block, /\[FAVORITE EDITOR\] — user's favorite editor/);
  });
});
