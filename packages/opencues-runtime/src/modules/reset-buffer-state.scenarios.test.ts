/**
 * Scenario tests for `resetSharedBufferState()` (the wipe-on-external-
 * mutation handler exposed as `BootResult.resetBufferState()` on every
 * band).
 *
 * The handler exists because the runtime's span / DynDef / highlight
 * state objects are anchored to character offsets in the live buffer.
 * Anything that mutates the buffer outside the runtime's `setText`
 * pipeline — host-level undo / redo, paste, IME commit, native
 * autocomplete, multi-buffer focus switch — leaves those offsets
 * pointing at characters that no longer mean what they did. Cycling,
 * dim-render, navigation then operate on stale anchors.
 *
 * These tests pin the wipe set (what gets cleared, what survives) AND
 * the multi-step user journeys that triggered the original bug class:
 *
 *   1. The "cycle → external-replace → cycle" sequence — does the
 *      runtime stop trying to splice against stale DynDefs?
 *   2. The "blank fill in flight → reset" path — does the in-flight
 *      span-fill stash get cleared so it can't splice into the new
 *      buffer?
 *   3. The "selector-satellite mid-cycle → reset" path — does the
 *      two-headed pair clear without leaving a half-broken state?
 *   4. The "armed agent task survives" invariant — does undo NOT
 *      destroy the user's `agentically X _` task?
 *
 * Unit tests on `dynDefs.clear()` etc. would pass without the contract
 * holding at the journey level. These scenarios cross modules + state
 * + time, matching the CLAUDE.md "write the scenario that triggered
 * the bug" rule.
 *
 * Companion to:
 *   - `src/boot-common.ts` (resetSharedBufferState implementation)
 *   - `adapters/<band>/<v>/boot.ts` (per-band BootResult.resetBufferState)
 *   - `adapters/chrome/v1/boot.test.ts` (chrome-level integration test)
 */

import { describe, expect, it } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { Navigation } from './navigation';
import { resetSharedBufferState } from '../boot-common';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { SelectorSatelliteState, type SelectorSatelliteEntry } from '../state/selector-satellite';
import { AgentTaskState } from '../state/agent-task';
import { DismissedBlanks } from '../state/dismissed-blanks';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';

const TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'words',
      words: {
        attorney: { tip: '', alts: ['lawyer', 'legal eagle', 'defendant counsel'] },
        fast: { tip: '', alts: ['quick', 'rapid', 'swift'] },
        big: { tip: '', alts: ['large', 'huge'] },
        word: { tip: '', alts: ['term'] },
      },
    },
  ],
});

interface Harness {
  adapter: MockAdapter;
  hlState: HighlightState;
  dynDefs: DynDefs;
  spanFillState: SpanFillState;
  selectorSatelliteState: SelectorSatelliteState;
  agentTaskState: AgentTaskState;
  dismissedBlanks: DismissedBlanks;
  loader: ConfigLoader;
  cycling: Cycling;
  nav: Navigation;
}

async function setup(initialText: string): Promise<Harness> {
  const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
  adapter.pushText(initialText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const spanFillState = new SpanFillState();
  const selectorSatelliteState = new SelectorSatelliteState();
  const agentTaskState = new AgentTaskState();
  const dismissedBlanks = new DismissedBlanks();
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const cycling = new Cycling(
    adapter, hlState, dynDefs, loader,
    spanFillState, dismissedBlanks, selectorSatelliteState,
  );
  cycling.subscribe();
  const nav = new Navigation(adapter, hlState, dynDefs, loader, spanFillState, selectorSatelliteState);
  nav.subscribe();
  return {
    adapter, hlState, dynDefs, spanFillState, selectorSatelliteState,
    agentTaskState, dismissedBlanks, loader, cycling, nav,
  };
}

function makeSatelliteEntry(): SelectorSatelliteEntry {
  return {
    blankName: 'opencues',
    scriptPath: '/mock/opencues-blank.sh',
    selectorIndex: 1,
    selectorLength: 1,
    satelliteIndex: 2,
    satelliteLength: 1,
    currentSetting: 'voice-mode',
    currentValue: 'active',
    separator: ' ',
    clearOnEdit: false,
    pairCharStart: 9,
    pairCharEnd: 26,
  };
}

// ===========================================================================
// A. Wipe set — what resetSharedBufferState clears
// ===========================================================================

describe('resetSharedBufferState — wipe set', () => {
  it('clears every DynDef populated by prior cycles', async () => {
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.size).toBeGreaterThan(0);

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(dynDefs.size).toBe(0);
    expect(dynDefs.get(1)).toBeUndefined();
  });

  it('deactivates the active highlight', async () => {
    const { hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    expect(hlState.active).toBe(true);
    expect(hlState.wordIndex).toBe(1);

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(hlState.active).toBe(false);
    expect(hlState.wordIndex).toBeNull();
  });

  it('clears an in-flight SpanFillState entry', async () => {
    const { hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('improve this _');
    spanFillState.set(
      { index: 0, alternatives: ['improve this <better>'], currentAltIndex: 0, spanLength: 3 },
      'improve this <better>',
    );
    expect(spanFillState.current).not.toBeNull();
    expect(spanFillState.lastFilledText).toBe('improve this <better>');

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(spanFillState.current).toBeNull();
    expect(spanFillState.lastFilledText).toBe('');
  });

  it('clears an active SelectorSatelliteState pair', async () => {
    const { hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('opencues voice-mode active');
    selectorSatelliteState.set(makeSatelliteEntry(), 'opencues voice-mode active');
    expect(selectorSatelliteState.current).not.toBeNull();

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(selectorSatelliteState.current).toBeNull();
    expect(selectorSatelliteState.lastFilledText).toBe('');
  });

  it('wipes all four state objects in a single call when every one is populated', async () => {
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed quickly');
    // Populate everything in one go.
    hlState.activate(1, 'the attorney filed quickly');
    adapter.fireKey('up', { ctrl: true, alt: true });
    spanFillState.set(
      { index: 3, alternatives: ['<placeholder>'], currentAltIndex: 0, spanLength: 1 },
      'irrelevant',
    );
    selectorSatelliteState.set(makeSatelliteEntry(), 'irrelevant');

    expect(dynDefs.size).toBeGreaterThan(0);
    expect(hlState.active).toBe(true);
    expect(spanFillState.current).not.toBeNull();
    expect(selectorSatelliteState.current).not.toBeNull();

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(dynDefs.size).toBe(0);
    expect(hlState.active).toBe(false);
    expect(spanFillState.current).toBeNull();
    expect(selectorSatelliteState.current).toBeNull();
  });
});

// ===========================================================================
// B. Survival set — what resetSharedBufferState deliberately preserves
// ===========================================================================
//
// The deliberate non-wipes encode product decisions:
//   - agentTaskState: armed `agentically X _` survives undo / focus / paste
//     so users can leave a draft, switch tabs, return without re-arming.
//   - dismissedBlanks: dismissing `weather _` once stays dismissed; undo
//     shouldn't resurrect a suggestion the user already declined.
//
// These tests fail loudly if a future refactor extends the wipe set.

describe('resetSharedBufferState — survival set (deliberate non-wipes)', () => {
  it('does NOT touch an armed AgentTaskState', async () => {
    const { hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState } =
      await setup('the doc');
    agentTaskState.arm('shorten every sentence');
    const taskIdBefore = agentTaskState.taskId;
    const promptBefore = agentTaskState.prompt;
    expect(agentTaskState.armed).toBe(true);

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(agentTaskState.armed).toBe(true);
    expect(agentTaskState.taskId).toBe(taskIdBefore);
    expect(agentTaskState.prompt).toBe(promptBefore);
  });

  it('does NOT touch DismissedBlanks entries', async () => {
    const { hlState, dynDefs, spanFillState, selectorSatelliteState, dismissedBlanks } =
      await setup('weather today');
    dismissedBlanks.add(0);
    dismissedBlanks.add(2);
    expect(dismissedBlanks.has(0)).toBe(true);
    expect(dismissedBlanks.has(2)).toBe(true);

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(dismissedBlanks.has(0)).toBe(true);
    expect(dismissedBlanks.has(2)).toBe(true);
  });

  it('does NOT touch ConfigLoader (loaded settings + cue sources stay loaded)', async () => {
    const { hlState, dynDefs, spanFillState, selectorSatelliteState, loader } =
      await setup('the attorney filed');
    expect(loader.loaded).toBe(true);
    const cueMapSizeBefore = loader.cueMap.size;
    const opencuesStateBefore = loader.opencuesState;
    expect(cueMapSizeBefore).toBeGreaterThan(0);

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBe(cueMapSizeBefore);
    expect(loader.opencuesState).toBe(opencuesStateBefore);
  });
});

// ===========================================================================
// C. Multi-step user journeys — the bugs this exists to prevent
// ===========================================================================
//
// CLAUDE.md "Write the scenario that triggered the bug" rule. Each test
// here mirrors a user sequence that produced (or would produce) a
// stale-offset / phantom-highlight / blocked-substitution bug before
// the wipe was wired up.

describe('reset-buffer-state scenarios — multi-step journeys', () => {
  it('cycle → cycle → external buffer replace → reset → next activate works on the new buffer', async () => {
    // The canonical undo scenario: user cycles a word twice, browser undo
    // restores text that doesn't match the runtime's DynDef anchors.
    // Reset clears the stale state; a fresh activate on the post-undo
    // buffer cycles correctly without bleed-through.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle filed');
    expect(dynDefs.size).toBeGreaterThan(0);

    // External mutation — host writes the new buffer directly (paste /
    // undo / IME). The runtime's spans now anchor to characters that no
    // longer exist at those offsets.
    adapter.pushText('big fast word');
    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    // Fresh activate on the new buffer — every cycle must operate on
    // the post-mutation text, not leftover anchors from "the legal eagle filed".
    expect(dynDefs.size).toBe(0);
    hlState.activate(1, 'big fast word');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('big quick word');
  });

  it('multi-word cycle (span expansion) → reset → no stale span offsets remain', async () => {
    // Multi-word alts expand the span, which is exactly when stale-offset
    // bugs surface most badly — the post-cycle DynDefs hold spanEnd > the
    // original word's end, and any subsequent operation against the
    // post-undo buffer would splice on a non-existent range.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true }); // attorney → lawyer (1 word)
    adapter.fireKey('up', { ctrl: true, alt: true }); // lawyer → legal eagle (2 words)
    const def = dynDefs.get(1);
    expect(def).toBeDefined();
    expect(def!.spanEnd - def!.spanStart).toBeGreaterThan('attorney'.length);

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(dynDefs.get(1)).toBeUndefined();
    expect([...dynDefs.entries()].length).toBe(0);
  });

  it('reset then second-buffer cycle does NOT echo into prior buffer state', async () => {
    // The May 2026 fluid-blank-cross-buffer bug at the journey level:
    // a buffer-bound DynDef from a prior buffer would block / mislocate
    // the next buffer's activation. After reset, the second buffer's
    // wordIndex 1 must be a fresh fast-quick cycle, not a confused
    // attorney-anchored splice.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.get(1)?.originalWord).toBe('attorney');

    // External replace + reset (simulate undo / focus switch).
    adapter.pushText('a fast car');
    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    hlState.activate(1, 'a fast car');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('a quick car');
    expect(dynDefs.get(1)?.originalWord).toBe('fast');
  });

  it('blank fill in flight → reset → in-flight state cannot splice into new buffer', async () => {
    // A span-fill stash from a fluid blank in flight would, without
    // reset, fire its substitute into whatever the new buffer says at
    // the same character range. After reset the stash is gone; any
    // subsequent text change is treated as fresh user input.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('answer _ please');
    spanFillState.set(
      { index: 1, alternatives: ['answer 42 please'], currentAltIndex: 0, spanLength: 1 },
      'answer 42 please',
    );
    expect(spanFillState.current).not.toBeNull();
    expect(spanFillState.lastFilledText).toBe('answer 42 please');

    // External replace + reset.
    adapter.pushText('totally different content');
    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(spanFillState.current).toBeNull();
    expect(spanFillState.lastFilledText).toBe('');
  });

  it('selector-satellite mid-cycle → reset → pair clears without half-broken state', async () => {
    // Mid-cycle on `opencues voice-mode active`: a half-cleared pair
    // (e.g. selector cleared but satellite retained) would leave the
    // satellite cycling against a setting that no longer exists in the
    // buffer. Reset must clear both heads atomically.
    const { hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('opencues voice-mode active');
    selectorSatelliteState.set(makeSatelliteEntry(), 'opencues voice-mode active');
    expect(selectorSatelliteState.current?.currentSetting).toBe('voice-mode');
    expect(selectorSatelliteState.current?.currentValue).toBe('active');

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(selectorSatelliteState.current).toBeNull();
    expect(selectorSatelliteState.lastFilledText).toBe('');
  });

  it('armed agent task + cycle state → reset → task survives, cycle state gone', async () => {
    // Composite invariant: even when the user has both an armed agent
    // task AND active cycle state, the reset preserves only the task.
    // Pins both halves at once so a regression splitting the wipe set
    // would still trip.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState, agentTaskState } =
      await setup('the attorney filed');
    agentTaskState.arm('be more concise');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dynDefs.size).toBeGreaterThan(0);
    expect(agentTaskState.armed).toBe(true);

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(dynDefs.size).toBe(0);
    expect(hlState.active).toBe(false);
    expect(agentTaskState.armed).toBe(true);
    expect(agentTaskState.prompt).toBe('be more concise');
  });

  it('reset between two cycle batches — first batch does not leak into second', async () => {
    // Without reset, the first buffer's DynDefs would survive into the
    // second buffer's cycle attempt and the runtime would try to splice
    // the wrong alts at the wrong offsets. After reset, each batch sees
    // a clean slate.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    const firstBatchCalls = adapter.setTextCalls.length;

    adapter.pushText('the big word');
    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });
    hlState.activate(1, 'the big word');
    adapter.fireKey('up', { ctrl: true, alt: true });
    const lastCall = adapter.setTextCalls.at(-1);

    expect(adapter.setTextCalls.length).toBeGreaterThan(firstBatchCalls);
    expect(lastCall).toBe('the large word');
    expect(lastCall).not.toContain('attorney');
    expect(lastCall).not.toContain('lawyer');
    expect(lastCall).not.toContain('legal eagle');
  });
});

// ===========================================================================
// D. Edge cases — cold state, idempotency, ordering
// ===========================================================================

describe('resetSharedBufferState — edge cases', () => {
  it('does not throw when called on a completely cold state', () => {
    const dynDefs = new DynDefs();
    const hlState = new HighlightState();
    const spanFillState = new SpanFillState();
    const selectorSatelliteState = new SelectorSatelliteState();

    expect(() => {
      resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });
    }).not.toThrow();

    expect(dynDefs.size).toBe(0);
    expect(hlState.active).toBe(false);
    expect(spanFillState.current).toBeNull();
    expect(selectorSatelliteState.current).toBeNull();
  });

  it('is idempotent — three consecutive calls leave identical state', async () => {
    // Focus-change spam / input-event bursts during paste or IME
    // composition can trigger the reset many times in a row. Must be
    // a true no-op after the first call.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });
    const afterFirst = {
      dynDefSize: dynDefs.size,
      hlActive: hlState.active,
      spanFillCurrent: spanFillState.current,
      satelliteCurrent: selectorSatelliteState.current,
    };
    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });
    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(dynDefs.size).toBe(afterFirst.dynDefSize);
    expect(hlState.active).toBe(afterFirst.hlActive);
    expect(spanFillState.current).toBe(afterFirst.spanFillCurrent);
    expect(selectorSatelliteState.current).toBe(afterFirst.satelliteCurrent);
  });

  it('reset does not fire side-effect mutations on the host (no setText call)', async () => {
    // The wipe is in-memory state only — it must not write to the host
    // buffer. Hosts that emit the reset signal (chrome's undo handler,
    // focus-change handler) already let the host's own write land
    // first; we'd double-render if reset also called setText.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');
    hlState.activate(1, 'the attorney filed');
    adapter.fireKey('up', { ctrl: true, alt: true });
    const setTextCountBeforeReset = adapter.setTextCalls.length;

    resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });

    expect(adapter.setTextCalls.length).toBe(setTextCountBeforeReset);
  });

  it('survives a reset → activate → cycle → reset → cycle loop ten times', async () => {
    // Stress / repeat-cycle safety net: nothing accumulates over
    // repeated reset+cycle cycles. Catches a regression where reset
    // forgot to clear an internal map and the Nth iteration tripped on
    // leftover N-1 state.
    const { adapter, hlState, dynDefs, spanFillState, selectorSatelliteState } =
      await setup('the attorney filed');

    for (let i = 0; i < 10; i++) {
      hlState.activate(1, 'the attorney filed');
      adapter.fireKey('up', { ctrl: true, alt: true });
      expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed');
      adapter.pushText('the attorney filed');
      resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });
      expect(dynDefs.size).toBe(0);
      expect(hlState.active).toBe(false);
    }
  });

  it('order of population does not matter — same end state regardless', async () => {
    // Two harnesses: populate state objects in opposite orders, reset
    // both, assert identical outcomes. Pins that the reset doesn't
    // depend on insertion order or internal map iteration.
    const a = await setup('the attorney filed');
    const b = await setup('the attorney filed');

    a.hlState.activate(1, 'the attorney filed');
    a.adapter.fireKey('up', { ctrl: true, alt: true });
    a.spanFillState.set(
      { index: 3, alternatives: ['<x>'], currentAltIndex: 0, spanLength: 1 },
      'x',
    );
    a.selectorSatelliteState.set(makeSatelliteEntry(), 'x');

    b.selectorSatelliteState.set(makeSatelliteEntry(), 'x');
    b.spanFillState.set(
      { index: 3, alternatives: ['<x>'], currentAltIndex: 0, spanLength: 1 },
      'x',
    );
    b.hlState.activate(1, 'the attorney filed');
    b.adapter.fireKey('up', { ctrl: true, alt: true });

    resetSharedBufferState(a);
    resetSharedBufferState(b);

    expect(a.dynDefs.size).toBe(b.dynDefs.size);
    expect(a.hlState.active).toBe(b.hlState.active);
    expect(a.spanFillState.current).toBe(b.spanFillState.current);
    expect(a.selectorSatelliteState.current).toBe(b.selectorSatelliteState.current);
  });
});

// ===========================================================================
// E. Structural-type contract — minimal Pick<> signature
// ===========================================================================
//
// `resetSharedBufferState` takes a structural Pick<> shape rather than
// `SharedRuntime` so CC v2.1 (which builds state classes inline) can
// pass its locals. These tests pin that contract — if someone tightens
// the signature back to SharedRuntime, the CC band breaks at compile
// time but these tests are the runtime smoke check that the
// destructured-args path stays sound.

describe('resetSharedBufferState — structural-type contract', () => {
  it('accepts a plain object literal of state classes (CC v2.1 calling shape)', () => {
    const dynDefs = new DynDefs();
    const hlState = new HighlightState();
    const spanFillState = new SpanFillState();
    const selectorSatelliteState = new SelectorSatelliteState();
    hlState.activate(0, 'hi');

    expect(() => {
      resetSharedBufferState({ dynDefs, hlState, spanFillState, selectorSatelliteState });
    }).not.toThrow();
    expect(hlState.active).toBe(false);
  });

  it('accepts a SharedRuntime-shaped object (buildSharedRuntime calling shape)', () => {
    // Smoke-test that extra fields (configLoader, blankLoading, etc.)
    // on the passed object are ignored — the helper only reads the
    // four state fields and tolerates extras the SharedRuntime callers
    // include.
    const dynDefs = new DynDefs();
    const hlState = new HighlightState();
    const spanFillState = new SpanFillState();
    const selectorSatelliteState = new SelectorSatelliteState();
    const sharedShaped = {
      dynDefs,
      hlState,
      spanFillState,
      selectorSatelliteState,
      // Extra fields that buildSharedRuntime would include:
      configLoader: {} as unknown,
      blankLoading: {} as unknown,
      markdownRender: {} as unknown,
      dismissedBlanks: new DismissedBlanks(),
      agentTaskState: new AgentTaskState(),
    };
    hlState.activate(0, 'hi');

    expect(() => {
      resetSharedBufferState(sharedShaped);
    }).not.toThrow();
    expect(hlState.active).toBe(false);
  });
});
