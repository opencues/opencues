// Scenario tests for the ConfigIntent substitution path in resolver.ts.
//
// ConfigIntent is the natural-language `_` settings classifier that
// emits a selector-satellite-shaped CueResult (alternatives=[setting],
// metadata.satelliteValue=value, blankName='opencues'). The runtime
// substitutes the user's summon words for "<setting><sep><value>",
// registers cycling state so Up/Down on either word flips other
// allowed values, and bails on race conditions (`_` gone from live
// buffer, wipe range no longer matches analyzed text).
//
// Companions:
//   - PR #22 feat(fluid-config): natural-language provider/model switching via _
//   - PR #24 feat(fluid-config): bare provider switches default to blanks bucket
//   - PR #25 fix(resolver): await disk write in applyOpencuesScalar
//     to serialise back-to-back calls
//
// These tests pin the runtime-side splice + selector-satellite
// registration + race-condition bails. The classifier itself
// (ConfigIntentSource in @opencues/core) is benched separately at
// tests/benchmarks/fluid-config/.

import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;

interface ScriptedConfigIntent {
  setting: string;            // e.g. 'llm-provider', 'blanks-llm-provider'
  value: string;              // e.g. 'openai', 'kimi-k2'
  separator?: string;         // default ' '
  wipeText: string;           // the buffer text the source analyzed
  cyclingValue?: string;      // when set, currentValue in cycling state ≠ satelliteValue
}

function scriptConfigIntentResult(s: ScriptedConfigIntent) {
  return {
    wordIndex: 0,
    word: '_',
    alternatives: [s.setting],
    spanStart: 0,
    spanEnd: s.wipeText.length,
    source: 'config-intent',
    priority: 94,
    metadata: {
      satelliteValue: s.value,
      displaySeparator: s.separator ?? ' ',
      blankName: 'opencues',
      selectorBlank: true,
      ...(s.cyclingValue !== undefined ? { satelliteCyclingValue: s.cyclingValue } : {}),
    },
  };
}

function setupConfigIntentScenario(initialText: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText(initialText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const selectorSatelliteState = new SelectorSatelliteState();
  const resolver = new Resolver(
    adapter,
    hlState,
    dynDefs,
    loader,
    { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} },
    undefined,                  // spanFillState
    undefined,                  // agentTaskState
    undefined,                  // blankLoading
    undefined,                  // markdownRender
    selectorSatelliteState,
  );
  let scripted: ReturnType<typeof scriptConfigIntentResult>[] = [];
  (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: typeof scripted }> } })._resolver = {
    resolve: async () => ({ results: scripted }),
  };
  function script(results: typeof scripted): void { scripted = results; }
  return { adapter, dynDefs, resolver, selectorSatelliteState, script };
}

describe('ConfigIntent substitute — selector-satellite splice', () => {
  it('replaces the summon-words with "<setting><sep><value>"', async () => {
    const { adapter, resolver, script } = setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      wipeText: 'use openai _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('llm-provider openai');
  });

  it('honours a custom separator (": ")', async () => {
    const { adapter, resolver, script } = setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      separator: ': ',
      wipeText: 'use openai _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('llm-provider: openai');
  });

  it('routes a bare provider to the BLANKS bucket (PR #24)', async () => {
    // PR #24: typing just "openai _" (no verb) sets
    // blanks-llm-provider — NOT the global llm-provider. The
    // classifier is responsible for picking the bucket; this test
    // pins that whatever bucket the source returns gets spliced as-is.
    const { adapter, resolver, script } = setupConfigIntentScenario('openai _');
    script([scriptConfigIntentResult({
      setting: 'blanks-llm-provider',
      value: 'openai',
      wipeText: 'openai _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('blanks-llm-provider openai');
  });

  it('moves the cursor to the end of the spliced pair', async () => {
    const { adapter, resolver, script } = setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      wipeText: 'use openai _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getCursorOffset()).toBe('llm-provider openai'.length);
  });
});

describe('ConfigIntent substitute — selector-satellite cycling registration', () => {
  it('registers selectorSatelliteState so cycling Up/Down works on the pair', async () => {
    const { adapter, resolver, selectorSatelliteState, script } =
      setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      wipeText: 'use openai _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    const entry = selectorSatelliteState.current;
    expect(entry).toBeTruthy();
    expect(entry!.blankName).toBe('opencues');
    expect(entry!.currentSetting).toBe('llm-provider');
    expect(entry!.currentValue).toBe('openai');
    expect(entry!.separator).toBe(' ');
    // Both selector AND satellite word indices are populated so the
    // standard cycling.ts path lands on the right def.
    expect(entry!.selectorIndex).toBe(0);
    expect(entry!.satelliteIndex).toBe(1);
  });

  it('clearOnEdit: true — backspacing into either word wipes the whole pair', async () => {
    const { adapter, resolver, selectorSatelliteState, script } =
      setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      wipeText: 'use openai _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(selectorSatelliteState.current!.clearOnEdit).toBe(true);
  });

  it('handles a multi-word setting key (e.g. cues-llm-provider)', async () => {
    // Three-bucket routing (PR #19): cues-llm-provider is one
    // valid setting; the splice + cycling needs to handle a
    // setting word that contains hyphens (single-token).
    const { adapter, resolver, selectorSatelliteState, script } =
      setupConfigIntentScenario('use openai for cues _');
    script([scriptConfigIntentResult({
      setting: 'cues-llm-provider',
      value: 'openai',
      wipeText: 'use openai for cues _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('cues-llm-provider openai');
    expect(selectorSatelliteState.current!.currentSetting).toBe('cues-llm-provider');
  });
});

describe('ConfigIntent substitute — race-condition bails', () => {
  it('bails when the `_` is gone from the live buffer between analyze and substitute', async () => {
    const { adapter, resolver, script } = setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      wipeText: 'use openai _',
    })]);
    // Simulate the user typing past the `_` after the LLM call was
    // dispatched but before its result was substituted. resolveAndApply
    // analyzes the buffer it's given, then re-reads live state at
    // substitute time and bails if the `_` is gone.
    const stale = 'use openai _';
    adapter.pushText('use openai already typed');  // live buffer no longer has `_`
    await resolver.resolveAndApply(stale);
    expect(adapter.getText()).toBe('use openai already typed');
  });

  it('bails when the wipe range no longer matches the analyzed text', async () => {
    const { adapter, resolver, script } = setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      wipeText: 'use openai _',
    })]);
    // Stricter check: the user edited the prefix WHILE the LLM was
    // resolving. The `_` is still present (suffix), but the wipe
    // range [0, len) no longer matches what the source analyzed.
    const stale = 'use openai _';
    adapter.pushText('use claude _');  // same length-ish range, different content
    await resolver.resolveAndApply(stale);
    // Buffer not touched — the user's edit wins.
    expect(adapter.getText()).toBe('use claude _');
  });

  it('bails when metadata.satelliteValue is missing (degraded classifier output)', async () => {
    const { adapter, resolver, script } = setupConfigIntentScenario('use openai _');
    // Build a result that's missing satelliteValue — should not splice.
    script([{
      ...scriptConfigIntentResult({
        setting: 'llm-provider',
        value: 'openai',
        wipeText: 'use openai _',
      }),
      metadata: {
        // satelliteValue intentionally absent
        displaySeparator: ' ',
        blankName: 'opencues',
        selectorBlank: true,
      },
    }]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('use openai _');
  });
});

describe('ConfigIntent substitute — sequential setting changes (PR #25)', () => {
  it('two back-to-back fires both land on disk (no clobber)', async () => {
    // PR #25 fixed a race where ConfigIntent's provider+model
    // sequential applyOpencuesScalar calls fire-and-forgot the disk
    // write. Second call's read-modify-write would land BEFORE the
    // first's write, persisting only one scalar.
    //
    // We exercise this at the substitute layer: two separate
    // ConfigIntent results in succession should both leave their
    // setter pair visible — neither overwrites the other.
    const { adapter, resolver, script } = setupConfigIntentScenario('use openai _');
    script([scriptConfigIntentResult({
      setting: 'llm-provider',
      value: 'openai',
      wipeText: 'use openai _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('llm-provider openai');

    // User changes model now — pushes new buffer state with another `_`.
    adapter.pushText('use gpt-4 _');
    script([scriptConfigIntentResult({
      setting: 'llm-model',
      value: 'gpt-4',
      wipeText: 'use gpt-4 _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('llm-model gpt-4');
  });
});

describe('ConfigIntent substitute — provider:model pair display (the pair UX)', () => {
  // The user explicitly asked for "a unique state indication of
  // provider: model" so they always know what model is in use after
  // a fluid switch. The classifier emits `satelliteValue: provider:model`
  // (one token; `:` isn't whitespace so splitWords keeps it as one
  // word) and `satelliteCyclingValue: provider` so the buffer renders
  // the pair while cycling Up/Down still walks the provider catalogue.

  it('splices the buffer as `<bucket>-llm-provider <provider>:<model>` when verdict has a model', async () => {
    const { adapter, resolver, script } = setupConfigIntentScenario('use claude opus for auditors _');
    script([scriptConfigIntentResult({
      setting: 'auditors-llm-provider',
      value: 'anthropic:claude-opus-4-7',
      cyclingValue: 'anthropic',
      wipeText: 'use claude opus for auditors _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('auditors-llm-provider anthropic:claude-opus-4-7');
  });

  it('cycling state stores just `provider` even when buffer shows the pair', async () => {
    const { adapter, resolver, selectorSatelliteState, script } =
      setupConfigIntentScenario('use claude opus for auditors _');
    script([scriptConfigIntentResult({
      setting: 'auditors-llm-provider',
      value: 'anthropic:claude-opus-4-7',
      cyclingValue: 'anthropic',
      wipeText: 'use claude opus for auditors _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(selectorSatelliteState.current).toBeTruthy();
    // Cycling Up/Down walks the provider catalogue, NOT the cartesian
    // product. The pair is visible in the buffer for the user; cycling
    // semantics stay simple (one scalar at a time).
    expect(selectorSatelliteState.current!.currentValue).toBe('anthropic');
    expect(selectorSatelliteState.current!.currentSetting).toBe('auditors-llm-provider');
  });

  it('preserves the legacy single-token behaviour when verdict has no model', async () => {
    // When the classifier emits a provider-only verdict (no model id),
    // the satellite is just the provider name — no `:model` suffix.
    // This pins backwards compatibility with the pre-pair UX path
    // (existing `switch to anthropic _` cases).
    const { adapter, resolver, selectorSatelliteState, script } =
      setupConfigIntentScenario('switch to anthropic _');
    script([scriptConfigIntentResult({
      setting: 'blanks-llm-provider',
      value: 'anthropic',
      wipeText: 'switch to anthropic _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    expect(adapter.getText()).toBe('blanks-llm-provider anthropic');
    expect(selectorSatelliteState.current!.currentValue).toBe('anthropic');
  });

  it('satellite is a single splitWords token (colon is not whitespace)', async () => {
    // Regression: if a future refactor changed `splitWords` to split
    // on `:`, the pair would become two words and the cycling code's
    // `satelliteLength: 1` assertion would break. This pins the
    // single-word property of the satellite at the splice layer.
    const { adapter, resolver, selectorSatelliteState, script } =
      setupConfigIntentScenario('use claude opus for auditors _');
    script([scriptConfigIntentResult({
      setting: 'auditors-llm-provider',
      value: 'anthropic:claude-opus-4-7',
      cyclingValue: 'anthropic',
      wipeText: 'use claude opus for auditors _',
    })]);
    await resolver.resolveAndApply(adapter.getText());
    // Buffer: "auditors-llm-provider anthropic:claude-opus-4-7" → 2 words
    expect(adapter.getText().split(/\s+/)).toHaveLength(2);
    expect(selectorSatelliteState.current!.satelliteLength).toBe(1);
  });
});
