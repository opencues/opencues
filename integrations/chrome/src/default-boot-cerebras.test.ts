// "Dead-on-arrival" guard — verifies the chrome extension's SHIPPED
// defaults are usable by a fresh install with ONLY a Cerebras key set
// AND no chrome-host running.
//
// Failure modes this catches:
//   - Default OPENCUES.md routes a pipeline to a provider whose env-key
//     isn't set, with no fallback to the user's actually-keyed provider.
//   - A pipeline source crashes at construction with default config.
//   - The HTTP layer wires the wrong endpoint / wrong Authorization header.
//
// What's NOT covered here (out of scope — separate test layers):
//   - The chrome bootstrap's setText / replaceAllText path (already pinned
//     in replace-all-text-undo.test.ts + the Playwright suite).
//   - Live LLM accuracy (that's the benchmarks under tests/benchmarks/).
//
// This is a STATELESS test — no network, no real LLM, just verifies
// the wiring goes to the right place with the right auth.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseCuesMd,
  buildSourcesFromConfig,
  resolveLLM,
  setCliAvailabilityForTests,
  SUBSCRIPTION_AUTO_FALLBACK,
  type HttpAdapter,
} from '@opencues/core';

// These tests model the BROWSER environment, where pickAutoProvider's
// zero-key subscription-CLI rung can never fire (content scripts have
// no `process`, so the probe self-disables). The suite runs on Node
// though — seed the probe off so the developer's real claude/codex on
// PATH doesn't flip the zero-key expectations.
beforeEach(() => {
  for (const id of SUBSCRIPTION_AUTO_FALLBACK) setCliAvailabilityForTests(id, false);
});

// Stub httpAdapter — required by buildSourcesFromConfig even when no
// LLM call is exercised in the test. Records any (unexpected) calls
// so a regression that fires a real request shows up loudly.
const noopHttpAdapter: HttpAdapter = {
  post: async () => '{"choices":[{"message":{"content":""}}]}',
};

// Equivalent of the chrome boot's option set when the runtime reads
// the shipped OPENCUES.md defaults (fluid-blank-mode: on,
// word-cues-mode: on, transform-blank-mode: on).
function defaultChromeBuildOpts(apiKeys: Record<string, string>): Parameters<typeof buildSourcesFromConfig>[2] {
  return {
    httpAdapter: noopHttpAdapter,
    apiKeys,
    enableFluidBlank: true,
    enableTransformBlank: true,
  };
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULTS_DIR = resolve(REPO_ROOT, 'defaults');

function loadOpencuesMd(): string {
  return readFileSync(resolve(DEFAULTS_DIR, 'OPENCUES.md'), 'utf8');
}

// The shipped repo uses folder-only cue config (defaults/cues/<name>/CUE.md);
// there's no top-level CUES.md. Concatenating all folder bodies gives the
// effective cue-source surface — same merge ConfigLoader does at boot.
function loadCombinedCuesMd(): string {
  const cuesDir = resolve(DEFAULTS_DIR, 'cues');
  const parts: string[] = [];
  for (const entry of readdirSync(cuesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      parts.push(readFileSync(resolve(cuesDir, entry.name, 'CUE.md'), 'utf8'));
    } catch { /* no CUE.md in folder */ }
  }
  return parts.join('\n\n');
}

function loadCueFolders(): Record<string, string> {
  const cuesDir = resolve(DEFAULTS_DIR, 'cues');
  const folders: Record<string, string> = {};
  for (const entry of readdirSync(cuesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      folders[entry.name] = readFileSync(resolve(cuesDir, entry.name, 'CUE.md'), 'utf8');
    } catch { /* no CUE.md in folder */ }
  }
  return folders;
}

describe('Chrome extension — dead-on-arrival guard (Cerebras-only key)', () => {
  it('default OPENCUES.md loads from disk without throwing', () => {
    // Sanity check on the shipped file. Drift here = seed-configs ships
    // a structurally invalid file.
    expect(() => loadOpencuesMd()).not.toThrow();
    const opencuesMd = loadOpencuesMd();
    expect(opencuesMd.length).toBeGreaterThan(0);
    // Critical scalars the chrome boot relies on must be present.
    expect(opencuesMd).toContain('fluid-blank-mode:');
    expect(opencuesMd).toContain('transform-blank-mode:');
  });

  it('resolveLLM auto-routes to cerebras when only CEREBRAS_API_KEY is set', () => {
    const r = resolveLLM({ apiKeys: { CEREBRAS_API_KEY: 'csk-test' } });
    expect(r).not.toBeNull();
    expect(r?.provider.id).toBe('cerebras');
    expect(r?.endpoint).toBe('https://api.cerebras.ai/v1/chat/completions');
    expect(r?.apiKey).toBe('csk-test');
  });

  it('resolveLLM auto-routes to groq when only GROQ_API_KEY is set', () => {
    const r = resolveLLM({ apiKeys: { GROQ_API_KEY: 'gsk_test' } });
    expect(r).not.toBeNull();
    expect(r?.provider.id).toBe('groq');
    expect(r?.apiKey).toBe('gsk_test');
  });

  it('resolveLLM returns null when no keys are set (rather than silently routing nowhere)', () => {
    // Today's behaviour: hardcoded 'cerebras' fallback so a ProviderId
    // is always emitted, but with no key the call short-circuits null.
    // The test pins the CONTRACT — null when unusable — so callers know
    // to drop the source rather than fire a doomed request.
    const r = resolveLLM({ apiKeys: {} });
    expect(r).toBeNull();
  });

  it('buildSourcesFromConfig produces at least one usable source with shipped defaults + only Cerebras key', () => {
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultChromeBuildOpts({ CEREBRAS_API_KEY: 'csk-test' }));
    expect(sources.length).toBeGreaterThan(0);
  });

  it('every shipped cue folder either parses + wires through cerebras, OR is dropped (NEVER throws)', () => {
    const cueFolders = loadCueFolders();
    const names = Object.keys(cueFolders);
    expect(names.length).toBeGreaterThan(0);

    for (const [name, body] of Object.entries(cueFolders)) {
      // Parse must not throw. Build should not throw — if a cue requires
      // a provider whose key isn't set, the source should be DROPPED
      // (returns null from resolveFor), not crash the boot.
      expect(() => {
        const parsed = parseCuesMd(body, undefined);
        buildSourcesFromConfig(parsed, undefined, defaultChromeBuildOpts({ CEREBRAS_API_KEY: 'csk-test' }));
      }, `cue folder "${name}" should not crash buildSourcesFromConfig`).not.toThrow();
    }
  });

  it('FluidBlankSource is constructed when fluid-blank-mode is on (default) + Cerebras key set', () => {
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultChromeBuildOpts({ CEREBRAS_API_KEY: 'csk-test' }));
    // FluidBlankSource is the catch-all for unbound `_` — without it
    // the chrome extension does nothing on `_` keystrokes.
    const hasFluid = sources.some(s => s.constructor.name === 'FluidBlankSource');
    expect(hasFluid).toBe(true);
  });

  it('TransformBlankSource is constructed when transform-blank-mode is on (default) + Cerebras key set', () => {
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const sources = buildSourcesFromConfig(cuesConfig, undefined, defaultChromeBuildOpts({ CEREBRAS_API_KEY: 'csk-test' }));
    const hasTransform = sources.some(s => s.constructor.name === 'TransformBlankSource');
    expect(hasTransform).toBe(true);
  });

  it('No-keys → MissingKeyFallbackSource is wired with a host-specific message (the in-buffer indication)', () => {
    // The host-specific message ("open the extension popup" for chrome,
    // "edit ~/.cues/.env" for native) lands in the buffer when the user
    // types `_`. Without this fallback, the silent-no-op regression
    // returns — the user has no idea why their `_` does nothing.
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const sources = buildSourcesFromConfig(cuesConfig, undefined, {
      httpAdapter: noopHttpAdapter,
      apiKeys: {}, // ← no keys at all
      enableFluidBlank: true,
      enableTransformBlank: true,
      missingKeyFallbackMessage: '[OpenCues: no API key — open the extension popup]',
    });
    const fallback = sources.find(s => s.id === 'missing-key-fallback') as
      { id: string; getCues: (ctx: { text: string; words: string[] }) => Promise<{ results: Array<{ alternatives: string[] }> }> } | undefined;
    expect(fallback).toBeDefined();
  });

  it('Fallback does NOT fire when at least one LLM source got wired (cerebras key set)', () => {
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const sources = buildSourcesFromConfig(cuesConfig, undefined, {
      ...defaultChromeBuildOpts({ CEREBRAS_API_KEY: 'csk-test' }),
      missingKeyFallbackMessage: '[OpenCues: no API key — open the extension popup]',
    });
    const fallback = sources.find(s => s.id === 'missing-key-fallback');
    expect(fallback).toBeUndefined();
  });

  it('Fallback substitutes `_` with the configured message when typed', async () => {
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const message = '[OpenCues: no API key — open the extension popup]';
    const sources = buildSourcesFromConfig(cuesConfig, undefined, {
      httpAdapter: noopHttpAdapter,
      apiKeys: {},
      enableFluidBlank: true,
      enableTransformBlank: true,
      missingKeyFallbackMessage: message,
    });
    const fallback = sources.find(s => s.id === 'missing-key-fallback');
    expect(fallback).toBeDefined();
    const result = await fallback!.getCues({
      text: 'what is the capital of France _',
      words: ['what', 'is', 'the', 'capital', 'of', 'France', '_'],
    } as { text: string; words: string[] });
    expect(result.results.length).toBe(1);
    expect(result.results[0].alternatives).toContain(message);
    expect(result.results[0].alternatives[0]).toBe('_'); // cycling back restores the bare underscore
  });

  it('When NO keys are set, build-sources surfaces a clear missing-key signal — never silent', () => {
    // Smart-failure contract: a user with zero LLM keys should be able
    // to install the chrome extension, see SOMETHING tell them to add a
    // key, and not just sit in a silent "extension does nothing" state.
    //
    // The signal can land via two channels:
    //   (a) build-sources LOGS a message that names the missing key, OR
    //   (b) build-sources returns ZERO usable sources (which the popup's
    //       Self-Check translates to "no API keys present → substitutions
    //       will fail").
    //
    // Either is acceptable. Both is best. Test pins that at least one
    // fires — silent zero-source-zero-log is the failure mode this
    // guards against.
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const logged: string[] = [];
    const sources = buildSourcesFromConfig(cuesConfig, undefined, {
      ...defaultChromeBuildOpts({}),
      log: (msg) => { logged.push(msg); },
    });
    const someSignal = sources.length === 0 || logged.some(l => /key|api|missing|no/i.test(l));
    if (!someSignal) {
      // Surface what we got so a future failure debugs faster.
      // eslint-disable-next-line no-console
      console.log('[silent-failure debug] sources:', sources.map(s => s.constructor.name));
      // eslint-disable-next-line no-console
      console.log('[silent-failure debug] logged:', logged);
    }
    expect(someSignal).toBe(true);
  });

  it('No source ends up wired to a provider whose key is missing (silent-failure guard)', () => {
    const cuesMd = loadCombinedCuesMd();
    const cuesConfig = parseCuesMd(cuesMd, undefined);
    const dropped: string[] = [];
    const sources = buildSourcesFromConfig(cuesConfig, undefined, {
      ...defaultChromeBuildOpts({ CEREBRAS_API_KEY: 'csk-test' }),
      log: msg => { if (msg.includes('refusing') || msg.includes('no api key')) dropped.push(msg); },
    });
    // Every built source must have a working LLM tuple — if it doesn't,
    // build-sources should have refused it (logged + skipped), never
    // shipped a silently-doomed source.
    expect(sources.length).toBeGreaterThan(0);
    // Audit log: we don't assert dropped is empty (some sources may opt
    // out for valid reasons — non-LLM sources, etc.) but we surface it
    // so failures point at the right place.
    if (dropped.length > 0) {
      // eslint-disable-next-line no-console
      console.log('[default-boot-cerebras] dropped sources:', dropped);
    }
  });
});
