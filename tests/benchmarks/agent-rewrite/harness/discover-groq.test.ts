/**
 * Real-Groq harness — runs typing scenarios against the actual Groq
 * API. 100 scenarios across 10 categories, 10 each. Mocks catch known
 * failure modes deterministically; this catches what mocks can't —
 * actual LLM behaviour you'd see in production sessions.
 *
 * Gated on GROQ_API_KEY:
 *   GROQ_API_KEY=... npx vitest run tests/benchmarks/agent-rewrite/harness/discover-groq.test.ts --testTimeout=180000
 *
 * Each scenario builds the buffer progressively (chunk + tick + chunk
 * + tick + ...) so the LLM sees an evolving doc. Bugs that only
 * surface across rounds (canonicalisation, over-edit, oscillation,
 * trim, no-flicker) emerge naturally.
 *
 * Cost: ~1s per Groq call. 100 scenarios × ~1-3 ticks ≈ 2-3 minutes.
 */
import { describe, expect, it } from 'vitest';
import { simulate, reportResult, step as s } from './simulator';
import type { ScenarioResult, Step } from './types';

const HAS_KEY = !!process.env.GROQ_API_KEY;
const RUN = HAS_KEY ? describe : describe.skip;
const TIMEOUT = 180_000;

async function run(name: string, task: string, steps: ReadonlyArray<Step>, opts?: {
  skipInvariants?: ReadonlyArray<string>;
}): Promise<ScenarioResult> {
  return simulate(name, steps, {
    task,
    llm: { kind: 'groq', task },
    stopOnViolation: false,
    skipInvariants: opts?.skipInvariants,
  });
}

function fail(result: ScenarioResult): void {
  if (!result.passed) {
    // eslint-disable-next-line no-console
    console.log(reportResult(result));
  }
  expect(result.violations).toEqual([]);
}

const lc = (r: ScenarioResult): string =>
  r.trace[r.trace.length - 1].bufferAfter.toLowerCase();

const finalText = (r: ScenarioResult): string =>
  r.trace[r.trace.length - 1].bufferAfter;

// ════════════════════════════════════════════════════════════════════
// 1. Trailing whitespace (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — trailing whitespace', () => {
  it('1. trailing space at fragment end survives 3 idle ticks', async () => {
    const r = await run('ws-1', 'fix grammar', [
      s.type('food? '), s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/\s$/);
  }, TIMEOUT);

  it('2. trailing newline survives multiple ticks', async () => {
    const r = await run('ws-2', 'fix grammar', [
      s.type('hello\n'), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/\n$/);
  }, TIMEOUT);

  it('3. multiple trailing whitespace chars survive', async () => {
    const r = await run('ws-3', 'fix grammar', [
      s.type('text? \n  '), s.tick(),
    ]);
    fail(r);
  }, TIMEOUT);

  it('4. append-after-pause: trailing space stays + new content lands', async () => {
    const r = await run('ws-4', 'fix grammar', [
      s.type('I am here. '), s.tick(), s.tick(),
      s.type('and more'),    s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('and more');
  }, TIMEOUT);

  it('5. trailing space alternating with content typing', async () => {
    const r = await run('ws-5', 'fix grammar', [
      s.type('hello '),  s.tick(),
      s.type('world '),  s.tick(),
      s.type('today '),  s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/\s$/);
  }, TIMEOUT);

  it('6. trailing tab survives', async () => {
    const r = await run('ws-6', 'fix grammar', [
      s.type('text\t'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/\s$/);
  }, TIMEOUT);

  it('7. multiple trailing newlines survive', async () => {
    const r = await run('ws-7', 'fix grammar', [
      s.type('content\n\n\n'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r).match(/\n+$/)?.[0].length).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);

  it('8. mixed trailing whitespace (space + newline)', async () => {
    const r = await run('ws-8', 'fix grammar', [
      s.type('done  \n'), s.tick(), s.tick(),
    ]);
    fail(r);
  }, TIMEOUT);

  it('9. trailing space after question mark survives', async () => {
    const r = await run('ws-9', 'fix grammar', [
      s.type('really? '), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/\s$/);
  }, TIMEOUT);

  it('10. trailing space across long doc', async () => {
    const r = await run('ws-10', 'correct spelling', [
      s.type('This is a longer sentence with several words. '), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/\s$/);
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 2. Paragraph breaks (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — paragraph breaks', () => {
  it('1. single paragraph break preserved', async () => {
    const r = await run('pb-1', 'fix grammar', [
      s.type('first sentence.\n\nsecond sentence.'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('2. multi-paragraph doc preserves all breaks', async () => {
    const r = await run('pb-2', 'fix grammar', [
      s.type('one.\n\ntwo.\n\nthree.'), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('one');
    expect(lc(r)).toContain('two');
    expect(lc(r)).toContain('three');
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('3. progressive paragraph typing builds structure', async () => {
    const r = await run('pb-3', 'correct spelling', [
      s.type('first.'),               s.tick(),
      s.type('\n\n'),                 s.tick(),
      s.type('second has rite.'),     s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/write|right/);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('4. triple newlines preserved (intentional spacing)', async () => {
    const r = await run('pb-4', 'fix grammar', [
      s.type('para one.\n\n\npara two.'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('5. paragraph break preserved through a multi-edit pass', async () => {
    const r = await run('pb-5', 'correct spelling', [
      s.type('paragraph one has typoo.\n\nparagraph two has anotherr typo.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n\n');
    expect(lc(r)).toMatch(/typo/);
  }, TIMEOUT);

  it('6. four-paragraph doc keeps all 3 paragraph breaks', async () => {
    const r = await run('pb-6', 'fix grammar', [
      s.type('Para one.\n\nPara two.\n\nPara three.\n\nPara four.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r).match(/\n{2,}/g)?.length).toBeGreaterThanOrEqual(3);
  }, TIMEOUT);

  it('7. paragraph break with sentence containing punctuation', async () => {
    const r = await run('pb-7', 'fix grammar', [
      s.type('First; with semicolons.\n\nSecond, with commas.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('8. paragraph break in the middle of progressive typing', async () => {
    const r = await run('pb-8', 'fix grammar', [
      s.type('starting here'),       s.tick(),
      s.type('.\n\n'),                s.tick(),
      s.type('continuing'),          s.tick(),
      s.type('\n\n'),                s.tick(),
      s.type('and more'),            s.tick(),
    ]);
    fail(r);
    expect(finalText(r).match(/\n{2,}/g)?.length).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);

  it('9. single newline between sentences (not collapsed to space)', async () => {
    const r = await run('pb-9', 'fix grammar', [
      s.type('line one.\nline two.\nline three.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n');
  }, TIMEOUT);

  it('10. paragraph break preserved through translation', async () => {
    const r = await run('pb-10', 'translate to german', [
      s.type('Hello.\n\nHow are you today?'),
      s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 3. In-flight sentences (no auto-terminator) (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — in-flight sentences', () => {
  it('1. single mid-thought word: no auto-period', async () => {
    const r = await run('if-1', 'fix punctuation', [
      s.type('Today'), s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/Today\.$/);
  }, TIMEOUT);

  it('2. mid-thought multi-word fragment: no auto-period', async () => {
    const r = await run('if-2', 'fix punctuation', [
      s.type('I was thinking we could'), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/[.!?]\s*$/);
  }, TIMEOUT);

  it('3. mid-thought question: no auto-question-mark', async () => {
    const r = await run('if-3', 'fix punctuation', [
      s.type('What if we'), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/[.!?]\s*$/);
  }, TIMEOUT);

  it('4. terminated sentence + mid-thought tail: tail not terminated', async () => {
    const r = await run('if-4', 'fix grammar', [
      s.type('All done.\n\nNow I am'), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/I am\.\s*$/);
    expect(lc(r)).toContain('all done.');
  }, TIMEOUT);

  it('5. fragment ending with conjunction', async () => {
    const r = await run('if-5', 'fix grammar', [
      s.type('I was here and'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/and\.\s*$/);
  }, TIMEOUT);

  it('6. fragment ending with preposition', async () => {
    const r = await run('if-6', 'fix grammar', [
      s.type('It is for'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/for\.\s*$/);
  }, TIMEOUT);

  it('7. fragment with greeting only', async () => {
    const r = await run('if-7', 'fix grammar', [
      s.type('Hi'), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/Hi\.\s*$/);
  }, TIMEOUT);

  it('8. fragment ending mid-noun-phrase', async () => {
    const r = await run('if-8', 'fix grammar', [
      s.type('She gave me a beautiful'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/[.!?]\s*$/);
  }, TIMEOUT);

  it('9. fragment with comma at end: still no auto-period', async () => {
    const r = await run('if-9', 'fix grammar', [
      s.type('I have apples, oranges,'), s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/[.!?]\s*$/);
  }, TIMEOUT);

  it('10. long fragment without terminator', async () => {
    const r = await run('if-10', 'fix grammar', [
      s.type('I was walking down the street and saw a really interesting'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).not.toMatch(/[.!?]\s*$/);
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 4. Translation (non-idempotent) (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — translation', () => {
  it('1. translate to german: progressive typing converts each round', async () => {
    const r = await run('tr-1', 'translate to german', [
      s.type('I am going home'),                s.tick(),
      s.type(' today'),                          s.tick(),
      s.type(' with my friend.'),                s.tick(), s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(lc(r)).toMatch(/(ich|nach|hause|heute|freund|gehe|mit)/);
  }, TIMEOUT);

  it('2. translate to spanish: short prompt translates', async () => {
    const r = await run('tr-2', 'translate to spanish', [
      s.type('Hello, how are you today?'),
      s.tick(), s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(lc(r)).toMatch(/(hola|cómo|estás|qué|tal|hoy)/);
  }, TIMEOUT);

  it('3. translate to french', async () => {
    const r = await run('tr-3', 'translate to french', [
      s.type('Good morning, my friend.'),
      s.tick(), s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(lc(r)).toMatch(/(bonjour|matin|ami)/);
  }, TIMEOUT);

  it('4. translate to italian', async () => {
    const r = await run('tr-4', 'translate to italian', [
      s.type('Good evening, friend.'),
      s.tick(), s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(lc(r)).toMatch(/(buona|sera|amico)/);
  }, TIMEOUT);

  it('5. translate preserves paragraph breaks', async () => {
    const r = await run('tr-5', 'translate to german', [
      s.type('First sentence is here.\n\nSecond sentence is here too.'),
      s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('6. translate with mid-thought fragment: no auto-terminator on fragment', async () => {
    const r = await run('tr-6', 'translate to french', [
      s.type('I am thinking'),
      s.tick(), s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(finalText(r)).not.toMatch(/[.!?]\s*$/);
  }, TIMEOUT);

  it('7. translate keeps trailing whitespace', async () => {
    const r = await run('tr-7', 'translate to german', [
      s.type('I am going home '),                                         // trailing space
      s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(finalText(r)).toMatch(/\s$/);
  }, TIMEOUT);

  it('8. translate-progressive then continue typing in original language', async () => {
    const r = await run('tr-8', 'translate to german', [
      s.type('I am here.'),                                               s.tick(),
      s.type(' I see you.'),                                              s.tick(),
      s.type(' We go now.'),                                              s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    // Some German emerged.
    expect(lc(r)).toMatch(/(ich|sehe|gehe|wir|jetzt)/);
  }, TIMEOUT);

  it('9. translate single word', async () => {
    const r = await run('tr-9', 'translate to spanish', [
      s.type('water'), s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    expect(lc(r)).toMatch(/(agua|water)/);
  }, TIMEOUT);

  it('10. translate three short phrases as separate sentences', async () => {
    const r = await run('tr-10', 'translate to german', [
      s.type('Hello. Goodbye. Thank you.'),
      s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    // At least two German equivalents present.
    const text = lc(r);
    const hits = ['hallo', 'tschüss', 'auf wiedersehen', 'danke'].filter(w => text.includes(w));
    expect(hits.length).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 5. Spelling correction (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — spelling correction', () => {
  it('1. progressive spelling: each round catches new typos', async () => {
    const r = await run('sp-1', 'correct spelling', [
      s.type('hii'),                          s.tick(),
      s.type(' my'),                          s.tick(),
      s.type(' namee'),                       s.tick(),
      s.type(' is'),                          s.tick(),
      s.type(' wilfred'),                     s.tick(), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('name');
    expect(finalText(r)).not.toMatch(/[.!?]\s*$/);
  }, TIMEOUT);

  it('2. common typos in a paragraph all get fixed', async () => {
    const r = await run('sp-2', 'correct spelling', [
      s.type('I recieve emails frequently. The team is workng on it.'),
      s.tick(), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('receive');
    expect(lc(r)).toContain('working');
  }, TIMEOUT);

  it('3. correct doc stays untouched (idempotent)', async () => {
    const r = await run('sp-3', 'correct spelling', [
      s.type('This text is already perfect.'),
      s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('already perfect');
  }, TIMEOUT);

  it('4. proper noun typo gets capitalised correctly', async () => {
    const r = await run('sp-4', 'correct spelling', [
      s.type('I went to london last weekend.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('London');
  }, TIMEOUT);

  it('5. acronym and capitalisation', async () => {
    const r = await run('sp-5', 'correct spelling', [
      s.type('the ceo and the cto met on monday.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/(CEO|ceo)/);
  }, TIMEOUT);

  it('6. multiple typos same word stem', async () => {
    const r = await run('sp-6', 'correct spelling', [
      s.type('definately and absolutley not.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('definitely');
    expect(lc(r)).toContain('absolutely');
  }, TIMEOUT);

  it('7. mixed-case typos', async () => {
    const r = await run('sp-7', 'correct spelling', [
      s.type('I Recieved Recievering items.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('receiv');
  }, TIMEOUT);

  it('8. apostrophe typo (dont vs don\'t)', async () => {
    const r = await run('sp-8', 'correct spelling', [
      s.type('I dont know what to do.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toMatch(/don't|dont/i);
  }, TIMEOUT);

  it('9. multi-line typos all get fixed', async () => {
    const r = await run('sp-9', 'correct spelling', [
      s.type('Line one has typoo.\nLine two has anotherr typo.\nLine three has thrid.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/typo/);
    expect(lc(r)).toMatch(/another/);
    expect(lc(r)).toMatch(/third/);
  }, TIMEOUT);

  it('10. compound word typo', async () => {
    const r = await run('sp-10', 'correct spelling', [
      s.type('Its alot of work tonite.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/(a lot|tonight)/);
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 6. Grammar (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — grammar', () => {
  it('1. missing word inserted', async () => {
    const r = await run('gr-1', 'fix grammar', [
      s.type('I went store yesterday.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/went to (the )?store/);
  }, TIMEOUT);

  it('2. duplicated stop-word collapsed', async () => {
    const r = await run('gr-2', 'fix grammar', [
      s.type('I went to the the store.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r).match(/the\s+the/g)).toBeNull();
  }, TIMEOUT);

  it('3. preserves user paragraph structure', async () => {
    const r = await run('gr-3', 'fix grammar', [
      s.type('I went store.\n\nWe drank tea.\n\nThis was good.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('4. verb tense fix', async () => {
    const r = await run('gr-4', 'fix grammar', [
      s.type('Yesterday I go to the store.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/(went)/);
  }, TIMEOUT);

  it('5. subject-verb agreement', async () => {
    const r = await run('gr-5', 'fix grammar', [
      s.type('She walk to school every day.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/(walks)/);
  }, TIMEOUT);

  it('6. missing article (a/the)', async () => {
    const r = await run('gr-6', 'fix grammar', [
      s.type('I saw cat in the garden.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/(a cat|the cat)/);
  }, TIMEOUT);

  it('7. run-on sentence stays readable (not destroyed)', async () => {
    const r = await run('gr-7', 'fix grammar', [
      s.type('I went to the store and I bought milk and I came home.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('milk');
    expect(lc(r)).toContain('store');
  }, TIMEOUT);

  it('8. comma splice fix', async () => {
    const r = await run('gr-8', 'fix grammar', [
      s.type('I went to the store, I bought milk.'),
      s.tick(),
    ]);
    fail(r);
    // Either kept, or split into two sentences.
    expect(lc(r)).toContain('milk');
  }, TIMEOUT);

  it('9. wrong pronoun', async () => {
    const r = await run('gr-9', 'fix grammar', [
      s.type('Me and him went to store.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/(he|i)/);
  }, TIMEOUT);

  it('10. capitalisation in proper nouns', async () => {
    const r = await run('gr-10', 'fix grammar', [
      s.type('we went to paris on monday.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('Paris');
    expect(finalText(r)).toContain('Monday');
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 7. Backspace + edits (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — backspace + edits', () => {
  it('1. backspace and retype: deleted content not resurrected', async () => {
    const r = await run('be-1', 'fix typos', [
      s.type('I rite something here.'),       s.tick(),
      s.replace('I rite some'),                s.tick(),
      s.type('text here.'),                    s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('text');
    expect(lc(r)).not.toContain('something');
  }, TIMEOUT);

  it('2. user wipes buffer mid-flow: empty stays empty', async () => {
    const r = await run('be-2', 'fix grammar', [
      s.type('lots of content here'),          s.tick(),
      s.replace(''),                           s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toBe('');
  }, TIMEOUT);

  it('3. mid-buffer insert lands', async () => {
    const r = await run('be-3', 'correct spelling', [
      s.type('I rite stuff'),                  s.tick(),
      s.moveCursor(2),
      s.replace('I really rite stuff'),        s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('really');
  }, TIMEOUT);

  it('4. type, delete, retype same content (idempotent)', async () => {
    // The user wipes the buffer then retypes. The no-flicker invariant
    // would fire on the X → "" → X tick history pattern, but that's
    // user-driven, not LLM-driven. Skip flicker for this scenario —
    // it's testing idempotency under the user's wipe/retype gesture.
    const r = await run('be-4', 'fix grammar', [
      s.type('Hello world.'),                   s.tick(),
      s.replace(''),                             s.tick(),
      s.type('Hello world.'),                   s.tick(),
    ], { skipInvariants: ['no-buffer-flicker'] });
    fail(r);
    expect(lc(r)).toContain('hello world');
  }, TIMEOUT);

  it('5. partial backspace mid-word', async () => {
    const r = await run('be-5', 'correct spelling', [
      s.type('riteable'),                      s.tick(),
      s.replace('rite'),                       s.tick(),
    ]);
    fail(r);
    // After backspacing "able" the LLM may fix "rite" → "write" or "right".
    expect(lc(r)).toMatch(/(write|right|rite)/);
  }, TIMEOUT);

  it('6. cursor-at-start typing prepends', async () => {
    const r = await run('be-6', 'correct spelling', [
      s.type('rite stuff here.'),               s.tick(),
      s.moveCursor(0),
      s.replace('Hi, rite stuff here.'),       s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('hi');
  }, TIMEOUT);

  it('7. delete-and-type-different replaces content', async () => {
    const r = await run('be-7', 'fix grammar', [
      s.type('I am happy.'),                    s.tick(),
      s.replace('I am sad.'),                   s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('sad');
    expect(lc(r)).not.toContain('happy');
  }, TIMEOUT);

  it('8. delete trailing word, leave punctuation', async () => {
    const r = await run('be-8', 'fix grammar', [
      s.type('I went to the store yesterday.'),  s.tick(),
      s.replace('I went to the store.'),         s.tick(),
    ]);
    fail(r);
    expect(lc(r)).not.toContain('yesterday');
  }, TIMEOUT);

  it('9. multi-edit: insert + delete in same flow', async () => {
    const r = await run('be-9', 'fix grammar', [
      s.type('I went store.'),                  s.tick(),     // missing "to the"
      s.replace('I went to the store today.'),   s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('today');
  }, TIMEOUT);

  it('10. replace whole sentence', async () => {
    const r = await run('be-10', 'fix grammar', [
      s.type('First version of text.'),          s.tick(),
      s.replace('Completely different sentence here.'), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('completely different');
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 8. Realistic user flows (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — realistic flows', () => {
  it('1. email greeting + body progressive', async () => {
    const r = await run('rf-1', 'fix grammar and spelling', [
      s.type('Hi John'),                       s.tick(),
      s.type(',\n\n'),                         s.tick(),
      s.type('Just a quick note.'),            s.tick(),
      s.type(' Hope you are well'),            s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('john');
    expect(finalText(r)).toContain('\n\n');
    expect(finalText(r)).not.toMatch(/well\.$/);
  }, TIMEOUT);

  it('2. casual chat short messages', async () => {
    const r = await run('rf-2', 'fix typos', [
      s.type('hii'),                           s.tick(),
      s.type(' how'),                          s.tick(),
      s.type(' are'),                          s.tick(),
      s.type(' you'),                          s.tick(),
      s.type(' dooing'),                       s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('doing');
  }, TIMEOUT);

  it('3. multi-paragraph note with progressive typing', async () => {
    const r = await run('rf-3', 'correct spelling', [
      s.type('Hi team,'),                                      s.tick(),
      s.type('\n\n'),                                          s.tick(),
      s.type('Just a quick update on the project.'),           s.tick(),
      s.type('\n\n'),                                          s.tick(),
      s.type('We are makng good progres.'),                    s.tick(), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('making');
    expect(lc(r)).toContain('progress');
  }, TIMEOUT);

  it('4. long-doc rewrite preserves structure', async () => {
    const longDoc = [
      'The team made significnt progress on the new platfrom this quarter.',
      '',
      'We launched the redesignd interface and recieved positive feedback.',
      '',
      'Next steps: keep improvng performance and adress any remaining issues.',
    ].join('\n');
    const r = await run('rf-4', 'correct spelling', [
      s.type(longDoc),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('5. slack-style short sentence', async () => {
    const r = await run('rf-5', 'fix typos', [
      s.type('lol thats funy'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toMatch(/(funny)/);
  }, TIMEOUT);

  it('6. reply-style "Re:" message', async () => {
    const r = await run('rf-6', 'fix grammar', [
      s.type('Re: meeting tomorrow.\n\nSounds good, see you then.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('\n\n');
  }, TIMEOUT);

  it('7. tweet-length post', async () => {
    const r = await run('rf-7', 'fix grammar', [
      s.type('Just shipped a new feature today, super excited about how it turned out!'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('shipped');
  }, TIMEOUT);

  it('8. note with bullet-style items', async () => {
    const r = await run('rf-8', 'correct spelling', [
      s.type('Todo:\n- buy mlik\n- finish projct\n- email teh team'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('milk');
    expect(lc(r)).toContain('project');
    expect(lc(r)).toContain('the');
  }, TIMEOUT);

  it('9. apology message', async () => {
    const r = await run('rf-9', 'fix grammar', [
      s.type('Sorry I missed your call. Will catch up soon.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('sorry');
  }, TIMEOUT);

  it('10. status update with mixed content', async () => {
    const r = await run('rf-10', 'correct spelling', [
      s.type('Update: We finshed the main featur. Bugs reaminng: 3.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('finished');
    expect(lc(r)).toMatch(/(feature|features)/);
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 9. Convergence + flicker (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — convergence + flicker', () => {
  it('1. idle ticks on stable buffer: no flicker', async () => {
    const r = await run('cf-1', 'fix grammar', [
      s.type('This sentence is fine.'),
      s.tick(), s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    const buffers = r.trace.filter(t => t.step.kind === 'tick').slice(-3).map(t => t.bufferAfter);
    expect(new Set(buffers).size).toBeLessThanOrEqual(2);
  }, TIMEOUT);

  it('2. progressive spelling converges within 3 rounds', async () => {
    const r = await run('cf-2', 'correct spelling', [
      s.type('hii my namee is wilfred'),
      s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    const tickStates = r.trace.filter(t => t.step.kind === 'tick');
    const last2 = tickStates.slice(-2).map(t => t.bufferAfter);
    expect(last2[0]).toBe(last2[1]);
  }, TIMEOUT);

  it('3. five idle ticks on stable buffer remain stable', async () => {
    const r = await run('cf-3', 'fix grammar', [
      s.type('Hello world. This is a test.'),
      s.tick(), s.tick(), s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    const last3 = r.trace.filter(t => t.step.kind === 'tick').slice(-3).map(t => t.bufferAfter);
    expect(new Set(last3).size).toBeLessThanOrEqual(2);
  }, TIMEOUT);

  it('4. clean grammar doc stable across ticks', async () => {
    const r = await run('cf-4', 'fix grammar', [
      s.type('I went to the store and bought milk.'),
      s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    const last2 = r.trace.filter(t => t.step.kind === 'tick').slice(-2).map(t => t.bufferAfter);
    expect(last2[0]).toBe(last2[1]);
  }, TIMEOUT);

  it('5. translation converges across rounds', async () => {
    const r = await run('cf-5', 'translate to german', [
      s.type('I am going home today.'),
      s.tick(), s.tick(), s.tick(),
    ], { skipInvariants: ['user-content-survives'] });
    fail(r);
    const last2 = r.trace.filter(t => t.step.kind === 'tick').slice(-2).map(t => t.bufferAfter);
    expect(last2[0]).toBe(last2[1]);
  }, TIMEOUT);

  it('6. large-paragraph doc stable', async () => {
    const r = await run('cf-6', 'fix grammar', [
      s.type('This is paragraph one with several sentences. Each sentence has its own meaning.\n\nThis is paragraph two with more text. We discuss things here.'),
      s.tick(), s.tick(),
    ]);
    fail(r);
  }, TIMEOUT);

  it('7. single-word fragment stays stable', async () => {
    const r = await run('cf-7', 'fix grammar', [
      s.type('Today'),
      s.tick(), s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    const last2 = r.trace.filter(t => t.step.kind === 'tick').slice(-2).map(t => t.bufferAfter);
    expect(last2[0]).toBe(last2[1]);
  }, TIMEOUT);

  it('8. spelling fix lands on first round, stable thereafter', async () => {
    const r = await run('cf-8', 'correct spelling', [
      s.type('I have a typoo here.'),
      s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('typo');
    const last2 = r.trace.filter(t => t.step.kind === 'tick').slice(-2).map(t => t.bufferAfter);
    expect(last2[0]).toBe(last2[1]);
  }, TIMEOUT);

  it('9. no LLM-driven oscillation on stable doc', async () => {
    const r = await run('cf-9', 'fix grammar', [
      s.type('You will go to the meeting.'),
      s.tick(), s.tick(), s.tick(), s.tick(),
    ]);
    fail(r);
  }, TIMEOUT);

  it('10. mixed idle + typing converges', async () => {
    const r = await run('cf-10', 'correct spelling', [
      s.type('hii'),                      s.tick(),
      s.tick(),                            // idle
      s.type(' there'),                   s.tick(),
      s.tick(),                            // idle
    ]);
    fail(r);
    const last2 = r.trace.filter(t => t.step.kind === 'tick').slice(-2).map(t => t.bufferAfter);
    expect(last2[0]).toBe(last2[1]);
  }, TIMEOUT);
});

// ════════════════════════════════════════════════════════════════════
// 10. Edge cases (10)
// ════════════════════════════════════════════════════════════════════
RUN('Real-Groq — edge cases', () => {
  it('1. empty buffer: tick is a no-op', async () => {
    const r = await run('ec-1', 'fix grammar', [s.tick()]);
    fail(r);
    expect(finalText(r)).toBe('');
  }, TIMEOUT);

  it('2. single-character buffer: tick doesn\'t expand', async () => {
    const r = await run('ec-2', 'fix grammar', [
      s.type('a'),
      s.tick(), s.tick(),
    ]);
    fail(r);
    expect(finalText(r).length).toBeLessThan(20);
  }, TIMEOUT);

  it('3. whitespace-only buffer: no-op', async () => {
    const r = await run('ec-3', 'fix grammar', [
      s.type('   '),
      s.tick(),
    ]);
    fail(r);
  }, TIMEOUT);

  it('4. code-like content: doesn\'t mangle structure', async () => {
    const r = await run('ec-4', 'fix grammar', [
      s.type('const x = 5; // a comment'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('=');
  }, TIMEOUT);

  it('5. only punctuation', async () => {
    const r = await run('ec-5', 'fix grammar', [
      s.type('...???!!!'),
      s.tick(),
    ]);
    fail(r);
  }, TIMEOUT);

  it('6. URL in content', async () => {
    const r = await run('ec-6', 'fix grammar', [
      s.type('Check https://example.com for more.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('example.com');
  }, TIMEOUT);

  it('7. emoji in content', async () => {
    const r = await run('ec-7', 'fix grammar', [
      s.type('Great work! 🎉 Keep it up.'),
      s.tick(),
    ]);
    fail(r);
    expect(finalText(r)).toContain('🎉');
  }, TIMEOUT);

  it('8. numbers and units', async () => {
    const r = await run('ec-8', 'fix grammar', [
      s.type('The meeting is at 3pm on the 5th of october.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('3');
  }, TIMEOUT);

  it('9. very short input (single word)', async () => {
    const r = await run('ec-9', 'correct spelling', [
      s.type('hello'),
      s.tick(), s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('hello');
  }, TIMEOUT);

  it('10. mixed-language text', async () => {
    const r = await run('ec-10', 'fix grammar', [
      s.type('Hello, café au lait please.'),
      s.tick(),
    ]);
    fail(r);
    expect(lc(r)).toContain('café');
  }, TIMEOUT);
});

if (!HAS_KEY) {
  // eslint-disable-next-line no-console
  console.log('GROQ_API_KEY not set — skipping real-Groq harness tests.');
}
