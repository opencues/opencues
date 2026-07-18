/**
 * Life-context CUE correctness (Phase 2 — the cue path). Proves the calendar
 * sentence-cue detects a scheduling contradiction in prose and flags it (naming
 * the clashing event by its hydrated title), and cedes (ALT: NONE) when there's
 * no conflict. Drives the SAME prompt assembly SentenceCueSource uses:
 *   CUE.md body + SINGLE_SENTENCE_FORMAT_SPEC + renderLifeContextForCue.
 *
 * Reference "now" pinned to Fri 2026-07-17 09:00 for determinism. Providers:
 *   (default) groq gpt-oss-120b (the cues-bucket capable model — where this routes)
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss …
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { SINGLE_SENTENCE_FORMAT_SPEC, parseSingleSentenceAlts } from '../../../packages/opencues-core/src/sources/sentence-cue-source';
import { renderLifeContextForCue, buildLifeContextSnapshot } from '../../../packages/opencues-core/src/life-context';
import { postProcessContext } from '../../../packages/opencues-core/src/identity-context';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const GREEN = '\x1b[32m'; const RED = '\x1b[31m'; const YELLOW = '\x1b[33m'; const RESET = '\x1b[0m';
const N = parseInt(process.env.N ?? '3', 10);
const NOW = '2026-07-17T09:00';

const EVENTS = [
  { title: 'Dentist',        start: '2026-07-17T15:00', end: '2026-07-17T15:45' },                 // [EVENT 1] today 3:00–3:45pm
  { title: 'Team standup',   start: '2026-07-17T16:00', end: '2026-07-17T16:30' },                 // [EVENT 2] today 4:00–4:30pm (2nd today → "multiple")
  { title: '1:1 with Sarah', start: '2026-07-20T09:00', end: '2026-07-20T10:00' },                 // [EVENT 3] Mon 9–10am
  { title: 'Conference',     start: '2026-07-22T00:00', end: '2026-07-22T23:59', allDay: true },   // [EVENT 4] Wed all-day
];
const SNAP = buildLifeContextSnapshot(EVENTS);
// Extract the CUE.md prompt body (text outside frontmatter), mirroring what the
// parser hands SentenceCueSource as promptText.
const cueMd = readFileSync(join(__dirname, '../../../defaults/cues/calendar/CUE.md'), 'utf8');
const promptBody = cueMd.replace(/^---[\s\S]*?---\n/, '').trim();
const SYSTEM = `${promptBody}\n\n${SINGLE_SENTENCE_FORMAT_SPEC}${renderLifeContextForCue(SNAP, 'on', NOW)}`;

async function cueFor(sentence: string): Promise<{ flagged: boolean; text: string; ceded: boolean }> {
  const r = await chat(sysUser(SYSTEM, `SENTENCE: ${sentence}`), { maxTokens: 300, temperature: 0.3 });
  const parsed = parseSingleSentenceAlts(r.text);
  if (parsed.ceded || parsed.alts.length === 0) return { flagged: false, text: '', ceded: parsed.ceded };
  // Hydrate [EVENT N] → title (what the runtime does before display).
  const alt = postProcessContext(parsed.alts[0], { catalog: SNAP.catalog, originalBody: sentence, preserveUnknown: true }).output;
  const flagged = /heads up|Dentist|Team standup|1:1 with Sarah|Conference|\[EVENT/i.test(alt);
  return { flagged, text: alt, ceded: false };
}

interface Case { id: string; sentence: string; want: 'flag' | 'none'; }
const CASES: Case[] = [
  // CONFLICT — should flag (claimed time overlaps an event).
  { id: 'free-3pm',    sentence: "I'm free at 3pm today.",                 want: 'flag' },
  { id: 'meet-315',    sentence: "Let's meet at 3:15 this afternoon.",     want: 'flag' },
  { id: 'mon-930',     sentence: "I can do Monday at 9:30am.",             want: 'flag' },
  { id: 'around-3',    sentence: "I'll be around at 3 today.",             want: 'flag' },
  // NO CONFLICT — should cede.
  { id: 'free-5pm',    sentence: "I'm free at 5pm today.",                 want: 'none' }, // dentist ends 3:45
  { id: 'mon-2pm',     sentence: "Let's meet Monday at 2pm.",             want: 'none' }, // 1:1 is 9–10am
  { id: 'not-sched',   sentence: "I love pizza.",                          want: 'none' }, // not a scheduling claim
  { id: 'question',    sentence: "How was your weekend?",                  want: 'none' },
];

async function main(): Promise<void> {
  console.log(`\n${BOLD}Life-context CUE (calendar-conflict)${RESET}   model: ${MODEL}   N=${N}   (now = Fri 2026-07-17 9am)\n`);
  console.log(`${DIM}Calendar: [EVENT 1] Dentist Fri 3:00–3:45pm · [EVENT 2] 1:1 Mon 9–10am${RESET}\n`);
  let ok = 0, tot = 0;
  for (const c of CASES) {
    const runs = await Promise.all(Array.from({ length: N }, () => cueFor(c.sentence)));
    const hits = runs.filter(r => (c.want === 'flag' ? r.flagged : (!r.flagged))).length;
    ok += hits; tot += N;
    const sample = runs.find(r => r.text)?.text ?? (runs[0].ceded ? 'ALT: NONE' : '(none)');
    console.log(`${hits === N ? GREEN + 'PASS' : (hits === 0 ? RED + 'FAIL' : YELLOW + 'PART')}${RESET} ${c.id.padEnd(10)} want=${c.want.padEnd(4)} ${hits}/${N}  ${DIM}${JSON.stringify(sample).slice(0, 80)}${RESET}`);
  }
  // Enhancement checks: LIST MULTIPLE + ALL-DAY shows title (not a fake time).
  console.log(`\n${BOLD}ENHANCEMENTS${RESET}`);
  const multi = await Promise.all(Array.from({ length: N }, () => cueFor("I'm free this afternoon.")));
  const listsBoth = multi.filter(r => /Dentist/i.test(r.text) && /Team standup/i.test(r.text)).length;
  console.log(`${listsBoth === N ? GREEN + 'PASS' : (listsBoth === 0 ? RED + 'FAIL' : YELLOW + 'PART')}${RESET} list-multiple   ${listsBoth}/${N}  ${DIM}${JSON.stringify(multi.find(r => r.text)?.text ?? '').slice(0, 90)}${RESET}`);
  const allday = await Promise.all(Array.from({ length: N }, () => cueFor("Let's meet on wednesday.")));
  const showsAllDay = allday.filter(r => /Conference/i.test(r.text) && /all.?day/i.test(r.text) && !/12:00|11:59|00:00/i.test(r.text)).length;
  console.log(`${showsAllDay === N ? GREEN + 'PASS' : (showsAllDay === 0 ? RED + 'FAIL' : YELLOW + 'PART')}${RESET} all-day-title   ${showsAllDay}/${N}  ${DIM}${JSON.stringify(allday.find(r => r.text)?.text ?? '').slice(0, 90)}${RESET}`);

  console.log(`\n${BOLD}SUMMARY${RESET}  base ${ok}/${tot} · list-multiple ${listsBoth}/${N} · all-day ${showsAllDay}/${N}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
