// Production-path bench: calls the REAL FluidBlankSource prompt + catalog
// renderer directly (not the stripped SYSTEM_PROMPT the bench used
// initially). This is the only honest measurement — the live runtime
// runs against this same prompt, so the bench result reflects what
// users actually see in opencode/cc/etc.
//
// The earlier `run.ts` used a tiny system prompt that lacked the 30+
// factual-lookup examples in `FUSED_SYSTEM_PROMPT`. That overstated
// catalog-token emission rates by ~50pp on the gpt-oss family because
// the model's gravitational pull toward plain-prose answers (from
// those 30 examples) wasn't represented.

import { CASES } from './cases';
import {
  FluidBlankSource,
  renderBlankContextCatalog,
  renderIdentityContextCatalog,
  type BlankContextSnapshot,
  type Identity,
} from '../../../packages/opencues-core/dist';
import { chat, sysUser } from '../fluid-blank/groq';
// Import the real FUSED prompt — the same string the live runtime uses.
const { FUSED_SYSTEM_PROMPT } = require('../../../packages/opencues-core/dist/sources/fluid-blank-source.js');

// Mirror live OPENCODE config: 14 identity-context fields injected
// alongside blank-context. The 14 fields create token-selection
// competition the model must navigate.
const LIVE_IDENTITY: Identity = {
  fields: [
    { key: 'firstName',    token: '[FIRST NAME]',    value: 'Wilfred',                   description: 'first name' },
    { key: 'lastName',     token: '[LAST NAME]',     value: 'Kasekende',                 description: 'last name' },
    { key: 'fullName',     token: '[FULL NAME]',     value: 'Wilfred Kasekende',         description: 'full name' },
    { key: 'pronouns',     token: '[PRONOUNS]',      value: 'he/him',                    description: 'pronouns' },
    { key: 'email',        token: '[EMAIL]',         value: 'w@commandstick.com',        description: 'email' },
    { key: 'phone',        token: '[PHONE]',         value: '+44 7700 900123',           description: 'phone' },
    { key: 'company',      token: '[COMPANY]',       value: 'Command Stick',             description: 'company' },
    { key: 'jobTitle',     token: '[JOB TITLE]',     value: 'Founder',                   description: 'job title' },
    { key: 'github',       token: '[GITHUB]',        value: 'https://github.com/wkasekende', description: 'github profile' },
    { key: 'linkedin',     token: '[LINKEDIN]',      value: 'https://linkedin.com/in/wkasekende', description: 'linkedin profile' },
    { key: 'workCity',     token: '[WORK CITY]',     value: 'London',                    description: 'work city' },
    { key: 'homeCountry',  token: '[HOME COUNTRY]',  value: 'United Kingdom',            description: 'home country' },
    { key: 'portfolio',    token: '[PORTFOLIO]',     value: 'AAPL,NVDA,GOOG',             description: 'stock portfolio' },
    { key: 'birthday',     token: '[BIRTHDAY]',      value: '1992-04-15',                 description: 'date of birth' },
  ],
  catalog: new Map(),
};
for (const f of LIVE_IDENTITY.fields) LIVE_IDENTITY.catalog.set(f.token, f.value);

interface Result {
  caseId: string;
  klass: string;
  expectedLabel: string;
  rawAnswer: string;
  emittedTokens: string[];
  correct: boolean;
}

function parseAnswer(raw: string): string {
  const m = raw.match(/^ANSWER:\s*(.*)$/m);
  return m ? m[1].trim() : raw.trim();
}

function detectTokens(answer: string, validTokens: ReadonlyArray<string>): string[] {
  const found = answer.match(/\[[A-Z][A-Z 0-9_-]*\]/g) ?? [];
  return found.filter(t => validTokens.includes(t));
}

function expectedLabel(c: typeof CASES[0]): string {
  if (c.expected === null) return 'none';
  if (typeof c.expected === 'string') return c.expected;
  return `topic:${c.expected.topic}`;
}

async function runOne(c: typeof CASES[0]): Promise<Result> {
  // Build snapshot the same way the runtime does — fields with token/description/value/blankName/slot.
  const snapshot: BlankContextSnapshot = {
    fields: c.catalog.map(t => ({
      ...t,
      blankName: 'test',
      slot: t.token.replace(/[\[\]]/g, '').split(' ').slice(1).join(' ') || 'value',
    })),
    catalog: new Map(c.catalog.map(t => [t.token, t.value])),
  };
  // Mirror live: BOTH catalogs injected, identity-context first then
  // blank-context (matching fluid-blank-source.ts ordering).
  const identityBlock = renderIdentityContextCatalog(LIVE_IDENTITY, 'safe');
  const blankBlock = renderBlankContextCatalog(snapshot, 'safe');
  const userMsg = `INPUT: ${c.input}${identityBlock}${blankBlock}`;
  // Production fluid-blank now forces reasoning='low' on every call
  // (see `fluid-blank-source.ts:callLLM`). Bench reuses provider
  // defaults via the bench's chat() wrapper, which on Cerebras would
  // default to medium — but we want this bench to mirror what
  // PRODUCTION does, so override to low here too.
  const { text } = await chat(sysUser(FUSED_SYSTEM_PROMPT, userMsg), { maxTokens: 256, reasoning: 'low' } as any);
  const answer = parseAnswer(text);
  const validTokens = c.catalog.map(t => t.token);
  const emitted = detectTokens(answer, validTokens);

  let correct: boolean;
  if (c.expected === null) correct = emitted.length === 0;
  else if (typeof c.expected === 'string') correct = emitted.includes(c.expected);
  else {
    const prefix = `[${c.expected.topic} `;
    const exact = `[${c.expected.topic}]`;
    correct = emitted.some(t => t === exact || t.startsWith(prefix));
  }

  return {
    caseId: c.id,
    klass: c.klass,
    expectedLabel: expectedLabel(c),
    rawAnswer: answer,
    emittedTokens: emitted,
    correct,
  };
}

async function main(): Promise<void> {
  console.log(`══════════════════════════════════════════════════════════════`);
  console.log(`Production-path bench — real FUSED_SYSTEM_PROMPT + renderBlankContextCatalog`);
  console.log(`══════════════════════════════════════════════════════════════`);
  const results: Result[] = [];
  for (const c of CASES) {
    const r = await runOne(c);
    results.push(r);
    const flag = r.correct ? '\x1b[32m●\x1b[0m' : '✗';
    const ans = r.rawAnswer.slice(0, 70).replace(/\s+/g, ' ');
    const got = r.emittedTokens.length === 0 ? '(prose)' : r.emittedTokens.join(',');
    console.log(`  ${flag} ${r.caseId} [${r.klass}] expected=${r.expectedLabel} got=${got}  → "${ans}"`);
  }

  const byKlass: Record<string, { p: number; t: number }> = {
    positive: { p: 0, t: 0 }, negative: { p: 0, t: 0 }, ambiguous: { p: 0, t: 0 },
  };
  for (const r of results) { byKlass[r.klass].t++; if (r.correct) byKlass[r.klass].p++; }
  const pct = (k: string) => byKlass[k].t === 0 ? '-' : ((byKlass[k].p / byKlass[k].t) * 100).toFixed(1) + '%';
  const overall = results.filter(r => r.correct).length;

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`SUMMARY (production path)`);
  console.log(`══════════════════════════════════════════════════════════════`);
  console.log(`  positive   ${byKlass.positive.p}/${byKlass.positive.t}  (${pct('positive')})`);
  console.log(`  negative   ${byKlass.negative.p}/${byKlass.negative.t}  (${pct('negative')})`);
  console.log(`  ambiguous  ${byKlass.ambiguous.p}/${byKlass.ambiguous.t}  (${pct('ambiguous')})`);
  console.log(`  overall    ${overall}/${results.length}  (${((overall / results.length) * 100).toFixed(1)}%)`);
}

void FluidBlankSource;  // silence unused-import warning; kept for future reference
main().catch(err => { console.error('ERROR:', err); process.exit(1); });
