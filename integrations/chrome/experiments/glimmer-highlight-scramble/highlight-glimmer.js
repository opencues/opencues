/**
 * highlight-glimmer.js — the glimmer scramble as a reusable API.
 *
 * Everything the bench page (glimmer-bench.html) proved, extracted into
 * a self-contained ES module with zero dependencies. Renders a
 * character-scramble animation over existing DOM text using ONLY the
 * CSS Custom Highlight API: no text-DOM writes, nothing for a managed
 * editor's reconciler to revert, nothing on the undo stack.
 *
 * Browser requirements: CSS.highlights (Chromium 105+, Safari 17.2+,
 * Firefox 140+). Callers should feature-check `supportsHighlightGlimmer()`.
 *
 * Usage:
 *   import { createHighlightGlimmer, supportsHighlightGlimmer } from './highlight-glimmer.js';
 *   const glimmer = createHighlightGlimmer({ target: rangeOrElement });
 *   await glimmer.play({ mode: 'appear', direction: 'fwd', durationMs: 900 });
 *   // or: glimmer.loopStart(); ... glimmer.loopStop();
 *   glimmer.cancel();   // skip to settled end state (call on user edit!)
 *   glimmer.destroy();  // full teardown — every highlight + style removed
 *
 * Key differences from the bench page (the generalizations an
 * integration needs):
 *  - `target` is an Element OR a Range, and may span MULTIPLE text
 *    nodes (real contenteditables are never one text node). Words that
 *    span nodes or wrap lines fall back to per-character measurement.
 *  - Highlight names are namespaced per instance, so several glimmers
 *    can run in one document without colliding.
 *  - The shadow color is read from the target's computed style (with
 *    an override), not a hardcoded design token.
 *  - `styleParent` lets the stylesheet land inside a shadow root —
 *    ::highlight() rules only reach ranges in their own tree scope.
 */

let instanceCounter = 0;

export function supportsHighlightGlimmer() {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

const DECORATION_STYLES = {
  'underline-solid':  'text-decoration-line: underline; text-decoration-style: solid',
  'underline-wavy':   'text-decoration-line: underline; text-decoration-style: wavy',
  'underline-dotted': 'text-decoration-line: underline; text-decoration-style: dotted',
  'strike-solid':     'text-decoration-line: line-through; text-decoration-style: solid',
  'strike-wavy':      'text-decoration-line: line-through; text-decoration-style: wavy',
};

const DEFAULTS = {
  // The tuned recipe (bench defaults as approved): 80% of a word's
  // characters swap, 60% of words re-roll per tick, single-line
  // decorations from the mixed pool at 30% density on swapped chars
  // only, tail keeps scrambling until the transition ends.
  activePct: 80,
  rerollPct: 60,
  tickMs: 70,
  decoration: {
    enabled: true,
    pool: ['underline-solid', 'underline-wavy', 'underline-dotted', 'strike-solid', 'strike-wavy'],
    density: 0.3,
    followSwap: true,
  },
};

export function createHighlightGlimmer(options) {
  if (!supportsHighlightGlimmer()) throw new Error('CSS Custom Highlight API not available');
  const opts = { ...DEFAULTS, ...options };
  const deco = { ...DEFAULTS.decoration, ...(options && options.decoration) };
  const prefix = (opts.idPrefix || 'oc-glimmer') + '-' + (++instanceCounter);
  const doc = (opts.target.ownerDocument || opts.target.commonAncestorContainer?.ownerDocument || document);

  // ---- Resolve target to a Range.
  let targetRange;
  if (opts.target instanceof Range) {
    targetRange = opts.target;
  } else {
    targetRange = doc.createRange();
    targetRange.selectNodeContents(opts.target);
  }

  // ---- Build character cells + word groups by walking every text
  // node the range intersects. charIndex -> (node, offset) mapping,
  // then a word regex over the concatenated plain text so words can
  // span node boundaries (e.g. "wil<b>fred</b>").
  const charNode = [];   // per char: text node
  const charOff = [];    // per char: offset within its node
  let plain = '';
  {
    const walker = doc.createTreeWalker(
      targetRange.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (targetRange.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) }
    );
    let n;
    while ((n = walker.nextNode())) {
      const from = n === targetRange.startContainer ? targetRange.startOffset : 0;
      const to = n === targetRange.endContainer ? targetRange.endOffset : n.data.length;
      for (let i = from; i < to; i++) {
        charNode.push(n);
        charOff.push(i);
        plain += n.data[i];
      }
    }
  }

  const charRanges = [];
  const wordGroups = [];   // arrays of char indices — the swap scope; a permutation never leaves its word
  const wordMeta = [];     // { text, sameNode } per word, for the measurement fast path
  {
    const wordRe = /[\p{L}\p{N}]+/gu;
    let m;
    while ((m = wordRe.exec(plain))) {
      const group = [];
      let sameNode = true;
      for (let k = 0; k < m[0].length; k++) {
        const ci = m.index + k;
        const r = doc.createRange();
        r.setStart(charNode[ci], charOff[ci]);
        r.setEnd(charNode[ci], charOff[ci] + 1);
        charRanges.push(r);
        group.push(charRanges.length - 1);
        if (charNode[ci] !== charNode[m.index]) sameNode = false;
      }
      wordGroups.push(group);
      wordMeta.push({ text: m[0], sameNode, firstChar: m.index });
    }
  }
  const N = charRanges.length;
  const W = wordGroups.length;

  // ---- Shadow color: the field's real computed text color unless
  // overridden. Read once — glimmer runs are short; a mid-run theme
  // flip just plays out in the old color.
  const anchorEl = (targetRange.startContainer.nodeType === Node.TEXT_NODE
    ? targetRange.startContainer.parentElement
    : targetRange.startContainer);
  const textColor = opts.textColor || (anchorEl ? getComputedStyle(anchorEl).color : '#000');
  const decoColor = opts.decorationColor || textColor;

  // ---- Style + registry state. Offset buckets: highlights keyed by
  // quantized offset VALUE (0.5px bins), created lazily — O(B)
  // registration, B independent of text length.
  const styleEl = doc.createElement('style');
  (opts.styleParent || doc.head).appendChild(styleEl);
  const bucketMap = new Map();   // key(number) -> { h, name }
  const charKey = new Array(N).fill(null);
  const wordActive = wordGroups.map(() => []);
  const registered = [];         // every highlight name this instance ever registered, for destroy()

  function registerHighlight(name, h) {
    CSS.highlights.set(name, h);
    registered.push(name);
    return h;
  }

  const decoBuckets = {};
  for (const name of deco.pool) {
    if (!DECORATION_STYLES[name]) throw new Error('unknown decoration: ' + name);
    decoBuckets[name] = registerHighlight(prefix + '-deco-' + name, new Highlight());
    styleEl.sheet.insertRule(
      `::highlight(${prefix}-deco-${name}) { ${DECORATION_STYLES[name]}; text-decoration-color: ${decoColor}; }`,
      styleEl.sheet.cssRules.length
    );
  }
  const currentBucket = new Array(N).fill(null);
  let decoAssigned = [];

  const hideBucket = registerHighlight(prefix + '-hide', new Highlight());
  styleEl.sheet.insertRule(`::highlight(${prefix}-hide) { color: transparent; }`, styleEl.sheet.cssRules.length);
  let hiddenChars = new Set();

  function getBucket(key) {
    let b = bucketMap.get(key);
    if (b === undefined) {
      const name = prefix + '-off-' + String(key).replace('-', 'n').replace('.', 'p');
      const h = registerHighlight(name, new Highlight());
      styleEl.sheet.insertRule(
        `::highlight(${name}) { color: transparent; text-shadow: ${key}px 0 0 ${textColor}; }`,
        styleEl.sheet.cssRules.length
      );
      b = { h, name };
      bucketMap.set(key, b);
    }
    return b;
  }

  function assignChar(idx, dx) {
    const key = Math.round(dx * 2) / 2;
    const prev = charKey[idx];
    if (prev === key) return;
    if (prev !== null) bucketMap.get(prev).h.delete(charRanges[idx]);
    getBucket(key).h.add(charRanges[idx]);
    charKey[idx] = key;
  }

  function releaseChar(idx) {
    const prev = charKey[idx];
    if (prev !== null) {
      bucketMap.get(prev).h.delete(charRanges[idx]);
      charKey[idx] = null;
    }
  }

  // ---- Geometry: lazy per-word, phase-separated (all reads before any
  // writes within a tick — interleaving forces a reflow per word, the
  // 534ms-per-tick trap the bench hit). Word-batched cumulative
  // measureText when the word is one text node on one line; per-char
  // rect fallback for node-spanning or line-wrapped words.
  const charPosX = new Float32Array(N).fill(NaN);
  const geoBuilt = new Uint8Array(W);
  const measureCtx = doc.createElement('canvas').getContext('2d');
  let measureFontSet = false;

  function ensureGeometry(wi) {
    if (geoBuilt[wi]) return;
    const group = wordGroups[wi];
    const meta = wordMeta[wi];
    let fast = false;
    if (meta.sameNode) {
      const first = group[0];
      const last = group[group.length - 1];
      const wr = doc.createRange();
      wr.setStart(charNode[first], charOff[first]);
      wr.setEnd(charNode[last], charOff[last] + 1);
      const rects = wr.getClientRects();
      if (rects.length === 1) {
        if (!measureFontSet) {
          const cs = getComputedStyle(charNode[first].parentElement);
          measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          measureFontSet = true;
        }
        const rect = rects[0];
        const cum = [0];
        for (let k = 1; k <= meta.text.length; k++) cum.push(measureCtx.measureText(meta.text.slice(0, k)).width);
        const measuredWidth = cum[cum.length - 1];
        const corr = measuredWidth > 0 ? rect.width / measuredWidth : 1;
        for (let k = 0; k < group.length; k++) charPosX[group[k]] = rect.left + cum[k] * corr;
        fast = true;
      }
    }
    if (!fast) {
      for (const ci of group) charPosX[ci] = charRanges[ci].getBoundingClientRect().left;
    }
    geoBuilt[wi] = 1;
  }

  // ---- Random helpers (bench-verified permutation machinery).
  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function partialShuffleSelect(arr, k) {
    const n = arr.length;
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(Math.random() * (n - i));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr.slice(0, k);
  }

  function scrambleWord(wi) {
    const group = wordGroups[wi];
    const activeCount = Math.min(group.length, Math.max(2, Math.round(group.length * opts.activePct / 100)));
    const active = partialShuffleSelect(group.slice(), activeCount);
    const targets = shuffleInPlace(active.slice()); // permutation of active onto itself — collision-free by bijection
    const newSet = new Set(active);
    for (const idx of wordActive[wi]) if (!newSet.has(idx)) releaseChar(idx);
    for (let i = 0; i < active.length; i++) assignChar(active[i], charPosX[targets[i]] - charPosX[active[i]]);
    wordActive[wi] = active;
  }

  function decorationPass() {
    for (const idx of decoAssigned) {
      decoBuckets[currentBucket[idx]].delete(charRanges[idx]);
      currentBucket[idx] = null;
    }
    decoAssigned = [];
    if (!deco.enabled || deco.density <= 0 || deco.pool.length === 0) return;
    // Follow-swap only: in a span-scoped transition, doc-wide marks on
    // settled/hidden chars read as noise (bench finding). Non-follow
    // sampling exists in the bench for A/B purposes; the API ships the
    // mode that won.
    for (let wi = 0; wi < W; wi++) {
      for (const idx of wordActive[wi]) {
        if (Math.random() >= deco.density) continue;
        const name = deco.pool[Math.floor(Math.random() * deco.pool.length)];
        decoBuckets[name].add(charRanges[idx]);
        currentBucket[idx] = name;
        decoAssigned.push(idx);
      }
    }
  }

  function releaseAll() {
    for (let wi = 0; wi < W; wi++) {
      for (const idx of wordActive[wi]) releaseChar(idx);
      wordActive[wi] = [];
    }
    for (const idx of decoAssigned) {
      decoBuckets[currentBucket[idx]].delete(charRanges[idx]);
      currentBucket[idx] = null;
    }
    decoAssigned = [];
    for (const idx of hiddenChars) hideBucket.delete(charRanges[idx]);
    hiddenChars = new Set();
  }

  // ---- Tick driver: setTimeout cadence, mutations offered to the next
  // real frame via rAF with a 24ms unaligned fallback (frames can be
  // starved — headless, prerender, background windows). Hidden tabs
  // skip work but stay armed.
  let timer = null;
  let tickFn = null;
  function loopRound() {
    if (!tickFn) return;
    if (doc.hidden) { timer = setTimeout(loopRound, opts.tickMs); return; }
    let done = false;
    let fb = null;
    const raf = requestAnimationFrame(() => {
      if (done || !tickFn) return;
      done = true; clearTimeout(fb);
      tickFn();
      timer = setTimeout(loopRound, opts.tickMs);
    });
    fb = setTimeout(() => {
      if (done || !tickFn) return;
      done = true; cancelAnimationFrame(raf);
      tickFn();
      timer = setTimeout(loopRound, opts.tickMs);
    }, 24);
  }
  function stopLoop() {
    tickFn = null;
    clearTimeout(timer);
    timer = null;
  }

  // ---- One-shot state.
  let playResolve = null;
  let wordSettled = null;

  function finishPlay() {
    stopLoop();
    releaseAll();
    wordSettled = null;
    if (playResolve) { const r = playResolve; playResolve = null; r(); }
  }

  const api = {
    /** One transition. mode: 'appear' (start hidden, materialize through
     *  scramble) | 'sweep' (visible, wave passes through).
     *  direction: 'fwd' | 'rev'. tail (default true): once a word starts
     *  scrambling it churns until the end; false = narrow traveling band
     *  with progressive settle. Resolves when settled. */
    play({ mode = 'appear', direction = 'fwd', durationMs = 900, tail = true } = {}) {
      finishPlay(); // one at a time; a second play() skips the first to its end
      if (N === 0) return Promise.resolve();
      const dir = direction === 'rev' ? -1 : 1;
      const hidden = mode === 'appear';
      const bandW = Math.max(2, Math.round(W * 0.12));
      wordSettled = new Uint8Array(W);
      if (hidden) {
        for (let i = 0; i < N; i++) { hideBucket.add(charRanges[i]); hiddenChars.add(i); }
      }
      const startTs = performance.now();
      const promise = new Promise((res) => { playResolve = res; });

      tickFn = () => {
        const t = (performance.now() - startTs) / durationMs;
        if (t >= 1) { finishPlay(); return; }
        const front = tail ? t * W : t * (W + bandW);
        // Phase 1 — reads.
        const scrambling = [];
        for (let wi = 0; wi < W; wi++) {
          if (wordSettled[wi]) continue;
          const pos = dir > 0 ? wi : W - 1 - wi;
          const on = tail ? pos <= front : (pos <= front && pos > front - bandW);
          if (on && wordGroups[wi].length >= 2) { ensureGeometry(wi); scrambling.push(wi); }
        }
        // Phase 2 — writes.
        for (let wi = 0; wi < W; wi++) {
          if (wordSettled[wi]) continue;
          const group = wordGroups[wi];
          const pos = dir > 0 ? wi : W - 1 - wi;
          const settleNow = tail
            ? (group.length < 2 && pos <= front)
            : (pos <= front - bandW || (group.length < 2 && pos <= front));
          if (settleNow) {
            for (const idx of wordActive[wi]) releaseChar(idx);
            wordActive[wi] = [];
            if (hidden) for (const idx of group) { if (hiddenChars.delete(idx)) hideBucket.delete(charRanges[idx]); }
            wordSettled[wi] = 1;
          }
        }
        for (const wi of scrambling) {
          if (hidden) for (const idx of wordGroups[wi]) { if (hiddenChars.delete(idx)) hideBucket.delete(charRanges[idx]); }
          scrambleWord(wi);
        }
        decorationPass();
      };
      loopRound();
      return promise;
    },

    /** Ambient loop (blank-loading style) — scramble indefinitely until
     *  loopStop(). Uses the re-roll rate; no settle-front. */
    loopStart() {
      finishPlay();
      tickFn = () => {
        const rerollP = opts.rerollPct / 100;
        const scrambling = [];
        for (let wi = 0; wi < W; wi++) {
          if (wordGroups[wi].length < 2 || Math.random() >= rerollP) continue;
          ensureGeometry(wi);
          scrambling.push(wi);
        }
        for (const wi of scrambling) scrambleWord(wi);
        decorationPass();
      };
      loopRound();
    },

    loopStop() {
      stopLoop();
      releaseAll();
    },

    /** Skip to the settled end state immediately. THE call to make the
     *  instant the user edits the field — Ranges over mutated text are
     *  unreliable, so the animation must not outlive the text it was
     *  built against. */
    cancel() {
      finishPlay();
    },

    /** Full teardown: cancel + deregister every highlight this instance
     *  created + remove its stylesheet. The instance is dead after. */
    destroy() {
      finishPlay();
      for (const name of registered) CSS.highlights.delete(name);
      registered.length = 0;
      styleEl.remove();
    },

    get charCount() { return N; },
    get wordCount() { return W; },
  };
  return api;
}
