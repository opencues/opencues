/**
 * docs/features/tables.md is the public page for the tables blank (and what
 * opencues.com distils). Every example on it is typed here through the full
 * path a person's `_` takes: the shipped defaults/blanks/tables/BLANK.md
 * shapes, BlankFill's keyword scan + shape match, the real TablesBlank and
 * its calculators, with `table-lookups-mode: on`. The answer written on the
 * page must be the answer the product gives, exactly.
 *
 * The page's clock is 2026-09-19 11:30 UTC in Europe/London (`iso now _` →
 * `2026-09-19T11:30:00.000Z`, `in 45 minutes _` → `13:15`), so the test pins
 * both. A row the product cannot reproduce fails here: fix the product if
 * the page is right, the page if the product is right.
 *
 * What the page may write in an answer cell:
 *   - one code span: the exact answer (`…` inside it elides any text);
 *   - several code spans joined by ` / `: the answer's lines;
 *   - several joined by ` or `: any one of them;
 *   - prose (`the text recased`): one of the PROSE predicates below, and a
 *     prose answer with no predicate fails, so a new one must be pinned.
 * A generator's digits (`roll 2d6 _` → `7 (4 + 3)`) match any digits.
 * Plain phrasings reach the tables through the decision route and are out
 * of scope for this keyword-path test; so are the country facts (their own
 * blank). "Not claimed" examples must leave the text alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { BlankFill } from '../../modules/blank-fill';
import { ConfigLoader } from '../../modules/config-loader';
import { MockAdapter } from '../../../testing/mock-adapter';
import { TablesBlank, configureCalcEnv, calculatorForDispatchKeyword } from '../tables';
import { createBlankInvoke } from '../index';

const REPO_ROOT = resolvePath(__dirname, '../../../../..');
const DOC = readFileSync(resolvePath(REPO_ROOT, 'docs/features/tables.md'), 'utf8');
const TABLES_MD = readFileSync(resolvePath(REPO_ROOT, 'defaults/blanks/tables/BLANK.md'), 'utf8');
const NOW = new Date('2026-09-19T11:30:00.000Z');
const ZONE = 'Europe/London';
/** the buffer for a prose example that says it runs "over several lines" */
const LINES_BUFFER = 'zorb\nblorp';

interface Example { line: number; input: string; buffer: string; answer: Answer }
type Answer =
  | { kind: 'exact'; text: string }
  | { kind: 'lines'; lines: string[] }
  | { kind: 'oneOf'; options: string[] }
  | { kind: 'prose'; text: string };

/** Answers the page writes in words; each is a predicate over (answer, prior buffer, typed command without its `_`). */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROSE: Record<string, (out: string, buffer: string, command: string) => boolean> = {
  'the text recased': (out, buf) => out.toLowerCase() === buf.toLowerCase(),
  'the text three times': (out, buf) => out.replace(/\s+/g, '') === buf.replace(/\s+/g, '').repeat(3),
  'the JSON indented': (out) => { try { JSON.parse(out); return out.includes('\n  '); } catch { return false; } },
  "the command's words, then a fresh UUID": (out, _buf, cmd) => new RegExp(`^${cmd} ${UUID}$`).test(out),
  'a number': (out) => /^\d+$/.test(out) && Number(out) >= 1 && Number(out) <= 100,
  'one of them': (out) => ['red', 'green', 'blue'].includes(out),
};

const ESC = '\u0000';
/** code spans of a markdown cell, with `\`` kept as a literal backtick */
function spans(cell: string): { spans: string[]; between: string[]; rest: string } {
  const s = cell.replace(/\\`/g, ESC);
  const out: string[] = []; const between: string[] = [];
  let rest = ''; let last = 0;
  for (const m of s.matchAll(/`([^`]*)`/g)) {
    between.push(s.slice(last, m.index));
    out.push(m[1].split(ESC).join('`'));
    last = m.index! + m[0].length;
  }
  rest = s.slice(last);
  return { spans: out, between: between.slice(1), rest: (between[0] ?? '') + rest };
}

function parseAnswer(cell: string): Answer {
  const { spans: all, between } = spans(cell);
  // a code span that is itself a command (`truncate to 5 words _`) is an aside, not the answer
  const idx = all.map((_, i) => i).filter((i) => !/\s_$/.test(all[i]));
  const got = idx.map((i) => all[i]);
  if (got.length === 0) return { kind: 'prose', text: cell.trim() };
  if (got.length === 1) return { kind: 'exact', text: got[0] };
  const seps = idx.slice(1).map((i) => between[i - 1].trim());
  if (seps.every((x) => x === '/')) return { kind: 'lines', lines: got };
  if (seps.every((x) => x === 'or')) return { kind: 'oneOf', options: got };
  throw new Error(`cannot read the answer cell: ${cell}`);
}

/** Every example on the page: table rows, `input _` → `answer` pairs in prose, and the "Not claimed" lists. */
function readDoc(): { examples: Example[]; unclaimed: Array<{ line: number; input: string }> } {
  const lines = DOC.split('\n');
  const examples: Example[] = []; const unclaimed: Array<{ line: number; input: string }> = [];
  let tableBuffer = ''; let pendingBuffer = ''; let inTable = false; let paragraph: number[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.map((i) => lines[i]).join(' ');
    if (/^Not claimed|stay rewrite requests/.test(text)) {
      for (const sp of spans(text).spans) if (/\s_$/.test(sp)) unclaimed.push({ line: paragraph[0] + 1, input: sp });
    }
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('|')) {
      flushParagraph();
      if (!inTable) { inTable = true; tableBuffer = pendingBuffer; pendingBuffer = ''; }
      const cells = raw.replace(/\\`/g, ESC).split(/\s\|\s|^\|\s|\s\|$/).filter((c, j, a) => !(j === 0 && c === '') && !(j === a.length - 1 && c === '')).map((c) => c.split(ESC).join('\\`'));
      if (cells.length < 2 || /^-+$/.test(cells[0].trim()) || /^you type$/.test(cells[0].trim())) continue;
      const inputs = spans(cells[0]).spans.filter((x) => /\s_$/.test(x) || x === '_');
      if (inputs.length === 0) continue;
      const answer = parseAnswer(cells[1]);
      for (const input of inputs) examples.push({ line: i + 1, input, buffer: tableBuffer, answer });
      continue;
    }
    if (inTable) { inTable = false; tableBuffer = ''; }
    const over = raw.match(/^Over `([^`]+)`:\s*$/);
    if (over) { pendingBuffer = over[1]; continue; }
    if (raw.trim() === '' || raw.startsWith('#')) { flushParagraph(); continue; }
    paragraph.push(i);
    // `input _` → `answer` pairs written in prose (a pair may wrap onto the next line)
    const joined = raw + ' ' + (lines[i + 1] ?? '');
    for (const m of raw.matchAll(/`([^`]*\s_)`\s*→\s*/g)) {
      const after = joined.slice(m.index! + m[0].length).match(/^`([^`]*)`/);
      if (!after) continue;
      const para = [...paragraph.map((j) => lines[j]), lines[i + 1] ?? ''].join(' ');
      examples.push({ line: i + 1, input: m[1], buffer: /over several lines/.test(para) ? LINES_BUFFER : '', answer: { kind: 'exact', text: after[1] } });
    }
  }
  flushParagraph();
  return { examples, unclaimed };
}

async function type(buffer: string, input: string) {
  const adapter = new MockAdapter({
    cwd: '/proj',
    files: { '/mock/CUES.md': JSON.stringify({ concepts: [] }), '/proj/blanks/tables/BLANK.md': TABLES_MD, '/proj/OPENCUES.md': '---\ntable-lookups-mode: on\n---\n' },
    capabilities: ['render-override', 'dim-ranges', 'highlight-range', 'file-read', 'file-write', 'force-render', 'change-source', 'blank-invoke'],
  });
  const invoke = createBlankInvoke(new Map([['tables', new TablesBlank()]]));
  const dispatched: string[][] = [];
  (adapter as unknown as { blankInvoke: typeof invoke }).blankInvoke = ((req: { args: readonly string[] }) => { dispatched.push([...req.args]); return invoke(req as Parameters<typeof invoke>[0]); }) as typeof invoke;
  const loader = new ConfigLoader(adapter, { settingsFile: '/proj/OPENCUES.md' });
  await loader.load();
  const bf = new BlankFill(adapter, loader);
  bf.subscribe();
  const text = buffer ? `${buffer}\n${input}` : input;
  adapter.pushText(text);
  await new Promise((r) => setTimeout(r, 30));
  return { out: adapter.setTextCalls.at(-1) ?? adapter.getText(), text, dispatched };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `…` in a documented answer elides any text; a generator's digits are any digits */
function pattern(text: string, generator: boolean): RegExp {
  let src = text.split('…').map(escapeRe).join('[\\s\\S]*');
  if (generator) src = src.replace(/\d+/g, '\\d+');
  return new RegExp(`^${src}$`);
}

const { examples, unclaimed } = readDoc();

async function answers(e: Example): Promise<void> {
  const { out, dispatched } = await type(e.buffer, e.input);
  expect(dispatched, `L${e.line}: "${e.input}" was not dispatched to the tables blank`).toHaveLength(1);
  const [kw, ...rest] = dispatched[0];
  const calc = calculatorForDispatchKeyword(kw, rest.join(' '));
  const prior = e.buffer;
  // a metric or lookup fills after the prior text; a transform replaces it
  const got = prior && out.startsWith(`${prior}\n`) ? out.slice(prior.length + 1) : out;
  const a = e.answer;
  if (a.kind === 'exact') expect(got, `L${e.line}: "${e.input}"`).toMatch(pattern(a.text, !!calc?.generator));
  else if (a.kind === 'lines') expect(got, `L${e.line}: "${e.input}"`).toBe(a.lines.join('\n'));
  else if (a.kind === 'oneOf') expect(a.options, `L${e.line}: "${e.input}" gave "${got}"`).toContain(got);
  else expect(PROSE[a.text](got, prior, e.input.replace(/\s*_$/, '')), `L${e.line}: "${e.input}" gave "${got}" for "${a.text}"`).toBe(true);
}

/** Pin the clock (and the zone the page was written in) for one describe block. */
function onClock(now: Date): void {
  const tz = process.env.TZ;
  beforeAll(() => { process.env.TZ = ZONE; configureCalcEnv({ now: () => now }); });
  afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; configureCalcEnv({ now: () => new Date() }); });
}

describe('docs/features/tables.md: every example answers as documented', () => {
  onClock(NOW);

  it('reads the page (a parse that finds nothing is a broken guard, not a green one)', () => {
    expect(examples.length).toBeGreaterThan(200);
    expect(unclaimed.length).toBeGreaterThan(20);
    for (const e of examples) if (e.answer.kind === 'prose') expect(PROSE[e.answer.text], `L${e.line}: no predicate for prose answer "${e.answer.text}"`).toBeDefined();
  });

  it.each(examples.map((e) => [`L${e.line}`, e.input, e] as const))('%s: "%s"', async (_l, _input, e) => answers(e));

  it.each(unclaimed.map((u) => [`L${u.line}`, u.input] as const))('%s: "%s" is not claimed', async (_l, input) => {
    const { out, text, dispatched } = await type('', input);
    expect(dispatched).toHaveLength(0);
    expect(out).toBe(text);
  });
});

/**
 * The same page on a later day of the same year: an answer that does not
 * read the clock must not move. Only the rows below are ABOUT today (a
 * relative date, a countdown, the time or zone offset now, a bare `quarter
 * _`); every other row answering differently in December is a date resolved
 * against today when it should not be (the bug that made `days between 3
 * march and 19 september _` 565 days once 19 September had passed).
 */
const LATER = new Date('2026-12-01T11:30:00.000Z');
const TIME_DEPENDENT = new Set<string>([
  // relative to today
  '90 days from today _', '3 weeks from friday _', '45 days ago _', 'weeks until christmas _', 'days since 1 jan _',
  // the clock now
  'in 45 minutes _', '3 hours from now _', 'day of year _', 'quarter _', 'unix time _', 'iso now _',
  // a zone's offset today (daylight saving)
  'time in tokyo _', '3pm london in tokyo _', '9am est to utc _', 'is it dst in london _', 'overlap between london and sydney _', 'meeting at 3pm london for new york tokyo _',
]);

describe('docs/features/tables.md: clock-free examples answer the same later in the year', () => {
  onClock(LATER);

  it('every TIME_DEPENDENT entry is still an example on the page', () => {
    const inputs = new Set(examples.map((e) => e.input));
    for (const t of TIME_DEPENDENT) expect(inputs.has(t), `"${t}" is no longer on the page`).toBe(true);
  });

  it.each(examples.filter((e) => !TIME_DEPENDENT.has(e.input)).map((e) => [`L${e.line}`, e.input, e] as const))('%s: "%s"', async (_l, _input, e) => answers(e));
});

/** Lines the page does not carry, typed through the same path: a date pair after its dates have passed, and a leading keyword that must beat one inside its argument. */
describe('tables: date pairs resolve together, the leading keyword names the command', () => {
  onClock(new Date('2026-09-26T11:30:00.000Z'));
  it.each([
    ['days between 3 march and 19 september _', '200 days (28.6 weeks)'],
    ['days between 1 march and 14 july _', '135 days (19.3 weeks)'],
    ['days between 1 dec and 10 jan _', '40 days (5.7 weeks)'],
    ['days between 10 jan 2027 and 1 dec _', '325 days (46.4 weeks)'],
    ['days between 1 dec and 10 jan 2026 _', '40 days (5.7 weeks)'],
    ['days between today and christmas _', '90 days (12.9 weeks)'],
    ['days between 1 march and today _', '209 days (29.9 weeks)'],
    ['weeks between 1 jan and 1 mar _', '8.4 weeks (59 days)'],
    ['working days between 1 sep and 30 sep _', '21 working days (Mon–Fri, no holidays counted)'],
    ['days since 25 december _', '275 days (39.3 weeks)'],
    ['tip 15% on 64.20 split 4 ways _', 'tip 9.63 · total 73.83 · 18.46 each (4 ways)'],
    ['split 143 four ways with 15% tip _', '41.11 each (4 ways, total 164.45 with 15% tip)'],
  ])('"%s" → %s', async (input, answer) => {
    const { out } = await type('', input);
    expect(out).toBe(answer);
  });
});
