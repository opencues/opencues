// Drift-prevention: every consumer site that maintains its own
// hardcoded copy of provider data (for pre-build/fallback scenarios)
// MUST stay in sync with the canonical PROVIDERS registry here.
//
// Today the consumer with a fallback is `help.cjs` — it ships
// PROVIDER_DISPLAY + PROVIDER_DEFAULT_MODEL maps so the help banner
// works even when core isn't built yet. Drift between these and
// the registry surfaces as different display names / model defaults
// pre-build vs post-build.
//
// If another consumer adds a fallback copy, add a check here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listProviders } from './llm-provider';

// Extract a `const NAME = { ... };` object literal from a source
// string. Returns parsed JS object. Simple enough for one-level flat
// objects (PROVIDER_DISPLAY / PROVIDER_DEFAULT_MODEL).
function extractConstObject(source: string, name: string): Record<string, string> {
  const re = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`);
  const m = source.match(re);
  if (!m) throw new Error(`could not find const ${name}`);
  // eslint-disable-next-line no-eval
  return eval('(' + m[1] + ')') as Record<string, string>;
}

describe('help.cjs provider fallbacks ↔ PROVIDERS registry', () => {
  const helpPath = join(__dirname, '../../opencues-cli/src/commands/help.cjs');
  const helpSource = readFileSync(helpPath, 'utf8');
  const display = extractConstObject(helpSource, 'PROVIDER_DISPLAY');
  const defaultModel = extractConstObject(helpSource, 'PROVIDER_DEFAULT_MODEL');

  for (const adapter of listProviders()) {
    it(`PROVIDER_DISPLAY['${adapter.id}'] matches displayName`, () => {
      expect(display[adapter.id],
        `help.cjs PROVIDER_DISPLAY missing '${adapter.id}'. ` +
        `Add: ${adapter.id}: '${adapter.displayName}'`,
      ).toBe(adapter.displayName);
    });

    it(`PROVIDER_DEFAULT_MODEL['${adapter.id}'] matches defaultModel`, () => {
      expect(defaultModel[adapter.id],
        `help.cjs PROVIDER_DEFAULT_MODEL missing '${adapter.id}'. ` +
        `Add: ${adapter.id}: '${adapter.defaultModel}'`,
      ).toBe(adapter.defaultModel);
    });
  }
});
