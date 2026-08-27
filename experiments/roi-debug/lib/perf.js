// RoiPerf — in-extension benchmark harness. Real timings from real browsing,
// attributed per phase, because this environment cannot be reproduced
// headlessly. Overhead is two performance.now() calls per sample.
//
// API (window.RoiPerf):
//   rec(name, ms)          add one sample to a bucket
//   frame(totalMs, worst)  record a tick; totals > 12ms count as jank,
//                          attributed to that frame's worst phase
//   summary()              compact live line for the panel
//   table()                console.table of every bucket (calls/avg/max/total)
//   reset()                clear all buckets
//
// Reading the numbers:
//   - 'membership' spiking while a churn runs = the boil's nodeValue writes
//     forcing relayout ahead of the frame's first rect read — the attribution
//     is the diagnosis.
//   - 'longtask(page)' entries are main-thread stalls from ANYWHERE
//     (page's own scripts included) — compare against 'tick' totals to tell
//     our lag from the site's.
(() => {
  'use strict';
  if (window.RoiPerf) return;

  const buckets = new Map();
  let jank = 0;
  // master switch — wired to the panel's "perf instrumentation" setting.
  // Off (the default), rec/frame return immediately: no buckets, no cost.
  let enabled = false;

  function get(name) {
    let b = buckets.get(name);
    if (!b) { b = { n: 0, total: 0, max: 0 }; buckets.set(name, b); }
    return b;
  }
  function rec(name, ms) {
    if (!enabled) return;
    const b = get(name);
    b.n++;
    b.total += ms;
    if (ms > b.max) b.max = ms;
  }
  function frame(totalMs, worstName) {
    if (!enabled) return;
    rec('tick', totalMs);
    if (totalMs > 12) {
      jank++;
      rec('jank:' + worstName, totalMs);
    }
  }
  function summary() {
    const t = buckets.get('tick');
    if (!t || !t.n) return 'perf: no ticks yet';
    const rows = [...buckets.entries()]
      .filter(([n]) => n !== 'tick' && !n.startsWith('jank:') && !n.startsWith('longtask'));
    rows.sort((a, b) => b[1].total - a[1].total);
    const parts = rows.slice(0, 3)
      .map(([n, b]) => `${n} ${(b.total / b.n).toFixed(2)}`)
      .join(' · ');
    const lt = buckets.get('longtask(page)');
    return `tick ${(t.total / t.n).toFixed(2)}ms avg / ${t.max.toFixed(1)} max` +
      ` · jank ${jank}` + (lt ? ` · pageLT ${lt.n}` : '') + (parts ? ` · ${parts}` : '');
  }
  function rows() {
    const out = {};
    for (const [n, b] of [...buckets.entries()].sort((a, c) => c[1].total - a[1].total)) {
      out[n] = { calls: b.n, avgMs: b.total / b.n, maxMs: b.max, totalMs: b.total };
    }
    return out;
  }
  function table() {
    const out = {};
    for (const [n, b] of [...buckets.entries()].sort((a, c) => c[1].total - a[1].total)) {
      out[n] = {
        calls: b.n,
        avgMs: +(b.total / b.n).toFixed(3),
        maxMs: +b.max.toFixed(2),
        totalMs: +b.total.toFixed(1),
      };
    }
    console.table(out);
    console.log('[roi-dbg] jank frames (>12ms):', jank,
      '— jank:* rows name the worst phase of each jank frame');
  }
  function reset() {
    buckets.clear();
    jank = 0;
  }

  // main-thread stalls from ANY source, page included — the control group
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) rec('longtask(page)', e.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* longtask unsupported — fine */ }

  window.RoiPerf = {
    rec, frame, summary, table, rows, reset,
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; },
  };
})();
