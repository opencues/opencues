// Glimmer — reading-side cues. An attention band over the page; prose
// passing through it is analysed for one insight, the last visible prose
// word shimmers, hover reveals the insight in place. Tune via the extension
// popup (popup.html); debug visuals via its "debug ui" toggle.
(() => {
  'use strict';
  if (window.__roiDbgLoaded) return;
  window.__roiDbgLoaded = true;

  // ---- settings (popup-tunable; persisted in chrome.storage) ----
  const S = {
    debugUi: false,     // master: ALL visual debug chrome (band, boxes, minimap).
                        // Off = the true final product — only the glimmer shows.
    bandPct: 24,        // band height as % of viewport
    bufferPct: 30,      // hysteresis: % of band height added above AND below.
                        // A glimmer STARTS only in the core band, but stays
                        // interactable until it leaves the buffered zone — so
                        // text animating out of the box can still be clicked.
    mode: 'all',        // 'all' = every candidate in band | 'closest' = only nearest band center
    showCandidates: true,
    minChars: 120,      // min innerText length for generic-tier candidates
    lookahead: 0,       // minimap range: 0 = full page, N = window of N page-heights TOTAL
    scrollbarMode: true,  // dock minimap full-height right + hide native scrollbar
    mapMarks: true,     // debug ticks (candidates/band/hits) inside the strip
    textMarks: true,    // green in-band paint on the text nodes themselves
    fadeMs: 600,        // dim -> highlight -> dim transition duration (page + minimap)
    candAlpha: 0.1,     // minimap candidate wash opacity (ghosts at 40% of it)
    blurPx: 0,          // gaussian blur on the tick layer (0 = crisp rects)
    fullTicks: false,   // ticks span the strip's full width instead of inset
    insightMode: true,  // cerebras insight glimmer on in-band prose
    glimmerMs: 300,     // scramble burst on glimmer start AND revert
    settleOnly: true,   // glimmers start only once the scroll has settled;
                        // reverts still fire immediately while scrolling
    perfMode: false,    // benchmark instrumentation (see perf.js) — off = inert
  };

  // ---- module deps (load order in manifest.json: key -> scramble ->
  // dom-utils -> insight-client -> content) ----
  const { glimmerableWord, inBadAncestor, wordVisible, wrapRange, shapeOf,
          paintShape, paintText, restoreShape, lockBox, unlockBox, refreshLock } = window.RoiDom;
  const insightClient = window.RoiInsightClient;

  // ---- tier 1: per-site registry (selectors verified against live HTML) ----
  const REGISTRY = [
    { test: h => /(^|\.)wikipedia\.org$/.test(h), sel: ['#mw-content-text .mw-parser-output > p'] },
    { test: h => h === 'github.com', sel: ['article.markdown-body p', 'article.markdown-body li'] },
    { test: h => h === 'news.ycombinator.com', sel: ['.commtext'] },
    { test: h => h === 'developer.mozilla.org', sel: ['main#content section.content-section p'] },
    { test: h => /(^|\.)stackoverflow\.com$/.test(h), sel: ['.s-prose p'] },
    { test: h => h === 'arxiv.org', sel: ['blockquote.abstract'] },
    // X renders tweet text as spans inside this container div — box the container.
    { test: h => h === 'x.com' || h === 'twitter.com', sel: ['[data-testid="tweetText"]'], min: 20 },
    // Reddit: a comment is often several <p>s — treat the comment BODY
    // container as ONE candidate (one insight, one glimmer), same pattern as
    // X's tweet container. Covers shreddit comments, text posts, old reddit.
    { test: h => /(^|\.)reddit\.com$/.test(h),
      sel: ['shreddit-comment div[slot="comment"]', 'shreddit-post div[slot="text-body"]', '.usertext-body .md'],
      min: 30 },
  ];
  // Substack lives on custom domains — detect by DOM shape, not hostname.
  const SUBSTACK_SEL = '.available-content .body.markup p';
  // tier 2 (generic fallback, length-filtered)
  const GENERIC_SEL = ['article p', 'main p', '[role="main"] p'];

  function candidateSelectors() {
    const h = location.hostname;
    const entry = REGISTRY.find(r => r.test(h));
    if (entry) return { sel: entry.sel, tier: 'registry', min: entry.min ?? 60 };
    if (document.querySelector(SUBSTACK_SEL)) return { sel: [SUBSTACK_SEL], tier: 'registry', min: 60 };
    return { sel: GENERIC_SEL, tier: 'generic' };
  }

  // ---- state ----
  const known = new WeakSet();      // elements already registered
  const inBand = new Set();         // elements currently intersecting the band
  let candidates = [];
  let tier = 'generic';
  let disabled = false;

  // ---- band geometry ----
  // Near the top of the scrollable area the band sits high (so top-of-page
  // content is capturable); over the first page-height of scrolling it eases
  // to the middle. Symmetrically it eases low near the very bottom.
  const smooth = t => t * t * (3 - 2 * t);
  // the ACTIVE scroller: pages like reddit's post overlay scroll an inner
  // container, leaving window.scrollY frozen — which pinned the band in its
  // "top of page" position. Found DETERMINISTICALLY (nearest viewport-sized
  // scrollable ancestor of a candidate, cached at scan time) — inferring it
  // from scroll-event targets flip-flopped between sources and made the band
  // jump. Whichever scroller has the LARGER range owns the ease.
  let scroller = null;   // null = the window scrolls
  function findScroller() {
    const el = candidates[0];
    for (let p = el && el.parentElement; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 4 && p.clientHeight > window.innerHeight * 0.5) {
        const cs = getComputedStyle(p);
        if (/(auto|scroll|overlay)/.test(cs.overflowY)) return p;
      }
    }
    return null;
  }
  function scrollState() {
    const vh = window.innerHeight;
    const winMax = Math.max(0, document.documentElement.scrollHeight - vh);
    if (scroller && scroller.isConnected) {
      const m = scroller.scrollHeight - scroller.clientHeight;
      if (m > winMax) return { y: scroller.scrollTop, max: m };
    }
    return { y: window.scrollY, max: winMax };
  }
  function bandRange() {
    const vh = window.innerHeight;
    const bandH = vh * (S.bandPct / 100);
    const { y, max } = scrollState();
    let center = vh * 0.5;
    if (max > 0) {
      const topCenter = Math.min(center, vh * 0.06 + bandH / 2);
      const p = Math.min(1, y / vh);
      center = topCenter + (center - topCenter) * smooth(p);
      const botCenter = Math.max(vh * 0.5, vh * 0.94 - bandH / 2);
      const q = Math.min(1, (max - y) / vh);
      center = botCenter + (center - botCenter) * smooth(q);
    }
    // HARD FLOOR: the bottom ease assumes "little scroll left" means the
    // page end, but infinite feeds (reddit) ALWAYS have little scroll left —
    // more keeps appending — so the band rode low chronically. Whatever the
    // easing says, the band centre never drops below 62% of the viewport.
    center = Math.min(center, vh * 0.62);
    return { top: center - bandH / 2, bottom: center + bandH / 2, center };
  }

  // ---- overlay band (+ the buffered hysteresis zone behind it) ----
  const band = document.createElement('div');
  band.className = 'roi-dbg-band';
  const buffer = document.createElement('div');
  buffer.className = 'roi-dbg-buffer';
  function bufferPad(range) {
    return (range.bottom - range.top) * (S.bufferPct / 100);
  }
  function layoutBand(range) {
    band.style.top = range.top + 'px';
    band.style.height = (range.bottom - range.top) + 'px';
    const pad = bufferPad(range);
    buffer.style.top = (range.top - pad) + 'px';
    buffer.style.height = (range.bottom - range.top + pad * 2) + 'px';
  }

  // ---- membership: PUSH-BASED via IntersectionObserver ----
  // The browser computes intersections on the compositor and reports DELTAS,
  // so far elements cost zero main-thread work — no tree walk, no rect
  // reads, no index to go stale when images load. The observer maintains
  // nearSet (viewport + one viewport of slack each side); the per-frame code
  // takes precise rects only inside it. Works through inner scrollers too.
  const viewRect = new WeakMap();   // el -> {top, bottom} (near candidates only)
  const nearSet = new Set();        // candidates near the viewport (IO-maintained)
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) nearSet.add(e.target);
      else nearSet.delete(e.target);
    }
    scheduleTick();   // membership changed without a scroll (feed loaded, resize)
  }, { rootMargin: '100% 0px 100% 0px' });

  function updateMembership(range) {
    inBand.clear();
    for (const el of nearSet) {
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      viewRect.set(el, { top: r.top, bottom: r.bottom });
      if (r.bottom > range.top && r.top < range.bottom) inBand.add(el);
    }
  }

  // ---- full-page position index — DEBUG MINIMAP ONLY ----
  // The minimap maps the whole page by definition, so it is the one consumer
  // that needs every candidate's position. Rebuilt lazily, and only while
  // the debug UI is showing; the product path never pays for it.
  let docIndex = [];                // [{el, top, bottom}] sorted by top
  function rebuildIndex() {
    if (!S.debugUi) { docIndex = []; return; }
    const tRb = performance.now();
    const yOff = scrollState().y;
    docIndex = [];
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const top = r.top + yOff;
      docIndex.push({ el, top, bottom: r.bottom + yOff });
      lastPos.set(el, { top, height: r.height });
    }
    docIndex.sort((a, b) => a.top - b.top);
    RoiPerf.rec('rebuildIndex', performance.now() - tRb);
  }

  // hits = the logical selection; the class paint on the page is gated by
  // S.textMarks, but the minimap and the glimmer read the logic directly
  const hits = new Set();
  let classed = new Set();          // elements currently carrying frame classes
  function paint(range) {
    hits.clear();
    if (S.mode === 'all') {
      inBand.forEach(el => hits.add(el));
    } else {
      let winner = null;
      let bestDist = Infinity;
      for (const el of inBand) {
        const vr = viewRect.get(el);   // measured this frame in updateMembership
        const d = Math.abs((vr.top + vr.bottom) / 2 - range.center);
        if (d < bestDist) { bestDist = d; winner = el; }
      }
      if (winner) hits.add(winner);
    }
    // class writes touch only near candidates + whatever was classed before —
    // never the whole candidate list
    const vh = window.innerHeight;
    const keep = new Set();
    const apply = el => {
      const vr = viewRect.get(el);
      const hit = S.debugUi && S.textMarks && hits.has(el);
      const on = nearSet.has(el) && !!vr && vr.bottom > 0 && vr.top < vh;
      el.classList.toggle('roi-dbg-hit', hit);
      el.classList.toggle('roi-dbg-onscreen', on);
      if (hit || on) keep.add(el);
    };
    nearSet.forEach(apply);
    classed.forEach(el => { if (!nearSet.has(el)) apply(el); });
    classed = keep;
  }

  // one pass per frame: band position, membership, page paint, minimap
  let lastRange = null;   // for insight callbacks that fire between ticks
  function tick() {
    if (disabled) return;
    const t0 = performance.now();
    const range = bandRange();
    lastRange = range;
    // READS first (membership rects, insight span rects), writes after —
    // interleaving them forces a synchronous relayout per read on big pages.
    if (!S.perfMode) {
      updateMembership(range);
      insightTick(range);
      paint(range);
      layoutBand(range);
      drawMinimap();
      return;
    }
    // Each phase is timed: a 'membership' spike while a churn runs means the
    // boil's writes forced relayout ahead of the frame's first rect read.
    let tp = t0, worst = 'membership', worstMs = 0;
    const ph = name => {
      const now = performance.now();
      const ms = now - tp;
      RoiPerf.rec(name, ms);
      if (ms > worstMs) { worstMs = ms; worst = name; }
      tp = now;
    };
    updateMembership(range); ph('membership');
    insightTick(range); ph('insight');
    paint(range); ph('paint');
    layoutBand(range); ph('band');
    drawMinimap(); ph('minimap');
    RoiPerf.frame(performance.now() - t0, worst);
  }

  // scroll-settle detection: while the user is actively scrolling, glimmer
  // STARTS are held back; the settle timer fires one tick when it goes quiet
  let scrolling = false;
  let settleTimer = null;
  const SCROLL_SETTLE_MS = 180;
  function onResize() {
    // a pinned width is stale after a resize; re-pin glimmering elements at
    // their new natural size (revealing ones keep their lock — their current
    // content is the short insight, so a re-measure would pin the wrong box)
    for (const el of glimmerSet) {
      const st = insightOf.get(el);
      if (!st || !st.revealing) refreshLock(el);
    }
    rebuildIndex();
    measureMinimap();
    tick();
  }
  let rafPending = false;
  function scheduleTick() {
    if (rafPending || disabled) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; tick(); });
  }
  function onScroll() {
    if (disabled) return;
    if (!scrolling) {
      // entering a scroll: settle any running churn instantly — its 70ms
      // nodeValue writes between our frame reads would force a full
      // relayout every frame (the insight-mode scroll lag on big pages)
      for (const el of glimmerSet) {
        const st = insightOf.get(el);
        if (st && st.span && st.span.__ocBoil) {
          st.span.__ocBoil.cancel();
          st.burstCut = true;   // re-fire this burst at the next settle
        }
      }
    }
    scrolling = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { scrolling = false; rebuildIndex(); tick(); }, SCROLL_SETTLE_MS);
    scheduleTick();
  }

  // ---- minimap ----
  const minimap = document.createElement('div');
  minimap.className = 'roi-dbg-minimap';
  // SVG, not canvas — vector marks stay crisp at any zoom / fractional DPR
  const mmSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  minimap.appendChild(mmSvg);
  // persistent layers: the marks <g> re-parses only on its throttled rebuild,
  // the chrome <g> (thumb/arrows — a handful of nodes) re-parses per frame.
  // Assigning the WHOLE svg's innerHTML per frame re-parsed ~1k rects every
  // frame even when the marks STRING was cached — that was the debug-UI lag.
  mmSvg.innerHTML =
    '<defs><filter id="roiBlur" x="-50%" y="-50%" width="200%" height="200%">' +
    '<feGaussianBlur stdDeviation="0"/></filter></defs>' +
    '<g class="roi-mm-marks"></g><g class="roi-mm-chrome"></g>';
  const mmBlurNode = mmSvg.querySelector('feGaussianBlur');
  const gMarks = mmSvg.querySelector('.roi-mm-marks');
  const gChrome = mmSvg.querySelector('.roi-mm-chrome');
  const ARROW_H = 18;          // arrow zone ≈ 1.19 × track width (measured from screenshot)
  let mmDark = false;
  function detectDark() {
    // the native scrollbar follows the page's rendered background, so we do too
    const parse = c => (c.match(/\d+(\.\d+)?/g) || []).map(Number);
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const p = parse(getComputedStyle(el).backgroundColor);
      if (p.length >= 3 && (p[3] === undefined || p[3] > 0.5)) {
        return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] < 128;
      }
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  // gutter compensation, the way modal libraries do it: measure the real
  // scrollbar width BEFORE hiding it, add it to body's existing padding-right
  // inline, restore the original on exit. Overlay-scrollbar setups measure 0,
  // so we fall back to the strip's width — content must clear the strip.
  let gutterComp = null;
  function applyGutterComp() {
    if (gutterComp || !document.body) return;
    const gw = (window.innerWidth - document.documentElement.clientWidth) || 15;
    const cur = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
    gutterComp = {
      prev: document.body.style.getPropertyValue('padding-right'),
      prevPriority: document.body.style.getPropertyPriority('padding-right'),
    };
    document.body.style.setProperty('padding-right', (cur + gw) + 'px', 'important');
  }
  function removeGutterComp() {
    if (!gutterComp) return;
    if (gutterComp.prev) {
      document.body.style.setProperty('padding-right', gutterComp.prev, gutterComp.prevPriority);
    } else {
      document.body.style.removeProperty('padding-right');
    }
    gutterComp = null;
  }

  // if the page declares its own scrollbar-color, adopt it (thumb + track).
  // ::-webkit-scrollbar styling isn't queryable from JS, so those pages get
  // the native default look instead.
  let pagePrefs = null;
  function readPageScrollbarPrefs() {
    const root = document.documentElement;
    const had = root.classList.contains('roi-dbg-scrollbar-mode');
    if (had) root.classList.remove('roi-dbg-scrollbar-mode'); // our override IS a scrollbar-color
    let out = null;
    try {
      const sc = getComputedStyle(root).scrollbarColor;
      if (sc && sc !== 'auto' && !/transparent/.test(sc)) {
        const probe = document.createElement('canvas').getContext('2d');
        const parse = str => {
          probe.fillStyle = str;
          const v = probe.fillStyle;
          if (v.startsWith('#')) {
            return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)).concat(1);
          }
          const m = (v.match(/[\d.]+/g) || []).map(Number);
          return [m[0], m[1], m[2], m[3] ?? 1];
        };
        const cols = sc.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+/g) || [];
        if (cols.length >= 2) {
          const thumb = parse(cols[0]);
          const track = parse(cols.slice(1).join(''));
          const lum = 0.2126 * thumb[0] + 0.7152 * thumb[1] + 0.0722 * thumb[2];
          const toward = lum < 128 ? 255 : 0;   // dark thumbs lighten on hover, light ones darken
          const mix = (c, k) => c.map((v, i) => (i < 3 ? Math.round(v + (toward - v) * k) : v));
          const rgb = a => `rgba(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`;
          out = {
            thumb: rgb(thumb),
            thumbHover: rgb(mix(thumb, 0.18)),
            thumbDrag: rgb(mix(thumb, 0.35)),
            track: rgb(track),
          };
        }
      }
    } catch { /* malformed value → native default look */ }
    if (had) root.classList.add('roi-dbg-scrollbar-mode');
    return out;
  }
  const mapAlpha = new Map();  // live candidate -> fade level (0..1)
  const lastPos = new Map();   // live candidate -> {top, height} in doc px
  const ghosts = [];           // {top, height, alpha, target} for detached candidates
  let minimapRange = { top: 0, height: 1 };
  let mmAnimPending = false;
  let mmLastFrame = 0;
  let mmMarksAt = 0;         // throttled marks rebuild (see drawMinimap)
  let mmMarksDirty = true;   // a setting changed — rebuild marks next draw
  let mmMarksShown = false;
  let mmSettling = false;    // a fade is mid-flight — keep scheduling redraws
  let mmW = 0;               // cached strip dims — reading clientWidth per
  let mmH = 0;               // frame forces layout after our style writes
  function measureMinimap() {
    mmW = minimap.clientWidth;
    mmH = minimap.clientHeight;
    if (mmW && mmH) mmSvg.setAttribute('viewBox', `0 0 ${mmW} ${mmH}`);
  }
  // sb-dark class, gutter width, track background: reads + writes, so it
  // runs only from the throttled rebuild / resize — never per frame
  function styleMinimapChrome() {
    minimap.classList.toggle('roi-dbg-sb-dark', S.scrollbarMode && mmDark);
    if (S.scrollbarMode) {
      const gw = window.innerWidth - document.documentElement.clientWidth;
      if (gw >= 10 && gw <= 30) minimap.style.setProperty('width', gw + 'px', 'important');
      if (pagePrefs) minimap.style.setProperty('background', pagePrefs.track, 'important');
      else minimap.style.removeProperty('background');
    } else {
      minimap.style.removeProperty('width');
      minimap.style.removeProperty('background');
    }
    measureMinimap();
  }

  function drawMinimap() {
    if (disabled || !S.debugUi) return;
    if (!docIndex.length && candidates.length) rebuildIndex();   // debug UI just turned on
    if (!mmW || !mmH) { measureMinimap(); if (!mmW || !mmH) return; }
    const w = mmW;
    const h = mmH;
    const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    const scrollY = window.scrollY;

    // range: full page, or an N-page-height window centered on the viewport
    let rangeTop = 0;
    let rangeH = docH;
    if (S.lookahead > 0) {
      const wantH = window.innerHeight * S.lookahead;
      if (wantH < docH) {
        const center = scrollY + window.innerHeight / 2;
        rangeH = wantH;
        rangeTop = Math.max(0, Math.min(docH - rangeH, center - rangeH / 2));
      }
    }
    minimapRange = { top: rangeTop, height: rangeH };
    const native = S.scrollbarMode;
    const oy = native ? ARROW_H : 0;   // arrow buttons reserve the strip ends
    const oh = h - oy * 2;
    const y = px => oy + ((px - rangeTop) / rangeH) * oh;
    const now = performance.now();

    // ---- marks layer: rebuilt at most ~11fps, BUCKETED to a fixed rect
    // budget. Ticks are aggregated into 2px rows and merged into runs, so
    // the layer holds at most a few hundred rects no matter how many
    // thousands of candidates the page has. ----
    if (S.mapMarks) {
      if (now - mmMarksAt > 90 || mmMarksDirty) {
        mmMarksAt = now;
        mmMarksDirty = false;
        mmDark = detectDark();
        styleMinimapChrome();
        mmBlurNode.setAttribute('stdDeviation', String(S.blurPx));
        if (S.blurPx > 0) gMarks.setAttribute('filter', 'url(#roiBlur)');
        else gMarks.removeAttribute('filter');
        const dark = mmDark;
        const inset = S.fullTicks ? 0 : native ? 3 : 6;
        const ca = S.candAlpha;
        const washC = native && dark ? '0, 0, 0' : '255, 255, 255';
        const col = !native
          ? { cand: a => `rgba(${washC}, ${ca * a})`,
              band: a => `rgba(46, 204, 113, ${0.45 * a})`,
              hit: a => `rgba(46, 204, 113, ${0.95 * a})`,
              ghost: a => `rgba(${washC}, ${0.4 * ca * a})` }
          : dark
          ? { cand: a => `rgba(${washC}, ${ca * a})`,
              band: a => `rgba(80, 210, 140, ${0.5 * a})`,
              hit: a => `rgba(80, 210, 140, ${0.95 * a})`,
              ghost: a => `rgba(${washC}, ${0.4 * ca * a})` }
          : { cand: a => `rgba(${washC}, ${ca * a})`,
              band: a => `rgba(30, 150, 80, ${0.45 * a})`,
              hit: a => `rgba(30, 150, 80, ${0.9 * a})`,
              ghost: a => `rgba(${washC}, ${0.4 * ca * a})` };
        // time-based linear fade so the panel's duration is real
        let settling = false;
        const dt = Math.min(150, now - (mmLastFrame || now));
        mmLastFrame = now;
        const step = (cur, target) => {
          const d = dt / S.fadeMs;
          const next = cur < target ? Math.min(target, cur + d) : Math.max(target, cur - d);
          if (next !== target) settling = true;
          return next;
        };
        // bucket pass: strongest state wins a row (hit > band > cand > ghost)
        const B = 2;
        const buckets = new Map();
        const put = (top, bottom, st, a) => {
          const y0 = Math.floor(y(top) / B) * B;
          const y1 = Math.max(y0 + B, Math.ceil(y(bottom) / B) * B);
          for (let yy = y0; yy < y1; yy += B) {
            const b = buckets.get(yy);
            if (!b || st > b.st || (st === b.st && a > b.a)) buckets.set(yy, { st, a });
          }
        };
        for (const g of ghosts) {
          g.alpha = step(g.alpha, g.target);
          if (g.top + g.height < rangeTop || g.top > rangeTop + rangeH) continue;
          if (g.alpha < 0.02) continue;
          put(g.top, g.top + g.height, -1, g.alpha);
        }
        for (const e of docIndex) {
          const a = step(mapAlpha.get(e.el) ?? 0, 1);
          mapAlpha.set(e.el, a);
          if (e.bottom < rangeTop || e.top > rangeTop + rangeH) continue;
          if (a < 0.02) continue;
          put(e.top, e.bottom, hits.has(e.el) ? 2 : inBand.has(e.el) ? 1 : 0, a);
        }
        // merge adjacent same-state rows into runs, emit one rect per run
        const marks = [];
        const keys = [...buckets.keys()].sort((k1, k2) => k1 - k2);
        let run = null;
        const flush = () => {
          if (!run) return;
          const fill = run.st === 2 ? col.hit(run.a) : run.st === 1 ? col.band(run.a)
            : run.st === 0 ? col.cand(run.a) : col.ghost(run.a);
          const ai = S.fullTicks ? 0 : run.st === 2 ? Math.max(1, inset - 2) : inset;
          marks.push(`<rect x="${ai}" y="${run.y0}" width="${w - ai * 2}" height="${run.y1 - run.y0}" fill="${fill}"/>`);
          run = null;
        };
        for (const k of keys) {
          const b = buckets.get(k);
          const qa = Math.round(b.a * 10);
          if (run && k === run.y1 && b.st === run.st && qa === run.qa) run.y1 = k + B;
          else { flush(); run = { y0: k, y1: k + B, st: b.st, a: b.a, qa }; }
        }
        flush();
        gMarks.innerHTML = marks.join('');
        mmMarksShown = true;
        mmSettling = settling;
      }
    } else if (mmMarksShown) {
      gMarks.innerHTML = '';
      mmMarksShown = false;
      mmSettling = false;
    }

    // ---- chrome layer: thumb / arrows / viewport — a handful of nodes,
    // rebuilt per frame so scrubbing stays smooth ----
    const dark = mmDark;
    const chrome = [];
    const vpTop = y(scrollY);
    const vpH = Math.max(native ? 24 : 4, (window.innerHeight / rangeH) * oh);
    const range = bandRange();
    if (native) {
      const glyph = pagePrefs ? pagePrefs.thumb
        : dark ? '#9e9e9e' : '#505050';
      const aHalf = (w * 0.62 - 2.4) / 2;
      const aTop = w * 0.29 + 1.2;
      const aBase = aTop + w * 0.49 - 2.4;
      for (const [apexY, baseY] of [[aTop, aBase], [h - aTop, h - aBase]]) {
        chrome.push(`<path d="M ${w / 2} ${apexY} L ${w / 2 - aHalf} ${baseY} L ${w / 2 + aHalf} ${baseY} Z" ` +
          `fill="${glyph}" stroke="${glyph}" stroke-width="2.4" stroke-linejoin="round"/>`);
      }
      const thumbW = (drag || mmHover) ? 12 : Math.round(w * 0.6);
      const tx = (w - thumbW) / 2;
      const thumbFill = pagePrefs
        ? (drag ? pagePrefs.thumbDrag : mmHover ? pagePrefs.thumbHover : pagePrefs.thumb)
        : dark
        ? (drag ? '#b4b4b4' : mmHover ? '#969696' : '#757575')
        : (drag ? '#787878' : mmHover ? '#a8a8a8' : '#c1c1c1');
      chrome.push(`<rect x="${tx}" y="${vpTop}" width="${thumbW}" height="${vpH}" rx="${thumbW / 2}" fill="${thumbFill}"/>`);
    } else {
      chrome.push(`<rect x="1.5" y="${vpTop}" width="${w - 3}" height="${vpH}" ` +
        `fill="none" stroke="rgba(215, 224, 217, 0.8)" stroke-width="1"/>`);
      chrome.push(`<rect x="1.5" y="${vpTop + (range.top / window.innerHeight) * vpH}" width="${w - 3}" ` +
        `height="${Math.max(2, ((range.bottom - range.top) / window.innerHeight) * vpH)}" fill="rgba(46, 204, 113, 0.28)"/>`);
    }
    gChrome.innerHTML = chrome.join('');

    // keep animating while any fade is settling (cache-hit frames included,
    // so the next throttled rebuild advances the fade)
    if (mmSettling && !mmAnimPending) {
      mmAnimPending = true;
      requestAnimationFrame(() => { mmAnimPending = false; drawMinimap(); });
    }
  }

  // click = jump, drag = scrub (like a real scrollbar thumb)
  let drag = null;
  let mmHover = false;
  minimap.addEventListener('mouseenter', () => { mmHover = true; drawMinimap(); });
  minimap.addEventListener('mouseleave', () => { mmHover = false; drawMinimap(); });
  function scrollToStripY(clientY, range, behavior) {
    const rect = minimap.getBoundingClientRect();
    const oy = S.scrollbarMode ? ARROW_H : 0;
    const frac = Math.min(1, Math.max(0, (clientY - rect.top - oy) / (rect.height - oy * 2)));
    const target = range.top + frac * range.height;
    window.scrollTo({ top: target - window.innerHeight / 2, behavior });
  }

  // arrow buttons: click steps a line (Chrome's 40px), hold repeats
  let arrowTimer = null;
  function stopArrows() {
    clearTimeout(arrowTimer);
    clearInterval(arrowTimer);
    arrowTimer = null;
  }
  function arrowDirAt(clientY) {
    if (!S.scrollbarMode) return 0;
    const rect = minimap.getBoundingClientRect();
    if (clientY - rect.top < ARROW_H) return -1;
    if (rect.bottom - clientY < ARROW_H) return 1;
    return 0;
  }
  minimap.addEventListener('pointerdown', e => {
    minimap.setPointerCapture(e.pointerId);
    e.preventDefault();
    const dir = arrowDirAt(e.clientY);
    if (dir) {
      window.scrollBy({ top: dir * 40, behavior: 'auto' });
      arrowTimer = setTimeout(() => {
        arrowTimer = setInterval(() => window.scrollBy({ top: dir * 40, behavior: 'auto' }), 60);
      }, 350);
      return;
    }
    // freeze the range for the whole drag — in windowed mode the range
    // follows the scroll, and scrubbing against a moving range feeds back
    drag = { startY: e.clientY, moved: false, range: { ...minimapRange } };
    drawMinimap();
  });
  minimap.addEventListener('pointermove', e => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
    if (drag.moved) scrollToStripY(e.clientY, drag.range, 'auto');
  });
  minimap.addEventListener('pointerup', e => {
    stopArrows();
    const d = drag;
    drag = null;
    if (d && !d.moved) scrollToStripY(e.clientY, d.range, 'smooth');
    drawMinimap();
  });
  minimap.addEventListener('pointercancel', () => { stopArrows(); drag = null; });

  // ---- insight glimmer (cerebras via background.js) ----
  // A candidate entering the band asks the model for ONE short insight (once,
  // ever, per element — the background worker queues calls one at a time).
  // The glimmer is a STATE tied to band membership: while the paragraph is in
  // the ROI its last word glimmers gold; when it leaves, the glimmer reverts.
  // Each direction announces itself with a S.glimmerMs scramble burst — the
  // Zelda sparkle in the grass, in and out. Hovering the glimmering word
  // churns the whole paragraph and settles it into the insight ALONE — the
  // future state of the text, nothing else. A min-height lock keeps the block
  // at its original size, so a short insight never collapses the lines the
  // paragraph was holding.
  //
  // THE REVEAL IS NON-DESTRUCTIVE: it captures the element's text-node
  // values at hover time (after cancelling every running boil inside, so no
  // mid-churn text is baked in) and only ever writes VALUES back into those
  // same nodes. No innerHTML, no node replacement — the page's own children
  // (LinkedIn's "…more" button, framework-managed nodes) keep their
  // listeners and identity through the whole round trip.
  // ---- reading concern (CUE.md-shaped — see concerns.js) ----
  // ONE concern is active per page: highest-priority doc whose site scope
  // matches. Changing the concern set bumps a generation counter; element
  // states from an older generation re-request under the new concern.
  let userConcernDocs = [];
  let activeConcern = null;
  let concernGen = 0;
  let concernLoc = '';
  function rebuildConcern() {
    const loc = location.hostname + location.pathname;
    concernLoc = loc;
    const next = RoiConcerns.pickActive(
      RoiConcerns.effective(userConcernDocs), location.hostname, location.pathname);
    const changed = (next ? next.name + '\u0000' + next.prompt + '\u0000' + (next.model || '') : '') !==
      (activeConcern ? activeConcern.name + '\u0000' + activeConcern.prompt + '\u0000' + (activeConcern.model || '') : '');
    activeConcern = next;
    if (changed) concernGen++;
  }

  const insightOf = new WeakMap();  // el -> {status, text, shape, glimmering, span, revealing}
  const activeReveals = new Set();  // elements mid-reveal, for teardown restore
  let insightAsked = 0;
  let insightReady = 0;
  let insightErr = '';

  const PREFETCH_AHEAD = 3;  // analyse this many nodes below the band

  function stateOf(el) {
    let s = insightOf.get(el);
    if (!s) { s = { status: 'new', text: '', glimmering: false, gen: concernGen }; insightOf.set(el, s); }
    if (s.gen !== concernGen && !s.revealing) {
      // the concern changed under this element — its insight is stale
      if (s.glimmering) stopGlimmer(el, s);
      s.status = 'new';
      s.text = '';
      s.gen = concernGen;
    }
    return s;
  }

  function requestInsight(el, s) {
    s.status = 'pending';
    insightAsked++;
    const passage = (el.innerText || '').trim().slice(0, 1200);
    const c = activeConcern;
    insightClient.complete(passage, c ? { system: c.prompt, model: c.model } : undefined).then(text => {
      s.status = 'ready';
      s.text = text;
      insightReady++;
      insightErr = '';
      insightTick();   // in band right now → glimmer immediately, no scroll needed
    }, e => {
      s.status = 'error';
      insightErr = String((e && e.message) || e);
      console.warn('[roi-dbg] insight failed:', insightErr);
    });
  }

  const glimmerSet = new Set();     // elements currently holding a glimmer

  function insightTick(range) {
    if (!S.insightMode || disabled || typeof OcScramble === 'undefined') return;
    if (!activeConcern) {
      // no concern matches this site — unwind anything live, then idle
      for (const el of [...glimmerSet]) stopGlimmer(el, insightOf.get(el));
      return;
    }
    range = range || lastRange;
    if (!range) return;
    const pad = bufferPad(range);
    const handle = el => {
      const s = stateOf(el);
      if (inBand.has(el) && s.status === 'new') requestInsight(el, s);
      if (s.status !== 'ready') return;
      if (s.revealing) {
        // a reveal survives inside the buffered zone; unwind past its edge
        const r = el.getBoundingClientRect();
        const inBuf = r.height > 0 && r.bottom > range.top - pad && r.top < range.bottom + pad;
        if (!inBuf && s.unwind) s.unwind();
        return;
      }
      if (s.glimmering) {
        // live: the only question is "has the WORD left the buffered zone?"
        const span = s.span;
        if (!span || !span.isConnected) { stopGlimmer(el, s); return; }
        const r = span.getBoundingClientRect();
        if (!(r.height > 0 && r.bottom > range.top - pad && r.top < range.bottom + pad)) {
          stopGlimmer(el, s);
          return;
        }
        // a burst the scroll-suppression cut short re-fires once at settle —
        // without this, a cancelled word stayed "lit" in state but never
        // visibly churned again (the cannot-see-the-glimmer bug)
        if (s.burstCut && !scrolling) {
          s.burstCut = false;
          OcScramble.boil(span, { ms: S.glimmerMs, density: 0.35 });
        }
        return;
      }
      // start path. Cheap gates first: the word lives inside the paragraph,
      // so a paragraph that misses the core means the word does too — no
      // span walk, no span rect. And settle-hold before any work at all.
      if (S.settleOnly && scrolling) return;
      const vr = viewRect.get(el);
      if (!vr || vr.bottom < range.top || vr.top > range.bottom) return;
      const span = ensureGlimmerSpan(el, s);
      if (!span) return;
      const r = span.getBoundingClientRect();
      if (r.height > 0 && r.bottom > range.top && r.top < range.bottom) {
        startGlimmer(el, s, span);
      }
    };
    // near candidates + anything already live — never the whole page, and
    // no per-frame Set allocation
    for (const el of nearSet) handle(el);
    for (const el of glimmerSet) if (!nearSet.has(el)) handle(el);
    for (const el of activeReveals) if (!nearSet.has(el) && !glimmerSet.has(el)) handle(el);
    // prefetch: the nearest candidates BELOW the band get analysed early, so
    // scrolling onto them finds the glimmer already primed — no waiting.
    // nearSet spans a viewport of slack below, so the next few are in it.
    const below = [];
    for (const el of nearSet) {
      const vr = viewRect.get(el);
      if (vr && vr.top >= range.bottom) below.push([vr.top, el]);
    }
    below.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < below.length && i < PREFETCH_AHEAD; i++) {
      const s = stateOf(below[i][1]);
      if (s.status === 'new') requestInsight(below[i][1], s);
    }
  }

  // the hover target: the LAST word in the paragraph that reads as prose —
  // walk backwards from the end, skipping bad ancestors, junk tokens, and
  // words the truncation is hiding
  function ensureGlimmerSpan(el, s) {
    if (s.span && s.span.isConnected) return s.span;
    // a failed walk is EXPENSIVE (computed styles + layout-forcing
    // hit-tests) — don't re-run it every scroll frame for the same element
    if (s.spanRetryAt && performance.now() < s.spanRetryAt) return null;
    // a candidate wrapped in a REAL hyperlink is never a target: every word
    // in it navigates on click. (Generic clickable wrappers — LinkedIn's
    // role="button" post shells — stay allowed; a[href] does not.)
    if (el.closest('a[href]')) { s.spanRetryAt = performance.now() + 5000; return null; }
    const elRect = el.getBoundingClientRect();
    if (!elRect.height) return null;
    // defer creation until the paragraph is near the viewport: the occlusion
    // hit-test only answers for on-screen points, and a glimmer can only
    // start inside the (on-screen) core band anyway. (Positional — no backoff.)
    if (elRect.bottom < 0 || elRect.top > window.innerHeight) return null;
    const tWalk = performance.now();
    const done = v => { RoiPerf.rec('span-walk', performance.now() - tWalk); return v; };
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      if (n.parentElement && n.parentElement.closest('.roi-dbg-glimmer')) continue;
      nodes.push(n);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (inBadAncestor(n, el)) continue;
      const words = [...n.nodeValue.matchAll(/\S+/g)];
      for (let w = words.length - 1; w >= 0; w--) {
        if (!glimmerableWord(words[w][0])) continue;
        if (!wordVisible(n, words[w].index, words[w][0].length, el)) continue;
        s.span = wrapRange(n, words[w].index, words[w][0].length);
        s.span.__ocOwner = el;   // O(1) hover lookup — no candidate search
        s.spanRetryAt = 0;
        return done(s.span);
      }
    }
    s.spanRetryAt = performance.now() + 800;
    return done(null);
  }

  // the word entered the box: burst in, then hold the glimmering state
  function startGlimmer(el, s, span) {
    s.glimmering = true;
    glimmerSet.add(el);
    lockBox(el);
    span.classList.add('roi-dbg-glimmering');
    OcScramble.boil(span, { ms: S.glimmerMs, density: 0.35 });
  }

  // leaving the band: burst out, land back on the plain word
  function stopGlimmer(el, s) {
    s.glimmering = false;
    glimmerSet.delete(el);
    const span = s.span;
    if (!span || !span.isConnected) {
      if (!s.revealing) unlockBox(el);
      return;
    }
    if (scrolling) {
      // mid-scroll: snap clean instead of churning — see onScroll
      if (span.__ocBoil) span.__ocBoil.cancel();
      span.classList.remove('roi-dbg-glimmering');
      if (!s.revealing && !s.glimmering) unlockBox(el);
      return;
    }
    OcScramble.boil(span, { ms: S.glimmerMs, density: 0.35,
      onDone: () => {
        span.classList.remove('roi-dbg-glimmering');
        if (!s.revealing && !s.glimmering) unlockBox(el);
      } });
  }

  // hover on a glimmer → reveal. Delegated, so it survives innerHTML restores.
  document.addEventListener('mouseover', e => {
    if (disabled || !S.insightMode || !e.target.closest) return;
    if (!glimmerSet.size) return;   // PERF: nothing live → no closest() walk
    const g = e.target.closest('.roi-dbg-glimmer');
    if (!g) return;
    // identity, not containment (nested candidates), and O(1): the span
    // carries its owner; s.span === g rejects stale spans after re-wraps
    const el = g.__ocOwner;
    if (!el) return;
    const s = insightOf.get(el);
    if (!s || s.span !== g) return;
    // only a live glimmer reveals — outside the ROI the word is plain text
    if (s && s.status === 'ready' && s.glimmering && !s.revealing) reveal(el, s);
  });

  const REVEAL_CHURN = 3;   // frames boiling the full original shape
  const REVEAL_SHRINK = 7;  // frames scrambling it down to the insight's length
  const REVEAL_EASE = 2;    // frames easing the insight itself in

  function reveal(el, s) {
    s.revealing = true;
    activeReveals.add(el);
    // settle every running boil inside so the shape captures clean text
    el.querySelectorAll('.roi-dbg-glimmer').forEach(sp => {
      if (sp.__ocBoil) sp.__ocBoil.cancel();
    });
    // NON-DESTRUCTIVE from here on: the whole round trip only ever writes
    // text-node VALUES inside the existing tree. No innerHTML, no element
    // creation or removal — the page's own children (LinkedIn's "…more"
    // button with its listeners, framework-managed nodes) survive untouched.
    const shape = shapeOf(el);
    s.shape = shape;
    // NON-SHAPE DEBRIS: inline links, code, img emojis are excluded from the
    // shape (never scrambled/overwritten), so through the shrink and the
    // settled insight they would linger as stray fragments floating inside
    // the reveal — wikipedia citations, github/so/mdn inline code, X's emoji
    // imgs. Hide them for the reveal's lifetime. Style-only and restored on
    // unwind, so the non-destructive contract holds.
    s.debris = [];
    el.querySelectorAll('a, button, code, pre, img, svg, video, [role="link"], [role="button"]')
      .forEach(n => {
        s.debris.push([n, n.style.display]);
        n.style.display = 'none';
      });
    lockBox(el);   // usually already locked by the glimmer — idempotent
    el.classList.add('roi-dbg-revealed');
    const ins = s.text.trim();
    const L0 = shape.total;
    const L1 = Math.min(ins.length, L0);
    let curLen = L0;          // what is on screen right now, in characters
    const show = (len, den) => { paintShape(shape, len, den); curLen = len; };
    let frame = 0;
    let timer = setInterval(() => {
      frame++;
      if (frame <= REVEAL_CHURN) {
        show(L0, 0.45);                       // the original shape, boiling
      } else if (frame <= REVEAL_CHURN + REVEAL_SHRINK) {
        const p = (frame - REVEAL_CHURN) / REVEAL_SHRINK;
        show(Math.round(L0 + (L1 - L0) * p), 0.45);   // scramble DOWN
      } else if (frame <= REVEAL_CHURN + REVEAL_SHRINK + REVEAL_EASE) {
        const k = REVEAL_CHURN + REVEAL_SHRINK + REVEAL_EASE - frame + 1;
        paintText(shape, OcScramble.scramble(ins, k * 0.15, Math.random));  // easing in
        curLen = L1;
      } else {
        clearInterval(timer);
        timer = null;
        paintText(shape, ins);                // the future state, clean
      }
    }, 70);
    const leave = () => {
      if (s.unwinding) return;   // mouseleave and band-exit can both fire
      s.unwinding = true;
      el.removeEventListener('mouseleave', leave);
      if (timer) { clearInterval(timer); timer = null; }
      // grow back through the same path, in the same nodes
      const from = curLen;
      const GROW = 5;
      paintShape(shape, from, 0.4);           // synchronous — no clean flash
      let back = 0;
      const t2 = setInterval(() => {
        back++;
        if (back <= GROW) {
          paintShape(shape, Math.round(from + (shape.total - from) * (back / GROW)), 0.4);
        } else {
          clearInterval(t2);
          restoreReveal(el, s);
        }
      }, 70);
      s.restore = () => { clearInterval(t2); restoreReveal(el, s); };
    };
    el.addEventListener('mouseleave', leave);
    s.unwind = leave;   // the band-exit path uses the same animated wind-down
    s.restore = () => {
      if (timer) clearInterval(timer);
      el.removeEventListener('mouseleave', leave);
      restoreReveal(el, s);
    };
  }

  function restoreReveal(el, s) {
    if (s.shape) restoreShape(s.shape);   // originals back into the same nodes
    s.shape = null;
    if (s.debris) {
      for (const [n, d] of s.debris) n.style.display = d;
      s.debris = null;
    }
    unlockBox(el);   // re-locked at fresh size if the glimmer restarts below
    el.classList.remove('roi-dbg-revealed');
    s.revealing = false;
    s.restore = null;
    s.unwind = null;
    s.unwinding = false;
    s.glimmering = false;        // recomputed below from the word's position
    glimmerSet.delete(el);
    activeReveals.delete(el);
    insightTick();               // word still in the box → glimmer comes straight back
  }

  // ---- scanning (initial + late-rendered content) ----
  function scan() {
    const tScan = performance.now();
    // prune nodes a virtualized feed (X, Reddit) has detached — keep their
    // last-known position as a fading ghost so the minimap retains hindsight
    candidates = candidates.filter(el => {
      if (el.isConnected) return true;
      io.unobserve(el);
      inBand.delete(el);
      nearSet.delete(el);
      const pos = lastPos.get(el);
      if (pos) ghosts.push({ ...pos, alpha: mapAlpha.get(el) ?? 0, target: 1 });
      lastPos.delete(el);
      mapAlpha.delete(el);
      return false;
    });
    if (ghosts.length > 800) ghosts.splice(0, ghosts.length - 800);

    // selector resolution is O(page) for the substack probe — only on full
    // passes; delta passes reuse the cached decision
    if (!scan.sel || pendingRoots === null) scan.sel = candidateSelectors();
    const { sel, tier: t, min } = scan.sel;
    tier = t;
    const minLen = t === 'generic' ? S.minChars : min;
    const roots = pendingRoots === null ? [document] : pendingRoots.filter(r => r.isConnected);
    pendingRoots = [];
    const found = [];
    for (const root of roots) {
      if (root.nodeType === 1 && root.matches) {
        for (const s2 of sel) if (root.matches(s2)) { found.push(root); break; }
      }
      for (const s2 of sel) found.push(...root.querySelectorAll(s2));
    }
    for (const el of found) {
      if (known.has(el)) continue;
      if ((el.textContent || '').trim().length < minLen) continue;  // textContent: innerText forces layout per node
      known.add(el);
      el.classList.add('roi-dbg-candidate');
      candidates.push(el);
      io.observe(el);        // membership deltas arrive push-based from here on
      mapAlpha.set(el, 0);   // fade in on the minimap
    }
    scroller = findScroller();   // re-resolve as content mounts/unmounts
    if (location.hostname + location.pathname !== concernLoc) rebuildConcern();  // SPA nav
    rebuildIndex();
    RoiPerf.rec('scan', performance.now() - tScan);
    tick();
  }

  let scanTimer = null;
  // DELTA SCAN state: mutations queue their added subtrees, and scan()
  // queries only inside them — O(new content), not O(page). null means the
  // next scan is a full-document pass (boot, or a mutation storm overflowed
  // the queue and a delta pass could miss content).
  let pendingRoots = null;
  const mutations = new MutationObserver(muts => {
    // a mutation inside a LOCKED element means the page changed its content
    // (e.g. "…more" expanded) — re-pin at the new natural size immediately,
    // or the exact-height lock clips the new content until unlock
    for (const m of muts) {
      let p = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      for (; p; p = p.parentElement) {
        if (p.__ocBoxLock) { refreshLock(p); break; }
      }
    }
    if (pendingRoots !== null) {
      outer: for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (pendingRoots.length >= 64) { pendingRoots = null; break outer; }
          pendingRoots.push(n);
        }
      }
    }
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  });

  // ---- settings (popup-driven) ----
  // The ROI debug screen lives in the extension's ACTION POPUP (popup.html),
  // styled after the OpenCues chrome extension. Settings persist in
  // chrome.storage.local['glimmer_settings']; changes apply here live via
  // storage.onChanged — no page reload, no in-page panel.
  const SETTINGS_KEY = 'glimmer_settings';
  let sbWas = false;
  function applySettings() {
    RoiPerf.enabled = S.perfMode;
    document.documentElement.style.setProperty('--roi-dbg-fade', S.fadeMs + 'ms');
    // the master gate: with debug UI off, nothing of ours paints on the page
    // or its scrollbar — the band and minimap hide, the native bar returns
    band.style.display = S.debugUi ? '' : 'none';
    buffer.style.display = S.debugUi ? '' : 'none';
    minimap.style.display = S.debugUi ? '' : 'none';
    document.body.classList.toggle('roi-dbg-show-candidates', S.showCandidates && S.debugUi);
    const sbOn = S.scrollbarMode && S.debugUi && !disabled;
    if (sbOn && !sbWas) pagePrefs = readPageScrollbarPrefs();  // read before hiding the native bar
    if (sbOn) applyGutterComp();   // measure while the native bar still shows
    document.documentElement.classList.toggle('roi-dbg-scrollbar-mode', sbOn);
    if (!sbOn) removeGutterComp();
    sbWas = sbOn;
    mmMarksDirty = true;      // any setting change re-renders the marks layer
    measureMinimap();         // display / scrollbar-mode toggles resize the strip
  }

  // ZONE PREVIEW: adjusting band height / buffer zone from the popup shows
  // the zones on the page even with debug UI off — you see what you're
  // shaping while you drag, and it fades away shortly after you stop.
  let zonePreviewTimer = null;
  function previewZone() {
    band.style.display = '';
    buffer.style.display = '';
    clearTimeout(zonePreviewTimer);
    zonePreviewTimer = setTimeout(() => {
      if (!S.debugUi && !disabled) {
        band.style.display = 'none';
        buffer.style.display = 'none';
      }
    }, 1600);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || disabled) return;
      if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
        const v = changes[SETTINGS_KEY].newValue;
        const zoneChanged = v.bandPct !== S.bandPct || v.bufferPct !== S.bufferPct;
        Object.assign(S, v);
        applySettings();
        if (zoneChanged) previewZone();   // after applySettings — it re-hides
        tick();
      }
      if (changes.glimmer_concerns) {
        userConcernDocs = changes.glimmer_concerns.newValue || [];
        rebuildConcern();
        tick();
      }
    });
  } catch { /* orphaned context */ }

  // ---- popup bridge: live stats + perf over runtime messaging ----
  function statsSnapshot() {
    const u = insightClient.usage();
    return {
      concern: activeConcern ? activeConcern.name : '(none)',
      tier,
      candidates: candidates.length,
      inBand: inBand.size,
      ready: insightReady,
      asked: insightAsked,
      err: insightErr,
      tokIn: u.tokIn,
      tokOut: u.tokOut,
      cost: u.cost,
      perf: S.perfMode ? RoiPerf.summary() : '',
    };
  }
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || disabled) return;
      if (msg.type === 'glimmer-stats') sendResponse(statsSnapshot());
      else if (msg.type === 'glimmer-perf') sendResponse({ rows: RoiPerf.rows() });
      else if (msg.type === 'glimmer-perf-reset') { RoiPerf.reset(); sendResponse({ ok: true }); }
    });
  } catch { /* orphaned context */ }

  function teardown() {
    disabled = true;
    mutations.disconnect();
    io.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(settleTimer);
    clearTimeout(zonePreviewTimer);
    stopArrows();
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    activeReveals.forEach(el => {
      const s = insightOf.get(el);
      if (s && s.restore) s.restore();
    });
    document.querySelectorAll('.roi-dbg-glimmer').forEach(sp => {
      if (sp.__ocBoil) sp.__ocBoil.cancel();
      sp.replaceWith(...sp.childNodes);
    });
    glimmerSet.clear();
    candidates.forEach(el => { el.classList.remove('roi-dbg-candidate', 'roi-dbg-hit', 'roi-dbg-onscreen'); unlockBox(el); });
    document.body.classList.remove('roi-dbg-show-candidates');
    document.documentElement.classList.remove('roi-dbg-scrollbar-mode');
    removeGutterComp();
    band.remove();
    buffer.remove();
    minimap.remove();
  }

  // ---- boot ----
  document.documentElement.appendChild(buffer);
  document.documentElement.appendChild(band);
  document.documentElement.appendChild(minimap);
  const boot = () => {
    rebuildConcern();
    applySettings();
    scan();
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
  };
  try {
    chrome.storage.local.get([SETTINGS_KEY, 'glimmer_concerns']).then(
      r => {
        if (r && r[SETTINGS_KEY]) Object.assign(S, r[SETTINGS_KEY]);
        userConcernDocs = (r && r.glimmer_concerns) || [];
        boot();
      },
      boot,
    );
  } catch {
    boot();
  }
})();
