// Scenario tests for the `undo _` / `redo _` ACTION path in resolver.ts
// + UndoApplier (modules/undo.ts) + the journal recording taps.
//
// The classifier (ConfigIntentSource's ACTION verdict) is unit-tested in
// @opencues/core and benched at tests/benchmarks/fluid-config/; these
// tests pin the RUNTIME contracts:
//   - command span spliced out, prior prose preserved, ONE buffer write
//   - unique-match relocation (exact-match-or-refuse, never guess)
//   - side-effect inversions (scalar / os-set / file-write) verify-then-set
//   - partial failure reported, never masked; nothing-applied → inline note
//   - stale-epoch buffer entries skip while sibling entries still revert
//   - race bails leave the journal untouched
//
// Journal population uses BOTH real taps (driving the fluid/config-intent
// substitute branches with scripted results) and direct journal.record()
// (for side-effect entries whose recording sites need a live host).

import { describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { SpanFillState } from '../state/span-fill';
import { UndoJournal } from '../state/undo-journal';
import { MockAdapter } from '../../testing/mock-adapter';
import type { BlankInvokeSpec, ProcessHandle } from '../adapter';

const TIPS = JSON.stringify({ concepts: [] });
const CUES_MD = `---
name: test-cues
domain: test
version: 1
---
`;

interface ScriptedResult {
  wordIndex: number;
  word: string;
  alternatives: string[];
  spanStart?: number;
  spanEnd?: number;
  source: string;
  priority: number;
  metadata?: Record<string, unknown>;
}

function undoResult(action: 'undo' | 'redo', count: number, spanStart: number, spanEnd: number): ScriptedResult {
  return {
    wordIndex: 0,
    word: '_',
    alternatives: [action],
    spanStart,
    spanEnd,
    source: 'config-intent',
    priority: 94,
    metadata: { undoAction: { action, count, confidence: 0.95 } },
  };
}

function fluidResult(answer: string, spanStart: number, spanEnd: number): ScriptedResult {
  return {
    wordIndex: 0,
    word: '_',
    alternatives: [answer],
    spanStart,
    spanEnd,
    source: 'fluid-blank',
    priority: 92,
    metadata: {},
  };
}

function setup(initialText: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': TIPS, '/proj/CUES.md': CUES_MD },
  });
  adapter.pushText(initialText);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
  const selectorSatelliteState = new SelectorSatelliteState();
  const spanFillState = new SpanFillState();
  const journal = new UndoJournal();
  const resolver = new Resolver(
    adapter,
    hlState,
    dynDefs,
    loader,
    { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} },
    spanFillState,
    undefined,                  // agentTaskState
    undefined,                  // blankLoading
    undefined,                  // markdownRender
    selectorSatelliteState,
    undefined,                  // blankContextProvider
    undefined,                  // blankFetchProvider
    journal,
  );
  let scripted: ScriptedResult[] = [];
  (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: ScriptedResult[] }> } })._resolver = {
    resolve: async () => ({ results: scripted }),
  };
  function script(results: ScriptedResult[]): void { scripted = results; }
  return { adapter, dynDefs, hlState, loader, resolver, selectorSatelliteState, spanFillState, journal, script };
}

/** Attach a scripted blankInvoke to the mock adapter. Returns the call log. */
function stubBlankInvoke(
  adapter: MockAdapter,
  respond: (spec: BlankInvokeSpec) => { stdout?: string; exitCode?: number },
): BlankInvokeSpec[] {
  const calls: BlankInvokeSpec[] = [];
  (adapter as unknown as { blankInvoke: (spec: BlankInvokeSpec) => ProcessHandle | null }).blankInvoke = (spec) => {
    calls.push(spec);
    const r = respond(spec);
    return {
      result: Promise.resolve({ stdout: r.stdout ?? '', stderr: '', exitCode: r.exitCode ?? 0, timedOut: false }),
      kill: () => { /* no-op */ },
    };
  };
  return calls;
}

describe('undo — fluid-blank fill journeys (real recording tap)', () => {
  async function fillParis(s: ReturnType<typeof setup>): Promise<void> {
    s.script([fluidResult('Paris', 0, 'capital of france _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('Paris');
    expect(s.journal.undoDepth).toBe(1);
  }

  it('fill → undo _ — command span gone, fill reverted, one buffer write', async () => {
    const s = setup('capital of france _');
    await fillParis(s);
    // User types the undo command.
    s.adapter.pushText('Paris undo _');
    // Count runtime writes from here — the whole undo application must
    // land as exactly ONE buffer write (one host history entry).
    let writes = 0;
    const origPush = s.adapter.pushText.bind(s.adapter);
    (s.adapter as unknown as { pushText: typeof origPush }).pushText = (t: string, c?: number) => { writes++; origPush(t, c); };
    const setCallsBefore = s.adapter.setTextCalls.length;
    s.script([undoResult('undo', 1, 'Paris '.length, 'Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('capital of france _');
    expect(writes + (s.adapter.setTextCalls.length - setCallsBefore)).toBe(1);
    expect(s.journal.undoDepth).toBe(0);
    expect(s.journal.redoDepth).toBe(1);
  });

  it('fill → user types elsewhere → undo _ relocates by unique match, prose preserved', async () => {
    const s = setup('capital of france _');
    await fillParis(s);
    s.adapter.pushText('hello there. Paris undo _');
    s.script([undoResult('undo', 1, 'hello there. Paris '.length, 'hello there. Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('hello there. capital of france _');
  });

  it('fill → user edits INSIDE the filled text → undo _ refuses honestly (inline note)', async () => {
    const s = setup('capital of france _');
    await fillParis(s);
    // 'Paris' → 'Pris' — the relocation anchor no longer exists.
    s.adapter.pushText('Pris undo _');
    s.script([undoResult('undo', 1, 'Pris '.length, 'Pris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('Pris [OpenCues: could not undo (not-found)]');
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.skipped[0]?.reason).toBe('not-found');
    // The transaction is consumed either way — no wedged stack.
    expect(s.journal.undoDepth).toBe(0);
  });

  it('fill → undo _ → redo _ restores the fill; journal depths track', async () => {
    const s = setup('capital of france _');
    await fillParis(s);
    s.adapter.pushText('Paris undo _');
    s.script([undoResult('undo', 1, 'Paris '.length, 'Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('capital of france _');
    s.adapter.pushText('capital of france _ redo _');
    s.script([undoResult('redo', 1, 'capital of france _ '.length, 'capital of france _ redo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('Paris');
    expect(s.journal.undoDepth).toBe(1);
    expect(s.journal.redoDepth).toBe(0);
  });

  it('undo → NEW change → redo _ finds nothing (redo cleared by fresh record)', async () => {
    const s = setup('capital of france _');
    await fillParis(s);
    s.adapter.pushText('Paris undo _');
    s.script([undoResult('undo', 1, 'Paris '.length, 'Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.journal.redoDepth).toBe(1);
    // A fresh runtime change branches the timeline.
    s.journal.record({ label: 'fill', entries: [{ kind: 'buffer-splice', beforeSlice: 'x _', afterSlice: 'y', bufferEpoch: s.journal.currentEpoch }] });
    expect(s.journal.redoDepth).toBe(0);
    s.adapter.pushText('capital of france _ redo _');
    s.script([undoResult('redo', 1, 'capital of france _ '.length, 'capital of france _ redo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toContain('[OpenCues: nothing to redo]');
  });
});

describe('undo — count + clamp', () => {
  it('undo 2 _ reverts two transactions newest-first in one buffer write', async () => {
    const s = setup('one two three undo 2 _');
    const epoch = s.journal.currentEpoch;
    s.journal.record({ label: 'a', entries: [{ kind: 'buffer-splice', beforeSlice: 'uno', afterSlice: 'one', bufferEpoch: epoch }] });
    s.journal.record({ label: 'b', entries: [{ kind: 'buffer-splice', beforeSlice: 'dos', afterSlice: 'two', bufferEpoch: epoch }] });
    s.journal.record({ label: 'c', entries: [{ kind: 'buffer-splice', beforeSlice: 'tres', afterSlice: 'three', bufferEpoch: epoch }] });
    s.script([undoResult('undo', 2, 'one two three '.length, 'one two three undo 2 _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    // Newest two (c, b) reverted; oldest (a) stays.
    expect(s.adapter.getText()).toBe('one dos tres');
    expect(s.journal.undoDepth).toBe(1);
  });

  it('count clamps to depth (undo 9 with 2 recorded)', async () => {
    const s = setup('one two undo 9 _');
    const epoch = s.journal.currentEpoch;
    s.journal.record({ label: 'a', entries: [{ kind: 'buffer-splice', beforeSlice: 'uno', afterSlice: 'one', bufferEpoch: epoch }] });
    s.journal.record({ label: 'b', entries: [{ kind: 'buffer-splice', beforeSlice: 'dos', afterSlice: 'two', bufferEpoch: epoch }] });
    s.script([undoResult('undo', 9, 'one two '.length, 'one two undo 9 _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('uno dos');
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.requested).toBe(2);
    expect(report?.appliedTransactions).toBe(2);
  });
});

describe('undo — settings (scalar-write inversions)', () => {
  it('reverts a scalar to its prior value and clears selector-satellite state', async () => {
    const s = setup('voice-mode active undo _');
    await s.loader.load();
    s.loader.applyOpenCuesScalar('voice-mode', 'active');
    const epoch = s.journal.currentEpoch;
    s.journal.record({
      label: 'settings change',
      entries: [
        { kind: 'scalar-write', key: 'voice-mode', prevValue: 'inactive', newValue: 'active' },
        { kind: 'buffer-splice', beforeSlice: 'voice mode on _', afterSlice: 'voice-mode active', bufferEpoch: epoch },
      ],
    });
    // Simulate the live selector-satellite pair the splice registered.
    s.selectorSatelliteState.set({
      blankName: 'opencues', scriptPath: '', selectorIndex: 0, selectorLength: 1,
      satelliteIndex: 1, satelliteLength: 1, currentSetting: 'voice-mode',
      currentValue: 'active', separator: ' ', clearOnEdit: true,
      pairCharStart: 0, pairCharEnd: 'voice-mode active'.length,
    }, s.adapter.getText());
    s.script([undoResult('undo', 1, 'voice-mode active '.length, 'voice-mode active undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('voice mode on _');
    expect(s.loader.opencuesState.settings.get('voice-mode')).toBe('inactive');
    // Stale span state cleaned — no satellite entry pointing into removed text.
    expect(s.selectorSatelliteState.current).toBeNull();
  });

  it('provider verdict transaction: both scalars revert atomically', async () => {
    const s = setup('blanks-llm-provider anthropic:claude-opus-4-7 undo _');
    await s.loader.load();
    s.loader.applyOpenCuesScalar('blanks-llm-provider', 'anthropic');
    s.loader.applyOpenCuesScalar('blanks-llm-model', 'claude-opus-4-7');
    const epoch = s.journal.currentEpoch;
    s.journal.record({
      label: 'settings change',
      entries: [
        { kind: 'scalar-write', key: 'blanks-llm-provider', prevValue: 'cerebras', newValue: 'anthropic' },
        { kind: 'scalar-write', key: 'blanks-llm-model', prevValue: 'gpt-oss-120b', newValue: 'claude-opus-4-7' },
        { kind: 'buffer-splice', beforeSlice: 'use anthropic _', afterSlice: 'blanks-llm-provider anthropic:claude-opus-4-7', bufferEpoch: epoch },
      ],
    });
    const cmdStart = 'blanks-llm-provider anthropic:claude-opus-4-7 '.length;
    s.script([undoResult('undo', 1, cmdStart, s.adapter.getText().length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('use anthropic _');
    expect(s.loader.opencuesState.settings.get('blanks-llm-provider')).toBe('cerebras');
    expect(s.loader.opencuesState.settings.get('blanks-llm-model')).toBe('gpt-oss-120b');
  });

  it('hand-edited scalar since the change → value-drifted skip, setting untouched', async () => {
    const s = setup('x undo _');
    await s.loader.load();
    // The journal says the change wrote 'active', but the user has since
    // hand-edited the file to 'inactive'.
    s.loader.applyOpenCuesScalar('voice-mode', 'inactive');
    s.journal.record({
      label: 'settings change',
      entries: [{ kind: 'scalar-write', key: 'voice-mode', prevValue: 'inactive', newValue: 'active' }],
    });
    s.script([undoResult('undo', 1, 'x '.length, 'x undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.loader.opencuesState.settings.get('voice-mode')).toBe('inactive');
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.skipped[0]?.reason).toBe('value-drifted');
  });
});

describe('undo — os-set (verify-then-set)', () => {
  it('volume burst coalesced → one undo restores the origin value via get-verify + set', async () => {
    const s = setup('volume 58% undo _');
    // Simulated coalesced burst 40 → 58 (as cycleBlankStep records it).
    const epoch = s.journal.currentEpoch;
    s.journal.record({
      label: 'volume step',
      coalesceKey: 'blank-step:volume:1',
      entries: [
        { kind: 'buffer-splice', beforeSlice: '40%', afterSlice: '58%', bufferEpoch: epoch },
        { kind: 'os-set', blankName: 'volume', prevValue: '40', newValue: '58' },
      ],
    });
    const calls = stubBlankInvoke(s.adapter, spec =>
      spec.action === 'get' ? { stdout: '58' } : { stdout: '' });
    s.script([undoResult('undo', 1, 'volume 58% '.length, 'volume 58% undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('volume 40%');
    const set = calls.find(c => c.action === 'set');
    expect(set).toMatchObject({ blankName: 'volume', args: ['40'] });
  });

  it('OS value drifted (another app changed it) → os-set skipped, buffer still reverts', async () => {
    const s = setup('volume 58% undo _');
    const epoch = s.journal.currentEpoch;
    s.journal.record({
      label: 'volume step',
      entries: [
        { kind: 'buffer-splice', beforeSlice: '40%', afterSlice: '58%', bufferEpoch: epoch },
        { kind: 'os-set', blankName: 'volume', prevValue: '40', newValue: '58' },
      ],
    });
    const calls = stubBlankInvoke(s.adapter, spec =>
      spec.action === 'get' ? { stdout: '99' } : { stdout: '' });
    s.script([undoResult('undo', 1, 'volume 58% '.length, 'volume 58% undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('volume 40%');
    expect(calls.some(c => c.action === 'set')).toBe(false);
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.skipped[0]?.reason).toBe('value-drifted');
    expect(report?.appliedEntries).toBe(1); // the buffer entry
  });
});

describe('undo — file-write (validator-preserving inversions)', () => {
  it('sentinel set → undo replays the inverse op through the blank path', async () => {
    const s = setup('CITY = oslo undo _');
    s.journal.record({
      label: 'sentinel fill',
      entries: [{
        kind: 'file-write', file: 'IDENTITY.md', blankName: 'sentinel',
        inverseOp: { keyword: 'remove sentinel', args: ['city'] },
        forwardOp: { keyword: 'set sentinel', args: ['city', 'oslo'] },
      }],
    });
    const calls = stubBlankInvoke(s.adapter, () => ({ stdout: '[removed city]' }));
    s.script([undoResult('undo', 1, 'CITY = oslo '.length, 'CITY = oslo undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(calls[0]).toMatchObject({
      blankName: 'sentinel',
      action: 'get',
      args: ['remove sentinel', 'city'],
    });
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.appliedEntries).toBe(1);
  });

  it('blank refuses the inverse ([err]) → exec-failed skip with the blank\'s message', async () => {
    const s = setup('x undo _');
    s.journal.record({
      label: 'note fill',
      entries: [{
        kind: 'file-write', file: 'NOTES.md', blankName: 'note',
        inverseOp: { keyword: 'note', args: ['delete', 'buy', 'milk'] },
        forwardOp: { keyword: 'note', args: ['add', 'buy', 'milk'] },
      }],
    });
    stubBlankInvoke(s.adapter, () => ({ stdout: '[err] 2 notes match "buy milk" — be more specific' }));
    s.script([undoResult('undo', 1, 'x '.length, 'x undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.skipped[0]?.reason).toBe('exec-failed');
    expect(report?.skipped[0]?.detail).toContain('be more specific');
  });
});

describe('undo — epochs, Tier-4, races, empty journal', () => {
  it('buffer reset between change and undo: buffer entry skips stale-epoch, scalar still reverts', async () => {
    const s = setup('undo _');
    await s.loader.load();
    s.loader.applyOpenCuesScalar('voice-mode', 'active');
    s.journal.record({
      label: 'settings change',
      entries: [
        { kind: 'scalar-write', key: 'voice-mode', prevValue: 'inactive', newValue: 'active' },
        { kind: 'buffer-splice', beforeSlice: 'voice mode on _', afterSlice: 'voice-mode active', bufferEpoch: s.journal.currentEpoch },
      ],
    });
    s.journal.noteBufferReset(); // submit / new message
    s.script([undoResult('undo', 1, 0, 'undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.loader.opencuesState.settings.get('voice-mode')).toBe('inactive');
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.skipped[0]?.reason).toBe('stale-epoch');
    expect(report?.appliedEntries).toBe(1);
  });

  it('Tier-4 external effect: buffer reverts, external skip reported', async () => {
    const s = setup('done undo _');
    const epoch = s.journal.currentEpoch;
    s.journal.record({
      label: 'somepack fill',
      entries: [
        { kind: 'buffer-splice', beforeSlice: 'somepack go _', afterSlice: 'done', bufferEpoch: epoch },
        { kind: 'external', label: 'somepack ran an external action' },
      ],
    });
    s.script([undoResult('undo', 1, 'done '.length, 'done undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('somepack go _');
    const report = s.journal.recentApplyReport(60_000);
    expect(report?.skipped[0]?.reason).toBe('external');
    expect(report?.skipped[0]?.detail).toContain('somepack');
  });

  it('race bail: live text mutated after analysis → journal untouched, no write', async () => {
    const s = setup('Paris undo _');
    s.journal.record({ label: 'fill', entries: [{ kind: 'buffer-splice', beforeSlice: 'q _', afterSlice: 'Paris', bufferEpoch: s.journal.currentEpoch }] });
    const analyzed = s.adapter.getText();
    s.script([undoResult('undo', 1, 'Paris '.length, analyzed.length)]);
    // User keeps typing between analysis and apply — the command span
    // in the live buffer no longer matches the analyzed snapshot.
    s.adapter.pushText('Paris undoX _x');
    const before = s.adapter.getText();
    await s.resolver.resolveAndApply(analyzed);
    expect(s.adapter.getText()).toBe(before);
    expect(s.journal.undoDepth).toBe(1);
  });

  it('empty journal → inline nothing-to-undo note with clearOnEdit span', async () => {
    const s = setup('hello. undo _');
    s.script([undoResult('undo', 1, 'hello. '.length, 'hello. undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('hello. [OpenCues: nothing to undo]');
    expect(s.spanFillState.current?.clearOnEdit).toBe(true);
  });

  it('undo application itself is never journaled (reentrancy)', async () => {
    const s = setup('Paris undo _');
    s.journal.record({ label: 'fill', entries: [{ kind: 'buffer-splice', beforeSlice: 'q _', afterSlice: 'Paris', bufferEpoch: s.journal.currentEpoch }] });
    s.script([undoResult('undo', 1, 'Paris '.length, 'Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    // One tx moved undo → redo; nothing NEW was recorded by the apply.
    expect(s.journal.undoDepth).toBe(0);
    expect(s.journal.redoDepth).toBe(1);
  });
});

describe('undo — config-intent settings splice records via the real tap', () => {
  it('the settings substitute branch commits a transaction with the buffer entry', async () => {
    const s = setup('voice mode off _');
    await s.loader.load();
    s.script([{
      wordIndex: 0,
      word: '_',
      alternatives: ['voice-mode'],
      spanStart: 0,
      spanEnd: 'voice mode off _'.length,
      source: 'config-intent',
      priority: 94,
      metadata: {
        satelliteValue: 'inactive',
        displaySeparator: ' ',
        blankName: 'opencues',
        selectorBlank: true,
      },
    }]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('voice-mode inactive');
    expect(s.journal.undoDepth).toBe(1);
    // And it round-trips: undo restores the summon phrase.
    s.adapter.pushText('voice-mode inactive undo _');
    s.script([undoResult('undo', 1, 'voice-mode inactive '.length, 'voice-mode inactive undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('voice mode off _');
  });
});

describe('undo — over-wide summon span (live agentic-scenario 109 regression)', () => {
  // The summon resolver can claim the WHOLE buffer as the command when
  // unpunctuated prior content precedes the verb ('debug-mode on
  // undo _' → spanStart 0). The branch must tighten the span so the
  // pending transaction's relocation anchor is never swallowed —
  // un-tightened, the splice emptied the buffer and every buffer entry
  // skipped as not-found.

  it('fill answer before the verb survives a whole-buffer span and reverts', async () => {
    const s = setup('Paris undo _');
    s.journal.record({
      label: 'fluid-blank fill',
      entries: [{ kind: 'buffer-splice', beforeSlice: 'capital of france _', afterSlice: 'Paris', bufferEpoch: s.journal.currentEpoch }],
    });
    // Whole-buffer command span — exactly what the summon model returned live.
    s.script([undoResult('undo', 1, 0, 'Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('capital of france _');
  });

  it('settings pair before the verb survives a whole-buffer span; scalar reverts; buffer never empties', async () => {
    const s = setup('debug-mode on undo _');
    await s.loader.load();
    s.loader.applyOpenCuesScalar('debug-mode', 'on');
    s.journal.record({
      label: 'settings change',
      entries: [
        { kind: 'scalar-write', key: 'debug-mode', prevValue: 'off', newValue: 'on' },
        { kind: 'buffer-splice', beforeSlice: 'enable debug logging _', afterSlice: 'debug-mode on', bufferEpoch: s.journal.currentEpoch },
      ],
    });
    s.script([undoResult('undo', 1, 0, 'debug-mode on undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('enable debug logging _');
    expect(s.loader.opencuesState.settings.get('debug-mode')).toBe('off');
  });
});

// ── Regression: bugs found in live CC testing (2026-07-15) ────────────────
function transformResult(rewrite: string, spanStart: number, spanEnd: number): ScriptedResult {
  return { wordIndex: 0, word: '_', alternatives: [rewrite], spanStart, spanEnd, source: 'transform-blank', priority: 93, metadata: {} };
}

describe('undo — ACTION exclusivity + deterministic cursor (live-CC regressions)', () => {
  async function fillParis(s: ReturnType<typeof setup>): Promise<void> {
    s.script([fluidResult('Paris', 0, 'capital of france _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('Paris');
  }

  it('redo _ alongside a LEFTOVER command `_` applies ONLY the redo — no re-transform double-fire', async () => {
    // The live bug: after undo restored `... formal _`, the user typed
    // ` redo _`. The buffer then had TWO `_`s; TransformBlank fired on
    // the stale command `_` in the SAME pass as the redo, splicing a
    // fresh rewrite on top of the undo. The ACTION-exclusivity gate must
    // drop the transform result: undo/redo is the sole intent.
    const s = setup('capital of france _');
    await fillParis(s);                      // buffer = 'Paris'
    s.adapter.pushText('Paris undo _');
    s.script([undoResult('undo', 1, 'Paris '.length, 'Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    expect(s.adapter.getText()).toBe('capital of france _');

    // Now redo, but ALSO script a competing transform on the leftover
    // `... france _` (what the live resolver did). Only the redo applies.
    s.adapter.pushText('capital of france _ redo _');
    const buf = s.adapter.getText();
    s.script([
      // Transform FIRST in the pass — the real double-apply risk: without
      // the ACTION-exclusivity gate this splices onto the buffer BEFORE
      // the redo runs, corrupting it (and then the redo's span guard
      // fails on the mutated buffer). With the gate, it's dropped.
      transformResult('France is a country in Europe', 0, 'capital of france _'.length),
      undoResult('redo', 1, 'capital of france _ '.length, buf.length),
    ]);
    await s.resolver.resolveAndApply(buf);
    // Redo restored the Paris fill; the transform's rewrite is NOWHERE.
    expect(s.adapter.getText()).toBe('Paris');
    expect(s.adapter.getText()).not.toContain('France is a country in Europe');
  });

  it('undo parks the cursor at the END of the restored content (not a stale offset)', async () => {
    const s = setup('capital of france _');
    await fillParis(s);
    s.adapter.pushText('Paris undo _');
    // Capture the cursor arg the undo application commits.
    let committedCursor = -1;
    const origPush = s.adapter.pushText.bind(s.adapter);
    (s.adapter as unknown as { pushText: typeof origPush }).pushText = (t: string, c?: number) => { committedCursor = c ?? -1; origPush(t, c); };
    s.script([undoResult('undo', 1, 'Paris '.length, 'Paris undo _'.length)]);
    await s.resolver.resolveAndApply(s.adapter.getText());
    const finalText = s.adapter.getText();
    expect(finalText).toBe('capital of france _');
    // cursorHint = end of the restored `capital of france _` splice —
    // i.e. the end of the buffer here. Deterministic, never a stale
    // pre-undo command offset.
    expect(committedCursor).toBe(finalText.length);
  });
});

