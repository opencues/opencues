// Glimmer popup — the ROI debug screen, as the extension's action popup.
// Settings persist to chrome.storage.local['glimmer_settings']; content
// scripts apply changes live via storage.onChanged (no reload needed).
// Live stats + perf come from the active tab over tabs.sendMessage.
(() => {
  'use strict';

  const KEY = 'glimmer_settings';
  // must mirror content.js S defaults — a popup-saved object is merged OVER
  // these, so an older saved shape never loses new settings
  const DEFAULTS = {
    debugUi: false,
    bandPct: 24,
    bufferPct: 30,
    mode: 'all',
    showCandidates: true,
    minChars: 120,
    lookahead: 0,
    scrollbarMode: true,
    mapMarks: true,
    textMarks: true,
    fadeMs: 600,
    candAlpha: 0.1,
    blurPx: 0,
    fullTicks: false,
    insightMode: true,
    glimmerMs: 300,
    settleOnly: true,
    perfMode: false,
  };

  let S = { ...DEFAULTS };

  document.getElementById('version').textContent =
    'v' + chrome.runtime.getManifest().version;

  // ---- controls <-> settings ----
  // data-s="candAlphaPct" is the one indirection: the range is 0..50 (%),
  // the stored value is 0..0.5
  const controls = [...document.querySelectorAll('[data-s]')];

  function toControl(name) {
    if (name === 'candAlphaPct') return Math.round(S.candAlpha * 100);
    return S[name];
  }
  function fromControl(name, el) {
    if (name === 'candAlphaPct') { S.candAlpha = (+el.value) / 100; return; }
    if (el.type === 'checkbox') S[name] = el.checked;
    else if (el.type === 'range') S[name] = +el.value;
    else if (name === 'fadeMs') S[name] = +el.value;
    else S[name] = el.value;
  }
  function lookaheadLabel(v) {
    return v === 0 ? 'full page' : `${v} page${v > 1 ? 's' : ''}`;
  }
  function render() {
    for (const el of controls) {
      const name = el.dataset.s;
      const v = toControl(name);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    }
    for (const span of document.querySelectorAll('.val')) {
      const name = span.dataset.v;
      span.textContent = name === 'lookahead' ? lookaheadLabel(S.lookahead) : String(toControl(name));
    }
  }
  function save() {
    chrome.storage.local.set({ [KEY]: S });
  }

  for (const el of controls) {
    el.addEventListener('input', () => {
      fromControl(el.dataset.s, el);
      render();
      save();
    });
  }

  chrome.storage.local.get(KEY).then(r => {
    if (r && r[KEY]) S = { ...DEFAULTS, ...r[KEY] };
    render();
  });

  // ---- cerebras key (separate storage slot; content client reads it) ----
  const keyInput = document.getElementById('cerebrasKey');
  chrome.storage.local.get('cerebras_key').then(({ cerebras_key }) => {
    if (cerebras_key) keyInput.placeholder = 'key set ✓ (paste to replace)';
  });
  keyInput.addEventListener('change', () => {
    const v = keyInput.value.trim();
    if (!v) return;
    chrome.storage.local.set({ cerebras_key: v }).then(() => {
      keyInput.value = '';
      keyInput.placeholder = 'key set ✓ (paste to replace)';
    });
  });

  // ---- talking to the active tab ----
  async function send(msg) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id === undefined) return null;
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      return null;   // no content script on this page (chrome://, store, …)
    }
  }

  const statsEl = document.getElementById('stats');
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  async function pollStats() {
    const s = await send({ type: 'glimmer-stats' });
    if (!s) {
      statsEl.textContent = '— no glimmer on this page —';
      return;
    }
    let html = `concern <span class="em">${s.concern ?? '—'}</span>` +
      ` · tier <span class="em">${s.tier}</span>` +
      ` · candidates <span class="em">${s.candidates}</span>` +
      ` · in band <span class="em">${s.inBand}</span>` +
      `<br>insights <span class="em">${s.ready}/${s.asked}</span>`;
    if (s.tokIn + s.tokOut > 0) {
      html += ` · tok <span class="em">${fmt(s.tokIn)}</span> in / <span class="em">${fmt(s.tokOut)}</span> out` +
        ` · ~$<span class="em">${s.cost.toFixed(4)}</span>`;
    }
    if (s.err) html += `<br><span class="warn">⚠ ${escapeHtml(s.err)}</span>`;
    if (s.perf) html += `<br>${escapeHtml(s.perf)}`;
    statsEl.innerHTML = html;
  }
  function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }
  pollStats();
  setInterval(pollStats, 1000);

  // ---- reading concerns (CUE.md-shaped — see concerns.js) ----
  const cText = document.getElementById('concerns');
  const cStatus = document.getElementById('concerns-status');
  chrome.storage.local.get('glimmer_concerns').then(r => {
    if (r.glimmer_concerns && r.glimmer_concerns.length) {
      cText.value = r.glimmer_concerns.join('\n===\n');
    }
  });
  document.getElementById('concerns-save').addEventListener('click', () => {
    const docs = RoiConcerns.splitDocs(cText.value);
    let ok = 0;
    const msgs = [];
    for (const d of docs) {
      const r = RoiConcerns.parse(d);
      if (r.error) msgs.push(r.error);
      else if (r.skip && r.tooNew) msgs.push(`"${r.name}": ${r.tooNew} — dropped`);
      else if (r.skip && !r.disabled) msgs.push(`"${r.name}": scope "${r.scope}" unsupported — dropped`);
      else ok++;
    }
    chrome.storage.local.set({ glimmer_concerns: docs }).then(() => {
      cStatus.textContent = msgs.length
        ? `${ok} ok · ⚠ ${msgs[0]}`
        : docs.length ? `${ok} concern${ok === 1 ? '' : 's'} saved` : 'cleared — built-ins active';
    });
  });

  // ---- cost ledger (persistent, cross-page — see insight-client.js) ----
  const costSummary = document.getElementById('cost-summary');
  const costDays = document.getElementById('cost-days');
  const costSites = document.getElementById('cost-sites');
  function renderLedger(L) {
    if (!L || !L.calls) {
      costSummary.textContent = '— no usage recorded yet —';
      costDays.textContent = '';
      costSites.textContent = '';
      return;
    }
    const pin = L.priceInPerM ?? 0.35;
    const pout = L.priceOutPerM ?? 0.75;
    const cost = e => (e.tokIn * pin + e.tokOut * pout) / 1e6;
    const since = new Date(L.since).toISOString().slice(0, 10);
    costSummary.innerHTML =
      `all-time since <span class="em">${since}</span>: ` +
      `<span class="em">${L.calls}</span> calls · ` +
      `tok <span class="em">${fmt(L.tokIn)}</span> in / <span class="em">${fmt(L.tokOut)}</span> out · ` +
      `~$<span class="em">${cost(L).toFixed(4)}</span>`;
    const dayRows = Object.entries(L.days).sort((a, b) => b[0] < a[0] ? -1 : 1).slice(0, 7);
    costDays.textContent = dayRows
      .map(([d, e]) => `${d}  ${String(e.calls).padStart(4)} calls  ~$${cost(e).toFixed(4)}`)
      .join('\n');
    const siteRows = Object.entries(L.sites).sort((a, b) => cost(b[1]) - cost(a[1])).slice(0, 10);
    const w = Math.max(4, ...siteRows.map(([s]) => s.length));
    costSites.textContent = siteRows
      .map(([s, e]) => `${s.padEnd(w)}  ${String(e.calls).padStart(4)} calls  ~$${cost(e).toFixed(4)}`)
      .join('\n');
  }
  function loadLedger() {
    chrome.storage.local.get('glimmer_usage').then(r => renderLedger(r.glimmer_usage));
  }
  loadLedger();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.glimmer_usage) renderLedger(changes.glimmer_usage.newValue);
  });
  document.getElementById('cost-reset').addEventListener('click', () => {
    chrome.storage.local.remove('glimmer_usage').then(loadLedger);
  });

  // ---- perf ----
  const perfOut = document.getElementById('perf-out');
  document.getElementById('perf-dump').addEventListener('click', async () => {
    const r = await send({ type: 'glimmer-perf' });
    perfOut.style.display = '';
    if (!r || !r.rows || !Object.keys(r.rows).length) {
      perfOut.textContent = 'no samples — enable perf instrumentation, browse, dump again';
      return;
    }
    const names = Object.keys(r.rows);
    const w = Math.max(...names.map(n => n.length));
    let out = `${'bucket'.padEnd(w)}  calls    avg     max    total\n`;
    for (const n of names) {
      const b = r.rows[n];
      out += `${n.padEnd(w)}  ${String(b.calls).padStart(5)}  ${b.avgMs.toFixed(2).padStart(6)}  ${b.maxMs.toFixed(1).padStart(6)}  ${b.totalMs.toFixed(1).padStart(7)}\n`;
    }
    perfOut.textContent = out;
  });
  document.getElementById('perf-reset').addEventListener('click', async () => {
    await send({ type: 'glimmer-perf-reset' });
    perfOut.style.display = '';
    perfOut.textContent = 'perf counters reset';
  });
})();
