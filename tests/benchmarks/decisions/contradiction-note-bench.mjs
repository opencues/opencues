// Step 6 bench A — what the contradiction NOTE says.
//
// Today the note is a chat-written tip (≤ 80 chars, the matcher's own words).
// Step 6 removes the chat call from detection, so the note has to come from
// data the runtime already holds: the rule statement, and the flagged unit.
// Three candidates per flagged pause (contradiction-corpus.mjs):
//   CHAT    today's tip, from the shipped matcher replayed byte for byte
//   RULE    the rule statement, verbatim
//   QUOTED  the rule statement + the writer's own words: `<rule> · you wrote: "<unit…>"`
// Scored two ways: (a) blind pairwise judgement — two judges (cerebras
// gpt-oss-120b and qwen-3.8-27b), both orders, "which note better tells the
// writer what they contradicted and what to do, on its own"; (b) the
// statusline's hard numbers — characters, and whether `⚠ ` + note fits 80
// columns. The judge is a reader, not an oracle; the table is the input to
// the ruling, not the ruling.
//
// Run: CEREBRAS_API_KEY=… node tests/benchmarks/decisions/contradiction-note-bench.mjs
import path from 'node:path';
import url from 'node:url';
import { buildPauses } from './contradiction-corpus.mjs';

const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const scMod = await import(path.join(R, 'packages/opencues-core/dist/contradiction/session-contradiction-source.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });
const CEREBRAS = process.env.CEREBRAS_API_KEY;
if (!CEREBRAS) { console.error('CEREBRAS_API_KEY is required'); process.exit(2); }
const provider = core.getProvider('cerebras');
const pauses = buildPauses();
const RAIL = 80, PREFIX = '⚠ ';

const chat = (model, system, user, maxTokens = 400) => core.dispatchChat(provider, http, { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens, temperature: 0, seed: 42 }, { apiKey: CEREBRAS, maxThinking: false });   // qwen thinks by default; the judge answers one letter

// ── candidates ─────────────────────────────────────────────────────────────
async function todaysTip(p) {
  const snap = core.buildSessionCommitmentsSnapshot(p.rules.map((statement) => ({ category: 'constraint', statement })), { sessionId: `note-${p.domain}` });
  const watchlist = core.renderSessionCommitmentsCatalog(snap, 'on');
  try {
    const raw = await chat('gpt-oss-120b', `${scMod.SESSION_CONTRADICTION_MATCH_SYSTEM}${watchlist}`, `DRAFT: ${p.draft}`);
    const flags = scMod.parseFlags(raw).filter((f) => typeof f.quote === 'string' && p.draft.includes(f.quote.trim())).filter((f) => snap.commitments.some((c) => c.id === f.commitmentId));
    return flags[0]?.tip?.trim() || null;
  } catch { return null; }
}
const ruleNote = (p) => p.rules[p.ruleIdx - 1];
const quotedNote = (p) => { const u = p.sentence.replace(/[.!?]$/, ''); return `${p.rules[p.ruleIdx - 1]} · you wrote: "${u.length > 40 ? u.slice(0, 39) + '…' : u}"`; };

// ── the judge ──────────────────────────────────────────────────────────────
const JUDGE_SYSTEM = `You are judging one-line notes a writing assistant paints next to a sentence in someone's draft. The note tells the writer that the sentence contradicts a rule they or their organisation set. The writer sees ONLY the note and their own draft — no chat history, no rule list.

Pick the note that better tells the writer WHAT they contradicted and leaves them knowing what to do, in as few words as needed. Prefer the note a busy writer understands at a glance; penalise vagueness, and penalise length that adds nothing. Answer with exactly one letter: A or B.`;
async function judge(model, draft, sentence, a, b) {
  const user = `DRAFT: ${draft}\nFLAGGED SENTENCE: ${sentence}\n\nNOTE A: ${a}\nNOTE B: ${b}\n\nWhich note is better? Answer A or B.`;
  try {
    const raw = (await chat(model, JUDGE_SYSTEM, user, 32)).trim().toUpperCase();
    return raw.startsWith('A') ? 'A' : raw.startsWith('B') ? 'B' : null;
  } catch { return null; }
}

// ── run ────────────────────────────────────────────────────────────────────
const JUDGES = ['gpt-oss-120b', 'qwen-3.8-27b'];
const NAMES = ['CHAT', 'RULE', 'QUOTED'];
const rows = [];
for (const p of pauses) {
  const notes = { CHAT: await todaysTip(p), RULE: ruleNote(p), QUOTED: quotedNote(p) };
  rows.push({ p, notes });
}
// (b) the hard numbers
console.log(`step 6 note bench · ${pauses.length} flagged pauses · chat tip available on ${rows.filter((r) => r.notes.CHAT).length}`);
for (const n of NAMES) {
  const xs = rows.map((r) => r.notes[n]).filter(Boolean);
  const lens = xs.map((s) => s.length);
  const fits = xs.filter((s) => (PREFIX + s).length <= RAIL).length;
  console.log(`  ${n.padEnd(7)} chars mean ${Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)} · max ${Math.max(...lens)} · fits ${RAIL} cols ${fits}/${xs.length}`);
}
// (a) blind pairwise, both orders, two judges
const wins = {}; for (const j of JUDGES) { wins[j] = {}; for (const n of NAMES) wins[j][n] = { w: 0, n: 0 }; }
const pairs = [['CHAT', 'RULE'], ['CHAT', 'QUOTED'], ['RULE', 'QUOTED']];
for (const r of rows) {
  for (const [x, y] of pairs) {
    if (!r.notes[x] || !r.notes[y]) continue;
    for (const j of JUDGES) {
      const v1 = await judge(j, r.p.draft, r.p.sentence, r.notes[x], r.notes[y]);   // x = A
      const v2 = await judge(j, r.p.draft, r.p.sentence, r.notes[y], r.notes[x]);   // y = A
      for (const [v, first, second] of [[v1, x, y], [v2, y, x]]) {
        if (!v) continue;
        const winner = v === 'A' ? first : second, loser = v === 'A' ? second : first;
        wins[j][winner].w++; wins[j][winner].n++; wins[j][loser].n++;
      }
    }
  }
}
for (const j of JUDGES) {
  console.log(`\n  judge ${j}: pairwise win rate (both orders)`);
  for (const n of NAMES) console.log(`    ${n.padEnd(7)} ${wins[j][n].w}/${wins[j][n].n} (${Math.round(100 * wins[j][n].w / Math.max(1, wins[j][n].n))}%)`);
}
console.log('\n  samples (first four pauses):');
for (const r of rows.slice(0, 4)) { console.log(`    «${r.p.sentence.slice(0, 60)}»`); for (const n of NAMES) console.log(`      ${n.padEnd(7)} ${r.notes[n] ?? '(silent)'}`); }
