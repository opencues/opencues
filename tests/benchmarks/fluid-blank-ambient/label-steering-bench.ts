/**
 * Label-steering bench — does ambient label + typed hint produce a
 * fully-resolved value?
 *
 * The hypothesis under test: a field labelled "LinkedIn profile URL
 * (full URL)" with the user typing `danielsunderland _` should
 * produce `https://www.linkedin.com/in/danielsunderland`. The label
 * carries the SHAPE; the user's hint carries the CONTENT; the LLM
 * merges.
 *
 * Deterministic regex check per case (no LLM judge). Runs in parallel
 * against the configured provider; ~30s for 10 cases × 1 provider.
 *
 * Usage:
 *   GROQ_API_KEY=... npx tsx tests/benchmarks/fluid-blank-ambient/label-steering-bench.ts
 *   CEREBRAS_API_KEY=... OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
 *     npx tsx tests/benchmarks/fluid-blank-ambient/label-steering-bench.ts
 */

import { chat, sysUser } from '../fluid-blank/groq';
import { FUSED_SYSTEM_PROMPT } from '../../../packages/opencues-core/src/sources/fluid-blank-source';
import { renderAmbientMinimal } from './prompts';
import type { AmbientContext } from './cases';
import { renderUserCatalog, type UserContext } from '../../../packages/opencues-core/src/user-context';

// Synthetic USER.md catalog matching the live one the user complained
// about — the rule-#10 fix has to beat rule #6's "emit the token"
// pull when a hint is typed. Without this catalog the bench couldn't
// reproduce the chrome-log bug
// ("danielsunderland _" + LinkedIn label → user's OWN URL).
const SYNTHETIC_USER_CATALOG: UserContext = {
  fields: [
    { token: '[FIRST NAME]', description: "user's first name", value: 'Wilfred' },
    { token: '[LAST NAME]', description: "user's last name", value: 'Kasekende' },
    { token: '[EMAIL]', description: "user's email", value: 'wilfred@example.com' },
    { token: '[LINKEDIN]', description: "user's linkedin URL", value: 'https://linkedin.com/in/wkasekende' },
    { token: '[GITHUB]', description: "user's github URL", value: 'https://github.com/wkasekende' },
    { token: '[HOME COUNTRY]', description: "user's home country", value: 'United Kingdom' },
    { token: '[HOME POSTCODE]', description: "user's home postcode", value: 'SW1A 1AA' },
  ],
  catalog: '',  // unused by renderUserCatalog
};

interface LabelSteeringCase {
  id: string;
  buffer: string;
  ambient: AmbientContext;
  expect: RegExp;
  note: string;
}

const CASES: LabelSteeringCase[] = [
  {
    id: 'linkedin-handle',
    buffer: 'danielsunderland _',
    ambient: { label: 'LinkedIn profile URL (full URL)' },
    expect: /^https?:\/\/(www\.)?linkedin\.com\/in\/danielsunderland\/?$/i,
    note: 'Handle + LinkedIn label → full URL with handle embedded',
  },
  {
    id: 'github-handle',
    buffer: 'wkasekende _',
    ambient: { label: 'GitHub profile URL (full URL)' },
    expect: /^https?:\/\/(www\.)?github\.com\/wkasekende\/?$/i,
    note: 'Handle + GitHub label → full GitHub URL',
  },
  {
    id: 'twitter-handle',
    buffer: 'danielsunderland _',
    ambient: { label: 'Twitter / X profile URL' },
    expect: /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/danielsunderland\/?$/i,
    note: 'Handle + Twitter/X label → full URL (either domain ok)',
  },
  {
    id: 'mastodon-handle',
    buffer: '@daniel@fosstodon.org _',
    ambient: { label: 'Mastodon handle (full URL)' },
    expect: /^https?:\/\/fosstodon\.org\/@daniel\/?$/i,
    note: 'Mastodon @handle@instance → full instance URL',
  },
  {
    id: 'country-abbreviation',
    buffer: 'UK _',
    ambient: { label: 'Country' },
    expect: /^(United Kingdom|UK)$/,
    note: 'Country abbreviation should resolve to full name OR pass through',
  },
  {
    id: 'phone-raw-digits',
    buffer: '447700900123 _',
    ambient: { label: 'Phone number (UK format)' },
    expect: /^\+?44[ -]?7700[ -]?900[ -]?123$/,
    note: 'Raw digits + UK phone label → formatted',
  },
  {
    id: 'email-username-with-domain-hint',
    buffer: 'daniel _',
    ambient: { label: 'Work email', pageTitle: 'Acme Corp — Onboarding' },
    expect: /^daniel@acme(\.com|corp\.com)$/i,
    note: 'Username + Work email + Acme page title → daniel@acme.com',
  },
  {
    id: 'date-relative',
    buffer: 'tomorrow _',
    ambient: { label: 'Date (ISO YYYY-MM-DD)' },
    expect: /^\d{4}-\d{2}-\d{2}$/,
    note: 'Relative date + ISO label → ISO date format',
  },
  {
    id: 'linkedin-no-hint-falls-through',
    buffer: '_',
    ambient: { label: 'LinkedIn profile URL (full URL)' },
    // Without USER.md context, the LLM should produce SOMETHING shaped
    // like a linkedin URL (might be a generic placeholder); the test
    // is intentionally loose — we mostly want to see what it returns.
    expect: /^https?:\/\/(www\.)?linkedin\.com\/in\/[a-z0-9-]+\/?$/i,
    note: 'No hint — should still produce a linkedin-shaped URL (any handle)',
  },
  {
    id: 'github-no-hint-falls-through',
    buffer: '_',
    ambient: { label: 'GitHub profile URL (full URL)' },
    expect: /^https?:\/\/(www\.)?github\.com\/[a-z0-9-]+\/?$/i,
    note: 'No hint — github-shaped URL with any handle',
  },
];

async function runOne(c: LabelSteeringCase, withUserContext: boolean): Promise<{
  pass: boolean;
  actual: string;
  latencyMs: number;
}> {
  const ambBlock = renderAmbientMinimal(c.ambient);
  const userCatalog = withUserContext
    ? renderUserCatalog(SYNTHETIC_USER_CATALOG, 'safe')
    : '';
  const userMsg = `INPUT: ${c.buffer}${ambBlock}${userCatalog}`;
  const t0 = Date.now();
  const r = await chat(sysUser(FUSED_SYSTEM_PROMPT, userMsg), {
    maxTokens: 256, temperature: 0, seed: 42,
  });
  const latencyMs = Date.now() - t0;
  const m = r.text.match(/^ANSWER:\s*([\s\S]*?)\s*$/im);
  const actual = (m ? m[1] : r.text).trim();
  return { pass: c.expect.test(actual), actual, latencyMs };
}

async function runSuite(label: string, withUserContext: boolean): Promise<number> {
  console.log(`\n--- ${label} ---`);
  let pass = 0;
  const results = await Promise.all(CASES.map(c => runOne(c, withUserContext)));
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const r = results[i];
    const mark = r.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const lat = `${r.latencyMs}ms`.padStart(7);
    console.log(`${mark} ${lat}  ${c.id.padEnd(36)} → ${r.actual}`);
    if (!r.pass) {
      console.log(`         expected matching ${c.expect}`);
    }
    if (r.pass) pass++;
  }
  console.log(`${pass}/${CASES.length} passing`);
  return pass;
}

async function main(): Promise<void> {
  const provider = process.env['OPENCUES_BENCH_PROVIDER'] ?? 'groq-gpt-oss-120b';
  console.log(`\nLABEL-STEERING bench — provider=${provider}`);
  console.log(`Hypothesis: ambient label (shape) + typed buffer (content)`);
  console.log(`→ LLM constructs fully-resolved value, even when USER.md`);
  console.log(`  catalog is injected (typed hint should beat sentinel).`);

  const a = await runSuite('SUITE A: no user-context', false);
  const b = await runSuite('SUITE B: WITH user-context (mode=safe)', true);

  console.log(`\nTotals: ${a}/${CASES.length} no-user-ctx, ${b}/${CASES.length} with-user-ctx`);
  console.log(`Suite B is the chrome-real scenario.`);
}

main().catch(e => { console.error(e); process.exit(1); });
