// App-aware output steering check — proves the NATIVE `app` ambient field
// (1) reshapes the fluid-blank ANSWER to the app's field format, AND
// (2) forces MODE=WIPE with the WHOLE input as the SPAN, so the answer
// REPLACES the query instead of being appended to it.
//
// This is the guard for the WHOLE-FIELD-IS-THE-QUERY rule in the `appSteer`
// block of fluid-blank-source.ts (opencues #341 follow-up). Before that rule,
// WIPE was left to the general segmenter's per-input guess: it wiped
// "my tax pdfs _" (Explorer) but FILLED "reddit com _" (Chrome omnibox), so
// the omnibox produced "reddit com https://www.reddit.com" — the answer
// appended, the query never removed.
//
// Run against the PRODUCTION renderAmbientBlock + FUSED_SYSTEM_PROMPT.
// Select a provider/model via the standard bench router env vars, e.g. the
// user's own runtime model:
//
//   OPENCUES_BENCH_PROVIDER=gemini-flash-lite OPENCUES_GEMINI_MODEL=gemini-3.1-flash-lite \
//     npx tsx tests/benchmarks/fluid-blank-ambient/app-steer-smoke.ts
//
// Pass/fail gate: every app case MUST come back MODE=WIPE with SPAN=the whole
// input. Exits non-zero on any failure. Prints the with-app vs without-app
// answer so the format steering is also eyeballable.
import { FUSED_SYSTEM_PROMPT, renderAmbientBlock } from '../../../packages/opencues-core/src/sources/fluid-blank-source';
import { chat, sysUser, MODEL } from '../fluid-blank/groq';

interface Case {
  id: string;
  input: string;
  withApp: Parameters<typeof renderAmbientBlock>[0];
  /** substring the ANSWER should contain (format sanity — not the gate) */
  answerHint?: string;
}

// Explorer (file-search) + Chrome (omnibox) — both must WIPE.
const CASES: Case[] = [
  {
    id: 'explorer-tax-pdfs',
    input: 'my tax pdfs _',
    withApp: { label: 'Search Box', pageTitle: 'Documents - File Explorer', app: 'explorer' },
    answerHint: '.pdf',
  },
  {
    id: 'explorer-downloads-folder',
    input: 'the downloads folder _',
    withApp: { label: 'Search Box', pageTitle: 'This PC - File Explorer', app: 'explorer' },
  },
  {
    id: 'explorer-photos-2023',
    input: 'photos from 2023 _',
    withApp: { label: 'Search Box', pageTitle: 'Pictures - File Explorer', app: 'explorer' },
  },
  {
    id: 'chrome-reddit',
    input: 'reddit com _',
    withApp: { label: 'Address and search bar', pageTitle: 'New Tab', app: 'chrome' },
    answerHint: 'reddit.com',
  },
  {
    id: 'chrome-wikipedia-rust',
    input: 'the wikipedia rust article _',
    withApp: { label: 'Address and search bar', pageTitle: 'New Tab', app: 'chrome' },
    answerHint: 'wikipedia.org',
  },
  {
    id: 'chrome-weather-search',
    input: 'weather in oslo tomorrow _',
    withApp: { label: 'Address and search bar', pageTitle: 'New Tab', app: 'chrome' },
  },
];

function field(text: string, name: string): string {
  const m = text.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)\\s*$`, 'im'));
  return (m ? m[1] : '').trim();
}
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

async function ask(input: string, ambient: Parameters<typeof renderAmbientBlock>[0]): Promise<{ span: string; mode: string; answer: string }> {
  const userMsg = `INPUT: ${input}${renderAmbientBlock(ambient)}`;
  const r = await chat(sysUser(FUSED_SYSTEM_PROMPT, userMsg), { maxTokens: 256, temperature: 0, seed: 42 });
  // MODE line often carries a trailing rationale ("WIPE — terse phrase"); take the first word.
  const modeRaw = field(r.text, 'MODE');
  return { span: field(r.text, 'SPAN'), mode: (modeRaw.match(/^\w+/)?.[0] ?? '').toUpperCase(), answer: field(r.text, 'ANSWER') };
}

async function main(): Promise<void> {
  console.log(`App-steer WIPE check — model: ${MODEL}\n`);
  let pass = 0;
  const fails: string[] = [];
  for (const c of CASES) {
    const noApp = { ...c.withApp, app: undefined };
    const [withApp, without] = await Promise.all([ask(c.input, c.withApp), ask(c.input, noApp)]);

    // GATE: with app present, the whole field is the query → MODE=WIPE and
    // SPAN must cover the whole input (no query words left outside it).
    const wholeSpan = norm(withApp.span) === norm(c.input);
    const isWipe = withApp.mode === 'WIPE';
    const answerOk = !!withApp.answer && (!c.answerHint || withApp.answer.toLowerCase().includes(c.answerHint.toLowerCase()));
    const ok = isWipe && wholeSpan && answerOk;
    if (ok) pass++;
    else fails.push(c.id);

    console.log(`${ok ? '✓' : '✗'} ${c.id}   input: "${c.input}"`);
    console.log(`    with app=${c.withApp?.app} : mode=${withApp.mode} span=${JSON.stringify(withApp.span)} answer=${JSON.stringify(withApp.answer)}`);
    console.log(`    without app         : mode=${without.mode} span=${JSON.stringify(without.span)} answer=${JSON.stringify(without.answer)}`);
    if (!ok) {
      const why = [!isWipe && `mode≠WIPE (${withApp.mode})`, !wholeSpan && 'SPAN≠whole-input', !answerOk && `answer missing "${c.answerHint}"`].filter(Boolean).join(', ');
      console.log(`    FAIL: ${why}`);
    }
    console.log('');
  }
  console.log(`──────────────────────────────────────────────`);
  console.log(`${pass}/${CASES.length} passed${fails.length ? `  (failing: ${fails.join(', ')})` : ''}`);
  if (fails.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
