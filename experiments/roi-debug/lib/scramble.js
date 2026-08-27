// Scramble — confusable-group text churn, extracted from the artifact kit
// (opencues-website: engine/scramble.js table + demo-engine boil recipe).
// Standalone module: no deps, callable over any existing text or element.
//
//   OcScramble.scramble(text, density, rand?)   → one scrambled string (pure)
//   OcScramble.boil(el, opts?)                  → churn an element's existing
//                                                 text in place, settle back
//   OcScramble.stream(seed)                     → deterministic PRNG (mulberry32)
//
// boil(el, { ms = 600, density = 0.45, seed, onDone }) returns { cancel() }.
// The element's markup is untouched — text nodes are scrambled individually
// and restored, so it works over highlighted / span-riddled content.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && !root.OcScramble) root.OcScramble = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* the wordmark scramble's confusable groups — a letter only ever swaps
     within its own group, symbols take precedence so _ boils through ?#&_
     not letters. Verbatim from the kit's one scramble table. */
  var GROUPS = [",li.:|';jI`!", "[]()tf", 'r/\\{}"*1', "-szJkvxy7",
    "aLF?hnuec4T32o<>EP#869bdgpq0+^", "ZY=$SBX~KR&VUAHD_", "NwGCOQm", "@M%W"];
  var ART = ["!", "?#&_", "@%"];
  var POOL = {};
  ART.concat(GROUPS).forEach(function (g) {
    for (var i = 0; i < g.length; i++) if (!(g[i] in POOL)) POOL[g[i]] = g;
  });
  GROUPS.forEach(function (g) {
    for (var i = 0; i < g.length; i++)
      if (POOL[g[i]].length < g.length && ART.indexOf(POOL[g[i]]) < 0) POOL[g[i]] = g;
  });

  function scramble(text, density, rand) {
    rand = rand || Math.random;
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var c = text[i], g = POOL[c];
      if (g && g.length > 1 && rand() < density) {
        var r = c;
        do { r = g[Math.floor(rand() * g.length)]; } while (r === c);
        out += r;
      } else out += c;
    }
    return out;
  }

  /* mulberry32 — seeded so the same call produces the same churn.
     Omit the seed for a live one-off; pass one when a run must repeat. */
  function stream(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  var FRAME_MS = 70;   // the kit's churn cadence
  var EASE_STEPS = 3;  // settle frames at 3/4, 2/4, 1/4 of the density

  /* Boil an element's EXISTING text in place and settle it back clean.
     The kit's recipe frame for frame: ms/70 churn frames at the density,
     then three easing frames, then the original text restored. */
  function boil(el, opts) {
    opts = opts || {};
    var ms = opts.ms > 0 ? opts.ms : 600;
    var density = opts.density > 0 ? opts.density : 0.45;
    var rand = opts.seed !== undefined ? stream(opts.seed) : Math.random;

    // one boil per element — a second call restarts it
    if (el.__ocBoil) el.__ocBoil.cancel();

    // collect the element's text nodes; markup stays where it is
    var nodes = [], originals = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue.trim()) { nodes.push(n); originals.push(n.nodeValue); }
    }

    var churnFrames = Math.max(1, Math.round(ms / FRAME_MS));
    var frame = 0, timer = null, done = false;

    function paint(den) {
      for (var i = 0; i < nodes.length; i++)
        nodes[i].nodeValue = scramble(originals[i], den, rand);
    }
    function restore() {
      for (var i = 0; i < nodes.length; i++) nodes[i].nodeValue = originals[i];
    }
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      restore();
      delete el.__ocBoil;
      if (opts.onDone) opts.onDone();
    }
    function tick() {
      if (done) return;
      if (frame < churnFrames) paint(density);
      else if (frame < churnFrames + EASE_STEPS)
        paint((churnFrames + EASE_STEPS - frame) * density / (EASE_STEPS + 1));
      else return finish();
      frame++;
      timer = setTimeout(tick, FRAME_MS);
    }

    var handle = { cancel: finish };
    el.__ocBoil = handle;
    if (nodes.length) tick(); else finish();
    return handle;
  }

  return { scramble: scramble, boil: boil, stream: stream };
});
