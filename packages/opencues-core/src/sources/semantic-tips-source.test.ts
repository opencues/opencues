import { describe, it, expect } from 'vitest';
import { entryCommand, isGroundedCommandLine, isGroundedRewrite, SemanticTipsSource } from './semantic-tips-source';
import { buildTipsCatalog, TIPS_CATALOG_BUDGET_CHARS, TIPS_CATALOG_HEADER } from '../tips-catalog';
import { getProvider } from '../llm-provider';
import type { CueContext, HttpAdapter, LocalCueData } from '../types';

function makeMockAdapter(content: string): HttpAdapter {
  return { post: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
}

// Synthetic pack — fixtures must not look like product output.
const PACK: LocalCueData = [
  { id: 'zeta', words: {
    '/zap': { tip: 'ALT-ONE zap resets the zorb', when: 'wants to begin again from nothing', say: 'ALT-SAY beginning again? /zap resets the zorb', alts: ['/zip'] },
    '/zip': { tip: 'ALT-TWO zip folds the zorb', when: 'says the zorb lost track mid-task', emoji: '🧭', alts: ['/zap'] },
  } },
  { id: 'eta', groups: [{ synonyms: ['quux', 'quuux'], tip: 'ALT-THREE quux is spendy', when: 'complains about spend', alts: [] }] },
];
const CATALOG = buildTipsCatalog(PACK);

function ctx(text: string, catalog = CATALOG): CueContext {
  return { text, words: text.split(/\s+/).filter(Boolean), tipsCatalog: catalog };
}
const baseConfig = { provider: getProvider('groq')!, endpoint: 'https://example.test/v1/chat/completions', apiKey: 'test-key', model: 'test-model' };

describe('buildTipsCatalog', () => {
  it('numbers entries t1.. across sections, groups before words within a section, and renders when: lines', () => {
    expect(CATALOG.entries.map((e) => e.id)).toEqual(['t1', 't2', 't3']);
    expect(CATALOG.entries[2].trigger).toBe('quux / quuux');
    expect(CATALOG.text).toContain('- t1 [zeta] /zap — when: wants to begin again from nothing — tip: ALT-ONE zap resets the zorb');
    expect(CATALOG.dropped).toEqual([]);
  });
  it('drops entries past the char budget, in pack order, and reports them', () => {
    const small = buildTipsCatalog(PACK, { budgetChars: 320 });
    expect(small.entries.length).toBeLessThan(3);
    expect(small.dropped.length).toBe(3 - small.entries.length);
    expect(TIPS_CATALOG_BUDGET_CHARS).toBeGreaterThan(10000);
  });
  it('is a watchlist of SITUATIONS: entries without when: are left out and ids stay dense; a pack with no when: at all keeps every entry', () => {
    const mixed = buildTipsCatalog([{ id: 'm', words: {
      zorb: { tip: 'ALT-DEF only', alts: [] },
      zorbo: { tip: 'ALT-SIT', when: 'wants the zorbo', alts: [] },
      zorbu: { tip: 'ALT-DEF too', alts: [] },
      zorbi: { tip: 'ALT-SIT two', when: 'lost the zorbi', alts: [] },
    } }]);
    expect(mixed.entries.map((e) => [e.id, e.trigger])).toEqual([['t1', 'zorbo'], ['t2', 'zorbi']]);
    expect(mixed.text).not.toContain('ALT-DEF');
    const bare = buildTipsCatalog([{ id: 'b', words: { zorb: { tip: 'ALT-DEF only', alts: [] }, zorbu: { tip: 'ALT-DEF too', alts: [] } } }]);
    expect(bare.entries.map((e) => e.id)).toEqual(['t1', 't2']);
    expect(bare.text).toContain('ALT-DEF only');
  });
  it('shards on section boundaries at shardSize; a section larger than a shard splits by lines; no size → one shard', () => {
    const big: LocalCueData = [
      { id: 'a', words: { a1: { tip: 'A1', when: 'w', alts: [] }, a2: { tip: 'A2', when: 'w', alts: [] } } },
      { id: 'b', words: { b1: { tip: 'B1', when: 'w', alts: [] }, b2: { tip: 'B2', when: 'w', alts: [] } } },
      { id: 'c', words: { c1: { tip: 'C1', when: 'w', alts: [] }, c2: { tip: 'C2', when: 'w', alts: [] }, c3: { tip: 'C3', when: 'w', alts: [] }, c4: { tip: 'C4', when: 'w', alts: [] }, c5: { tip: 'C5', when: 'w', alts: [] } } },
      { id: 'd', words: { d1: { tip: 'D1', when: 'w', alts: [] } } },
    ];
    const cat = buildTipsCatalog(big, { shardSize: 4 });
    expect(cat.entries.map((e) => e.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']);
    const ids = cat.shards.map((sh) => [...sh.matchAll(/^- (t\d+) /gm)].map((m) => m[1]));
    // a+b fill one shard (4); c is bigger than a shard on its own → split 4+1; d fits after c's tail
    expect(ids).toEqual([['t1', 't2', 't3', 't4'], ['t5', 't6', 't7', 't8'], ['t9'], ['t10']]);
    for (const sh of cat.shards) expect(sh.startsWith(TIPS_CATALOG_HEADER)).toBe(true);
    expect(buildTipsCatalog(big).shards).toHaveLength(1);
    expect(buildTipsCatalog(big).shards[0]).toBe(buildTipsCatalog(big).text);
    expect(buildTipsCatalog(big, { shardSize: 100 }).shards).toHaveLength(1);
    // balanced: 10 entries at a ceiling of 9 → two shards of ~5, not 9 + 1
    const two = buildTipsCatalog(big, { shardSize: 9 }).shards.map((sh) => [...sh.matchAll(/^- (t\d+) /gm)].length);
    expect(two).toEqual([4, 5, 1]);   // a+b (4), c (5) is a whole section, d (1) — sections stay whole, shards stay small
    expect(buildTipsCatalog([]).shards).toEqual([]);
  });
  it('renders nothing for an empty pack', () => {
    expect(buildTipsCatalog([]).text).toBe('');
    expect(buildTipsCatalog(undefined).entries).toEqual([]);
  });
});

describe('SemanticTipsSource.supports', () => {
  it('needs a non-empty buffer AND a non-empty catalogue', () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[]') });
    expect(s.supports(ctx('begin again please'))).toBe(true);
    expect(s.supports(ctx(''))).toBe(false);
    expect(s.supports({ text: 'x', words: ['x'] })).toBe(false);
    expect(s.supports(ctx('x', buildTipsCatalog([])))).toBe(false);
  });
});

describe('SemanticTipsSource.getCues — grounding', () => {
  it('emits a passive advisory with the PACK tip text for a grounded flag', async () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter(
      '[{"quote":"lets begin again from nothing","tipId":"t1","why":"fresh start"}]') });
    const r = await s.getCues(ctx('ok lets begin again from nothing on the zorb'));
    expect(r.results).toHaveLength(1);
    const c = r.results[0];
    expect(c.source).toBe('sentence-cue:tip');
    expect(c.priority).toBe(86);
    expect(c.cueTip).toBe('💡 ALT-SAY beginning again? /zap resets the zorb');   // the say: line, no model text
    // /zap is a command trigger: the WHOLE buffer is the span and the
    // solution is the bare trigger when the model gave no apply
    expect(c.alternatives).toEqual(['ok lets begin again from nothing on the zorb', '/zap']);
    expect(c.spanStart).toBe(0);
    expect(c.spanEnd).toBe('ok lets begin again from nothing on the zorb'.length);
    expect(c.wordIndex).toBe(0);
  });
  it('a command tip keeps the model’s apply only when it starts with the trigger', async () => {
    const good = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"begin again","tipId":"t1","apply":"/zap the zorb gently"}]') });
    expect((await good.getCues(ctx('begin again'))).results[0].alternatives).toEqual(['begin again', '/zap the zorb gently']);
    const bad = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"begin again","tipId":"t1","apply":"rm -rf /"}]') });
    expect((await bad.getCues(ctx('begin again'))).results[0].alternatives).toEqual(['begin again', '/zap']);
  });
  it('a plain-word trigger whose say: names a command is a COMMAND tip — the solution is the pack’s command, never the model’s rewrite', async () => {
    // Wilfred's live test, 2026-09-07: `_` on the undo tip put the tip's
    // SENTENCE in the buffer, because the model "rewrote" the quote into the
    // tip text and a plain-word trigger counted as prose.
    const pack = buildTipsCatalog([{ id: 'u', words: {
      zundo: { tip: 'ALT-TIP use /zrewind to undo', when: 'wants to take back what it did', say: 'ALT-SAY take it back? /zrewind restores the zorb', alts: [] },
      zkey: { tip: 'ALT-TIP press Ctrl+Z', when: 'wants a key', say: 'ALT-SAY press Ctrl+Z twice', alts: [] },
    } }]);
    const TEXT = 'zundo what it just did to the zorb';
    const tipText = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter(
      `[{"quote":"zundo what it just did","tipId":"t1","apply":"ALT-SAY take it back? /zrewind restores the zorb"}]`) });
    const r = await tipText.getCues(ctx(TEXT, pack));
    expect(r.results[0].alternatives).toEqual([TEXT, '/zrewind']);    // whole buffer → the pack's command
    expect(r.results[0].spanStart).toBe(0);
    expect(r.results[0].spanEnd).toBe(TEXT.length);
    const withArgs = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter(
      `[{"quote":"zundo what it just did","tipId":"t1","apply":"/zrewind 2"}]`) });
    expect((await withArgs.getCues(ctx(TEXT, pack))).results[0].alternatives).toEqual([TEXT, '/zrewind 2']);   // starts with the command: kept
    // a say: line with a KEY, not a command, stays a prose tip: the rewrite is the model's
    const key = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter(
      `[{"quote":"zkey please","tipId":"t2","apply":"zkey please (Ctrl+Z twice)"}]`) });
    const k = await key.getCues(ctx('zkey please now', pack));
    expect(k.results[0].alternatives).toEqual(['zkey please', 'zkey please (Ctrl+Z twice)']);
    expect(k.results[0].spanStart).toBe(0); expect(k.results[0].spanEnd).toBe('zkey please'.length);
  });
  it('entryCommand: the trigger when it is one, else the first command the say: line names; a path is not a command', () => {
    expect(entryCommand({ trigger: '/zap', tip: 'x' })).toBe('/zap');
    expect(entryCommand({ trigger: '--zap / zap', tip: 'x' })).toBeUndefined();   // a launch flag cannot be applied inside the session
    expect(entryCommand({ trigger: 'zpar', tip: 'x', say: 'several at once? claude --zworktree gives each a checkout' })).toBeUndefined();
    expect(entryCommand({ trigger: 'zundo', tip: 'use /zrewind', say: 'take it back? /zrewind restores; /zclear between' })).toBe('/zrewind');
    expect(entryCommand({ trigger: 'zundo', tip: 'use /zrewind now' })).toBe('/zrewind');
    expect(entryCommand({ trigger: 'zwsl', tip: 'keep the repo under /home/you, not /mnt/c' })).toBeUndefined();   // paths (a bare `/word` still reads as a command — pack lines avoid it; the bench's solution column catches one)
    expect(entryCommand({ trigger: 'zwsl', tip: 'keep it under /mnt/c; then /zdoctor' })).toBe('/zdoctor');
    expect(entryCommand({ trigger: 'zkey', tip: 'press Ctrl+Z', say: 'press Ctrl+Z twice' })).toBeUndefined();
  });
  it('a command line keeps REAL arguments, but the pack’s own text behind the command or a <placeholder> collapses to the bare command', async () => {
    const e = { tip: 'ALT-TIP /zmcp list|enable|disable|reload manages ZMCP servers', say: 'Connecting a tool? /zmcp shows what is live' };
    expect(isGroundedCommandLine('/zmcp', '/zmcp', e)).toBe(true);
    expect(isGroundedCommandLine('/zmcp add my-db', '/zmcp', e)).toBe(true);
    expect(isGroundedCommandLine('/zmcp shows', '/zmcp', e)).toBe(true);                                                 // a short argument, even one the say line uses
    expect(isGroundedCommandLine('/zmcp list|enable|disable|reload manages ZMCP servers', '/zmcp', e)).toBe(false);   // the tip with the command in front
    expect(isGroundedCommandLine('/zmcp shows what is live', '/zmcp', e)).toBe(false);                                 // the say line
    expect(isGroundedCommandLine('/zmodel set <name>', '/zmodel', { tip: 'x' })).toBe(false);                            // a template
    expect(isGroundedCommandLine('/zother add', '/zmcp', e)).toBe(false);
    const pack = buildTipsCatalog([{ id: 'm', words: { '/zmcp': { tip: e.tip, when: 'wants to connect a tool', say: e.say, alts: [] } } }]);
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter(
      '[{"quote":"connect it to my db","tipId":"t1","apply":"/zmcp list|enable|disable|reload manages ZMCP servers"}]') });
    expect((await s.getCues(ctx('connect it to my db', pack))).results[0].alternatives).toEqual(['connect it to my db', '/zmcp']);
  });
  it('a prose rewrite that is the tip’s own text, or drops the person’s words, is not a solution — the note stays advisory', async () => {
    expect(isGroundedRewrite('think really hard about this', 'think really hard about this ultrathink', { tip: 'Add ultrathink', say: 'A hard one? Put ultrathink in the prompt' })).toBe(true);
    expect(isGroundedRewrite('think really hard about this', 'A hard one? Put ultrathink in the prompt', { tip: 'Add ultrathink', say: 'A hard one? Put ultrathink in the prompt' })).toBe(false);
    expect(isGroundedRewrite('think really hard about this', 'Add ultrathink to your prompt for max reasoning.', { tip: 'Add ultrathink to your prompt for max reasoning' })).toBe(false);
    expect(isGroundedRewrite('make it plan before it touches files', 'use plan mode first', { tip: 'x' })).toBe(false);
    const tipText = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"so spendy","tipId":"t3","apply":"ALT-THREE quux is spendy"}]') });
    expect((await tipText.getCues(ctx('this is so spendy today'))).results[0].alternatives).toEqual(['so spendy']);   // advisory
  });
  it('a prose tip rewrites the flagged sentence in place, and stays advisory without a rewrite', async () => {
    const rw = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"so spendy","tipId":"t3","apply":"so spendy: use quux sparingly"}]') });
    const r = await rw.getCues(ctx('this is so spendy today'));
    expect(r.results[0].alternatives).toEqual(['so spendy', 'so spendy: use quux sparingly']);
    expect(r.results[0].spanStart).toBe(8);
    const adv = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"so spendy","tipId":"t3"}]') });
    expect((await adv.getCues(ctx('this is so spendy today'))).results[0].alternatives).toEqual(['so spendy']);   // advisory: nothing to cycle to
  });
  it('drops a flag citing an id not in the catalogue', async () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"begin again","tipId":"t9"}]') });
    expect((await s.getCues(ctx('begin again'))).results).toEqual([]);
  });
  it('drops a flag whose quote is not a verbatim substring', async () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"begin  again","tipId":"t1"}]') });
    expect((await s.getCues(ctx('begin again'))).results).toEqual([]);
  });
  it('a typed command does NOT silence a match in code — semantic outranks static; redundancy is the matcher’s call', async () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"run /zap, then begin again","tipId":"t1","apply":"/zap"}]') });
    const r = await s.getCues(ctx('run /zap, then begin again'));
    expect(r.results).toHaveLength(1);
    expect(r.results[0].alternatives[1]).toBe('/zap');
  });
  it('a typed PLAIN-WORD trigger does not defer to the static path — the word is the situation', async () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"Quuux is so spendy","tipId":"t3","apply":"Quuux is so spendy: use quux sparingly"}]') });
    const r = await s.getCues(ctx('Quuux is so spendy'));
    expect(r.results).toHaveLength(1);
    expect(r.results[0].metadata?.tip).toMatchObject({ id: 't3' });
  });
  it('a typed FLAG trigger is not silenced in code either (advisory when the model gives no apply)', async () => {
    const pack: LocalCueData = [{ id: 'f', words: { '--zork': { tip: 'ALT-FLAG', when: 'wants zork', alts: [] } } }];
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"run it with --zork","tipId":"t1"}]') });
    const r = await s.getCues(ctx('run it with --zork', buildTipsCatalog(pack)));
    expect(r.results).toHaveLength(1);
    expect(r.results[0].alternatives).toEqual(['run it with --zork']);   // a launch flag is not a solution: advisory
  });
  it('never renders the model’s text — the note is the pack’s say: or tip; the why goes to metadata only', async () => {
    const long = 'x'.repeat(200);
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter(`[{"quote":"it lost track","tipId":"t2","why":"${long}"}]`) });
    const r = await s.getCues(ctx('it lost track of the zorb'));
    expect(r.results[0].cueTip).toBe('🧭 ALT-TWO zip folds the zorb');   // the pack's own emoji leads; no say: → the tip
    expect(((r.results[0].metadata as { tip: { why: string } }).tip.why).length).toBe(80);
  });
  it('a sharded catalogue is ONE call per shard, in parallel, each shard its own system message; flags merge in shard order and dedupe by span', async () => {
    const pack: LocalCueData = [
      { id: 'zeta', words: { '/zap': { tip: 'ALT-ONE', when: 'wants to begin again', alts: [] } } },
      { id: 'eta', words: { '/zip': { tip: 'ALT-TWO', when: 'says the zorb lost track', alts: [] } } },
    ];
    const cat = buildTipsCatalog(pack, { shardSize: 1 });
    expect(cat.shards).toHaveLength(2);
    const seen: string[] = [];
    const adapter: HttpAdapter = { post: async (_url: string, body: unknown) => {
      const sys = String((JSON.parse(String(body)) as { messages: Array<{ content: string }> }).messages[0].content);
      seen.push(sys);
      // shard 1 knows t1 only, shard 2 knows t2 only — each flags its own; both quote the same clause
      const reply = sys.includes('- t1 ') ? '[{"quote":"begin again","tipId":"t1","apply":"/zap"}]' : '[{"quote":"begin again","tipId":"t2","apply":"/zip"}]';
      return JSON.stringify({ choices: [{ message: { content: reply } }] });
    } };
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: adapter });
    const r = await s.getCues(ctx('begin again', cat));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('- t1 '); expect(seen[0]).not.toContain('- t2 ');
    expect(seen[1]).toContain('- t2 '); expect(seen[1]).not.toContain('- t1 ');
    expect(r.results).toHaveLength(1);                       // same span twice → the first shard's flag stands
    expect(r.results[0].alternatives).toEqual(['begin again', '/zap']);
  });
  it('caps at two flags and one per span', async () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter(
      '[{"quote":"begin again","tipId":"t1"},{"quote":"begin again","tipId":"t2"},{"quote":"lost track","tipId":"t2"},{"quote":"so spendy","tipId":"t3"}]') });
    // t1 and t2 are command tips: the first claims the WHOLE buffer, so the
    // rest are dropped as overlapping — one solution per prompt
    const r = await s.getCues(ctx('begin again. lost track. so spendy.'));
    expect(r.results.map((c) => c.metadata?.tip && (c.metadata.tip as { id: string }).id)).toEqual(['t1']);
  });
  it('returns [] on a failed call and on garbage output', async () => {
    const bad: HttpAdapter = { post: async () => { throw new Error('boom'); } };
    expect((await new SemanticTipsSource({ ...baseConfig, httpAdapter: bad }).getCues(ctx('begin again'))).results).toEqual([]);
    expect((await new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('nope') }).getCues(ctx('begin again'))).results).toEqual([]);
  });
});

describe('SemanticTipsSource — trailing whitespace is not content', () => {
  it('a command tip spans the trimmed buffer; the typed spaces stay outside the span', async () => {
    const s = new SemanticTipsSource({ ...baseConfig, httpAdapter: makeMockAdapter('[{"quote":"begin again","tipId":"t1","apply":"/zap"}]') });
    const text = 'lets begin again on the zorb  ';
    const r = await s.getCues({ text, words: text.split(/\s+/).filter(Boolean), tipsCatalog: CATALOG });
    const c = r.results[0];
    expect(c.spanStart).toBe(0);
    expect(c.spanEnd).toBe(text.trimEnd().length);
    expect(c.alternatives).toEqual(['lets begin again on the zorb', '/zap']);   // the original is the content, not the spaces
  });
});
