// Does ask-cues belong at the DOCUMENT level rather than the sentence level?
//
// Today the trigger unit is "the sentence your cursor is in", and the source
// says why: `The "selection" for the prototype = the sentence containing the
// cursor … (Wiring a real selection is a host concern.)` The sentence is a
// stand-in for a selection nobody wired, and it is also forced — each option's
// `apply` replaces a span, so the unit of the QUESTION equals the unit of the
// EDIT.
//
// This bench answers whether changing that is worth the work, BEFORE the work.
// Two arms over identical drafts:
//
//   SENTENCE  the real ToolPromptCueSource, once per sentence (what ships)
//   DOCUMENT  one prototype call over the whole draft, at most one question,
//             quoting the sentence it would edit
//
// The metrics that decide it: how many questions each arm puts in front of the
// user, how many are worth reading, and how many LLM calls it costs. A tie on
// usefulness is still a win for DOCUMENT if it asks a third as often.
//
// Run: CEREBRAS_API_KEY=… ANTHROPIC_API_KEY=… node tests/benchmarks/ask-cues/document-bench.mjs

import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 });

const GEN = { provider: core.getProvider('cerebras'), model: 'gpt-oss-120b', key: process.env.CEREBRAS_API_KEY, name: 'cerebras/gpt-oss-120b' };
const JUDGE = { provider: core.getProvider('anthropic'), model: 'claude-sonnet-4-6', key: process.env.ANTHROPIC_API_KEY };

// Real-shaped drafts. `fork` names the ONE decision genuinely open in the
// draft, or null when the draft is clean and both arms should stay silent.
// `crossSentence: true` marks the forks that live BETWEEN sentences — the class
// a per-sentence trigger cannot see in principle, whatever its prompt says.
const DOCS = [
  {
    id: 'store-choice',
    crossSentence: true,
    fork: 'Postgres vs SQLite for the store',
    text: "I've started on the persistence layer for the sync service. We'll use Postgres for the store. Though SQLite might honestly be enough at this size, and it would drop a container from the compose file. I'll wire the migrations next and get the first table in.",
  },
  {
    id: 'launch-scope',
    crossSentence: true,
    fork: 'ship the whole redesign Friday vs split it',
    text: "The dashboard redesign is basically done. We're shipping the whole thing Friday. Although the settings pages have not had a design review yet and nobody has tested the mobile layout. Marketing is expecting the announcement to go out the same morning.",
  },
  {
    id: 'answered-draft',
    fork: null,
    text: "The new sync API is way faster than the old one. p50 dropped from 240ms to 38ms across the load test, measured over 10k requests. I'll deal with the retry logic later; until then every failure crashes loudly and pages on-call, which is what we want while it is behind the flag. Launch is the 14th, straight after the audit signs off.",
  },
  {
    id: 'clean-draft',
    fork: null,
    text: "The cache module exports a single get/set pair. Entries expire after 60 seconds. It uses an LRU eviction policy with a 512-entry ceiling. Tests cover the eviction path and the expiry boundary. I ran the suite and all 47 tests passed.",
  },
  {
    id: 'hardcoded-key',
    fork: 'what happens to the hardcoded key before launch',
    text: "Auth is the last piece before the beta. Just hardcode the API key for now so the demo works. Then we can get it in front of the design partners next week and see whether the flow lands at all.",
  },
  {
    id: 'vague-perf',
    fork: 'which path to optimise / what target',
    text: "The importer is too slow on big files. We should make it a lot faster before the next release. I have not profiled it yet but the parsing loop looks suspicious. Ideally this lands in the same release as the new schema.",
  },
];

const DOC_LEVEL_SYSTEM = `${core.ASK_USER_QUESTION_SYSTEM}

--- THIS CALL IS DIFFERENT: YOU SEE THE WHOLE DRAFT ---
You are given an entire draft, not one sentence. Everything above still applies, with three changes:

1. Ask AT MOST ONE question for the whole draft — the single most load-bearing open decision in it. Most drafts deserve none. A draft where every loose claim is supported later, or that is simply reporting settled work, gets {"question":"","options":[]}.
2. The fork may live BETWEEN sentences: a choice stated in one sentence and reopened in the next ("We'll use Postgres." … "Though SQLite might be enough.") is exactly what you are here for. That is the shape a per-sentence reader cannot see.
3. Add one extra field, "anchor": the EXACT sentence from the draft your options would edit, copied verbatim. It must appear in the draft character for character.

Output ONLY: {"header":"…","question":"…","anchor":"<verbatim sentence>","options":[{"label":"…","description":"…","apply":"…"}]}
Or exactly {"question":"","options":[]} to stay silent.`;

const JUDGE_SYS = `You are a strict editor grading an assistant that may attach ONE question to a developer's draft.

You get the DRAFT, the decision the draft genuinely leaves open (or "NONE"), and the assistant's OUTPUT.

Return ONLY JSON: {"quality": <0|1|2|null>, "onFork": <true|false|null>, "reason": "<up to 14 words>"}
- quality: 0 = restates the draft / rhetorical / options not distinct or already answered in the draft; 1 = ok; 2 = genuinely useful, the kind of question that changes what the developer does next. ABSTAINED -> null.
- onFork: did the question address the open decision named above? If the draft's decision is NONE, then any question at all is onFork:false. ABSTAINED -> null.`;

async function chat(who, sys, user, maxTokens) {
  return core.dispatchChat(who.provider, http,
    { model: who.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens },
    { apiKey: who.key });
}
const parseObj = (raw) => { const m = String(raw).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };

async function judge(doc, q) {
  const out = q ? `Q: ${q.question}\nOPTIONS: ${q.options.map((o) => o.label).join(' | ')}` : 'ABSTAINED';
  try {
    const raw = await chat(JUDGE, JUDGE_SYS, `DRAFT:\n${doc.text}\n\nOPEN DECISION: ${doc.fork ?? 'NONE'}\n\nOUTPUT:\n${out}`, 200);
    return parseObj(raw) ?? {};
  } catch { return {}; }
}

// ── arm 1: the real source, once per sentence ──────────────────────────────
async function sentenceArm(doc) {
  const words = doc.text.split(/\s+/).filter(Boolean);
  const bounds = core.segmentSentences ? core.segmentSentences(doc.text, words) : null;
  // segmentSentences is not exported; fall back to a regex over terminators.
  const spans = bounds ?? [...doc.text.matchAll(/[^.!?]+[.!?]+\s*/g)].map((m) => ({ start: m.index, end: m.index + m[0].trimEnd().length }));
  const asked = [];
  let calls = 0;
  for (const sp of spans) {
    const src = new core.ToolPromptCueSource({ httpAdapter: http, provider: GEN.provider, model: GEN.model, apiKey: GEN.key });
    calls++;
    try {
      const res = await src.getCues({ text: doc.text, words, cursor: Math.floor((sp.start + sp.end) / 2) });
      const q = res.results[0]?.metadata?.toolQuestion;
      if (q?.question) asked.push(q);
    } catch { /* transient — counts as no question, still cost a call */ }
  }
  return { asked, calls };
}

// ── arm 2: one call over the whole draft ───────────────────────────────────
async function documentArm(doc) {
  try {
    const raw = await chat(GEN, DOC_LEVEL_SYSTEM, `DRAFT:\n${doc.text}`, 600);
    const o = parseObj(raw);
    if (!o || !o.question || !Array.isArray(o.options) || o.options.length === 0) return { asked: [], calls: 1, anchor: null };
    const anchorOk = typeof o.anchor === 'string' && doc.text.includes(o.anchor.trim());
    return { asked: [o], calls: 1, anchor: o.anchor ?? null, anchorOk };
  } catch { return { asked: [], calls: 1, anchor: null }; }
}

const L = (...a) => process.stderr.write(a.join(' ') + '\n');
L(`document-vs-sentence bench — generator ${GEN.name}\n`);

const totals = { sentence: { q: 0, useful: 0, onFork: 0, calls: 0, noiseOnClean: 0 }, document: { q: 0, useful: 0, onFork: 0, calls: 0, noiseOnClean: 0, anchorOk: 0, anchored: 0 } };

for (const doc of DOCS) {
  const [sArm, dArm] = await Promise.all([sentenceArm(doc), documentArm(doc)]);
  const sJudged = await Promise.all(sArm.asked.map((q) => judge(doc, q)));
  const dJudged = await Promise.all(dArm.asked.map((q) => judge(doc, q)));

  const tally = (arm, armAsked, judged, key) => {
    totals[key].q += armAsked.length;
    totals[key].calls += arm.calls;
    totals[key].useful += judged.filter((j) => j.quality === 2).length;
    totals[key].onFork += judged.filter((j) => j.onFork).length;
    if (!doc.fork) totals[key].noiseOnClean += armAsked.length;
  };
  tally(sArm, sArm.asked, sJudged, 'sentence');
  tally(dArm, dArm.asked, dJudged, 'document');
  if (dArm.asked.length) { totals.document.anchored++; if (dArm.anchorOk) totals.document.anchorOk++; }

  L(`── ${doc.id}${doc.crossSentence ? '  [fork spans sentences]' : ''}  — open decision: ${doc.fork ?? 'NONE (should be silent)'}`);
  L(`   SENTENCE: ${sArm.asked.length} question(s) from ${sArm.calls} call(s)` +
    (sArm.asked.length ? `  · quality ${sJudged.map((j) => j.quality ?? '-').join(',')} · onFork ${sJudged.filter((j) => j.onFork).length}` : ''));
  for (const q of sArm.asked) L(`             · ${q.question.slice(0, 74)}`);
  L(`   DOCUMENT: ${dArm.asked.length} question(s) from ${dArm.calls} call(s)` +
    (dArm.asked.length ? `  · quality ${dJudged.map((j) => j.quality ?? '-').join(',')} · onFork ${dJudged.filter((j) => j.onFork).length} · anchor ${dArm.anchorOk ? 'ok' : 'BAD'}` : ''));
  for (const q of dArm.asked) L(`             · ${q.question.slice(0, 74)}`);
  L('');
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
L('='.repeat(78));
for (const [k, t] of Object.entries(totals)) {
  L(`${k.toUpperCase().padEnd(9)} questions ${String(t.q).padStart(2)} · useful ${t.useful}/${t.q} (${pct(t.useful, t.q)}) · on-fork ${t.onFork}/${t.q} (${pct(t.onFork, t.q)}) · LLM calls ${t.calls} · asked on a clean draft ${t.noiseOnClean}`);
}
L(`\nanchor verbatim-in-draft: ${totals.document.anchorOk}/${totals.document.anchored}   (a bad anchor = nothing to attach the edit to)`);
process.exit(0);
