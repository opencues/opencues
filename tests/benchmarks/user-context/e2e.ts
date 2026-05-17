/**
 * End-to-end smoke test for the User Context feature.
 *
 * Drives PRODUCTION code paths — not the bench prompt — against a
 * real LLM, with a synthetic User.md that includes obviously-fake
 * but realistic-looking fields.
 *
 * Specifically exercises:
 *   1. parseUserMd parses the synthetic User.md into a catalog
 *   2. renderUserCatalog produces a prompt block in `safe` mode
 *   3. A real call to FluidBlankSource (production class, real
 *      provider via OPENCUES_BENCH_PROVIDER) with userContext
 *      threaded through CueContext
 *   4. The resulting answer is post-processed → real values land
 *      in result.alternatives
 *   5. `off` mode skips the entire path; `raw` mode inlines values
 *
 * Usage:
 *   OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss \
 *     npx tsx tests/benchmarks/user-context/e2e.ts
 */

import {
  parseUserMd,
  renderUserCatalog,
  postProcessUserContext,
  type UserContextMode,
} from '../../../packages/opencues-core/src/user-context';
import { FluidBlankSource } from '../../../packages/opencues-core/src/sources/fluid-blank-source';
import { getProvider } from '../../../packages/opencues-core/src/llm-provider';
import type { HttpAdapter, CueContext } from '../../../packages/opencues-core/src/types';
import * as https from 'https';

// ─── synthetic User.md (FAKE — for testing only) ───────────────────────────

const FAKE_USER_MD = `---
firstName:    Wilfred
lastName:     Kasekende
fullName:     Wilfred Kasekende
pronouns:     he/him
email:        wilfred@example-test.com
phone:        +44 7700 900123
jobTitle:     Software Engineer
company:      Acme Corp
workCity:     London
homeCity:     London
homeCountry:  United Kingdom
homePostcode: SW1A 1AA
github:       https://github.com/wkasekende
linkedin:     https://linkedin.com/in/wkasekende
twitter:      "@wkasekende"
website:      https://wkasekende.com
---

# User.md body — IGNORED in Phase 1.
This is documentation for myself; the runtime parses only the
frontmatter above.
`;

// ─── real HTTP adapter — matches what production uses ──────────────────────

const httpAdapter: HttpAdapter = {
  post: (url, body, headers) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => res.statusCode && res.statusCode < 400 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  }),
};

// ─── runner ────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function pickEndpoint(): { endpoint: string; apiKey: string; model: string; providerId: 'groq' | 'cerebras' | 'gemini' | 'anthropic' | 'openai' } {
  // Default to the recommended fluid-blank provider — same model the
  // production auto-router would pick on a host with the matching key.
  const p = process.env.OPENCUES_BENCH_PROVIDER ?? 'groq-gpt-oss';
  if (p === 'cerebras-gpt-oss') {
    if (!process.env.CEREBRAS_API_KEY) throw new Error('CEREBRAS_API_KEY not set');
    return {
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: process.env.CEREBRAS_API_KEY,
      model: 'gpt-oss-120b',
      providerId: 'cerebras',
    };
  }
  if (p === 'gemini-flash-lite') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    return {
      // Production endpoint shape — `getProvider('gemini')` builds the
      // native generateContent payload. Using the OpenAI-compat URL
      // here hits the wrong API + 400s.
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
      apiKey: process.env.GEMINI_API_KEY,
      model: 'gemini-3.1-flash-lite',
      providerId: 'gemini',
    };
  }
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  return {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY,
    model: 'openai/gpt-oss-120b',
    providerId: 'groq',
  };
}

interface E2ECase {
  id: string;
  /** Text the "user" typed, ending in `_`. */
  input: string;
  /** True if the answer should contain a substituted catalog value. */
  expectsValue?: string;
  /** True if the answer should NOT contain any catalog value (anti-case). */
  forbidAnyCatalogValue?: boolean;
}

const CASES: E2ECase[] = [
  // Direct lookups — value should land in alternatives.
  { id: 'email',        input: 'my email _',                       expectsValue: 'wilfred@example-test.com' },
  { id: 'github',       input: 'my github _',                      expectsValue: 'https://github.com/wkasekende' },
  { id: 'first-name',   input: 'my first name _',                  expectsValue: 'Wilfred' },
  { id: 'work-city',    input: 'i work in _',                      expectsValue: 'London' },
  { id: 'twitter',      input: 'my twitter handle _',              expectsValue: '@wkasekende' },
  { id: 'postcode',     input: 'my postcode _',                    expectsValue: 'SW1A 1AA' },
  { id: 'company',      input: 'i work at _',                      expectsValue: 'Acme Corp' },

  // Anti-cases — generic factual; no catalog value should leak.
  { id: 'anti-capital', input: 'capital of france _',              forbidAnyCatalogValue: true },
  { id: 'anti-math',    input: '12 times 7 _',                     forbidAnyCatalogValue: true },
];

async function runCase(
  source: FluidBlankSource,
  c: E2ECase,
  userContext: ReturnType<typeof parseUserMd>,
  mode: UserContextMode,
): Promise<{ pass: boolean; answer: string; reason?: string; latencyMs: number }> {
  const ctx: CueContext = {
    text: c.input,
    words: c.input.split(/\s+/),
    userContext: mode === 'off' ? undefined : {
      fields: userContext.fields,
      catalog: userContext.catalog,
      mode,
    },
  };
  const t0 = Date.now();
  const result = await source.getCues(ctx);
  const latencyMs = Date.now() - t0;
  const alt = result.results[0]?.alternatives?.[1] ?? '';

  // Off mode: we don't care about what the LLM said (anything is fine);
  // we ONLY care that no catalog value leaked (since no catalog was sent).
  if (mode === 'off') {
    for (const f of userContext.fields) {
      if (alt.includes(f.value)) {
        return { pass: false, answer: alt, latencyMs, reason: `off mode but catalog value "${f.value}" leaked into output — runtime gate must be broken` };
      }
    }
    return { pass: true, answer: alt, latencyMs };
  }

  // Anti-case: no catalog value should appear in the answer.
  if (c.forbidAnyCatalogValue) {
    for (const f of userContext.fields) {
      // Skip very short / generic values to avoid false-positives —
      // "Wilfred" is unique enough; "he/him" too short / common
      // (intentional skip pattern, mirroring bench's ≥3 char rule).
      if (f.value.length < 4) continue;
      if (alt.includes(f.value)) {
        return { pass: false, answer: alt, latencyMs, reason: `anti-case but catalog value "${f.value}" appears in answer` };
      }
    }
    return { pass: true, answer: alt, latencyMs };
  }

  // Value case: the expected value should be in the answer (allowing
  // surrounding text — e.g. "wilfred@example-test.com" inside a fuller
  // signature). Exact substring is fine.
  if (c.expectsValue && !alt.includes(c.expectsValue)) {
    return { pass: false, answer: alt, latencyMs, reason: `expected "${c.expectsValue}" not in answer` };
  }
  return { pass: true, answer: alt, latencyMs };
}

async function main(): Promise<void> {
  const { endpoint, apiKey, model, providerId } = pickEndpoint();
  const provider = getProvider(providerId)!;
  const source = new FluidBlankSource({ provider, endpoint, apiKey, model, httpAdapter });

  // Step 1 — verify the parser.
  const userContext = parseUserMd(FAKE_USER_MD);
  console.log(`${BOLD}STEP 1: parseUserMd${RESET}`);
  console.log(`  Parsed ${userContext.fields.length} fields from fake User.md`);
  console.log(`  Sample tokens: ${userContext.fields.slice(0, 5).map(f => f.token).join(', ')} …`);
  if (userContext.fields.length !== 16) {
    console.error(`  ${RED}FAIL${RESET}: expected 16 fields, got ${userContext.fields.length}`);
    process.exit(2);
  }
  console.log(`  ${GREEN}OK${RESET}\n`);

  // Step 2 — verify renderUserCatalog produces sensible prompts.
  console.log(`${BOLD}STEP 2: renderUserCatalog${RESET}`);
  const safeBlock = renderUserCatalog(userContext, 'safe');
  const rawBlock = renderUserCatalog(userContext, 'raw');
  const offBlock = renderUserCatalog(userContext, 'off');
  console.log(`  safe block: ${safeBlock.length} chars, no values: ${!FAKE_USER_MD.includes('Wilfred') || !safeBlock.includes('Wilfred')}`);
  console.log(`  raw block:  ${rawBlock.length} chars, has values: ${rawBlock.includes('Wilfred')}`);
  console.log(`  off block:  empty: ${offBlock === ''}`);
  if (safeBlock.includes('Wilfred') || !rawBlock.includes('Wilfred') || offBlock !== '') {
    console.error(`  ${RED}FAIL${RESET}: catalog rendering broken`);
    process.exit(2);
  }
  console.log(`  ${GREEN}OK${RESET}\n`);

  // Step 3 — three sweeps: safe, raw, off.
  for (const mode of ['safe', 'raw', 'off'] as const) {
    console.log(`${BOLD}STEP 3: FluidBlankSource × real LLM, mode=${mode}${RESET}`);
    console.log(`Provider: ${model}\n`);
    let pass = 0;
    let totalLatency = 0;
    for (const c of CASES) {
      const r = await runCase(source, c, userContext, mode);
      totalLatency += r.latencyMs;
      const tag = r.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      console.log(`  ${tag}  ${c.id.padEnd(14)}  ${DIM}${r.latencyMs}ms${RESET}`);
      const shown = r.answer.length > 80 ? r.answer.slice(0, 80) + '…' : r.answer;
      console.log(`    ${DIM}answer:${RESET} ${shown || '(empty)'}`);
      if (!r.pass && r.reason) console.log(`    ${YELLOW}↳${RESET} ${r.reason}`);
      if (r.pass) pass++;
    }
    const total = CASES.length;
    const avg = Math.round(totalLatency / total);
    console.log(`  ${BOLD}${pass}/${total}${RESET} pass (${(pass / total * 100).toFixed(1)}%) · avg ${avg}ms\n`);
  }

  // Step 4 — verify the post-processor's report shape (in-process, no LLM).
  console.log(`${BOLD}STEP 4: postProcessUserContext (in-process)${RESET}`);
  const sample = postProcessUserContext(
    '[FIRST NAME] ([NICKNAME]) at [WORK_CITY] — [EMAIL]',
    { catalog: userContext.catalog },
  );
  console.log(`  resolved:   ${sample.report.resolved.map(r => r.token).join(', ')}`);
  console.log(`  tolerant:   ${sample.report.tolerantMatches.map(t => `${t.written}→${t.canonical}`).join(', ')}`);
  console.log(`  stripped:   ${sample.report.stripped.join(', ')}`);
  console.log(`  output:     ${sample.output}`);
  if (
    sample.report.resolved.length !== 2 ||
    sample.report.tolerantMatches.length !== 1 ||
    sample.report.stripped.length !== 1
  ) {
    console.error(`  ${RED}FAIL${RESET}: post-process report shape off`);
    process.exit(2);
  }
  console.log(`  ${GREEN}OK${RESET}\n`);

  console.log(`${BOLD}═══ E2E COMPLETE ═══${RESET}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
