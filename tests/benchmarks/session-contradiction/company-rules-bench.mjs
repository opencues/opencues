// Company-rules watchlists through the REAL session-contradiction matcher.
//
// The proposal: a static, org-authored rules file served to the matcher as a
// watchlist — no Stage-A producer, rules come from a file. Before building the
// loading mechanism, this bench answers whether the matcher is any good at
// POLICY statements rather than session decisions, across different kinds of
// company, and whether its "decisions you made earlier in this coding session"
// framing hurts when the watchlist is actually the employer's rulebook.
//
// Two arms:
//   SOURCE  the real SessionContradictionSource, unchanged — rules ride the
//           session-commitments catalog exactly as a merged RULES.md would
//   FRAMED  the same model + parsing, but the watchlist introduced as COMPANY
//           POLICY rather than session decisions — measures the headroom a
//           rules-aware header would buy before we commit to one
//
// Scoring is DETERMINISTIC, no judge: every case is labeled with the rule id
// it violates (or null), and the matcher's grounding invariant means a flag
// cites an id — so we score flagged-when-should, silent-when-should, and
// CITED THE RIGHT RULE, by string comparison. The traps are topic-adjacent
// compliant drafts: mention the rule's subject while obeying it. False-alarm
// rate on those is the number that decides whether this is shippable — a
// compliance nudge that wrongly accuses people gets turned off in a week.
//
// Run: CEREBRAS_API_KEY=… node tests/benchmarks/session-contradiction/company-rules-bench.mjs [--gen gemma]

import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const scMod = await import(path.join(R, 'packages/opencues-core/dist/contradiction/session-contradiction-source.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });

const genArg = process.argv.includes('--gen') ? process.argv[process.argv.indexOf('--gen') + 1] : '';
const GEN = genArg === 'gemma'
  ? { provider: core.getProvider('cerebras'), model: 'gemma-4-31b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gemma-4-31b' }
  : { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gpt-oss-120b' };

// ── five kinds of company ───────────────────────────────────────────────────
// Each: a curated rules list (the size we'd tell orgs to keep — see the
// near-duplicate finding in session-commitments.ts) and drafts labeled with
// the rule they violate, or null for the traps and the unrelated.
const DOMAINS = [
  {
    id: 'engineering',
    rules: [
      { id: 'r1', statement: 'No new third-party dependencies without platform-team approval.' },
      { id: 'r2', statement: 'Secrets and API keys never go in code, config files, or logs.' },
      { id: 'r3', statement: 'Customer data stays in EU regions (eu-west-1) — never replicate it elsewhere.' },
      { id: 'r4', statement: 'Every change to main requires a reviewed PR — no direct pushes.' },
      { id: 'r5', statement: 'Use the structured logger; console.log never ships to production.' },
    ],
    cases: [
      { s: "let's just npm install lodash for this, it's one helper", want: 'r1' },
      { s: "I'll hardcode the Stripe key in the config for the demo and rotate it later", want: 'r2' },
      { s: 'quickest fix is to mirror the customer table to us-east-1 for the analytics job', want: 'r3' },
      { s: "it's a one-line fix, I'll push straight to main and skip the PR", want: 'r4' },
      { s: 'threw a few console.logs in the payment handler to trace it in prod', want: 'r5' },
      { s: 'I asked platform for approval on the redis client and they signed off, adding it now', want: null },   // trap: obeys r1
      { s: 'moved the key out of the repo and into the vault like the policy says', want: null },                  // trap: obeys r2
      { s: 'the cache eviction tests all pass now, opening the PR for review', want: null },                       // unrelated + obeys r4
    ],
  },
  {
    id: 'comms-pr',
    rules: [
      { id: 'r1', statement: 'No forward-looking revenue or growth numbers in any external communication.' },
      { id: 'r2', statement: "Never name or hint at the unannounced product (codename Falcon) outside the core team." },
      { id: 'r3', statement: 'Do not disparage competitors by name.' },
      { id: 'r4', statement: 'Everything about the partnership is under embargo until the 14th.' },
    ],
    cases: [
      { s: "I'll tell the analyst we expect revenue to double next year", want: 'r1' },
      { s: 'adding a teaser line about Falcon to the newsletter draft', want: 'r2' },
      { s: "the blog post should say our competitor's product is unreliable junk", want: 'r3' },
      { s: "let's brief the journalist on the partnership today so the story lands early", want: 'r4' },
      { s: 'the earnings recap sticks to last quarter’s reported numbers only', want: null },      // trap: obeys r1
      { s: 'scheduled the partnership announcement for the 15th, after the embargo lifts', want: null },  // trap: obeys r4
      { s: 'drafting the conference booth copy for the products we already sell', want: null },
    ],
  },
  {
    id: 'support',
    rules: [
      { id: 'r1', statement: 'Never promise refunds beyond the published 30-day policy.' },
      { id: 'r2', statement: 'No SLA or uptime commitments beyond what the customer’s contract states.' },
      { id: 'r3', statement: 'Never blame a named engineer or team in customer communications.' },
      { id: 'r4', statement: 'Never reveal one customer’s identity or usage to another customer.' },
    ],
    cases: [
      { s: "tell them we'll refund the full year, it's been six months but they're angry", want: 'r1' },
      { s: "I'll commit us to 99.99% uptime in the reply so they calm down", want: 'r2' },
      { s: 'drafting the apology: the outage was the database team’s fault, specifically Marco’s migration', want: 'r3' },
      { s: 'mention that AcmeCorp uses the same plan and loves it, that should reassure them', want: 'r4' },
      { s: 'they are on day 12, so a refund is within policy — processing it', want: null },       // trap: obeys r1
      { s: 'pointed them at the SLA section of their contract for the uptime numbers', want: null }, // trap: obeys r2
      { s: 'escalating the ticket with full repro steps to the on-call queue', want: null },
    ],
  },
  {
    id: 'healthcare',
    rules: [
      { id: 'r1', statement: 'Staff never give medical advice — direct patients to their clinician.' },
      { id: 'r2', statement: 'PHI (patient names, conditions, records) never goes in email or chat — portal only.' },
      { id: 'r3', statement: 'Only HIPAA-approved vendors may process patient data.' },
    ],
    cases: [
      { s: "I'll tell the patient they can safely double the dose while they wait", want: 'r1' },
      { s: "emailing the front desk the patient's diagnosis so they can prep the room", want: 'r2' },
      { s: "let's pipe the intake forms through that new transcription startup, it's much cheaper", want: 'r3' },
      { s: 'replied that dosage questions need to go to their clinician, and flagged the chart', want: null },  // trap: obeys r1
      { s: 'uploaded the records to the portal and sent the patient a login reminder', want: null },            // trap: obeys r2
      { s: 'rescheduling Thursday’s staff meeting to Friday morning', want: null },
    ],
  },
  {
    id: 'finance',
    rules: [
      { id: 'r1', statement: 'Never give investment advice or guarantee returns to clients.' },
      { id: 'r2', statement: 'Material non-public information is never discussed outside the deal team.' },
      { id: 'r3', statement: 'Fees are quoted only from the published schedule — no ad-hoc discounts in writing.' },
    ],
    cases: [
      { s: "tell the client this fund is a sure thing, they'll easily make 20%", want: 'r1' },
      { s: 'mentioning the pending acquisition to the sales floor so they stop asking', want: 'r2' },
      { s: "I'll email them 40% off the management fee to close the deal", want: 'r3' },
      { s: 'sent the client the published fee schedule and the standard risk disclosure', want: null },  // trap: obeys r1+r3
      { s: 'the deal team sync moved to 3pm, same room', want: null },
    ],
  },
];

// ── arms ────────────────────────────────────────────────────────────────────
function snapshotOf(domain) {
  return core.buildSessionCommitmentsSnapshot(
    domain.rules.map((r) => ({ category: 'constraint', statement: r.statement })),
    { sessionId: `rules-${domain.id}` });
  // NOTE buildSessionCommitmentsSnapshot re-ids to c1..cN in order, so cN maps
  // 1:1 onto our rN by position — scoring below translates.
}

// The CueResult deliberately does not expose the cited commitment id, so to
// score right-rule we replicate the source's wire call BYTE FOR BYTE — same
// system prompt constant, same catalog renderer, same temp/seed/maxTokens —
// and apply the same two grounding filters to the parsed flags. Verified
// against src/contradiction/session-contradiction-source.ts:match().
async function runSOURCE(domain, text) {
  const snap = snapshotOf(domain);
  const watchlist = core.renderSessionCommitmentsCatalog(snap, 'on');
  try {
    const raw = await core.dispatchChat(GEN.provider, http, {
      model: GEN.model,
      messages: [
        { role: 'system', content: `${scMod.SESSION_CONTRADICTION_MATCH_SYSTEM}${watchlist}` },
        { role: 'user', content: `DRAFT: ${text}` },
      ],
      maxTokens: 400, temperature: 0, seed: 42,
    }, { apiKey: GEN.key });
    const flags = scMod.parseFlags(raw)
      .filter((f) => typeof f.quote === 'string' && text.includes(f.quote.trim()))
      .filter((f) => snap.commitments.some((c) => c.id === f.commitmentId));
    if (!flags.length) return { flagged: false };
    return { flagged: true, cited: flags[0].commitmentId, tip: flags[0].tip };
  } catch { return { flagged: false, errored: true }; }
}

const FRAMED_SYSTEM = `You are a fast checker inside a text editor. Your SYSTEM context lists COMPANY POLICY RULES that apply to everything the writer sends. The USER message is a DRAFT the writer is about to send. Find any sentence in the DRAFT that DIRECTLY VIOLATES a listed rule — i.e. it proposes, promises, or asserts the thing the rule forbids.

Output ONLY a JSON array (no prose, no markdown fences). Output [] when nothing violates a rule.
Each element: {"quote":"<the exact offending sentence, VERBATIM from the DRAFT>","commitmentId":"c<N>","tip":"<up to 80 chars: which rule it breaks>","reconciled":"<the sentence rewritten to comply; omit if no clean rewrite>"}

RULES (precision over recall — a false accusation is worse than a miss):
- Flag ONLY a direct, specific violation. Mentioning a rule's topic while COMPLYING with it is NOT a violation.
- Doing the thing the rule requires (getting the approval, using the portal, quoting the schedule) is COMPLIANCE — never flag it.
- If unsure, output [].`;

async function runFRAMED(domain, text) {
  const snap = snapshotOf(domain);
  const catalog = snap.commitments.map((c) => `- ${c.id}: ${c.statement}`).join('\n');
  try {
    const raw = await core.dispatchChat(GEN.provider, http, {
      model: GEN.model,
      messages: [
        { role: 'system', content: `${FRAMED_SYSTEM}\n\nCOMPANY POLICY RULES:\n${catalog}` },
        { role: 'user', content: `DRAFT: ${text}` },
      ],
      maxTokens: 400, temperature: 0, seed: 42,
    }, { apiKey: GEN.key });
    const flags = scMod.parseFlags(raw)
      // Same grounding the source enforces: verbatim quote + known id.
      .filter((f) => typeof f.quote === 'string' && text.includes(f.quote.trim()))
      .filter((f) => snap.commitments.some((c) => c.id === f.commitmentId));
    if (!flags.length) return { flagged: false };
    return { flagged: true, cited: flags[0].commitmentId, tip: flags[0].tip };
  } catch { return { flagged: false, errored: true }; }
}

// ── score ───────────────────────────────────────────────────────────────────
const L = (...a) => process.stderr.write(a.join(' ') + '\n');
L(`company-rules bench — matcher ${GEN.name}, deterministic scoring (no judge)\n`);

const totals = {};
for (const arm of ['SOURCE', 'FRAMED']) totals[arm] = { flag: 0, flagT: 0, right: 0, silent: 0, silentT: 0, err: 0 };

for (const domain of DOMAINS) {
  L(`── ${domain.id}  (${domain.rules.length} rules, ${domain.cases.length} drafts)`);
  for (const c of domain.cases) {
    const wantId = c.want ? `c${domain.rules.findIndex((r) => r.id === c.want) + 1}` : null;
    const [a, b] = await Promise.all([runSOURCE(domain, c.s), runFRAMED(domain, c.s)]);
    for (const [arm, r] of [['SOURCE', a], ['FRAMED', b]]) {
      const t = totals[arm];
      if (r.errored) t.err++;
      if (wantId) { t.flagT++; if (r.flagged) { t.flag++; if (r.cited === wantId) t.right++; } }
      else { t.silentT++; if (!r.flagged) t.silent++; }
    }
    const mark = (r) => !c.want ? (r.flagged ? '✗FALSE-ALARM' : '✓') : (r.flagged ? (r.cited === wantId ? '✓' : `~wrong-rule(${r.cited})`) : '✗missed');
    L(`   [${(c.want ?? 'silent').padEnd(6)}] src ${mark(a).padEnd(14)} framed ${mark(b).padEnd(14)} | ${c.s.slice(0, 62)}`);
  }
}

L('\n' + '='.repeat(86));
for (const [arm, t] of Object.entries(totals)) {
  L(`${arm.padEnd(7)} recall ${t.flag}/${t.flagT} · right-rule ${t.right}/${t.flag || 0} · restraint ${t.silent}/${t.silentT}${t.silentT - t.silent ? `  (${t.silentT - t.silent} FALSE ALARM${t.silentT - t.silent > 1 ? 'S' : ''})` : '  (0 false alarms)'}${t.err ? ` · errors ${t.err}` : ''}`);
}
process.exit(0);
