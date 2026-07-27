import { describe, expect, it } from 'vitest';
import { Statusline } from './statusline';
import { ConfigLoader } from './config-loader';
import { HighlightState } from '../state/highlight-state';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';

function setup(text: string) {
  const adapter = new MockAdapter();
  adapter.pushText(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const statusline = new Statusline(adapter, hlState, dynDefs, {
    exportPath: '/tmp/test-statusline.json',
  });
  statusline.subscribe();
  return { adapter, hlState, dynDefs, statusline };
}

describe('Statusline.buildPayload', () => {
  it('returns active:false when highlight inactive', () => {
    const { statusline } = setup('hello world');
    const p = statusline.buildPayload({ text: 'hello world', cursor: 0, externalHighlights: [] });
    expect(p.active).toBe(false);
    expect(p.highlightedWord).toBeUndefined();
    expect(typeof p.timestamp).toBe('number');
  });

  it('returns word + index for active highlight without DynDef', () => {
    const { hlState, statusline } = setup('alpha beta gamma');
    hlState.activate(1, 'alpha beta gamma');
    const p = statusline.buildPayload({ text: 'alpha beta gamma', cursor: 0, externalHighlights: [] });
    expect(p.active).toBe(true);
    expect(p.highlightedWordIndex).toBe(1);
    expect(p.highlightedWord).toBe('beta');
    expect(p.alts).toEqual(['beta']);
    expect(p.currentAltIndex).toBe(0);
    expect(p.wordCount).toBe(3);
  });

  it('reflects current alt when DynDef populated by Cycling', () => {
    const { hlState, dynDefs, statusline } = setup('undo');
    hlState.activate(0, 'undo');
    dynDefs.set(0, {
      originalWord: 'undo',
      alternatives: ['undo', '/rewind', 'revert'],
      currentIndex: 1,
      spanStart: 0,
      spanEnd: 7,
    });
    const p = statusline.buildPayload({ text: '/rewind', cursor: 0, externalHighlights: [] });
    expect(p.highlightedWord).toBe('/rewind');
    expect(p.currentAltIndex).toBe(1);
    expect(p.alts).toEqual(['undo', '/rewind', 'revert']);
  });

});

describe('Statusline event emission', () => {
  it('emits statusline.snapshot AFTER writeFile resolves (file-fresh barrier)', async () => {
    const { adapter, hlState, statusline } = setup('alpha beta');
    hlState.activate(0, 'alpha beta');
    statusline.maybeWrite({ text: 'alpha beta', cursor: 0, externalHighlights: [] });
    // adapter.writeFile is async (returns Promise) — flush microtasks
    await new Promise(r => setImmediate(r));
    const snaps = adapter.events.filter(e => e.type === 'statusline.snapshot');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].body).toMatchObject({
      exportPath: '/tmp/test-statusline.json',
      active: true,
    });
  });

  it('does not emit statusline.snapshot when exportPath is empty (in-process only)', async () => {
    const adapter = new MockAdapter();
    adapter.pushText('hello');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const statusline = new Statusline(adapter, hlState, dynDefs, { exportPath: '' });
    statusline.subscribe();
    hlState.activate(0, 'hello');
    statusline.maybeWrite({ text: 'hello', cursor: 0, externalHighlights: [] });
    await new Promise(r => setImmediate(r));
    expect(adapter.events.filter(e => e.type === 'statusline.snapshot')).toHaveLength(0);
  });

  it('emits statusline.snapshot exactly once per state change (deduped by stable JSON)', async () => {
    const { adapter, hlState, statusline } = setup('alpha beta');
    hlState.activate(0, 'alpha beta');
    statusline.maybeWrite({ text: 'alpha beta', cursor: 0, externalHighlights: [] });
    statusline.maybeWrite({ text: 'alpha beta', cursor: 0, externalHighlights: [] });
    statusline.maybeWrite({ text: 'alpha beta', cursor: 0, externalHighlights: [] });
    await new Promise(r => setImmediate(r));
    expect(adapter.events.filter(e => e.type === 'statusline.snapshot')).toHaveLength(1);
  });
});

describe('Statusline cue-tip plumbing', () => {
  const TIPS = wrapTipsAsCuesMd({
    domain: 'test',
    version: 1,
    concepts: [
      {
        id: 'g',
        groups: [{
          synonyms: ['undo', '/rewind', 'revert'],
          alts: [],
          tip: 'Undo a previous Claude action',
        }],
      },
      {
        id: 'h',
        words: {
          opus: { tip: 'Use the most capable model', alts: ['sonnet', 'haiku'] },
        },
      },
    ],
  });

  async function setupWithTips(text: string) {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': TIPS } });
    adapter.pushText(text);
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const statusline = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '/tmp/test-statusline.json',
    }, loader);
    statusline.subscribe();
    return { adapter, hlState, dynDefs, loader, statusline };
  }

  it('populates cueTip from cue map for non-cycled active word', async () => {
    const { hlState, statusline } = await setupWithTips('opus');
    hlState.activate(0, 'opus');
    const p = statusline.buildPayload({ text: 'opus', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBe('Use the most capable model');
  });

  it('uses alt-specific tip when available, else primary', async () => {
    const { hlState, dynDefs, statusline } = await setupWithTips('undo');
    hlState.activate(0, 'undo');
    dynDefs.set(0, {
      originalWord: 'undo',
      alternatives: ['undo', '/rewind', 'revert'],
      currentIndex: 1,
      spanStart: 0,
      spanEnd: 7,
    });
    const p = statusline.buildPayload({ text: '/rewind', cursor: 0, externalHighlights: [] });
    // The synonym group's tip is shared across all variants, so cueTip is the
    // group tip even for the alt. altCueTips contains per-variant entries.
    expect(p.cueTip).toBe('Undo a previous Claude action');
    expect(p.altCueTips).toBeDefined();
  });

  it('surfaces a def cueTip (dynamic advisory) passively in the status line under inline-cues-mode: secondary', async () => {
    // The passive advisory rides the status line when inline-cues-mode is
    // `secondary` (or on a host that can't paint inline). Pin the secondary
    // path explicitly — the DEFAULT (`inline`) routes it to DimRender's
    // InlineNote instead (asserted in the next test).
    const adapter = new MockAdapter({ files: { '/mock/OPENCUES.md': '---\ninline-cues-mode: secondary\n---\n' } });
    adapter.pushText('xyz');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/mock/OPENCUES.md' });
    await loader.load();
    const statusline = new Statusline(adapter, hlState, dynDefs, { exportPath: '/tmp/t-sec.json' }, loader);
    statusline.subscribe();
    hlState.activate(0, 'xyz');
    // A passive sentence-cue def (calendar-conflict): buffer keeps the original
    // (currentIndex 0), and the advisory rides on def.cueTip.
    dynDefs.set(0, {
      originalWord: 'xyz',
      alternatives: ['xyz', 'xyz — heads up: Conference all day'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 3,
      blankName: 'sentence-cue:calendar',
      cueTip: '⚠ Conference Sat Aug 23, all day',
    });
    const p = statusline.buildPayload({ text: 'xyz', cursor: 0, externalHighlights: [] });
    // 'xyz' isn't in the static cue map, so this can ONLY come from def.cueTip.
    expect(p.cueTip).toBe('⚠ Conference Sat Aug 23, all day');
  });

  it('inline-cues-mode: inline (default) suppresses the status-line copy on a dim-capable host — it goes inline instead', async () => {
    // Default mode. MockAdapter reports `dim-ranges`, so the passive advisory
    // is painted inline by DimRender and the redundant status-line copy is
    // suppressed. This is the intended default behaviour change: the tip moves
    // from the secondary display to the inline reveal.
    const { hlState, dynDefs, statusline } = await setupWithTips('xyz');
    hlState.activate(0, 'xyz');
    dynDefs.set(0, {
      originalWord: 'xyz',
      alternatives: ['xyz'],
      currentIndex: 0,
      spanStart: 0,
      spanEnd: 3,
      blankName: 'sentence-cue:calendar',
      cueTip: '⚠ Conference Sat Aug 23, all day',
    });
    const p = statusline.buildPayload({ text: 'xyz', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBeNull();
  });

  it('def cueTip is suppressed when tips-mode: off', async () => {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': '---\ntips-mode: off\n---\n' } });
    adapter.pushText('xyz');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/mock/CUES.md' });
    await loader.load();
    const statusline = new Statusline(adapter, hlState, dynDefs, { exportPath: '/tmp/t2.json' }, loader);
    statusline.subscribe();
    hlState.activate(0, 'xyz');
    dynDefs.set(0, { originalWord: 'xyz', alternatives: ['xyz'], currentIndex: 0, spanStart: 0, spanEnd: 3, blankName: 'sentence-cue:calendar', cueTip: '⚠ x' });
    const p = statusline.buildPayload({ text: 'xyz', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBeNull();
  });

  it('cueTip is null for words not in the cue map', async () => {
    const { hlState, statusline } = await setupWithTips('xyz');
    hlState.activate(0, 'xyz');
    const p = statusline.buildPayload({ text: 'xyz', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBeNull();
  });

  it('cueTip is null when CUES.md sets tips-mode: off', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/CUES.md': wrapTipsAsCuesMd({
          domain: 'test', version: 1,
          concepts: [{ id: 'g', words: { opus: { tip: 'Most capable model', alts: ['sonnet'] } } }],
        }, { 'tips-mode': 'off' }),
      },
    });
    adapter.pushText('opus');
    const hlState = new HighlightState();
    hlState.activate(0, 'opus');
    const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const sl = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '/tmp/x.json',
    }, loader);
    const p = sl.buildPayload({ text: 'opus', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBeNull();
    expect(p.altCueTips).toBeNull();
  });

  it('cueTip is null when no ConfigLoader is supplied', () => {
    const adapter = new MockAdapter();
    adapter.pushText('opus');
    const hlState = new HighlightState();
    hlState.activate(0, 'opus');
    const sl = new Statusline(adapter, hlState, new DynDefs(), {
      exportPath: '/tmp/x.json',
    });
    const p = sl.buildPayload({ text: 'opus', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBeNull();
    expect(p.altCueTips).toBeNull();
  });
});

describe('Statusline write behaviour', () => {
  it('writes on first render with active state', async () => {
    const { adapter, hlState } = setup('alpha beta');
    hlState.activate(0, 'alpha beta');
    adapter.fireRender();
    // writeFile is async; wait a tick.
    await new Promise(r => setImmediate(r));
    const written = await adapter.readFile('/tmp/test-statusline.json');
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written!);
    expect(parsed.active).toBe(true);
    expect(parsed.highlightedWord).toBe('alpha');
  });

  it('dedups consecutive identical-state renders', async () => {
    const { adapter, hlState } = setup('alpha');
    hlState.activate(0, 'alpha');
    adapter.fireRender();
    adapter.fireRender();
    adapter.fireRender();
    await new Promise(r => setImmediate(r));
    // Only one writeFile call was made because subsequent renders had
    // identical stable JSON.
    const writeCalls = adapter.logs.filter(l => l.msg.includes('writeFile failed'));
    expect(writeCalls).toHaveLength(0);
  });

  it('does not write when file-write capability absent', async () => {
    const adapter = new MockAdapter({ capabilities: ['file-read'] });
    adapter.pushText('alpha');
    const hlState = new HighlightState();
    hlState.activate(0, 'alpha');
    const sl = new Statusline(adapter, hlState, new DynDefs(), {
      exportPath: '/tmp/x.json',
    });
    sl.subscribe();
    adapter.fireRender();
    await new Promise(r => setImmediate(r));
    const written = await adapter.readFile('/tmp/x.json');
    // file-read is on but file-write is off; writeFile would have rejected.
    expect(written).toBeNull();
  });

  it('span-fill highlight emits tip + cueBlank=true', async () => {
    const { SpanFillState } = await import('../state/span-fill');
    const adapter = new MockAdapter();
    adapter.pushText('affirm I am strong');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    span.set({
      index: 1,
      alternatives: ['I am strong', 'I am brave', '_'],
      currentAltIndex: 0,
      spanLength: 3,
      tip: 'Daily affirmations',
    }, 'affirm I am strong');
    const sl = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '/tmp/x.json',
    }, undefined, span);
    hlState.activate(2, 'affirm I am strong'); // "am" — inside span
    const p = sl.buildPayload({ text: 'affirm I am strong', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBe('Daily affirmations');
    expect(p.cueBlank).toBe(true);
    expect(p.alts).toEqual(['I am strong', 'I am brave', '_']);
    expect(p.currentAltIndex).toBe(0);
  });

  // Pinning the manual-select-only rule (June 2026 user request): a
  // live spanFillState (BlankFill / fluid-blank / transform-blank /
  // agent-rewrite just substituted) MUST NOT make the statusline
  // active until the user explicitly navigates onto the span. The
  // payload stays { active: false } so chrome's runtime-statusbar
  // hides entirely and CC's status line consumer renders nothing.
  it('spanFillState set but hlState inactive → active=false (no auto-select after substitute)', async () => {
    const { SpanFillState } = await import('../state/span-fill');
    const adapter = new MockAdapter();
    adapter.pushText('affirm I am strong');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    // Mimic the post-substitute state: BlankFill just filled a span.
    // The user has NOT navigated onto it yet.
    span.set({
      index: 1,
      alternatives: ['I am strong', 'I am brave', '_'],
      currentAltIndex: 0,
      spanLength: 3,
      tip: 'Daily affirmations',
    }, 'affirm I am strong');
    const sl = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '/tmp/x.json',
    }, undefined, span);
    // hlState intentionally not activated — represents the moment
    // immediately after BlankFill landed.
    const p = sl.buildPayload({ text: 'affirm I am strong', cursor: 0, externalHighlights: [] });
    expect(p.active).toBe(false);
    expect(p.cueTip).toBeUndefined();
    expect(p.cueBlank).toBeUndefined();
    expect(p.alts).toBeUndefined();
  });

  it('selector word emits setting-level tip', async () => {
    const { SelectorSatelliteState } = await import('../state/selector-satellite');
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }),
        '/proj/CUES.md': OPENCUES_MD,
      },
    });
    adapter.pushText('voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const sl = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '/tmp/x.json',
    }, loader, undefined, ss);
    hlState.activate(0, 'voice-mode active'); // selector
    const p = sl.buildPayload({ text: 'voice-mode active', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBe('Gates TTS globally');
    expect(p.cueBlank).toBe(true);
  });

  it('satellite word emits per-value tip', async () => {
    const { SelectorSatelliteState } = await import('../state/selector-satellite');
    const OPENCUES_MD = `---
voice-mode: active
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS silenced
---`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': JSON.stringify({ domain: 't', version: 1, concepts: [] }),
        '/proj/CUES.md': OPENCUES_MD,
      },
    });
    adapter.pushText('voice-mode active');
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/CUES.md' });
    await loader.load();
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const ss = new SelectorSatelliteState();
    ss.set({
      blankName: 'opencues',
      scriptPath: '',
      selectorIndex: 0,
      selectorLength: 1,
      satelliteIndex: 1,
      satelliteLength: 1,
      currentSetting: 'voice-mode',
      currentValue: 'active',
      separator: ' ',
      clearOnEdit: false,
    }, 'voice-mode active');
    const sl = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '/tmp/x.json',
    }, loader, undefined, ss);
    hlState.activate(1, 'voice-mode active'); // satellite
    const p = sl.buildPayload({ text: 'voice-mode active', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBe('TTS reads tips aloud');
    expect(p.cueBlank).toBe(true);
  });

  it('highlight outside the span uses cueMap (no span tip leakage)', async () => {
    const { SpanFillState } = await import('../state/span-fill');
    const adapter = new MockAdapter();
    adapter.pushText('foo I am strong');
    const hlState = new HighlightState();
    const dynDefs = new DynDefs();
    const span = new SpanFillState();
    span.set({
      index: 1,
      alternatives: ['I am strong'],
      currentAltIndex: 0,
      spanLength: 3,
      tip: 'Daily affirmations',
    }, 'foo I am strong');
    const sl = new Statusline(adapter, hlState, dynDefs, {
      exportPath: '/tmp/x.json',
    }, undefined, span);
    hlState.activate(0, 'foo I am strong'); // "foo" — outside span
    const p = sl.buildPayload({ text: 'foo I am strong', cursor: 0, externalHighlights: [] });
    expect(p.cueTip).toBeNull();
    expect(p.cueBlank).toBe(false);
  });

  it('writes inactive payload after typing clears highlight', async () => {
    const { adapter, hlState } = setup('alpha');
    hlState.activate(0, 'alpha');
    adapter.fireRender();
    await new Promise(r => setImmediate(r));
    let written = await adapter.readFile('/tmp/test-statusline.json');
    expect(JSON.parse(written!).active).toBe(true);

    hlState.deactivate();
    adapter.fireRender();
    await new Promise(r => setImmediate(r));
    written = await adapter.readFile('/tmp/test-statusline.json');
    expect(JSON.parse(written!).active).toBe(false);
  });
});
