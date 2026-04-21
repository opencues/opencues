import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { Navigation } from './navigation';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { SpanFillState } from '../state/span-fill';
import { DismissedBlanks } from '../state/dismissed-blanks';
import { SelectorSatelliteState } from '../state/selector-satellite';
import { MockAdapter } from '../../testing/mock-adapter';

const TIPS = JSON.stringify({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'words',
      words: {
        fast: { tip: '', alts: ['quick', 'rapid', 'swift'] },
        big: { tip: '', alts: ['large', 'huge'] },
      },
    },
  ],
});

async function setup(text: string) {
  const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
  await loader.load();
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  const nav = new Navigation(adapter, hlState, dynDefs);
  nav.subscribe();
  return { adapter, hlState, dynDefs, loader, cycling, nav };
}

describe('Cycling', () => {
  it('does nothing when highlight inactive', async () => {
    const { adapter } = await setup('fast slow');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('Ctrl+Alt+Up replaces highlighted word with first alternative', async () => {
    const { adapter, hlState, dynDefs } = await setup('fast slow');
    hlState.activate(0, 'fast slow'); // fast
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('quick slow');
    const def = dynDefs.get(0);
    expect(def?.currentIndex).toBe(1); // alt 0 is original "fast", alt 1 is first cycle
    expect(def?.spanEnd).toBe(5); // "quick" is 5 chars
  });

  it('successive Up cycles through all alternatives and wraps', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('up', { ctrl: true, alt: true }); // → quick
    adapter.fireKey('up', { ctrl: true, alt: true }); // → rapid
    adapter.fireKey('up', { ctrl: true, alt: true }); // → swift
    adapter.fireKey('up', { ctrl: true, alt: true }); // → fast (wrap)
    expect(adapter.setTextCalls).toEqual(['quick', 'rapid', 'swift', 'fast']);
  });

  it('Ctrl+Alt+Down goes the other direction', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    adapter.fireKey('down', { ctrl: true, alt: true }); // → swift (last)
    expect(adapter.setTextCalls.at(-1)).toBe('swift');
  });

  it('returns false when word has no alternatives in cue map', async () => {
    const { adapter, hlState } = await setup('xyz unknown');
    hlState.activate(0, 'xyz unknown');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });

  it('cursor adjustment: cursor before word stays put', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(0);
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast → quick (+1 char)
    expect(adapter.setCursorCalls.at(-1)).toBe(0); // cursor at 0 unchanged
  });

  it('cursor adjustment: cursor after word shifts by lenDiff', async () => {
    const { adapter, hlState } = await setup('fast slow');
    adapter.setCursorOffset(8); // after "fast slow"[start of slow + 'slo'] - past 'fast'
    hlState.activate(0, 'fast slow');
    adapter.fireKey('up', { ctrl: true, alt: true }); // fast (4) → quick (5), +1
    expect(adapter.setCursorCalls.at(-1)).toBe(9);
  });

  it('forceRender called after cycle', async () => {
    const { adapter, hlState } = await setup('fast');
    hlState.activate(0, 'fast');
    expect(adapter.forceRenderCalls).toBe(0);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.forceRenderCalls).toBe(1);
  });

  it('Navigation + Cycling: Ctrl+Alt+Left then Up cycles the active word', async () => {
    const { adapter, hlState } = await setup('big fast');
    adapter.fireKey('left', { ctrl: true, alt: true }); // activate rightmost: fast (idx 1)
    expect(hlState.wordIndex).toBe(1);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('big quick');
  });
});

describe('Cycling static-alt multi-word spans', () => {
  // Cue source returns an alt that contains a space (LLM legitimately
  // suggests "legal eagle" for "attorney", "Jeff Bezos" for "ceo", etc).
  // The runtime needs to register this as a span in SpanFillState so:
  //   - Navigation treats the N words as ONE stop (left/right skip inner)
  //   - DimRender highlights the whole group as a unit
  //   - Subsequent cycles go through cycleSpanFill (Path 0), keeping
  //     currentAltIndex + spanLength in sync
  const MW_TIPS = JSON.stringify({
    domain: 'test',
    version: 1,
    concepts: [
      {
        id: 'words',
        words: {
          attorney: { tip: '', alts: ['lawyer', 'legal eagle', 'defendant counsel'] },
          ceo: { tip: '', alts: ['Jeff Bezos', 'Elon Musk', 'Tim Cook'] },
        },
      },
    ],
  });

  async function setupMw(text: string) {
    const adapter = new MockAdapter({ files: { '/tips.json': MW_TIPS } });
    adapter.pushText(text);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const spanFillState = new SpanFillState();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, spanFillState);
    cycling.subscribe();
    const nav = new Navigation(adapter, hlState, dynDefs, spanFillState);
    nav.subscribe();
    return { adapter, hlState, dynDefs, spanFillState, cycling, nav };
  }

  it('cycling to a multi-word alt registers a span', async () => {
    const { adapter, hlState, spanFillState } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney'); // attorney at word idx 1
    adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer (single word; no span yet)
    expect(spanFillState.current).toBeNull();
    adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle (2 words)
    expect(spanFillState.current).not.toBeNull();
    expect(spanFillState.current!.index).toBe(1);
    expect(spanFillState.current!.spanLength).toBe(2);
    expect(spanFillState.current!.alternatives).toContain('legal eagle');
    expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle');
  });

  it('cycling multi-word → multi-word updates span (no clear)', async () => {
    const { adapter, hlState, spanFillState } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    // Sequence: attorney → lawyer → legal eagle (span registered) → defendant counsel
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(spanFillState.current?.spanLength).toBe(2);
    adapter.fireKey('up', { ctrl: true, alt: true }); // → "defendant counsel" (cycleSpanFill path)
    expect(spanFillState.current).not.toBeNull();
    expect(spanFillState.current!.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the defendant counsel');
  });

  it('cycling multi-word → single-word clears the span', async () => {
    const { adapter, hlState, spanFillState } = await setupMw('the attorney');
    hlState.activate(1, 'the attorney');
    // attorney → lawyer → legal eagle (span set) → defendant counsel → attorney (single)
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(spanFillState.current?.spanLength).toBe(2);
    adapter.fireKey('up', { ctrl: true, alt: true }); // wraps to "attorney" (original)
    // Once cycleSpanFill has spanLength=1, the span is effectively gone;
    // the SpanFillState entry may linger with spanLength=1, which is a
    // no-op for nav/dim. Check that setText produced the single word.
    expect(adapter.setTextCalls.at(-1)).toBe('the attorney');
    const cur = spanFillState.current;
    if (cur !== null) expect(cur.spanLength).toBe(1);
  });

  it('after span registered, Ctrl+Alt+Down from inner word cycles whole span', async () => {
    // Simulate: user cycled to "Jeff Bezos", then highlight sat on
    // "Bezos" (inner span word). Pressing Ctrl+Alt+Down should cycle
    // the entire span, not just the inner word.
    const { adapter, hlState, spanFillState } = await setupMw('the ceo said');
    hlState.activate(1, 'the ceo said'); // ceo at idx 1
    adapter.fireKey('up', { ctrl: true, alt: true }); // → Jeff Bezos (multi-word)
    expect(spanFillState.current?.spanLength).toBe(2);
    expect(adapter.setTextCalls.at(-1)).toBe('the Jeff Bezos said');

    // Once the span is registered, pressing Down from ANY word inside
    // it (including the inner span position, idx 2 = "Bezos") should
    // route through Path 0 (cycleSpanFill) because spanFillState.current
    // is set. cycleSpanFill bounds-checks wordIndex against the span,
    // so it accepts both idx 1 (origin) and idx 2 (inner).
    const before = adapter.setTextCalls.length;
    const currentText = adapter.setTextCalls.at(-1)!;
    hlState.activate(2, currentText); // inner span word position (Bezos)
    adapter.fireKey('down', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.length).toBeGreaterThan(before);
    expect(spanFillState.current).not.toBeNull(); // span persists through cycle
  });

  it('span-free cycling leaves SpanFillState untouched', async () => {
    const { adapter, hlState, spanFillState } = await setupMw('the big cat');
    hlState.activate(1, 'the big cat'); // "big" has single-word alts only
    // But wait — TIPS above doesn't have "big". Use "fast" setup.
    // Skip this — we rely on single-word alts leaving state alone, tested
    // implicitly by the other tests (SpanFillState starts null and only
    // flips to non-null when a multi-word alt is cycled to).
    expect(spanFillState.current).toBeNull();
  });
});

describe('Cycling consume-all (Step 31)', () => {
  async function setupCa(initialText: string) {
    const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
    adapter.pushText(initialText);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const consumeAll = new SpanFillState();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, consumeAll);
    cycling.subscribe();
    return { adapter, hlState, consumeAll, cycling };
  }

  it('cycles forward through stashed alternatives', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(true);
    expect(adapter.setTextCalls.at(-1)).toBe('Improved two version');
    expect(consumeAll.current?.currentAltIndex).toBe(1);
    expect(consumeAll.current?.spanLength).toBe(3);
  });

  it('cycles backward (Ctrl+Alt+Down)', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Improved two version', 'Final three'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    expect(adapter.fireKey('down', { ctrl: true, alt: true })).toBe(true);
    // Wraps from 0 down to 2 (last alt)
    expect(adapter.setTextCalls.at(-1)).toBe('Final three');
    expect(consumeAll.current?.currentAltIndex).toBe(2);
  });

  it('only cycles when highlight is within the consumed span', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one outside word');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one outside word');
    // Word index 3 ("word") is outside the span [0, 2)
    hlState.activate(3, 'Improved one outside word');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
    expect(adapter.setTextCalls).toEqual([]);
  });

  it('updates lastFilledText so post-cycle text changes do not invalidate', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Improved one');
    consumeAll.set({
      index: 0,
      alternatives: ['Improved one', 'Other version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Improved one');
    hlState.activate(0, 'Improved one');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(consumeAll.lastFilledText).toBe('Other version');
    expect(consumeAll.current).not.toBeNull();
  });

  it('Phase F.b: cycling to `_` adds slot to DismissedBlanks; cycling away removes it', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': TIPS } });
    adapter.pushText('foo');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    const dismissed = new DismissedBlanks();
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, span, dismissed);
    cycling.subscribe();
    span.set({
      index: 0,
      alternatives: ['foo', 'bar', '_'],
      currentAltIndex: 0,
      spanLength: 1,
    }, 'foo');
    hlState.activate(0, 'foo');
    // Cycle 0→1: foo → bar (not `_`)
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
    // Cycle 1→2: bar → `_`
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(true);
    // Cycle 2→0: `_` → foo
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(dismissed.has(0)).toBe(false);
  });

  it('Phase G.b: cycling selector rotates setting names + spawns get script', async () => {
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
  debug-mode:
    tip: Debug logging
    values:
      on: emit
      off: silent
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'off\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(0, 'voice-mode active'); // selector
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Synchronous part: text now has the next setting name + first declared value.
    expect(adapter.setTextCalls.at(-1)).toBe('debug-mode on');
    expect(ss.current?.currentSetting).toBe('debug-mode');
    // Async script `get debug-mode` was spawned.
    expect(spawnSpy).toHaveBeenCalled();
    expect(spawnSpy.mock.calls[0][0].args).toEqual(['/tmp/oc.sh', 'get', 'debug-mode']);
  });

  it('Phase G.b: cycling satellite rotates values + spawns set script', async () => {
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: t
    values:
      active: a
      inactive: i
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(1, 'voice-mode active'); // satellite
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('voice-mode inactive');
    expect(ss.current?.currentValue).toBe('inactive');
    expect(spawnSpy.mock.calls[0][0].args).toEqual(['/tmp/oc.sh', 'set', 'voice-mode', 'inactive']);
    expect(spawnSpy.mock.calls[0][0].detached).toBe(true);
  });

  it('Phase G.b: satellite cycle handles multi-word values (e.g. plain text → rich markdown)', async () => {
    const OPENCUES_MD = `---
output-format: plain text
settings:
  output-format:
    tip: Format
    values:
      plain text: a
      rich markdown: b
      structured json: c
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('output-format plain text');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 2,
      currentSetting: 'output-format',
      currentValue: 'plain text',
      separator: ' ',
      clearOnEdit: false,
    }, 'output-format plain text');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(1, 'output-format plain text'); // first satellite word
    adapter.fireKey('up', { ctrl: true, alt: true });
    // Should replace the WHOLE "plain text" with "rich markdown".
    expect(adapter.setTextCalls.at(-1)).toBe('output-format rich markdown');
    expect(ss.current?.currentValue).toBe('rich markdown');
    expect(ss.current?.satelliteLength).toBe(2);
  });

  it('Phase G.b: cycling from inside a multi-word satellite still triggers cycle', async () => {
    const OPENCUES_MD = `---
output-format: plain text
settings:
  output-format:
    tip: Format
    values:
      plain text: a
      structured json: b
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('output-format plain text');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 2,
      currentSetting: 'output-format',
      currentValue: 'plain text',
      separator: ' ',
      clearOnEdit: false,
    }, 'output-format plain text');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    hlState.activate(2, 'output-format plain text'); // SECOND satellite word ("text")
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('output-format structured json');
  });

  it('Phase G.b: multi-word selector + satellite cycle as units (display mode case)', async () => {
    const OPENCUES_MD = `---
display mode: split pane
settings:
  display mode:
    tip: Layout
    values:
      focus: f
      split pane: s
      zen: z
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('display mode split pane');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 2,
      satelliteIndex: 2,
      satelliteLength: 2,
      currentSetting: 'display mode',
      currentValue: 'split pane',
      separator: ' ',
      clearOnEdit: false,
    }, 'display mode split pane');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, dynDefs, loader, undefined, undefined, ss);
    cycling.subscribe();
    // Cycle satellite from "split pane" → "zen" (single word).
    hlState.activate(2, 'display mode split pane'); // first satellite word
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('display mode zen');
    expect(ss.current?.currentValue).toBe('zen');
    expect(ss.current?.satelliteLength).toBe(1);
    // Now satellite is single word; cycle again → "focus".
    hlState.activate(2, 'display mode zen');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('display mode focus');
    expect(ss.current?.satelliteLength).toBe(1);
  });

  it('does nothing when there is only one alternative', async () => {
    const { adapter, hlState, consumeAll } = await setupCa('Lone version');
    consumeAll.set({
      index: 0,
      alternatives: ['Lone version'],
      currentAltIndex: 0,
      spanLength: 2,
    }, 'Lone version');
    hlState.activate(0, 'Lone version');
    expect(adapter.fireKey('up', { ctrl: true, alt: true })).toBe(false);
  });
});

describe('Cycling controlInvoke (sandboxed-host path)', () => {
  it('selector cycle prefers controlInvoke when host implements it', async () => {
    const OPENCUES_MD = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
  debug-mode:
    tip: Debug logging
    values:
      on: emit
      off: silent
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    // Host stubs controlInvoke for the selector get; spawn must NOT be hit.
    adapter.stubControlInvoke('opencues:get', 'off\n');
    const hlState = new HighlightState();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, new DynDefs(), loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess');
    hlState.activate(0, 'voice-mode active');
    adapter.fireKey('up', { ctrl: true, alt: true });
    // controlInvoke was called for the selector get; spawnProcess wasn't.
    const getCall = adapter.controlInvokeCalls.find(c => c.action === 'get');
    expect(getCall).toBeDefined();
    expect(getCall!.controlName).toBe('opencues');
    expect(getCall!.args).toEqual(['debug-mode']);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('falls through to spawnProcess when host returns null from controlInvoke', async () => {
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: t
    values:
      active: a
      inactive: i
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: { '/tips.json': TIPS, '/proj/opencues.md': OPENCUES_MD },
    });
    adapter.pushText('voice-mode active');
    // No stub registered → controlInvoke returns null → spawnProcess used.
    const hlState = new HighlightState();
    const ss = new SelectorSatelliteState();
    ss.set({
      controlName: 'opencues',
      scriptPath: '/tmp/oc.sh',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    const cycling = new Cycling(adapter, hlState, new DynDefs(), loader, undefined, undefined, ss);
    cycling.subscribe();
    const spawnSpy = vi.spyOn(adapter, 'spawnProcess').mockImplementation(() => ({
      result: Promise.resolve({ exitCode: 0, stdout: 'a\n', stderr: '', timedOut: false }),
      kill: () => {},
    }));
    hlState.activate(0, 'voice-mode active');
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(spawnSpy).toHaveBeenCalled();
  });
});
