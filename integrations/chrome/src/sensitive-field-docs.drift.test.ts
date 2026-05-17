// Drift-prevention: every doc that mentions the sensitive-field
// name/id heuristic MUST reference the exported constants
// (SENSITIVE_FIELD_NAME_PATTERN, SENSITIVE_AUTOCOMPLETE_TOKENS) in
// opencues-bootstrap.ts rather than duplicating the token list.
//
// The May 2026 audit found the same regex
// `password|passwd|pwd|cvv|cvc|ssn|sin|pin|otp|secret|token|...`
// duplicated verbatim in 5 docs. Adding a new token (e.g. `mfa`) to
// the code would silently leave all 5 doc copies stale.
//
// This test fails loud when a doc embeds the literal regex instead
// of a `SENSITIVE_FIELD_NAME_PATTERN` / `SENSITIVE_AUTOCOMPLETE_TOKENS`
// reference. The one canonical mention lives in
// `docs/architecture/chrome-security.md` — see SOURCE_OF_TRUTH below.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SENSITIVE_FIELD_NAME_PATTERN, SENSITIVE_AUTOCOMPLETE_TOKENS } from './opencues-bootstrap';

const REPO_ROOT = resolve(__dirname, '../../..');

// The one doc allowed to enumerate the token list literally — it's
// the canonical reference everyone else points at.
const SOURCE_OF_TRUTH = 'docs/architecture/chrome-security.md';

// Docs that historically duplicated the regex. They must NOT contain
// the literal regex pattern anymore — only references to the exported
// constants.
const DOCS_THAT_REFERENCE_NOT_DUPLICATE = [
  'docs/glossary.md',
  'docs/features/chrome-normal-inputs.md',
  'docs/architecture/universal-integration.md',
  'docs/architecture/security-audit.md',
];

// Substring fragments that indicate the doc embedded the regex literally
// rather than referencing the constant. Conservatively: a stretch of the
// canonical regex tokens in order.
const LITERAL_REGEX_FRAGMENTS = [
  'password|passwd|pwd|cvv',
  'ssn|sin|pin|otp|secret|token',
];

describe('SENSITIVE_FIELD_NAME_PATTERN constants exported', () => {
  it('SENSITIVE_FIELD_NAME_PATTERN is a RegExp covering canonical tokens', () => {
    expect(SENSITIVE_FIELD_NAME_PATTERN).toBeInstanceOf(RegExp);
    // Test shape mirrors production: `name + '|' + id` is the haystack
    // joined with `|`, which is NOT a word character, so `\b` fires at
    // its boundary. The exact shape from opencues-bootstrap.ts.
    for (const token of ['password', 'cvv', 'ssn', 'otp', 'api_key', 'access-key', 'auth']) {
      expect(SENSITIVE_FIELD_NAME_PATTERN.test(`username|${token}`), `name=${token}`).toBe(true);
      expect(SENSITIVE_FIELD_NAME_PATTERN.test(`${token}|signup_form`), `id=${token}`).toBe(true);
    }
    // Non-sensitive names don't match
    expect(SENSITIVE_FIELD_NAME_PATTERN.test('email|signup_form')).toBe(false);
    expect(SENSITIVE_FIELD_NAME_PATTERN.test('username|comment')).toBe(false);
  });

  it('SENSITIVE_AUTOCOMPLETE_TOKENS includes canonical entries', () => {
    expect(SENSITIVE_AUTOCOMPLETE_TOKENS).toBeInstanceOf(Set);
    for (const token of ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc']) {
      expect(SENSITIVE_AUTOCOMPLETE_TOKENS.has(token), token).toBe(true);
    }
  });
});

describe('No doc duplicates the sensitive-field regex except the source of truth', () => {
  for (const doc of DOCS_THAT_REFERENCE_NOT_DUPLICATE) {
    const fullPath = resolve(REPO_ROOT, doc);
    if (!existsSync(fullPath)) continue;
    it(`${doc} doesn't embed the literal token list`, () => {
      const source = readFileSync(fullPath, 'utf8');
      for (const fragment of LITERAL_REGEX_FRAGMENTS) {
        expect(source.includes(fragment),
          `${doc} contains "${fragment}" — replace the literal regex with a reference to ` +
          `SENSITIVE_FIELD_NAME_PATTERN (canonical doc: ${SOURCE_OF_TRUTH}).`,
        ).toBe(false);
      }
    });

    it(`${doc} references the canonical constants or the source-of-truth doc`, () => {
      const source = readFileSync(fullPath, 'utf8');
      const referencesConstants = source.includes('SENSITIVE_FIELD_NAME_PATTERN')
        || source.includes('SENSITIVE_AUTOCOMPLETE_TOKENS');
      const referencesSourceOfTruth = source.includes('chrome-security.md');
      expect(referencesConstants || referencesSourceOfTruth,
        `${doc} mentions sensitive fields but neither names the exported constants ` +
        `(SENSITIVE_FIELD_NAME_PATTERN / SENSITIVE_AUTOCOMPLETE_TOKENS) nor links to ` +
        `${SOURCE_OF_TRUTH}. Add a reference so the canonical source can change without ` +
        `silently leaving this doc stale.`,
      ).toBe(true);
    });
  }

  it('the canonical doc DOES enumerate at least one token (proving it carries the list)', () => {
    const source = readFileSync(resolve(REPO_ROOT, SOURCE_OF_TRUTH), 'utf8');
    expect(source).toContain('password');
    expect(source).toContain('cvv');
  });
});
