/**
 * Latency of the calendar-conflict CUE's LLM call, in ISOLATION. Runs the exact
 * prompt SentenceCueSource sends (CUE.md body + SINGLE_SENTENCE_FORMAT_SPEC +
 * renderCalendarContextForCue) against the provider and reports the per-call latency
 * distribution — to see whether a ~2.8s spike (seen live) is typical or an
 * outlier, and how big the prompt is.
 *
 * Default provider: groq gpt-oss-120b (what the live host uses).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { SINGLE_SENTENCE_FORMAT_SPEC } from '../../../packages/opencues-core/src/sources/sentence-cue-source';
import { renderCalendarContextForCue, buildCalendarContextSnapshot } from '../../../packages/opencues-core/src/calendar-context';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const GREEN = '\x1b[32m'; const YELLOW = '\x1b[33m'; const RED = '\x1b[31m'; const RESET = '\x1b[0m';
const N = parseInt(process.env.N ?? '10', 10);
const NOW = '2026-07-17T09:00';

const EVENTS = [
  { title: 'Dentist',     start: '2026-07-17T15:00', end: '2026-07-17T15:45' },
  { title: 'Conference',  start: '2026-08-23T00:00', end: '2026-08-23T23:59', allDay: true },
];
const SNAP = buildCalendarContextSnapshot(EVENTS);
const cueMd = readFileSync(join(__dirname, '../../../defaults/cues/calendar/CUE.md'), 'utf8');
const promptBody = cueMd.replace(/^---[\s\S]*?---\n/, '').trim();
const SYSTEM = `${promptBody}\n\n${SINGLE_SENTENCE_FORMAT_SPEC}${renderCalendarContextForCue(SNAP, 'on', NOW)}`;

const approxTokens = Math.round(SYSTEM.length / 4);

const SENTENCES = [
  { s: 'I am free at 3pm today.',      kind: 'flag' },
  { s: 'I love pizza.',                kind: 'cede' },
  { s: "Let's meet on august 23rd.",   kind: 'flag' },
  { s: 'How was your weekend?',        kind: 'cede' },
];

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}Calendar-cue LLM latency (isolated)${RESET}   model: ${MODEL}   N=${N}/sentence`);
  console.log(`${DIM}system prompt: ${SYSTEM.length} chars (~${approxTokens} tokens)${RESET}\n`);

  const all: number[] = [];
  for (const { s, kind } of SENTENCES) {
    const lats: number[] = [];
    for (let i = 0; i < N; i++) {
      const r = await chat(sysUser(SYSTEM, `SENTENCE: ${s}`), { maxTokens: 300, temperature: 0.3 });
      lats.push(r.latencyMs);
      all.push(r.latencyMs);
    }
    lats.sort((a, b) => a - b);
    const med = pct(lats, 50), p90 = pct(lats, 90), mx = Math.max(...lats), mn = Math.min(...lats);
    const col = med < 600 ? GREEN : med < 1200 ? YELLOW : RED;
    console.log(`${col}${kind.padEnd(4)}${RESET} ${DIM}"${s}"${RESET}`);
    console.log(`     min ${mn}ms · median ${col}${med}ms${RESET} · p90 ${p90}ms · max ${mx}ms`);
  }
  all.sort((a, b) => a - b);
  console.log(`\n${BOLD}OVERALL${RESET}  min ${Math.min(...all)}ms · median ${pct(all, 50)}ms · p90 ${pct(all, 90)}ms · p99 ${pct(all, 99)}ms · max ${Math.max(...all)}ms  (${all.length} calls)\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
