// Scenario tests for buffer dehydration (identity-context safe mode).
//
// Multi-step user journeys across the RUNTIME wiring: ConfigLoader
// parses IDENTITY.md from disk → Resolver forwards the catalog to
// every dispatch (identityContext, no keyword-bound gate) → a
// dehydrating source's HYDRATED result lands in the buffer with real
// values and no token residue → mode flips / satellite cycles / LLM
// failures never regress the scrub or destroy the buffer.
//
// The per-source outbound negative invariants (no catalog value in any
// request body) are pinned at the core layer in
// packages/opencues-core/src/sources/dehydration-outbound.test.ts —
// these scenarios pin the runtime glue those tests can't see.
//
// Per CLAUDE.md § agentic scenarios: assertions here are decoupled from
// LLM content — they pin negative invariants (no `[TOKEN]` residue, no
// value in the captured ctx, buffer byte-identical on failure), not
// specific model output.

import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;
const IDENTITY_MD = `---
firstName: Zorbath
fullName: Zorbath Quillfeather
workCity: Reykjavik
---
`;
// A bare [UPPERCASE] bracket-token shape — no token from IDENTITY_MD
// should ever survive into the live buffer.
const TOKEN_RESIDUE = /\[[A-Z][A-Z0-9 _-]*\]/;

interface CapturedCtx {
  identityContext?: { catalog: ReadonlyMap<string, string>; mode: string };
  text?: string;
}

function setupScenario(initialText: string, opts?: {
  opencuesMd?: string;
  identityMd?: string | null;
}) {
  const opencuesMd = opts?.opencuesMd ?? `---\n---\n`; // absent key → safe (default)
  const files: Record<string, string> = {
    '/mock/CUES.md': TIPS,
    '/proj/.cues/CUES.md': CUES_MD,
    '/proj/.cues/OPENCUES.md': opencuesMd,
  };
  if (opts?.identityMd !== null) {
    files['/proj/.cues/IDENTITY.md'] = opts?.identityMd ?? IDENTITY_MD;
  }
  const adapter = new MockAdapter({ cwd: '/proj', files });
  adapter.pushText(initialText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, {
    reloadDebounceMs: 0,
    settingsFile: '/proj/.cues/OPENCUES.md',
  });
  const resolver = new Resolver(
    adapter, hlState, dynDefs, loader,
    { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} },
  );
  const captured: CapturedCtx[] = [];
  let scripted: unknown[] = [];
  let throwOnResolve = false;
  (resolver as unknown as { _resolver: { resolve(ctx: CapturedCtx): Promise<{ results: unknown[] }> } })._resolver = {
    resolve: async (ctx) => {
      captured.push(ctx);
      if (throwOnResolve) throw new Error('provider exploded');
      return { results: scripted };
    },
  };
  return {
    adapter, loader, resolver, captured, dynDefs,
    script: (r: unknown[]) => { scripted = r; },
    setThrow: (v: boolean) => { throwOnResolve = v; },
  };
}

describe('identity-dehydration scenarios — catalog plumbing', () => {
  it('IDENTITY.md on disk + default (absent) mode → resolver forwards the parsed catalog in safe mode', async () => {
    const { loader, resolver, captured } = setupScenario('ask Zorbath about the weather _');
    await loader.load();
    expect(loader.opencuesState.identityContextMode).toBe('safe');
    await resolver.resolveAndApply('ask Zorbath about the weather _');
    expect(captured.length).toBe(1);
    const idCtx = captured[0].identityContext;
    expect(idCtx).toBeDefined();
    expect(idCtx!.mode).toBe('safe');
    expect(idCtx!.catalog.get('[FIRST NAME]')).toBe('Zorbath');
    expect(idCtx!.catalog.get('[FULL NAME]')).toBe('Zorbath Quillfeather');
  });

  it('mode off → catalog never forwarded; raw → forwarded with mode=raw', async () => {
    const off = setupScenario('hello _', { opencuesMd: `---\nidentity-context-mode: off\n---\n` });
    await off.loader.load();
    await off.resolver.resolveAndApply('hello _');
    expect(off.captured[0].identityContext).toBeUndefined();

    const raw = setupScenario('hello _', { opencuesMd: `---\nidentity-context-mode: raw\n---\n` });
    await raw.loader.load();
    await raw.resolver.resolveAndApply('hello _');
    expect(raw.captured[0].identityContext?.mode).toBe('raw');
  });

  it('missing IDENTITY.md → empty catalog forwarded (structural no-op, no crash)', async () => {
    const { loader, resolver, captured } = setupScenario('hello _', { identityMd: null });
    await loader.load();
    await resolver.resolveAndApply('hello _');
    expect(captured[0].identityContext?.catalog.size).toBe(0);
  });

  it('SCENARIO: satellite cycle → resolve — mode survives the inline re-parse (drift pin)', async () => {
    // Journey: config has NO identity-context-mode key (default safe).
    // The user cycles an unrelated satellite (voice-mode). Pre-fix, the
    // applyOpenCuesScalar inline re-parse defaulted the mode to 'off',
    // silently disabling the outbound PII scrub for the rest of the
    // session. The next resolve must still carry the catalog.
    const { loader, resolver, captured } = setupScenario('ask Zorbath _');
    await loader.load();
    loader.applyOpenCuesScalar('voice-mode', 'inactive');
    await resolver.resolveAndApply('ask Zorbath _');
    expect(captured[0].identityContext?.mode).toBe('safe');
    expect(captured[0].identityContext?.catalog.get('[FIRST NAME]')).toBe('Zorbath');
  });
});

describe('identity-dehydration scenarios — buffer safety', () => {
  it('SCENARIO: type PII → resolve → hydrated substitution lands with values, zero token residue', async () => {
    // The source (already pinned PII-free outbound at the core layer)
    // returns a HYDRATED answer. The runtime splices it; the live
    // buffer must contain the real value and no [TOKEN] residue.
    const text = 'the full name on the booking is _';
    const { adapter, loader, resolver, script } = setupScenario(text);
    await loader.load();
    script([{
      wordIndex: 7,
      word: '_',
      alternatives: ['_', 'Zorbath Quillfeather'],
      source: 'fluid-blank',
      priority: 90,
      metadata: { blankName: 'fluid-blank' },
    }]);
    await resolver.resolveAndApply(text);
    const live = adapter.getText();
    expect(live).toContain('Zorbath Quillfeather');
    expect(live).not.toMatch(TOKEN_RESIDUE);
  });

  it('SCENARIO: LLM throws mid-resolve with dehydration active → buffer byte-identical', async () => {
    // No logical landmines: a hard provider failure with the scrub
    // active must never cascade into buffer damage.
    const text = 'Zorbath Quillfeather lives in Reykjavik _';
    const { adapter, loader, resolver, setThrow } = setupScenario(text);
    await loader.load();
    setThrow(true);
    await resolver.resolveAndApply(text);
    expect(adapter.getText()).toBe(text);
  });
});
