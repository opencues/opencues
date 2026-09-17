// Shared corpus for the step-6 contradiction benches (span granularity and
// note wording): the company-rules bench's six rulebooks, each violating
// draft embedded between two of its own domain's compliant / unrelated
// sentences so a pause has MORE THAN ONE sentence and the flagged span is a
// known unit by construction — the reference is deterministic, not a model
// quote. Rules and sentences are copied from company-rules-bench.mjs
// verbatim so the numbers stay comparable with steps 2–3.
export const DOMAINS = [
  {
    id: 'engineering',
    rules: [
      'No new third-party dependencies without platform-team approval.',
      'Secrets and API keys never go in code, config files, or logs.',
      'Customer data stays in EU regions (eu-west-1) — never replicate it elsewhere.',
      'Every change to main requires a reviewed PR — no direct pushes.',
      'Use the structured logger; console.log never ships to production.',
    ],
    violating: [
      ["let's just npm install lodash for this, it's one helper", 1],
      ["I'll hardcode the Stripe key in the config for the demo and rotate it later", 2],
      ['quickest fix is to mirror the customer table to us-east-1 for the analytics job', 3],
      ["it's a one-line fix, I'll push straight to main and skip the PR", 4],
      ['threw a few console.logs in the payment handler to trace it in prod', 5],
    ],
    neutral: [
      'I asked platform for approval on the redis client and they signed off, adding it now',
      'moved the key out of the repo and into the vault like the policy says',
      'the cache eviction tests all pass now, opening the PR for review',
      'the retry helper is covered by the new unit tests',
    ],
  },
  {
    id: 'comms-pr',
    rules: [
      'No forward-looking revenue or growth numbers in any external communication.',
      'Never name or hint at the unannounced product (codename Falcon) outside the core team.',
      'Do not disparage competitors by name.',
      'Everything about the partnership is under embargo until the 14th.',
    ],
    violating: [
      ["I'll tell the analyst we expect revenue to double next year", 1],
      ['adding a teaser line about Falcon to the newsletter draft', 2],
      ["the blog post should say our competitor's product is unreliable junk", 3],
      ["let's brief the journalist on the partnership today so the story lands early", 4],
    ],
    neutral: [
      'the earnings recap sticks to last quarter’s reported numbers only',
      'scheduled the partnership announcement for the 15th, after the embargo lifts',
      'drafting the conference booth copy for the products we already sell',
      'the newsletter goes out Tuesday as usual',
    ],
  },
  {
    id: 'support',
    rules: [
      'Never promise refunds beyond the published 30-day policy.',
      'No SLA or uptime commitments beyond what the customer’s contract states.',
      'Never blame a named engineer or team in customer communications.',
      'Never reveal one customer’s identity or usage to another customer.',
    ],
    violating: [
      ["tell them we'll refund the full year, it's been six months but they're angry", 1],
      ["I'll commit us to 99.99% uptime in the reply so they calm down", 2],
      ['drafting the apology: the outage was the database team’s fault, specifically Marco’s migration', 3],
      ['mention that AcmeCorp uses the same plan and loves it, that should reassure them', 4],
    ],
    neutral: [
      'they are on day 12, so a refund is within policy — processing it',
      'pointed them at the SLA section of their contract for the uptime numbers',
      'escalating the ticket with full repro steps to the on-call queue',
      'the customer replied within the hour and confirmed the fix',
    ],
  },
  {
    id: 'healthcare',
    rules: [
      'Staff never give medical advice — direct patients to their clinician.',
      'PHI (patient names, conditions, records) never goes in email or chat — portal only.',
      'Only HIPAA-approved vendors may process patient data.',
    ],
    violating: [
      ["I'll tell the patient they can safely double the dose while they wait", 1],
      ["emailing the front desk the patient's diagnosis so they can prep the room", 2],
      ["let's pipe the intake forms through that new transcription startup, it's much cheaper", 3],
    ],
    neutral: [
      'replied that dosage questions need to go to their clinician, and flagged the chart',
      'uploaded the records to the portal and sent the patient a login reminder',
      'rescheduling Thursday’s staff meeting to Friday morning',
      'the waiting room screens are being replaced next week',
    ],
  },
  {
    id: 'finance',
    rules: [
      'Never give investment advice or guarantee returns to clients.',
      'Material non-public information is never discussed outside the deal team.',
      'Fees are quoted only from the published schedule — no ad-hoc discounts in writing.',
    ],
    violating: [
      ["tell the client this fund is a sure thing, they'll easily make 20%", 1],
      ['mentioning the pending acquisition to the sales floor so they stop asking', 2],
      ["I'll email them 40% off the management fee to close the deal", 3],
    ],
    neutral: [
      'sent the client the published fee schedule and the standard risk disclosure',
      'the deal team sync moved to 3pm, same room',
      'the quarterly statements went out on schedule',
      'booked the client review for Thursday',
    ],
  },
  {
    id: 'shipped-defaults',
    rules: [
      'Secrets, API keys, and tokens never go in code, config files, or logs.',
      'Never paste a real credential into a chat, ticket, or AI prompt — rotate any that leaks.',
      'Never commit .env or credential files — use a secret manager.',
      'Never run destructive commands (rm -rf, DROP TABLE, force-delete) against production.',
      'Never edit production data by hand — go through a reviewed script or migration.',
      'Confirm a backup exists before any irreversible operation.',
      'Never disable, skip, or delete a failing test to make CI pass — fix it or quarantine it with a ticket.',
      'Never use production data in tests or local dev without anonymizing it.',
      'Never give an agent blanket permission to run destructive commands unattended.',
    ],
    violating: [
      ["I'll hardcode the Stripe key in the config for the demo and rotate it later", 1],
      ["here's the prod DB password, I'll paste it into the ticket so ops can see it", 2],
      ['just commit the .env so CI has the creds', 3],
      ['run DROP TABLE on the prod orders table to clear the corrupt rows', 4],
      ["I'll just UPDATE the user's row directly in prod to fix their email", 5],
      ["no need for a backup before the column-drop migration, it'll be fine", 6],
      ['mark the flaky auth test as skipped so the pipeline goes green', 7],
      ['pull a dump of the production users table into my local dev DB for testing', 8],
      ['give the agent --dangerously-skip-permissions and let it run overnight on the repo', 9],
    ],
    neutral: [
      'moved the key into the vault; the config reads it from the environment now',
      'rotated the leaked token and scrubbed it from the logs',
      'the migration went through review and ran after a fresh snapshot was taken',
      'quarantined the flaky test with a ticket and linked it in the PR',
      'generated synthetic fixtures so we never need prod data locally',
      'the agent runs sandboxed with approval required for every command',
      'bumped the README badge and fixed two typos',
      'standup moves to 10am tomorrow',
    ],
  },
];

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const end = (s) => (/[.!?]$/.test(s) ? s : s + '.');

/** Every flagged pause: { domain, rules, draft, sentence (the violating unit, verbatim as it appears), ruleIdx (1-based) } */
export function buildPauses() {
  const out = [];
  for (const d of DOMAINS) {
    d.violating.forEach(([v, ruleIdx], i) => {
      const before = d.neutral[i % d.neutral.length];
      const after = d.neutral[(i + 1) % d.neutral.length];
      const sentence = end(cap(v));
      const draft = `${end(cap(before))} ${sentence} ${end(cap(after))}`;
      out.push({ domain: d.id, rules: d.rules, draft, sentence, ruleIdx, position: 'middle' });
      // a second placement per domain's first case: the violation LAST (the cursor sentence, the common pause shape)
      if (i === 0) out.push({ domain: d.id, rules: d.rules, draft: `${end(cap(before))} ${end(cap(after))} ${sentence}`, sentence, ruleIdx, position: 'last' });
    });
  }
  return out;
}

/** The runtime's two granularities, as this bench cuts them. */
export function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map((s) => s.trim()).filter(Boolean);
}
export function splitClauses(text) {
  return splitSentences(text)
    .flatMap((s) => s.split(/(?:,\s+(?=(?:but|so|and|then|which)\b)|;\s+|\s+(?=(?:but|so that|so)\b\s))/).map((c) => c.trim()).filter(Boolean));
}
