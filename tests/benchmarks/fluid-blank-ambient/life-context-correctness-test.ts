/**
 * Life-context CORRECTNESS — the Phase 1a proof that ingest → catalog →
 * reason → hydrate works with a real LLM, zero network (fixture calendar).
 *
 * Three suites:
 *   AVAILABILITY: free/busy reasoning over a fixture calendar must match the
 *                 event times (busy where an event overlaps, free otherwise).
 *   CONTROL:      unrelated queries must NOT emit any [EVENT N] token (no hijack).
 *   HYDRATION:    [EVENT N] → the real title via the runtime postProcessContext.
 *
 * Reference "today" is pinned to Fri 2026-07-17 so the run is deterministic.
 * Replicates the live fluid-blank prompt. Providers:
 *   (default)                                    → groq gpt-oss-120b (capable — the intended reasoning route)
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss OPENCUES_CEREBRAS_MODEL=gemma-4-31b
 *                                                → the fast fills model (does it handle free/busy?)
 */
import { FUSED_SYSTEM_PROMPT, MODE_RULES } from '../../../packages/opencues-core/src/sources/fluid-blank-source';
import { renderLifeContextCatalog, buildLifeContextSnapshot } from '../../../packages/opencues-core/src/life-context';
import { postProcessContext } from '../../../packages/opencues-core/src/identity-context';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const GREEN = '\x1b[32m'; const RED = '\x1b[31m'; const YELLOW = '\x1b[33m'; const RESET = '\x1b[0m';
const N = parseInt(process.env.N ?? '3', 10);

// Fixture calendar for the week of the pinned reference "today" = Fri 2026-07-17.
// NOW is pinned so the CURRENT MOMENT anchor is deterministic.
const NOW = '2026-07-17T09:00';
const EVENTS = [
  { title: 'Dentist',          start: '2026-07-17T14:00', end: '2026-07-17T15:00' },
  { title: 'Team standup',     start: '2026-07-17T16:00', end: '2026-07-17T16:30' },
  { title: '1:1 with Sarah',   start: '2026-07-20T09:00', end: '2026-07-20T10:00' },
  { title: 'Lunch with Alex',  start: '2026-07-21T12:00', end: '2026-07-21T13:00' },
  { title: 'Conference',       start: '2026-07-22T00:00', end: '2026-07-22T23:59', allDay: true },
  // A PAST event (yesterday) — must NOT make "today" busy (the post-midnight bug).
  { title: 'Yesterday call',   start: '2026-07-16T11:00', end: '2026-07-16T12:00' },
];
const SNAP = buildLifeContextSnapshot(EVENTS, '2026-07-17T08:55');
const SYSTEM = `${FUSED_SYSTEM_PROMPT}${renderLifeContextCatalog(SNAP, 'on', NOW)}\n\n${MODE_RULES}`;
const ALL_TOKENS = SNAP.events.map((e) => e.token);

function answerOf(text: string): string { const m = text.match(/^ANSWER:[ \t]*(.*)$/im); return (m ? m[1] : text).trim(); }
async function ask(input: string): Promise<string> {
  const r = await chat(sysUser(SYSTEM, `INPUT: ${input}`), { maxTokens: 512, temperature: 0.4 });
  return answerOf(r.text);
}
const hasAnyToken = (a: string): string | null => { const u = a.toUpperCase(); return ALL_TOKENS.find((t) => u.includes(t)) ?? null; };

// Fuzzy free/busy grader: a "busy" answer signals unavailability (busy / not
// free / a bare "no" to "am i free" / a specific event); a "free" answer signals
// availability. A bare "no"/"yes" is a valid answer to a yes/no availability ask.
const BUSY_RE = /\b(busy|not free|unavailable|can'?t|occupied|meeting|appointment|conflict|dentist|standup|1:?1|lunch|conference)\b/i;
const FREE_RE = /\b(free|available|open|nothing|no (?:events|meetings|appointments)|clear|yes)\b/i;
const BARE_NO = /^\W*no\b/i;   // "no" / "No." answering "am i free …?" → busy
function grade(answer: string, want: 'busy' | 'free'): boolean {
  const busyWord = BUSY_RE.test(answer) || BARE_NO.test(answer);
  const freeWord = FREE_RE.test(answer) && !BARE_NO.test(answer);
  // A token mention alone is a busy signal ONLY when the answer isn't clearly
  // free — a free answer may CITE an event for context ("Free, nothing after
  // the 10am [EVENT 3]") without being busy.
  if (want === 'busy') return busyWord || (hasAnyToken(answer) !== null && !freeWord);
  return freeWord && !busyWord;
}

interface ACase { id: string; input: string; want: 'busy' | 'free'; }
const AVAILABILITY: ACase[] = [
  { id: 'fri-2pm',    input: 'am i free at 2pm today _',        want: 'busy' }, // Dentist 2–3pm
  { id: 'fri-11am',   input: 'am i free at 11am today _',       want: 'free' }, // nothing before 2pm
  { id: 'fri-415',    input: 'free at 4:15pm today _',          want: 'busy' }, // Standup 4–4:30 (mid)
  { id: 'mon-am',     input: 'am i free monday at 9:30am _',    want: 'busy' }, // 1:1 9–10
  { id: 'mon-pm',     input: 'am i free monday afternoon _',    want: 'free' }, // nothing Mon PM
  { id: 'tue-3pm',    input: 'am i free tuesday at 3pm _',      want: 'free' }, // Lunch is 12–1
  { id: 'wed',        input: 'am i free wednesday _',           want: 'busy' }, // all-day Conference
  { id: 'past-day',   input: 'am i free at 11:30am today _',    want: 'free' }, // 11–12 event was YESTERDAY, not today
];

interface CCase { id: string; input: string; note: string; }
const CONTROLS: CCase[] = [
  { id: 'capital',    input: 'the capital of france is _',      note: 'plain lookup → Paris, no [EVENT]' },
  { id: 'synonym',    input: 'a synonym for happy _',           note: 'unrelated → prose, no token' },
  { id: 'math',       input: '2 + 2 = _',                       note: 'math → 4, no token' },
];

// LOOKUP — "next event" / "what's on" must name the event AND its day+time
// (a bare title token is not enough; the user asked WHICH and WHEN).
const LOOKUPS = [
  { id: 'next-event', input: 'next event _' },
  { id: 'next-mtg',   input: 'when is my next meeting _' },
  { id: 'whats-today', input: 'whats on today _' },
];
const hasTime = (a: string): boolean => /\d{1,2}:\d{2}|\d{1,2}\s*[ap]m|all day/i.test(a);
const hasToken = (a: string): boolean => /\[EVENT/i.test(a);

async function main(): Promise<void> {
  console.log(`\n${BOLD}Life-context CORRECTNESS${RESET}   model: ${MODEL}   N=${N}   (today = Fri 2026-07-17)\n`);
  console.log(`${DIM}${renderLifeContextCatalog(SNAP, 'on').trim().split('\n').slice(0, 8).join('\n')}${RESET}\n`);

  console.log(`${BOLD}AVAILABILITY — free/busy reasoning must match the event times${RESET}`);
  let aOk = 0, aTot = 0;
  for (const c of AVAILABILITY) {
    const ans = await Promise.all(Array.from({ length: N }, () => ask(c.input)));
    const hits = ans.filter((a) => grade(a, c.want)).length;
    aOk += hits; aTot += N;
    console.log(`${hits === N ? GREEN + 'PASS' : (hits === 0 ? RED + 'FAIL' : YELLOW + 'PART')}${RESET} ${c.id.padEnd(9)} want=${c.want.padEnd(4)} ${hits}/${N}  ${DIM}${[...new Set(ans)].slice(0, 3).map((a) => JSON.stringify(a)).join(' ')}${RESET}`);
  }

  console.log(`\n${BOLD}CONTROL — unrelated query must NOT emit any [EVENT] token${RESET}`);
  let cOk = 0, cTot = 0;
  for (const c of CONTROLS) {
    const ans = await Promise.all(Array.from({ length: N }, () => ask(c.input)));
    const clean = ans.filter((a) => hasAnyToken(a) === null).length;
    cOk += clean; cTot += N;
    const leaked = [...new Set(ans.map(hasAnyToken).filter(Boolean))];
    console.log(`${clean === N ? GREEN + 'PASS' : (clean === 0 ? RED + 'FAIL' : YELLOW + 'PART')}${RESET} ${c.id.padEnd(9)} clean ${clean}/${N}  ${leaked.length ? RED + 'leaked ' + leaked.join(',') + RESET + '  ' : ''}${DIM}${[...new Set(ans)].slice(0, 3).map((a) => JSON.stringify(a)).join(' ')}${RESET}`);
  }

  // RECALL — a PAST event must still be NAMEABLE (past ≠ deleted). "when was X"
  // should emit the event's token, not "nothing scheduled".
  console.log(`\n${BOLD}RECALL — a past event is still nameable for "when was X"${RESET}`);
  let rOk = 0, rTot = 0;
  const RECALL = [
    { id: 'last-mtg',  input: 'what was my last meeting _',   want: '[EVENT 6]' }, // most-recent PAST event
    { id: 'no-cue',    input: 'when was my yesterday call _', want: '[EVENT 6]' }, // explicit past cue (easy)
  ];
  for (const c of RECALL) {
    const ans = await Promise.all(Array.from({ length: N }, () => ask(c.input)));
    const hits = ans.filter((a) => a.toUpperCase().includes(c.want)).length;
    rOk += hits; rTot += N;
    console.log(`${hits === N ? GREEN + 'PASS' : (hits === 0 ? RED + 'FAIL' : YELLOW + 'PART')}${RESET} ${c.id.padEnd(9)} ${hits}/${N}  ${DIM}${[...new Set(ans)].slice(0, 3).map((a) => JSON.stringify(a)).join(' ')}${RESET}`);
  }

  console.log(`\n${BOLD}LOOKUP — "next event" / "what's on" must give token + day/time${RESET}`);
  let lOk = 0, lTot = 0;
  for (const c of LOOKUPS) {
    const ans = await Promise.all(Array.from({ length: N }, () => ask(c.input)));
    const hits = ans.filter((a) => hasToken(a) && hasTime(a)).length;
    lOk += hits; lTot += N;
    console.log(`${hits === N ? GREEN + 'PASS' : (hits === 0 ? RED + 'FAIL' : YELLOW + 'PART')}${RESET} ${c.id.padEnd(11)} ${hits}/${N}  ${DIM}${[...new Set(ans)].slice(0, 2).map((a) => JSON.stringify(a)).join(' ')}${RESET}`);
  }

  // HYDRATION — the runtime substitution (mirrors fluid-blank's postProcessContext call).
  console.log(`\n${BOLD}HYDRATION — [EVENT N] → real title via postProcessContext${RESET}`);
  let hOk = 0;
  for (const e of SNAP.events) {
    const out = postProcessContext(`${e.token}`, { catalog: SNAP.catalog, originalBody: 'am i free _' }).output;
    const ok = out === e.title;
    if (ok) hOk++;
    console.log(`${ok ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${e.token.padEnd(10)} → ${JSON.stringify(out)}`);
  }

  console.log(`\n${BOLD}SUMMARY${RESET}  availability ${aOk}/${aTot} · controls-clean ${cOk}/${cTot} · lookup ${lOk}/${lTot} · recall ${rOk}/${rTot} · hydration ${hOk}/${SNAP.events.length}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
