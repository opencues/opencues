// RoiDom — pure DOM utilities for the ROI system. No page state, no
// settings, no timers: everything arrives through arguments, so each
// function is testable and reusable on its own. Loaded before content.js
// (see manifest.json content_scripts order); consumed via window.RoiDom.
//
// API surface:
//   BAD_ANCESTOR                       selector of never-glimmer containers
//   glimmerableWord(word)              token reads as prose?
//   inBadAncestor(node, el)            interactive ancestor between node and el?
//   wordVisible(node, start, len, el)  reader can actually see the word?
//   wrapRange(node, start, len)        wrap a text slice in a glimmer span
//   shapeOf(el)                        capture text nodes + values (the shape)
//   paintShape(shape, len, density)    scrambled original, truncated to len
//   paintText(shape, text)             arbitrary text through the shape
//   restoreShape(shape)                originals back into the same nodes
//   lockBox(el) / unlockBox(el)        pin / release an element's box
(() => {
  'use strict';
  if (window.RoiDom) return;

  // targets we never glimmer: linked/interactive/code text, hashtags,
  // mentions, bare URLs, number-junk — the word has to read as prose,
  // because scrambling a control invites a click on something that acts
  const BAD_ANCESTOR = 'a, button, code, pre, [role="link"], [role="button"]';

  function glimmerableWord(word) {
    if (/^[#@]/.test(word)) return false;                 // #tag / @mention
    if (/https?:\/\/|www\./i.test(word)) return false;    // URL
    const core = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    return (core.match(/\p{L}/gu) || []).length >= 3;     // ≥3 letters of prose
  }

  // bad-ancestor test bounded at the candidate itself: a link INSIDE the
  // paragraph disqualifies its words, but a clickable WRAPPER above the
  // paragraph (LinkedIn wraps whole post bodies in role="button" regions)
  // must not disqualify everything — relative to that wrapper the text is
  // uniformly prose and there is no safer word to prefer
  function inBadAncestor(node, el) {
    for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
      if (p.matches(BAD_ANCESTOR)) return true;
    }
    return false;
  }

  // a word is a valid target only if the reader can SEE it. Checking against
  // the paragraph's own rect is not enough: LinkedIn clips via an ANCESTOR
  // (the line-clamp "…more" wrapper), so hidden tail words still intersect
  // the paragraph's full-height box — and screen-reader copies live in 1px
  // overflow-hidden containers whose inner text lays out at natural size.
  // So: intersect the word's rect with EVERY clipping ancestor up the chain,
  // and reject anything hidden, transparent, or clipped down to slivers.
  function wordVisible(node, start, len, el) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + len);
    const r = range.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    let top = r.top, bottom = r.bottom, left = r.left, right = r.right;
    for (let p = node.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible' || clamp) {
        const pr = p.getBoundingClientRect();
        top = Math.max(top, pr.top);
        bottom = Math.min(bottom, pr.bottom);
        left = Math.max(left, pr.left);
        right = Math.min(right, pr.right);
        // most of the word must survive the clip — a 2px peek is not visible
        if (bottom - top < Math.min(8, r.height * 0.5) || right - left < 4) return false;
      }
    }
    // OCCLUSION: rects can't see an overlay painted on top of laid-out text
    // (LinkedIn's "…more" button sits OVER the end of the visible line).
    // Hit-test the word's centre: whatever paints there must belong to the
    // paragraph itself. pointer-events:none overlays (fade gradients, our
    // own band) fall through the hit-test, so they don't false-positive.
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    if (cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight) {
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(node.parentElement)) return false;
    }
    return true;
  }

  // wrap [start, start+len) of a text node in a span (the hover target)
  function wrapRange(node, start, len) {
    const mid = node.splitText(start);
    mid.splitText(len);
    const span = document.createElement('span');
    span.className = 'roi-dbg-glimmer';
    mid.parentNode.insertBefore(span, mid);
    span.appendChild(mid);
    return span;
  }

  // collect an element's text nodes + their current values (the shape).
  // Text inside interactive children (the "…more" button, inline links,
  // code) is NOT part of the shape: never scrambled, never overwritten,
  // never restored — the page's own controls stay out of the animation.
  function shapeOf(el) {
    const nodes = [], originals = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.length) continue;
      if (inBadAncestor(n, el)) continue;
      nodes.push(n);
      originals.push(n.nodeValue);
    }
    return { nodes, originals, total: originals.reduce((a, o) => a + o.length, 0) };
  }

  // paint the shape at `len` characters: each node holds a scrambled slice of
  // its OWN original text, truncated from the document's tail — the markup is
  // never touched, so the paragraph keeps its own wrap while it boils down
  function paintShape(shape, len, den) {
    let rem = len;
    for (let i = 0; i < shape.nodes.length; i++) {
      const o = shape.originals[i];
      const take = Math.max(0, Math.min(o.length, rem));
      shape.nodes[i].nodeValue = take > 0 ? OcScramble.scramble(o.slice(0, take), den, Math.random) : '';
      rem -= take;
    }
  }

  // write arbitrary text through the shape: the FIRST node carries the whole
  // text, every other node empties. Distributing by node capacity looks fine
  // inside one paragraph (inline nodes reflow as one run) but breaks across
  // BLOCK boundaries — a 3-<p> reddit comment rendered the insight chopped
  // across three paragraphs, mid-word. One carrier node is one continuous
  // flow; the box lock still holds the block's original space.
  function paintText(shape, text) {
    for (let i = 0; i < shape.nodes.length; i++) {
      shape.nodes[i].nodeValue = i === 0 ? text : '';
    }
  }

  // originals back into the very same nodes; a node the page has since
  // replaced is skipped — we never stomp DOM the page re-rendered
  function restoreShape(shape) {
    for (let i = 0; i < shape.nodes.length; i++) {
      if (shape.nodes[i].isConnected) shape.nodes[i].nodeValue = shape.originals[i];
    }
  }

  // BOX LOCK — held for a glimmer's whole lifetime. Churn glyphs have
  // different widths, so the box can rewrap (height) AND, in shrink-to-fit
  // contexts like hacker news's table cells, resize the whole column
  // (width). Either way the word moves under a stationary cursor and hover
  // engages/disengages in a loop. Pin both dimensions; border-box makes the
  // pinned width mean the measured rect regardless of the site's box-sizing.
  function lockBox(el) {
    if (el.__ocBoxLock) return;
    const r = el.getBoundingClientRect();
    el.__ocBoxLock = true;
    el.style.boxSizing = 'border-box';
    el.style.width = r.width + 'px';
    // EXACT height, not min-height: churn glyphs can be WIDER than the
    // originals, and with the width pinned that wraps an extra line — the
    // box GREW mid-burst (seen on hacker news). Pin the height and clip;
    // a momentarily-overflowing churn line is invisible, a growing box is not.
    el.style.height = r.height + 'px';
    el.style.overflow = 'hidden';
  }
  function unlockBox(el) {
    if (!el.__ocBoxLock) return;
    el.__ocBoxLock = false;
    el.style.boxSizing = '';
    el.style.width = '';
    el.style.height = '';
    el.style.overflow = '';
  }
  // the page changed a locked element's content (e.g. LinkedIn's "…more"
  // expanding) — re-pin at the NEW natural size so the lock never clips
  // legitimate content
  function refreshLock(el) {
    if (!el.__ocBoxLock) return;
    unlockBox(el);
    lockBox(el);
  }

  window.RoiDom = {
    BAD_ANCESTOR, glimmerableWord, inBadAncestor, wordVisible, wrapRange,
    shapeOf, paintShape, paintText, restoreShape, lockBox, unlockBox, refreshLock,
  };
})();
