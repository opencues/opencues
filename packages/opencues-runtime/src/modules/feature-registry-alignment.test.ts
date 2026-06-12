// Drift-prevention test pinning that the FEATURES registry in
// @opencues/core stays aligned with this package's OpenCuesState
// typed interface.
//
// The registry is the single source of truth for which optional
// features exist. ConfigLoader (here in opencues-runtime) parses a
// subset of those scalars into typed OpenCuesState fields so that
// TypeScript consumers get narrow types (e.g. `'off' | 'safe' | 'raw'`
// for sentinelsMode) instead of `string`.
//
// The risk: someone adds a feature to FEATURES but forgets to add a
// matching OpenCuesState field. Consumers that read via the typed
// path silently never see the new feature, even though host.cjs and
// doctor pick it up automatically.
//
// This test fails loud when that drift happens. To resolve:
//   - If the new feature SHOULD be typed: add a field to OpenCuesState
//     in config-loader.ts and a parse case in _parseOpencuesMd.
//   - If the new feature should stay settings-map-only (read via
//     ConfigLoader.settings.get(scalar) by consumers like resolver.ts):
//     add its camelCase name to SETTINGS_MAP_ONLY below with a comment
//     explaining why.

import { describe, it, expect } from 'vitest';
import { FEATURES } from '@opencues/core';
import { DEFAULT_OPENCUES_STATE } from './config-loader';

// Features intentionally read straight off the settings Map by their
// consumers, NOT lifted into a typed OpenCuesState field. These don't
// need narrow types because their consumer treats them as a plain
// on/off toggle and the read site is concentrated (resolver.ts).
const SETTINGS_MAP_ONLY: ReadonlySet<string> = new Set([
  'fluidBlankMode',     // consumed in resolver.ts:enableFluidBlank
  'wordCuesMode',       // consumed in resolver.ts:enableWordCues
  'transformBlankMode', // consumed by transform-blank pipeline gate
  'fluidConfigMode',    // consumed in resolver.ts:enableConfigIntent
  'sentenceCuesMode',   // consumed in resolver.ts:enableSentenceCues
  'maxThinking',        // consumed in resolver.ts (buildSources maxThinking)
                        // + boot-common buildAgentLLMResolver; a plain
                        // on/off toggle, no narrow-typed consumer needs it.
  // The three `*-llm-model` scalars are read straight off `settings.get(...)`
  // by resolver.ts:532-535. They're dynamic-valued (their valid range
  // depends on the sibling `*-llm-provider`) so a typed enum would be
  // wrong — the legal values change at runtime.
  'cuesLlmModel',
  'auditorsLlmModel',
  'blanksLlmModel',
]);

describe('feature-registry ↔ OpenCuesState alignment', () => {
  const stateKeys = new Set(Object.keys(DEFAULT_OPENCUES_STATE));

  for (const f of FEATURES) {
    if (SETTINGS_MAP_ONLY.has(f.camelCase)) {
      it(`${f.scalar} is intentionally settings-map-only (not typed)`, () => {
        expect(stateKeys.has(f.camelCase)).toBe(false);
      });
    } else {
      it(`${f.scalar} has a matching OpenCuesState.${f.camelCase} field`, () => {
        expect(stateKeys.has(f.camelCase),
          `FEATURES declares scalar '${f.scalar}' (camelCase '${f.camelCase}') but OpenCuesState has no such field. ` +
          `Either add the field to OpenCuesState + parse case in config-loader.ts, OR add '${f.camelCase}' to SETTINGS_MAP_ONLY in this test file.`,
        ).toBe(true);
      });
    }
  }
});
