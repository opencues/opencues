// Drift-prevention: every host bootstrap must construct its blanks
// registry from `createDefaultBlanksRegistry(ctx)`, not from a
// hardcoded `new BlankClass()` list. The May 2026 audit found
// claude-status was registered on opencode + chrome but MISSING from
// CC + gemini-cli — a silent feature gap shipped to users.
//
// This test asserts each host bootstrap file invokes the helper. It's
// a lightweight string-search check, not a runtime invocation — that
// keeps it independent of the host's React/Ink/tweakcc particulars.
//
// To add a new built-in blank: append to BUILTIN_BLANKS in
// packages/opencues-runtime/src/blanks/index.ts. No host edit needed;
// this test still passes because every host invokes the helper.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILTIN_BLANKS, createDefaultBlanksRegistry } from './index';

const REPO_ROOT = resolve(__dirname, '../../../..');
const HOST_BOOTSTRAPS = [
  { name: 'opencode',   path: 'integrations/opencode/patches/opencuesBootstrap.ts' },
  { name: 'gemini-cli', path: 'integrations/gemini-cli/patches/opencuesBootstrap.ts' },
  { name: 'chrome',     path: 'integrations/chrome/src/blanks/index.ts' },
  { name: 'claude-code', path: 'integrations/claude-code/patches/opencuesRuntime.ts' },
];

describe('Host bootstraps use BUILTIN_BLANKS registry', () => {
  for (const host of HOST_BOOTSTRAPS) {
    const fullPath = resolve(REPO_ROOT, host.path);
    if (!existsSync(fullPath)) continue;  // skip if path doesn't resolve

    it(`${host.name} bootstrap calls createDefaultBlanksRegistry`, () => {
      const source = readFileSync(fullPath, 'utf8');
      expect(source,
        `${host.name} (${host.path}) doesn't reference createDefaultBlanksRegistry. ` +
        `Don't maintain a per-host hardcoded blank list — call the helper.`,
      ).toContain('createDefaultBlanksRegistry');
    });

    it(`${host.name} bootstrap does NOT hardcode individual blank class names`, () => {
      const source = readFileSync(fullPath, 'utf8');
      // If any of these substrings appears in a `new XxxBlank` form
      // outside the registry helper, it's drift. We check for the
      // characteristic instantiation pattern.
      const violations: string[] = [];
      for (const spec of BUILTIN_BLANKS) {
        const className = spec.name
          .split('-')
          .map(s => s[0].toUpperCase() + s.slice(1))
          .join('') + 'Blank';
        // Allow appearance in comments / type imports / JSDoc / re-exports.
        // Catch only `new XxxBlank(` instantiations.
        const re = new RegExp(`new\\s+(?:__ocCtl\\.)?${className}\\s*\\(`);
        if (re.test(source)) violations.push(className);
      }
      expect(violations,
        `${host.name} (${host.path}) still hardcodes blank instantiations: ` +
        `${violations.join(', ')}. Remove these — createDefaultBlanksRegistry handles them.`,
      ).toEqual([]);
    });
  }
});

describe('createDefaultBlanksRegistry semantics', () => {
  it('registers all blanks when full context is supplied', () => {
    const reg = createDefaultBlanksRegistry({
      llmConfig: { apiKey: 'test' },
      finnhubApiKey: 'test',
      opencuesMdIO: {
        readFile: async () => null,
        writeFile: async () => {},
      },
      identityMdIO: {
        readFile: async () => null,
        writeFile: async () => {},
      },
      notesMdIO: {
        readFile: async () => null,
        writeFile: async () => {},
      },
    });
    for (const spec of BUILTIN_BLANKS) {
      expect(reg.has(spec.name), `missing ${spec.name} in full-context registry`).toBe(true);
    }
  });

  it('does not register the removed bespoke LLM blanks (answer / prompt)', () => {
    // The legacy direct-to-Groq `answer` + `prompt` blanks were removed
    // (June 2026); their intents are served by the generalized semantic-`_`
    // sources (FluidBlank / TransformBlank) that use the user's provider.
    const reg = createDefaultBlanksRegistry({});
    expect(reg.has('answer')).toBe(false);
    expect(reg.has('prompt')).toBe(false);
    expect(BUILTIN_BLANKS.some(b => b.name === 'answer')).toBe(false);
    expect(BUILTIN_BLANKS.some(b => b.name === 'prompt')).toBe(false);
    // Non-LLM blanks still register
    expect(reg.has('weather')).toBe(true);
    expect(reg.has('claude-status')).toBe(true);
  });

  it('skips the opencues settings blank when opencuesMdIO is absent', () => {
    const reg = createDefaultBlanksRegistry({});
    expect(reg.has('opencues')).toBe(false);
  });

  it('skips the sentinel blank when identityMdIO is absent', () => {
    const reg = createDefaultBlanksRegistry({});
    expect(reg.has('sentinel')).toBe(false);
  });

  it('canonical built-ins are all present in BUILTIN_BLANKS', () => {
    // Pins the floor — if someone removes one of these from the
    // registry, hosts that depended on it break silently.
    const canonical = [
      'hackernews', 'stocks', 'weather', 'claude-status',
      'dictionary', 'crypto', 'countries',
      'opencues', 'sentinel',
    ];
    const present = new Set(BUILTIN_BLANKS.map(b => b.name));
    for (const name of canonical) {
      expect(present.has(name), `canonical blank ${name} missing from BUILTIN_BLANKS`).toBe(true);
    }
  });
});
