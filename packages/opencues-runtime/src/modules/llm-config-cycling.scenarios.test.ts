/**
 * Scenario tests for the granular LLM (provider, model) cycling surface.
 *
 * The fluid-config classifier (`use claude opus for auditors _`) writes
 * BOTH `auditors-llm-provider` and `auditors-llm-model` atomically.
 * Before this PR landed, the buffer surfaced only the provider — the
 * model was set silently. Worse, cycling the provider satellite Up/Down
 * left the model scalar pinned, shipping invalid (provider, model)
 * pairs as soon as the user advanced past the original provider.
 *
 * This file pins the structural fixes:
 *
 *   1. PAIR DISPLAY — the buffer shows `<bucket>-llm-provider provider:model`
 *      whenever the verdict named a model, so the user always knows
 *      what's in use.

 *   2. PROVIDER-CYCLE RESETS MODEL — cycling Ctrl+Alt+Up on the
 *      provider satellite ALSO writes the NEW provider's defaultModel
 *      to the sibling model scalar via applyOpenCuesScalar, so the
 *      (provider, model) pair stays valid by construction. (Up to PR
 *      #149 this wrote the literal `default` sentinel; we now write
 *      the resolved name so OPENCUES.md is self-explanatory and
 *      doctor's "inert sentinel" warning doesn't fire.)
 *   3. MODEL MENU IS PROVIDER-AWARE — the `*-llm-model` features
 *      registered with valuesProvider show only the current provider's
 *      knownModels. Cycling provider reshapes the model menu.
 *
 * Companion: docs/architecture/llm-routing.md.
 */

import { describe, expect, it } from 'vitest';
import { getProvider } from '@opencues/core';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({ concepts: [] });

async function setupBucketCycle(initialText: string, currentSetting: string, currentValue: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': '---\nname: t\n---\n' },
  });
  adapter.pushText(initialText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  await loader.load();
  const ss = new SelectorSatelliteState();
  // Wire selector + satellite at word-index 0 (selector) and 1 (satellite).
  ss.set({
    blankName: 'opencues',
    scriptPath: '',
    selectorIndex: 0,
    selectorLength: 1,
    satelliteIndex: 1,
    satelliteLength: 1,
    currentSetting,
    currentValue,
    separator: ' ',
    clearOnEdit: false,
  }, initialText);
  const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
  cycling.subscribe();
  return { adapter, hlState, dynDefs, loader, ss, cycling };
}

describe('LLM config cycling — provider cycle resets sibling model', () => {
  it('cycling auditors-llm-provider also writes auditors-llm-model: default in memory', async () => {
    // Seed: the file declares both provider AND a specific model. The
    // user then cycles the provider satellite — this is the structural
    // bug the new code prevents (old behaviour: model stays pinned;
    // resolver later dispatches an invalid pair).
    const { adapter, hlState, loader } = await setupBucketCycle(
      'auditors-llm-provider anthropic',
      'auditors-llm-provider',
      'anthropic',
    );
    // Pre-seed the model scalar in memory (as if the user had earlier
    // run `use claude opus for auditors _`).
    loader.applyOpenCuesScalar('auditors-llm-model', 'claude-opus-4-7');
    expect(loader.opencuesState.settings.get('auditors-llm-model')).toBe('claude-opus-4-7');

    hlState.activate(1, 'auditors-llm-provider anthropic');
    adapter.fireKey('up', { ctrl: true, alt: true });

    // Provider walked to the next value in the registry. Model reset to
    // the new provider's defaultModel — explicit, not the legacy
    // `'default'` sentinel.
    const newProvider = loader.opencuesState.settings.get('auditors-llm-provider')!;
    const newModel = loader.opencuesState.settings.get('auditors-llm-model');
    const expectedModel = getProvider(newProvider)?.defaultModel ?? 'default';
    expect(newModel, 'sibling model scalar must reset to new provider\'s defaultModel').toBe(expectedModel);
    expect(newModel, 'must NOT be the stale prior model').not.toBe('claude-opus-4-7');
  });

  it('cycling blanks-llm-provider also resets blanks-llm-model to the new provider\'s default', async () => {
    const { adapter, hlState, loader } = await setupBucketCycle(
      'blanks-llm-provider cerebras',
      'blanks-llm-provider',
      'cerebras',
    );
    loader.applyOpenCuesScalar('blanks-llm-model', 'gpt-oss-120b');
    hlState.activate(1, 'blanks-llm-provider cerebras');
    adapter.fireKey('up', { ctrl: true, alt: true });
    const newProvider = loader.opencuesState.settings.get('blanks-llm-provider')!;
    expect(loader.opencuesState.settings.get('blanks-llm-model'))
      .toBe(getProvider(newProvider)?.defaultModel ?? 'default');
  });

  it('cycling cues-llm-provider also resets cues-llm-model to the new provider\'s default', async () => {
    const { adapter, hlState, loader } = await setupBucketCycle(
      'cues-llm-provider openai',
      'cues-llm-provider',
      'openai',
    );
    loader.applyOpenCuesScalar('cues-llm-model', 'gpt-5.4');
    hlState.activate(1, 'cues-llm-provider openai');
    adapter.fireKey('up', { ctrl: true, alt: true });
    const newProvider = loader.opencuesState.settings.get('cues-llm-provider')!;
    expect(loader.opencuesState.settings.get('cues-llm-model'))
      .toBe(getProvider(newProvider)?.defaultModel ?? 'default');
  });

  it('cycling a non-provider scalar (voice-mode) does NOT clear any model scalar', async () => {
    // Regression guard: the reset is scoped to `<bucket>-llm-provider`
    // setting names only. Other cyclable settings must not touch the
    // model scalars.
    const { adapter, hlState, loader } = await setupBucketCycle(
      'voice-mode active',
      'voice-mode',
      'active',
    );
    loader.applyOpenCuesScalar('auditors-llm-model', 'claude-opus-4-7');
    loader.applyOpenCuesScalar('cues-llm-model', 'gpt-5.4');
    hlState.activate(1, 'voice-mode active');
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Model scalars unchanged — voice-mode cycle is unrelated.
    expect(loader.opencuesState.settings.get('auditors-llm-model')).toBe('claude-opus-4-7');
    expect(loader.opencuesState.settings.get('cues-llm-model')).toBe('gpt-5.4');
  });

  it('cycling global llm-provider (NOT a bucket provider) does NOT clear any sibling', async () => {
    // The global `llm-provider:` is a power-user knob with a sibling
    // `llm-model:`. We deliberately don't auto-reset on cycle because
    // it's not a bucket scalar — the cycling reset is scoped to the
    // three bucket pairs only. This pins that decision.
    const { adapter, hlState, loader } = await setupBucketCycle(
      'llm-provider cerebras',
      'llm-provider',
      'cerebras',
    );
    loader.applyOpenCuesScalar('llm-model', 'some-explicit-pin');
    hlState.activate(1, 'llm-provider cerebras');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(loader.opencuesState.settings.get('llm-model')).toBe('some-explicit-pin');
  });
});

describe('LLM config cycling — model menu is provider-aware', () => {
  it('after cycling auditors-llm-provider, the model menu reflects the NEW provider', async () => {
    // The most important invariant: the model menu the user advances
    // to (via Ctrl+Alt+Right) shows the CURRENT provider's models, not
    // the previous one. Without overlayDynamicDefinitions in
    // applyOpenCuesScalar, this would lag by 2.5s (the reload
    // suppression window) and could show invalid candidates.
    const { adapter, hlState, loader } = await setupBucketCycle(
      'auditors-llm-provider cerebras',
      'auditors-llm-provider',
      'cerebras',
    );

    hlState.activate(1, 'auditors-llm-provider cerebras');
    adapter.fireKey('up', { ctrl: true, alt: true });

    // After the cycle, query the current model menu via definitions.
    const newProvider = loader.opencuesState.settings.get('auditors-llm-provider');
    expect(newProvider, 'provider should have advanced from cerebras').not.toBe('cerebras');

    const modelDef = loader.opencuesState.definitions.get('auditors-llm-model');
    expect(modelDef, 'auditors-llm-model must be in definitions').toBeDefined();
    expect(modelDef!.valueOrder[0], 'default is always first').toBe('default');
    // The menu has more than just default — the new provider has
    // knownModels enumerated.
    expect(modelDef!.valueOrder.length, 'model menu must reflect new provider\'s knownModels').toBeGreaterThan(1);
  });

  it('starting from a pinned provider, model menu lists exactly that provider\'s known models', async () => {
    const { loader } = await setupBucketCycle(
      'blanks-llm-provider anthropic',
      'blanks-llm-provider',
      'anthropic',
    );
    loader.applyOpenCuesScalar('blanks-llm-provider', 'anthropic');

    const modelDef = loader.opencuesState.definitions.get('blanks-llm-model');
    expect(modelDef).toBeDefined();
    const ids = modelDef!.valueOrder;
    // Expect default + claude-* models.
    expect(ids[0]).toBe('default');
    expect(ids.some(id => id.includes('claude')), `expected claude-* in menu, got ${ids.join(',')}`).toBe(true);
    expect(ids.some(id => id.includes('gpt')), `should NOT contain gpt-* models`).toBe(false);
  });
});

describe('LLM config cycling — invariant: no invalid (provider, model) pair lands after any cycle', () => {
  // The strongest test: walk every scenario the user can produce
  // through cycling. After every step, assert OPENCUES.md state is
  // consistent — either model is `default` OR model is in the current
  // provider's knownModels.
  for (const bucket of ['cues', 'auditors', 'blanks'] as const) {
    it(`${bucket}-llm-provider full cycle pass keeps model invariant`, async () => {
      const { adapter, hlState, loader } = await setupBucketCycle(
        `${bucket}-llm-provider anthropic`,
        `${bucket}-llm-provider`,
        'anthropic',
      );
      loader.applyOpenCuesScalar(`${bucket}-llm-provider`, 'anthropic');
      // Pre-seed with a model valid for anthropic only.
      loader.applyOpenCuesScalar(`${bucket}-llm-model`, 'claude-opus-4-7');

      // Cycle 5 times — enough to walk past every cyclable provider.
      for (let i = 0; i < 5; i++) {
        hlState.activate(1, adapter.getText());
        adapter.fireKey('up', { ctrl: true, alt: true });

        const provider = loader.opencuesState.settings.get(`${bucket}-llm-provider`)!;
        const model = loader.opencuesState.settings.get(`${bucket}-llm-model`);

        // After ANY cycle, model must be the new provider's defaultModel
        // (since the cycle unconditionally resets it to a valid value).
        // When the cycled-to value is the `inherit` meta-provider (no
        // adapter), the runtime falls back to the legacy `default`
        // sentinel — both have the same "fall through to global"
        // semantics. This is the strongest invariant: there's no path
        // where an invalid pair can persist.
        const expectedDefault = getProvider(provider)?.defaultModel ?? 'default';
        expect(model, `after cycle ${i + 1}, ${bucket}-llm-model must be ${provider}'s defaultModel (${expectedDefault})`)
          .toBe(expectedDefault);
      }
    });
  }
});
