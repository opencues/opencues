/**
 * Unit tests for the user-context module.
 *
 * Runs under node:test (same as the rest of opencues-core tests; see
 * fluid-blank-source.test.ts etc.). Three layers exercised:
 *   - deriveToken      — key → canonical sentinel
 *   - parseUserMd      — frontmatter → UserContext
 *   - renderUserCatalog — UserContext + mode → prompt block
 *   - postProcessUserContext — LLM output → final string
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  deriveToken,
  parseUserMd,
  renderUserCatalog,
  postProcessUserContext,
} from './user-context';

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

// ─── parseUserMd ────────────────────────────────────────────────────────────

describe('parseUserMd — empty / missing inputs', () => {
  it('null returns empty UserContext', () => {
    const ctx = parseUserMd(null);
    assert.deepStrictEqual(ctx.fields, []);
    assert.strictEqual(ctx.catalog.size, 0);
  });

  it('undefined returns empty UserContext', () => {
    const ctx = parseUserMd(undefined);
    assert.deepStrictEqual(ctx.fields, []);
  });

  it('empty string returns empty UserContext', () => {
    const ctx = parseUserMd('');
    assert.deepStrictEqual(ctx.fields, []);
  });

  it('content with no frontmatter returns empty UserContext', () => {
    const ctx = parseUserMd('# Just markdown\n\nNo frontmatter here.');
    assert.deepStrictEqual(ctx.fields, []);
  });

  it('empty frontmatter returns empty UserContext', () => {
    const ctx = parseUserMd('---\n---\n\nBody.');
    assert.deepStrictEqual(ctx.fields, []);
  });
});

describe('parseUserMd — basic frontmatter', () => {
  it('parses a single camelCase field', () => {
    const ctx = parseUserMd('---\nfirstName: Wilfred\n---');
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
    const ctx = parseUserMd('---\nfirstName: A\nlastName: B\nemail: c@d.e\n---');
    assert.deepStrictEqual(
      ctx.fields.map(f => f.token),
      ['[FIRST NAME]', '[LAST NAME]', '[EMAIL]'],
    );
  });

  it('strips quoted values', () => {
    const ctx = parseUserMd('---\ntwitter: "@wkasekende"\n---');
    assert.strictEqual(ctx.catalog.get('[TWITTER]'), '@wkasekende');
  });

  it('strips single-quoted values', () => {
    const ctx = parseUserMd("---\ntwitter: '@wk'\n---");
    assert.strictEqual(ctx.catalog.get('[TWITTER]'), '@wk');
  });

  it('skips empty values', () => {
    const ctx = parseUserMd('---\nfirstName:\nlastName: K\n---');
    assert.strictEqual(ctx.fields.length, 1);
    assert.strictEqual(ctx.fields[0].key, 'lastName');
  });

  it('skips commented-out lines', () => {
    const ctx = parseUserMd('---\n# firstName: Wilfred\nemail: w@e\n---');
    assert.strictEqual(ctx.fields.length, 1);
    assert.strictEqual(ctx.fields[0].token, '[EMAIL]');
  });

  it('skips indented lines', () => {
    const ctx = parseUserMd('---\nfirstName: W\n  nested: ignored\nemail: w@e\n---');
    assert.deepStrictEqual(
      ctx.fields.map(f => f.token),
      ['[FIRST NAME]', '[EMAIL]'],
    );
  });
});

describe('parseUserMd — description comments', () => {
  it('inline `# description: ...` overrides the auto-derived description', () => {
    const ctx = parseUserMd('---\nwork: Acme Corp  # description: where i work\n---');
    assert.strictEqual(ctx.fields[0].description, 'where i work');
    assert.strictEqual(ctx.fields[0].value, 'Acme Corp');
  });

  it('falls back to auto-description when no comment', () => {
    const ctx = parseUserMd('---\njobTitle: SWE\n---');
    assert.strictEqual(ctx.fields[0].description, "user's job title");
  });
});

describe('parseUserMd — collision handling', () => {
  it('duplicate-token collision: first wins', () => {
    // `firstName` and `first_name` both derive to `[FIRST NAME]`.
    const ctx = parseUserMd('---\nfirstName: First\nfirst_name: Second\n---');
    assert.strictEqual(ctx.fields.length, 1);
    assert.strictEqual(ctx.fields[0].key, 'firstName');
    assert.strictEqual(ctx.catalog.get('[FIRST NAME]'), 'First');
  });
});

// ─── renderUserCatalog ──────────────────────────────────────────────────────

describe('renderUserCatalog', () => {
  const SAMPLE = parseUserMd('---\nfirstName: Wilfred\nemail: w@e\n---');

  it('returns empty string when mode is off', () => {
    assert.strictEqual(renderUserCatalog(SAMPLE, 'off'), '');
  });

  it('returns empty string when fields are empty', () => {
    const empty = parseUserMd(null);
    assert.strictEqual(renderUserCatalog(empty, 'safe'), '');
  });

  it('safe mode emits tokens + descriptions only (no values)', () => {
    const block = renderUserCatalog(SAMPLE, 'safe');
    assert.match(block, /\[FIRST NAME\] — user's first name/);
    assert.match(block, /\[EMAIL\] — user's email/);
    assert.doesNotMatch(block, /Wilfred/);
    assert.doesNotMatch(block, /w@e/);
  });

  it('raw mode emits tokens + descriptions + values', () => {
    const block = renderUserCatalog(SAMPLE, 'raw');
    assert.match(block, /\[FIRST NAME\] — user's first name \(value: Wilfred\)/);
    assert.match(block, /\[EMAIL\] — user's email \(value: w@e\)/);
  });

  it('includes the strict-rules block in both modes', () => {
    for (const mode of ['safe', 'raw'] as const) {
      const block = renderUserCatalog(SAMPLE, mode);
      assert.match(block, /RULES for these tokens/);
      assert.match(block, /ONLY use tokens from the list above/);
    }
  });
});

// ─── postProcessUserContext ────────────────────────────────────────────────

describe('postProcessUserContext', () => {
  const CATALOG = new Map([
    ['[FIRST NAME]', 'Wilfred'],
    ['[EMAIL]', 'wilfred@example.com'],
    ['[WORK CITY]', 'London'],
  ]);

  it('resolves a verbatim token', () => {
    const r = postProcessUserContext('[EMAIL]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'wilfred@example.com');
    assert.strictEqual(r.report.resolved.length, 1);
  });

  it('tolerant matches underscore form to space form', () => {
    const r = postProcessUserContext('[WORK_CITY]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'London');
    assert.strictEqual(r.report.tolerantMatches.length, 1);
    assert.strictEqual(r.report.tolerantMatches[0].canonical, '[WORK CITY]');
  });

  it('strips a hallucinated unlisted token', () => {
    const r = postProcessUserContext('Born on [DATE OF BIRTH] in [WORK CITY]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'Born on  in London');
    assert.deepStrictEqual(r.report.stripped, ['[DATE OF BIRTH]']);
  });

  it('preserves user-typed tokens via originalBody', () => {
    const body = 'The [FIRST NAME] sentinel is documented here.';
    const r = postProcessUserContext(body, { catalog: CATALOG, originalBody: body });
    assert.strictEqual(r.output, body);
    assert.deepStrictEqual(r.report.preserved, ['[FIRST NAME]']);
  });

  it('preserves user-typed [WORK_CITY] over tolerant match', () => {
    const body = 'See [WORK_CITY] placeholder.';
    const r = postProcessUserContext(body, { catalog: CATALOG, originalBody: body });
    assert.strictEqual(r.output, body);
    assert.deepStrictEqual(r.report.tolerantMatches, []);
  });

  it('no-op when catalog is empty', () => {
    const r = postProcessUserContext('hello world', { catalog: new Map() });
    assert.strictEqual(r.output, 'hello world');
  });

  it('does not match lowercase / prose brackets', () => {
    const r = postProcessUserContext('see [note] and [1]', { catalog: CATALOG });
    assert.strictEqual(r.output, 'see [note] and [1]');
    assert.strictEqual(r.report.resolved.length, 0);
    assert.strictEqual(r.report.stripped.length, 0);
  });
});
