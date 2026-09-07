/**
 * Semantic tips — user journeys (docs/architecture/semantic-tips.md).
 *
 * The matcher's own grounding is unit-tested in core
 * (semantic-tips-source.test.ts). What lives here is the RUNTIME contract
 * once its result reaches the resolver: the def lands as a sentence-cue on
 * the WHOLE buffer, `_` swaps the prompt for the solution and wraps back,
 * the note paints ONE emoji, and a tip with nothing to cycle to is an
 * advisory that `_` dismisses. The LLM is scripted (the resolver's
 * `_resolver` is patched), so nothing here depends on a model's phrasing.
 *
 * Fixtures are synthetic on purpose (CLAUDE.md § fixtures must not look
 * like product output).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Resolver } from './resolver';
import { Cycling } from './cycling';
import { ConfigLoader } from './config-loader';
import { DimRender } from './dim-render';
import { Statusline } from './statusline';
import { HighlightState } from '../state/highlight-state';
import { DynDefs, _resetCycledEverForTests } from '../state/dyn-defs';
import { _resetCueDismissalsForTests } from '../state/cue-dismissals';
import { MockAdapter } from '../../testing/mock-adapter';

afterEach(() => { _resetCueDismissalsForTests(); _resetCycledEverForTests(); });

interface Scripted {
  wordIndex: number; word: string; alternatives: string[]; source: string; priority: number;
  spanStart: number; spanEnd: number; cueTip: string; metadata: Record<string, unknown>;
}

/** the result SemanticTipsSource emits for a COMMAND tip: whole buffer → solution */
function commandTip(text: string, solution: string): Scripted {
  return {
    wordIndex: 0, word: text.split(/\s+/)[0], alternatives: [text, solution],
    source: 'sentence-cue:tip', priority: 86, spanStart: 0, spanEnd: text.length,
    cueTip: '💡 ALT-SAY beginning again? /zap resets the zorb',
    metadata: { sentenceCue: { cueName: 'tip' }, tip: { id: 't1', trigger: '/zap', section: 'zeta', alts: [], command: true } },
  };
}
/** the result for a PROSE tip with no rewrite: an advisory on the flagged clause */
function advisoryTip(text: string, quote: string): Scripted {
  const so = text.indexOf(quote);
  const wi = text.slice(0, so).split(/\s+/).filter(Boolean).length;
  return {
    wordIndex: wi, word: text.split(/\s+/)[wi], alternatives: [quote],
    source: 'sentence-cue:tip', priority: 86, spanStart: so, spanEnd: so + quote.length,
    cueTip: '💡 ALT-THREE quux is spendy',
    metadata: { sentenceCue: { cueName: 'tip' }, tip: { id: 't3', trigger: 'quux', section: 'eta', alts: [], command: false } },
  };
}

async function setupScenario(text: string, scripted: Scripted[]) {
  const adapter = new MockAdapter({ files: { '/mock/CUES.md': '---\ndomain: test\n---\n' } });
  adapter.pushTextNoKeystroke(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter);
  await loader.load();
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  });
  (resolver as unknown as { _resolver: { resolve(ctx: unknown): Promise<{ results: Scripted[] }> } })._resolver = {
    resolve: async () => ({ results: scripted }),
  };
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  const dim = new DimRender(adapter, hlState, dynDefs, loader);
  await resolver.resolveAndApply(text);
  return { adapter, dynDefs, dim, resolver };
}

describe('semantic tips — a command tip is a solution', () => {
  const TEXT = 'ok this is a mess, begin again on the zorb';

  it('registers on the WHOLE buffer as a sentence-cue with [original, solution]', async () => {
    const { dynDefs } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    const def = dynDefs.get(0);
    expect(def).toBeDefined();
    expect(def!.blankName).toBe('sentence-cue:tip');
    expect(def!.spanStart).toBe(0);
    expect(def!.spanEnd).toBe(TEXT.length);
    expect(def!.alternatives).toEqual([TEXT, '/zap']);
    expect(def!.currentIndex).toBe(0);            // passive: the buffer is untouched
  });

  it('the note paints ONE emoji and the advice line naming the command; the hint is the verb', async () => {
    const { dim } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    const note = dim.compute({ text: TEXT, cursor: 3, externalHighlights: [] })?.inlineNote;
    expect(note?.text).toBe('💡 ALT-SAY beginning again? /zap resets the zorb');
    expect(note?.text).not.toContain('⚠');
    expect(note?.hint).toBe('(underscore to apply)');
  });
  it('a command tip whose note does not name the command gets the solution after an arrow', async () => {
    const bare: Scripted = { ...commandTip(TEXT, '/zap'), cueTip: '💡 ALT-ONE zap resets the zorb' };
    const { dim } = await setupScenario(TEXT, [bare]);
    expect(dim.compute({ text: TEXT, cursor: 3, externalHighlights: [] })?.inlineNote?.text).toBe('💡 ALT-ONE zap resets the zorb → /zap');
  });
  it('after the press the note reads what it was, snippeted, and the hint says revert', async () => {
    const { adapter, dim } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    adapter.pushTextNoKeystroke(TEXT, 3);
    adapter.fireKey('_');
    const note = dim.compute({ text: '/zap', cursor: 2, externalHighlights: [] })?.inlineNote;
    expect(note?.text).toBe('💡 was: ok this is a mess, begin again on…');   // 8 words, then …
    expect(note?.hint).toBe('(underscore to revert)');
  });
  it('a prose tip shows the rewrite it applies and the hint says apply', async () => {
    const T2 = 'fix the login bug please';
    const prose: Scripted = { ...commandTip(T2, 'fix the login bug: [paste the error text and what fixed looks like] please'), cueTip: '💡 ALT-TWO paste the error' };
    const { dim } = await setupScenario(T2, [prose]);
    const note = dim.compute({ text: T2, cursor: 2, externalHighlights: [] })?.inlineNote;
    expect(note?.text).toBe('💡 ALT-TWO paste the error → fix the login bug: [paste the error text…');
    expect(note?.hint).toBe('(underscore to apply)');
  });

  it('underscore → the whole prompt becomes the solution → underscore → wraps back', async () => {
    const { adapter, dynDefs } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    adapter.pushTextNoKeystroke(TEXT, 3);           // caret inside the span
    adapter.fireKey('_');
    expect(adapter.setTextCalls.at(-1)).toBe('/zap');
    expect(dynDefs.get(0)?.currentIndex).toBe(1);
    adapter.pushTextNoKeystroke('/zap', 2);
    adapter.fireKey('_');
    expect(adapter.setTextCalls.at(-1)).toBe(TEXT);   // the wrap IS the revert
    expect(dynDefs.get(0)?.currentIndex).toBe(0);
  });

  it('the underscore is consumed, never typed into the buffer', async () => {
    const { adapter } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    adapter.pushTextNoKeystroke(TEXT, 3);
    adapter.fireKey('_');
    expect(adapter.setTextCalls.some((t) => t.includes('_'))).toBe(false);
  });
});

describe('semantic tips — a prose tip with no rewrite is an advisory', () => {
  const TEXT = 'this is so spendy today honestly';
  const QUOTE = 'so spendy';

  it('registers on the flagged clause only, with nothing to cycle to', async () => {
    const { dynDefs } = await setupScenario(TEXT, [advisoryTip(TEXT, QUOTE)]);
    const def = dynDefs.get(advisoryTip(TEXT, QUOTE).wordIndex);
    expect(def?.blankName).toBe('sentence-cue:tip');
    expect(def?.spanStart).toBe(TEXT.indexOf(QUOTE));
    expect(def?.spanEnd).toBe(TEXT.indexOf(QUOTE) + QUOTE.length);
  });

  it('the note offers dismiss, and underscore mutes it without touching the buffer', async () => {
    const { adapter, dim } = await setupScenario(TEXT, [advisoryTip(TEXT, QUOTE)]);
    const at = TEXT.indexOf(QUOTE) + 1;
    expect(dim.compute({ text: TEXT, cursor: at, externalHighlights: [] })?.inlineNote).toMatchObject({
      text: '💡 ALT-THREE quux is spendy', hint: '(underscore to dismiss)',
    });
    const before = adapter.setTextCalls.length;
    adapter.pushTextNoKeystroke(TEXT, at);
    adapter.fireKey('_');
    expect(adapter.setTextCalls.length).toBe(before);   // no buffer write
    expect(dim.compute({ text: TEXT, cursor: at, externalHighlights: [] })?.inlineNote?.hint)
      .toBe('(muted · underscore again to forget)');
  });
});

// ── the mode gates the catalogue, static and semantic coexist, priority wins ──
const PACK_MD = `# zeta\n\n## Tips\n\`\`\`json\n[{ "id": "zeta", "words": { "/zap": { "tip": "ALT-ONE zap resets the zorb", "when": "wants to begin again", "alts": ["/zip"] } } }]\n\`\`\`\n`;

async function setupWithMode(mode: string, text: string, scripted: Scripted[]) {
  const seen: Array<Record<string, unknown>> = [];
  const adapter = new MockAdapter({ files: { '/mock/CUES.md': PACK_MD, '/p/OPENCUES.md': `---\ntips-mode: ${mode}\n---\n` } });
  adapter.pushTextNoKeystroke(text);
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const loader = new ConfigLoader(adapter, { settingsFile: '/p/OPENCUES.md' });
  await loader.load();
  const resolver = new Resolver(adapter, hlState, dynDefs, loader, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {},
  });
  (resolver as unknown as { _resolver: { resolve(ctx: Record<string, unknown>): Promise<{ results: Scripted[] }> } })._resolver = {
    resolve: async (ctx) => { seen.push(ctx); return { results: scripted }; },
  };
  const cycling = new Cycling(adapter, hlState, dynDefs, loader);
  cycling.subscribe();
  const dim = new DimRender(adapter, hlState, dynDefs, loader);
  await resolver.resolveAndApply(text);
  return { adapter, dynDefs, dim, seen, loader, hlState };
}

describe('semantic tips — tips-mode gates the catalogue the resolver forwards', () => {
  const TEXT = 'begin again on the zorb';
  it('semantic → the catalogue rides the CueContext', async () => {
    const { seen } = await setupWithMode('semantic', TEXT, []);
    const cat = seen[0]?.tipsCatalog as { entries: unknown[]; text: string } | undefined;
    expect(cat?.entries).toHaveLength(1);
    expect(cat?.text).toContain('/zap — when: wants to begin again');
  });
  it('off → no catalogue; legacy `on` and the retired `definitions` read as semantic', async () => {
    expect((await setupWithMode('definitions', TEXT, [])).seen[0]?.tipsCatalog).toBeDefined();
    expect((await setupWithMode('off', TEXT, [])).seen[0]?.tipsCatalog).toBeUndefined();
    expect((await setupWithMode('on', TEXT, [])).seen[0]?.tipsCatalog).toBeDefined();
  });
  it('a typed pack word is a plain word: no static entry, no def, no nav target (the static layer left with spec 0.12)', async () => {
    const { loader, dynDefs } = await setupWithMode('semantic', 'run /zap now', []);
    expect(loader.lookup('/zap')).toBeNull();
    expect(loader.navigableWords.has('/zap')).toBe(false);
    expect(dynDefs.size).toBe(0);
  });
  it('the retired `definitions` value reads as semantic', async () => {
    const { loader } = await setupWithMode('definitions', 'run /zap now', []);
    expect(loader.opencuesState.tipsMode).toBe('semantic');
    expect(loader.lookup('/zap')).toBeNull();
  });
  it('off → no cue map either', async () => {
    const { loader } = await setupWithMode('off', TEXT, []);
    expect(loader.opencuesState.tipsMode).toBe('off');
    expect(loader.lookup('/zap')).toBeNull();
  });
});

describe('semantic tips — a word-cue def and a semantic advisory on one buffer', () => {
  const TEXT = 'run /zap then this is so spendy today';
  // A typed pack word is a plain word now: an LLM word-cue on it registers a
  // def like on any other word (the curated-list guard left with the static
  // map), and the semantic advisory lands on its own clause beside it.
  const wordCue: Scripted = {
    wordIndex: 1, word: '/zap', alternatives: ['/zap', 'ALT-LLM'], source: 'llm', priority: 60,
    spanStart: 0, spanEnd: 0, cueTip: 'a synonym the model offered', metadata: {},
  } as Scripted;
  it('both register: the word-cue def on the word, the advisory on the clause', async () => {
    const { dynDefs, loader } = await setupWithMode('semantic', TEXT, [wordCue, advisoryTip(TEXT, 'so spendy')]);
    expect(dynDefs.get(1)?.alternatives).toEqual(['/zap', 'ALT-LLM']);
    expect(loader.lookup('/zap')).toBeNull();
    const adv = dynDefs.get(advisoryTip(TEXT, 'so spendy').wordIndex);
    expect(adv?.blankName).toBe('sentence-cue:tip');
  });
  it('cycling the word swaps ITS alternative; underscore on the clause mutes the advisory', async () => {
    const { adapter, dim, hlState } = await setupWithMode('semantic', TEXT, [wordCue, advisoryTip(TEXT, 'so spendy')]);
    hlState.activate(1, TEXT);
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('run ALT-LLM then this is so spendy today');
    hlState.deactivate();
    const at = 'run ALT-LLM then this is '.length + 1;
    adapter.pushTextNoKeystroke('run ALT-LLM then this is so spendy today', at);
    const before = adapter.setTextCalls.length;
    adapter.fireKey('_');
    expect(adapter.setTextCalls.length).toBe(before);
    expect(dim.compute({ text: 'run ALT-LLM then this is so spendy today', cursor: at, externalHighlights: [] })?.inlineNote?.hint)
      .toBe('(muted · underscore again to forget)');
  });
});

describe('semantic tips — a contradiction on the same span outranks the tip', () => {
  // Core queries sources in priority order and returns results in that
  // order (contradiction 87/88 before tips 86); the runtime's first claim on
  // a span wins. So the arrival order below IS the priority order — the
  // reversed order cannot occur in production and is not a contract.
  const TEXT = 'lets add the redis package and begin again';
  const contradiction: Scripted = {
    wordIndex: 0, word: 'lets', alternatives: [TEXT, 'lets keep it dependency-free and begin again'],
    source: 'sentence-cue:session-contradiction', priority: 88, spanStart: 0, spanEnd: TEXT.length,
    cueTip: '⚠ no new deps', metadata: { sentenceCue: { cueName: 'session-contradiction' } },
  };
  it('the def on the buffer is the contradiction; the tip on the same span is dropped', async () => {
    const { dynDefs } = await setupWithMode('semantic', TEXT, [contradiction, commandTip(TEXT, '/zap')]);
    const defs = Array.from({ length: TEXT.split(/\s+/).length }, (_, i) => dynDefs.get(i)).filter(Boolean);
    expect(defs.map((d) => d!.blankName)).toEqual(['sentence-cue:session-contradiction']);
  });
});

// ── trailing whitespace: the NORMAL rule, no special reach ───────────────────
describe('semantic tips — a whole-buffer tip follows the normal span rule', () => {
  const TEXT = 'ok this is a mess, begin again on the zorb';
  it('caret at the end of the content is inside (end inclusive): the note is up and _ applies', async () => {
    const { adapter, dynDefs, dim } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    adapter.pushTextNoKeystroke(TEXT, TEXT.length);
    expect(dim.compute({ text: TEXT, cursor: TEXT.length, externalHighlights: [] })?.inlineNote?.hint).toBe('(underscore to apply)');
    adapter.fireKey('_');
    expect(adapter.setTextCalls.at(-1)).toBe('/zap');
    expect(dynDefs.get(0)?.currentIndex).toBe(1);
  });
  it('a typed trailing space puts the caret OUTSIDE: the note drops and _ is not the cue’s (W2 / W9, like every cue)', async () => {
    const { adapter, dynDefs, dim } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    const typed = TEXT + ' ';
    adapter.pushTextNoKeystroke(typed, typed.length);
    expect(dim.compute({ text: typed, cursor: typed.length, externalHighlights: [] })?.inlineNote).toBeUndefined();
    const before = adapter.setTextCalls.length;
    adapter.fireKey('_');
    expect(adapter.setTextCalls.length).toBe(before);
    expect(dynDefs.get(0)?.currentIndex).toBe(0);
    // backspace the space: the caret is back at the content end, the note returns
    adapter.pushTextNoKeystroke(TEXT, TEXT.length);
    expect(dim.compute({ text: TEXT, cursor: TEXT.length, externalHighlights: [] })?.inlineNote?.hint).toBe('(underscore to apply)');
  });
});

describe('semantic tips — the same cue re-resolved is a refresh, never a second def', () => {
  const TEXT = 'ok this is a mess, begin again on the zorb';
  it('resolving again after a trailing space keeps ONE def, and _ cycles it', async () => {
    const { adapter, dynDefs, resolver } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    const typed = TEXT + ' ';
    adapter.pushTextNoKeystroke(typed, typed.length);
    await resolver.resolveAndApply(typed);                    // the re-resolve after the space
    const live = Array.from(dynDefs.entries()).filter(([, d]) => d.blankName === 'sentence-cue:tip');
    expect(live.length).toBe(1);
    expect(live[0][0]).toBe(0);
    adapter.pushTextNoKeystroke(typed, TEXT.length);         // caret at the content end (inside), not after the space
    adapter.fireKey('_');
    expect(adapter.setTextCalls.at(-1)).toBe('/zap ');
    const after = Array.from(dynDefs.entries()).filter(([, d]) => d.blankName === 'sentence-cue:tip');
    expect(after.length).toBe(1);
    expect(after[0][1].currentIndex).toBe(1);
  });
});

describe('semantic tips — typing more content after the flag grows the one def', () => {
  const TEXT = 'ok this is a mess, begin again on the zorb';
  it('the re-resolve on the longer draft updates the span and the original; _ then swaps the whole new draft', async () => {
    const { adapter, dynDefs, resolver } = await setupScenario(TEXT, [commandTip(TEXT, '/zap')]);
    const longer = TEXT + ' and the quux too';
    adapter.pushTextNoKeystroke(longer, longer.length);
    (resolver as unknown as { _resolver: { resolve(): Promise<{ results: Scripted[] }> } })._resolver = {
      resolve: async () => ({ results: [commandTip(longer, '/zap')] }),
    };
    await resolver.resolveAndApply(longer);
    const live = Array.from(dynDefs.entries()).filter(([, d]) => d.blankName === 'sentence-cue:tip');
    expect(live.length).toBe(1);
    expect(live[0][1].spanEnd).toBe(longer.length);
    expect(live[0][1].alternatives[0]).toBe(longer);
    adapter.fireKey('_');
    expect(adapter.setTextCalls.at(-1)).toBe('/zap');           // the WHOLE new draft swapped
    adapter.pushTextNoKeystroke('/zap', 2);
    adapter.fireKey('_');
    expect(adapter.setTextCalls.at(-1)).toBe(longer);            // and the whole new draft comes back
  });
});

describe('a one-sentence contradiction cue follows the same normal rule', () => {
  it('caret after a trailing space is OUTSIDE the sentence: no note, _ is not the cue’s', async () => {
    const TEXT = 'lets meet zorbday the 19th';
    const contradiction: Scripted = {
      wordIndex: 0, word: 'lets', alternatives: [TEXT, 'lets meet quuxday the 19th'],
      source: 'sentence-cue:contradiction-weekday-date', priority: 87, spanStart: 0, spanEnd: TEXT.length,
      cueTip: '⚠ the 19th is a quuxday', metadata: { sentenceCue: { cueName: 'contradiction-weekday-date' } },
    };
    const { adapter, dim, dynDefs } = await setupScenario(TEXT, [contradiction]);
    const typed = TEXT + ' ';
    adapter.pushTextNoKeystroke(typed, typed.length);
    expect(dim.compute({ text: typed, cursor: typed.length, externalHighlights: [] })?.inlineNote).toBeUndefined();
    const before = adapter.setTextCalls.length;
    adapter.fireKey('_');
    expect(adapter.setTextCalls.length).toBe(before);          // not consumed by the cue
    expect(dynDefs.get(0)?.currentIndex).toBe(0);
  });
});

describe('semantic tips — a whole-buffer tip registers over a word-cue def inside it (semantic outranks a word cue)', () => {
  const wordDef = (word: string, start: number, alt: string) => ({ originalWord: word, alternatives: [word, alt], currentIndex: 0, spanStart: start, spanEnd: start + word.length, cueSource: 'llm', cueTip: `ALT-STATIC ${word}` });
  it('the whole-buffer tip anchored on a word that already has a def registers over it', async () => {
    const TEXT = 'zorbo what we just did';
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': '---\ndomain: test\n---\n', '/p/OPENCUES.md': '---\ntips-mode: semantic\n---\n' } });
    adapter.pushTextNoKeystroke(TEXT);
    const hlState = new HighlightState(); const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/p/OPENCUES.md' }); await loader.load();
    dynDefs.set(0, wordDef('zorbo', 0, 'zorbi'));
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} });
    (resolver as unknown as { _resolver: { resolve(): Promise<{ results: Scripted[] }> } })._resolver = { resolve: async () => ({ results: [commandTip(TEXT, '/zap')] }) };
    new Cycling(adapter, hlState, dynDefs, loader).subscribe();
    await resolver.resolveAndApply(TEXT);
    expect(dynDefs.get(0)?.blankName).toBe('sentence-cue:tip');
    expect(dynDefs.get(0)?.alternatives).toEqual([TEXT, '/zap']);
    adapter.pushTextNoKeystroke(TEXT, TEXT.length);
    adapter.fireKey('_');
    expect(adapter.setTextCalls.at(-1)).toBe('/zap');
  });
  it('a word-cue def cycled BEFORE the tip lands, inside its span: the status line and the next arrow are the tip’s', async () => {
    const TEXT = 'so zorbo what we just did';
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': '---\ndomain: test\n---\n', '/p/OPENCUES.md': '---\ntips-mode: semantic\ninline-cues-mode: secondary\n---\n' } });
    adapter.pushTextNoKeystroke(TEXT);
    const hlState = new HighlightState(); const dynDefs = new DynDefs();
    const loader = new ConfigLoader(adapter, { settingsFile: '/p/OPENCUES.md' }); await loader.load();
    dynDefs.set(1, wordDef('zorbo', 3, 'zorbi'));
    new Cycling(adapter, hlState, dynDefs, loader).subscribe();
    const statusline = new Statusline(adapter, hlState, dynDefs, { exportPath: '/tmp/test-statusline.json' }, loader);
    // 1. the word is arrow-cycled while no tip exists yet
    hlState.activate(1, TEXT);
    adapter.fireKey('up', { ctrl: true, alt: true });
    const CYCLED = 'so zorbi what we just did';
    expect(adapter.setTextCalls.at(-1)).toBe(CYCLED);
    expect(dynDefs.get(1)?.blankName).toBeUndefined();
    hlState.deactivate();
    // 2. the matcher flags the whole draft → the tip registers OVER the word def
    const resolver = new Resolver(adapter, hlState, dynDefs, loader, { endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', debounceMs: 10, httpAdapter: {} });
    (resolver as unknown as { _resolver: { resolve(): Promise<{ results: Scripted[] }> } })._resolver = { resolve: async () => ({ results: [commandTip(CYCLED, '/zap')] }) };
    await resolver.resolveAndApply(CYCLED);
    expect(dynDefs.get(0)?.blankName).toBe('sentence-cue:tip');
    // 3. caret on the cycled word: the status line shows the TIP
    hlState.activate(1, CYCLED);
    const p = statusline.buildPayload({ text: CYCLED, cursor: 3, externalHighlights: [] });
    expect(p.cueTip).toBe(commandTip(CYCLED, '/zap').cueTip);
    expect(p.cueBlank).toBe(true);
    // 4. the next arrow on that word cycles the TIP (whole draft → solution)
    adapter.fireKey('up', { ctrl: true, alt: true });
    expect(adapter.setTextCalls.at(-1)).toBe('/zap');
  });
});
