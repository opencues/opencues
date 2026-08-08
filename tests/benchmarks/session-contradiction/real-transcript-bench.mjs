// real-transcript-bench — Stage A extraction against REAL, messy CC sessions.
//
// The synthetic bench (extraction-bench.mjs) hands decisions to the extractor in
// clean prose. This one runs the EXACT producer pipeline over real Claude Code
// session transcripts (decisions buried in code/tool talk, revised mid-session,
// often huge), to answer the four scope questions together:
//
//   • real messy accuracy — precision/recall on decisions the model must MINE,
//     not read off a plate (independent claude-sonnet judge; no gold list).
//   • cost at real scale   — the producer reads only the last 256KB TAIL and
//     renders ≤48k chars of PROSE, so input cost is BOUNDED no matter the
//     session size. The reduction table shows raw MB → tail → prose → tokens.
//   • data/privacy boundary — the same table shows how much is dropped before
//     egress (tool_use/tool_result/thinking never reach the LLM).
//   • functional boundary  — the judge's "missed" examples reveal what the tail
//     window + prose-only filter structurally cannot catch (early decisions
//     evicted from the 256KB tail; decisions that live only in a code diff).
//
// Fixed matcher unused here (this is a Stage-A quality bench). Extraction models:
// cerebras/gemma-4-31b, anthropic/claude-haiku-4-5, gemini/3.6→3.5-flash-lite.
// Judge: anthropic/claude-sonnet-4-6 (independent family).
//
// Run: CEREBRAS_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… \
//        node tests/benchmarks/session-contradiction/real-transcript-bench.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 90000 });

const JUDGE = { provider: core.getProvider('anthropic'), model: 'claude-sonnet-4-6', key: process.env.ANTHROPIC_API_KEY };
const TAIL_BYTES = 256 * 1024;   // mirror extract-commitments.cjs

// Real full-session transcripts, size-spread (skip subagent shards). Override
// with args (paths) to point at your own sessions.
const P = path.join(os.homedir(), '.claude/projects');
const DEFAULT_TRANSCRIPTS = [
  { label: 'opencues ~7.6MB',  file: path.join(P, '-home-wilfred-opencues/de3e410e-bf27-4e4f-a673-f8fec7ceef6f.jsonl') },
  { label: 'worktree ~9.4MB',  file: path.join(P, '-home-wilfred-opencues--claude-worktrees-bright-singing-rivest/76d5707b-cebe-43f6-8bf4-c4c3c2ce6bd4.jsonl') },
  { label: 'opencues ~19.6MB', file: path.join(P, '-home-wilfred-opencues/67e401fe-f1b1-4f0e-a04f-864d9162c577.jsonl') },
  { label: 'opencues ~37MB',   file: path.join(P, '-home-wilfred-opencues/0fa04f2a-7b67-4cf3-9628-2e7c1a59a9d7.jsonl') },
  { label: 'ClaudeLog ~50MB',  file: path.join(P, '-home-wilfred-ClaudeLog/ccd50e61-9b39-4fca-8923-5d34c0fd4f2c.jsonl') },
];
const argPaths = process.argv.slice(2).filter(a => !a.startsWith('-'));
const TRANSCRIPTS = argPaths.length ? argPaths.map(f => ({ label: path.basename(f), file: f })) : DEFAULT_TRANSCRIPTS;

const EXTRACTORS = [
  { name: 'gemma  (cerebras/gemma-4-31b)', model: 'gemma-4-31b', key: process.env.CEREBRAS_API_KEY, pid: 'cerebras' },
  { name: 'haiku  (anthropic/claude-haiku-4-5)', model: 'claude-haiku-4-5-20251001', key: process.env.ANTHROPIC_API_KEY, pid: 'anthropic' },
  { name: 'gemini (gemini/flash-lite)', model: null, key: process.env.GEMINI_API_KEY, pid: 'gemini' },
];
async function pickGemini() {
  for (const m of ['gemini-3.6-flash-lite', 'gemini-3.5-flash-lite']) {
    try {
      const w = core.buildProviderRequest('gemini', { messages: [{ role: 'user', content: 'ping' }], model: m, maxTokens: 4 }, { apiKey: process.env.GEMINI_API_KEY });
      const r = await fetch(w.url, { method: 'POST', headers: w.headers, body: typeof w.body === 'string' ? w.body : JSON.stringify(w.body) });
      if (r.ok) return m;
    } catch { /* next */ }
  }
  return 'gemini-3.5-flash-lite';
}
EXTRACTORS.find(e => e.pid === 'gemini').model = await pickGemini();

// Exact producer tail read: last 256KB, drop the partial first line.
function readTail(file) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
  return { text, rawBytes: st.size };
}
function usageOf(pid, rawJson) {
  try {
    const j = JSON.parse(rawJson);
    if (pid === 'anthropic') return { in: j.usage?.input_tokens ?? 0, out: j.usage?.output_tokens ?? 0 };
    if (pid === 'gemini') return { in: j.usageMetadata?.promptTokenCount ?? 0, out: j.usageMetadata?.candidatesTokenCount ?? 0 };
    return { in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0 };
  } catch { return { in: 0, out: 0 }; }
}
async function extract(ex, rendered) {
  const wire = core.buildProviderRequest(ex.pid, {
    messages: [
      { role: 'system', content: core.SESSION_COMMITMENTS_EXTRACT_SYSTEM },
      { role: 'user', content: `TRANSCRIPT:\n${rendered}` },
    ], model: ex.model, maxTokens: 1024,
  }, { apiKey: ex.key });
  const t0 = performance.now();
  const resp = await fetch(wire.url, { method: 'POST', headers: wire.headers, body: typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body) });
  const bodyText = await resp.text();
  const ms = performance.now() - t0;
  if (!resp.ok) return { snapshot: null, ms, err: `http ${resp.status}: ${bodyText.slice(0, 140)}` };
  const ext = core.parseExtractionResult(core.parseProviderResponse(ex.pid, bodyText));
  const snapshot = core.buildSessionCommitmentsSnapshot(ext.commitments, { summary: ext.summary });
  const u = usageOf(ex.pid, bodyText);
  return { snapshot, ms, tokIn: u.in, tokOut: u.out };
}
async function chat(who, sys, user, maxTokens) {
  return core.dispatchChat(who.provider, http, { model: who.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens }, { apiKey: who.key });
}
function parseObj(raw) { const m = String(raw).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }

// Judge precision + recall on real prose (no gold — judge mines its own reference).
const JUDGE_SYS = `You audit a session-commitments watchlist a fast model extracted from a real coding-session transcript (only user+assistant PROSE; tool output was already stripped). The watchlist should contain DURABLE decisions/constraints the developer made (stack, architecture, constraints, scope, plan, key decisions) — NOT ephemeral chatter, questions, or restated task text.

Given the TRANSCRIPT prose and the extracted WATCHLIST, return ONLY JSON:
{
 "precisionSupported": <int>,   // watchlist items genuinely supported by a real decision in the transcript
 "precisionTotal": <int>,       // total watchlist items
 "keyDecisions": <int>,         // count of durable decisions YOU find in the transcript worth watching
 "recallCaptured": <int>,       // how many of those the watchlist captured (in meaning)
 "missedExamples": ["<up to 3 durable decisions the watchlist MISSED, short>"],
 "falseExamples": ["<up to 3 watchlist items that are vague/unsupported/ephemeral, short>"]
}`;
async function judgeQuality(renderedProse, snapshot) {
  const wl = (snapshot?.commitments || []).map(c => `- [${c.category}] ${c.statement}`).join('\n') || '(empty)';
  const prose = renderedProse.length > 46000 ? renderedProse.slice(-46000) : renderedProse;
  const raw = await chat(JUDGE, JUDGE_SYS, `TRANSCRIPT:\n${prose}\n\nWATCHLIST:\n${wl}`, 500);
  return parseObj(raw) || {};
}

// ── run ──
console.log(`\nreal-transcript-bench — Stage A on ${TRANSCRIPTS.length} real sessions`);
console.log(`gemini→${EXTRACTORS.find(e => e.pid === 'gemini').model}, judge anthropic/${JUDGE.model}, tail ${TAIL_BYTES / 1024}KB, render ≤48k chars`);
console.log('='.repeat(100));

const KB = n => (n / 1024).toFixed(0);
const pad = (s, n) => String(s).padEnd(n); const padL = (s, n) => String(s).padStart(n);

const reduction = [];
for (const T of TRANSCRIPTS) {
  if (!fs.existsSync(T.file)) { console.log(`\n! MISSING ${T.label} (${T.file})`); continue; }
  const { text, rawBytes } = readTail(T.file);
  const turns = core.extractTranscriptTurns(text);
  const rendered = core.renderTranscriptForExtraction(turns);
  const proseChars = turns.reduce((n, t) => n + t.text.length, 0);
  console.log(`\n■ ${T.label}`);
  console.log(`   data reduction:  raw ${KB(rawBytes)}KB  →  tail ${KB(text.length)}KB  →  ${turns.length} prose turns (${KB(proseChars)}KB)  →  rendered ${KB(rendered.length)}KB (${(rendered.length / 4 / 1000).toFixed(1)}k tok approx)`);
  reduction.push({ label: T.label, rawBytes, tailKB: +KB(text.length), turns: turns.length, proseKB: +KB(proseChars), renderKB: +KB(rendered.length) });
  if (!rendered.trim()) { console.log('   (no prose in tail — skipped)'); continue; }

  for (const ex of EXTRACTORS) {
    const runs = [await extract(ex, rendered), await extract(ex, rendered)];
    const ok = runs.filter(r => r.snapshot);
    if (!ok.length) { console.log(`   ${pad(ex.name, 34)} ERR ${runs[0].err}`); continue; }
    ok.sort((a, b) => a.ms - b.ms);
    const m = ok[Math.floor(ok.length / 2)];
    const q = await judgeQuality(rendered, m.snapshot);
    const prec = q.precisionTotal ? `${q.precisionSupported}/${q.precisionTotal}` : 'n/a';
    const rec = q.keyDecisions ? `${q.recallCaptured}/${q.keyDecisions}` : 'n/a';
    console.log(`   ${pad(ex.name, 34)} ${padL(m.ms.toFixed(0) + 'ms', 8)}  in ${padL((m.tokIn / 1000).toFixed(1) + 'k', 6)} out ${padL(m.tokOut, 4)}  #${padL(m.snapshot.commitments.length, 2)}  precision ${padL(prec, 6)}  recall ${padL(rec, 6)}`);
    if (q.missedExamples?.length) console.log(`       ${pad('', 32)} missed:  ${q.missedExamples.slice(0, 2).map(s => `"${s}"`).join('; ')}`);
    if (q.falseExamples?.length) console.log(`       ${pad('', 32)} weak:    ${q.falseExamples.slice(0, 2).map(s => `"${s}"`).join('; ')}`);
  }
}

console.log(`\n${'='.repeat(100)}`);
console.log('COST-AT-SCALE — input is bounded by the 256KB tail + 48k render, NOT the session size:');
console.log(`${pad('session', 20)} ${padL('raw', 9)} ${padL('tail', 7)} ${padL('prose', 8)} ${padL('rendered→LLM', 14)}`);
console.log('-'.repeat(100));
for (const r of reduction) {
  console.log(`${pad(r.label, 20)} ${padL(KB(r.rawBytes) + 'KB', 9)} ${padL(r.tailKB + 'KB', 7)} ${padL(r.proseKB + 'KB', 8)} ${padL(r.renderKB + 'KB', 14)}`);
}
console.log('\nNote: on the largest sessions the 256KB tail holds only the most RECENT turns —');
console.log('decisions made early in a long session fall outside it (a recall boundary, by design).');
console.log('');
