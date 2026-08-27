// RoiInsightClient — the LLM half, isolated from every DOM concern.
// Owns the endpoint, the model, the system prompt, the serialised request
// queue (one call in flight at a time — a scroll through a long page must
// not burst-fire the API), the timeout, and the token/cost ledger.
// Direct fetch from the content script: cerebras allows browser CORS
// (verified: ACAO * on POST and preflight), so there is no background
// worker and none of its message-channel failure modes.
//
// API surface (window.RoiInsightClient):
//   complete(passage) -> Promise<string>   queued; rejects with a readable Error
//   usage() -> { tokIn, tokOut, cost }     exact counts from the API's usage field
//
// Key resolution: baked key.js (gitignored) wins; a key pasted in the panel
// (chrome.storage.local 'cerebras_key') is the fallback.
(() => {
  'use strict';
  if (window.RoiInsightClient) return;

  const ENDPOINT = 'https://api.cerebras.ai/v1/chat/completions';
  const MODEL = 'gemma-4-31b';
  const TIMEOUT_MS = 20000;
  const SYSTEM =
    'You spot insights. Given a passage, reply with ONE short, non-obvious ' +
    'insight, implication, or connection a careful reader might miss. ' +
    'Under 18 words. Plain text only: no quotes, no preamble, no markdown.';

  // per-million-token rates for the cost display — EDIT to match the live
  // cerebras price sheet for the model in use (cloud.cerebras.ai)
  const PRICE_IN_PER_M = 0.35;
  const PRICE_OUT_PER_M = 0.75;
  let tokIn = 0;
  let tokOut = 0;

  async function call(passage, opts = {}) {
    let stored = {};
    try { stored = await chrome.storage.local.get('cerebras_key'); } catch { /* orphaned */ }
    const key = window.CEREBRAS_KEY || stored.cerebras_key;
    if (!key) throw new Error('no key — paste one in the panel');
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: opts.model || MODEL,           // per-concern model: override
        temperature: 0.4,
        max_tokens: 60,
        messages: [
          { role: 'system', content: opts.system || SYSTEM },
          { role: 'user', content: passage },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 160));
    const j = await res.json();
    const out = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!out) throw new Error('empty completion');
    const u = j.usage || {};
    const inTok = u.prompt_tokens || 0;
    const outTok = u.completion_tokens || 0;
    tokIn += inTok;
    tokOut += outTok;
    recordUsage(inTok, outTok);   // fire-and-forget: the persistent ledger
    return out.trim();
  }

  // ---- persistent cost ledger ----
  // Accumulated across pages, tabs and restarts in
  // chrome.storage.local['glimmer_usage']: all-time totals plus per-day
  // (last 30) and per-site (top 50) breakdowns. The popup's "cost" section
  // renders it. Prices ride along in the record so the popup computes cost
  // with the client's own rates — one source of truth.
  // (chrome.storage has no atomic increment; calls are serialised per tab
  // and rare, so read-modify-write races are acceptable for a dev tool.)
  async function recordUsage(inTok, outTok) {
    try {
      const key = 'glimmer_usage';
      const got = await chrome.storage.local.get(key);
      const L = got[key] || { since: Date.now(), calls: 0, tokIn: 0, tokOut: 0, days: {}, sites: {} };
      L.calls++;
      L.tokIn += inTok;
      L.tokOut += outTok;
      L.priceInPerM = PRICE_IN_PER_M;
      L.priceOutPerM = PRICE_OUT_PER_M;
      const day = new Date().toISOString().slice(0, 10);
      const d = L.days[day] || { calls: 0, tokIn: 0, tokOut: 0 };
      d.calls++; d.tokIn += inTok; d.tokOut += outTok;
      L.days[day] = d;
      const site = (location.hostname || '(unknown)');
      const s = L.sites[site] || { calls: 0, tokIn: 0, tokOut: 0 };
      s.calls++; s.tokIn += inTok; s.tokOut += outTok;
      L.sites[site] = s;
      // bounded growth: 30 days, 50 heaviest sites
      const dayKeys = Object.keys(L.days).sort();
      while (dayKeys.length > 30) delete L.days[dayKeys.shift()];
      const siteEntries = Object.entries(L.sites);
      if (siteEntries.length > 50) {
        siteEntries.sort((a, b) => (b[1].tokIn + b[1].tokOut) - (a[1].tokIn + a[1].tokOut));
        L.sites = Object.fromEntries(siteEntries.slice(0, 50));
      }
      await chrome.storage.local.set({ [key]: L });
    } catch { /* orphaned context — session totals still work */ }
  }

  // strict serialisation: each call starts only after the previous finished.
  // The caller's promise carries the rejection; the chain itself swallows it
  // so one failure can never wedge everything queued behind it.
  let chain = Promise.resolve();
  function complete(passage, opts) {
    const p = chain.then(() => {
      const t0 = performance.now();
      return call(passage, opts).finally(() => {
        if (window.RoiPerf) window.RoiPerf.rec('llm-roundtrip', performance.now() - t0);
      });
    });
    chain = p.catch(() => {});
    return p;
  }

  function usage() {
    return {
      tokIn,
      tokOut,
      cost: (tokIn * PRICE_IN_PER_M + tokOut * PRICE_OUT_PER_M) / 1e6,
    };
  }

  window.RoiInsightClient = { complete, usage, MODEL };
})();
