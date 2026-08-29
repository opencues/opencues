/**
 * highlight-glimmer.ts — the glimmer scramble engine for chrome, built
 * entirely on the CSS Custom Highlight API.
 *
 * TS port of the proven experiment module
 * (experiments/glimmer-highlight-scramble/highlight-glimmer.js — see
 * NOTES.md there for the full design history + measured evidence).
 * Renders a character-scramble transition over existing DOM text by
 * RESTYLING glyphs: per-character Ranges move between registered
 * Highlight sets whose rules displace (text-shadow), hide
 * (color: transparent), or decorate. The text DOM is never written —
 * managed editors (Lexical / ProseMirror / Quill / Draft.js) can't see
 * or revert any of it, nothing lands on the undo stack, and per-tick
 * cost is O(animated span), never O(field). That's the structural fix
 * for the real-write Gmail freeze.
 *
 * Mechanism guarantees (bench-verified):
 *  - Swaps are word-scoped permutations — a bijection of each word's
 *    active subset onto itself, so two glyphs can never land on the
 *    same slot (collision-free by construction, no runtime checks).
 *  - Offset bucketing: highlights are keyed by quantized offset VALUE
 *    (0.5px bins), so registration is O(distinct offsets) — bounded by
 *    word width, independent of span length.
 *  - Geometry is lazy per word and phase-separated within a tick (all
 *    layout reads before any style writes — interleaving forces a
 *    reflow per word; measured 534ms/tick vs 11ms for identical work).
 */

let instanceCounter = 0;

export function supportsHighlightGlimmer(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

/** First ancestor with a real (non-transparent) computed background —
 *  what a "hidden" glyph must be painted in to vanish against it. */
function resolveBackgroundColor(el: Element | null): string {
  let cur: Element | null = el;
  while (cur) {
    const bg = getComputedStyle(cur).backgroundColor;
    if (bg && bg !== 'transparent' && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(bg)) return bg;
    cur = cur.parentElement;
  }
  return '#ffffff';
}

const DECORATION_STYLES: Record<string, string> = {
  'underline-solid':  'text-decoration-line: underline; text-decoration-style: solid',
  'underline-wavy':   'text-decoration-line: underline; text-decoration-style: wavy',
  'underline-dotted': 'text-decoration-line: underline; text-decoration-style: dotted',
  'strike-solid':     'text-decoration-line: line-through; text-decoration-style: solid',
  'strike-wavy':      'text-decoration-line: line-through; text-decoration-style: wavy',
};

export interface HighlightGlimmerDecoration {
  enabled?: boolean;
  pool?: string[];
  density?: number;
  followSwap?: boolean;
}

export interface HighlightGlimmerOptions {
  /** The text to animate: an Element (whole contents) or a Range that
   *  may span multiple text nodes. */
  target: Element | Range;
  idPrefix?: string;
  /** Fraction of each word's characters displaced per frame (percent). */
  activePct?: number;
  /** Loop mode only: fraction of words re-rolled per tick (percent). */
  rerollPct?: number;
  tickMs?: number;
  /** Shadow color for displaced glyphs — defaults to the target's
   *  computed text color. */
  textColor?: string;
  decorationColor?: string;
  /** What "hidden" glyphs are painted in — defaults to the nearest
   *  ancestor's real background color (bg-on-bg vanishes; `transparent`
   *  proved unreliable in highlight paint on live pages). */
  hideColor?: string;
  /** Where the instance's <style> element lands — pass a shadow root's
   *  host document position when the target lives inside one
   *  (::highlight() rules only reach ranges in their own tree scope). */
  styleParent?: Node;
  decoration?: HighlightGlimmerDecoration;
}

export interface HighlightGlimmerPlaySpec {
  mode?: 'appear' | 'sweep';
  direction?: 'fwd' | 'rev';
  durationMs?: number;
  /** true (default): once a word starts scrambling it churns until the
   *  end, everything settles at t=1. false: narrow traveling band with
   *  progressive settle behind it. */
  tail?: boolean;
}

export interface HighlightGlimmer {
  play(spec?: HighlightGlimmerPlaySpec): Promise<void>;
  loopStart(): void;
  loopStop(): void;
  /** Skip to the settled end state immediately. THE call to make the
   *  instant the field's text changes — Ranges over mutated text are
   *  unreliable, so an animation must never outlive the text it was
   *  built against. */
  cancel(): void;
  /** cancel + deregister every highlight + remove the stylesheet. */
  destroy(): void;
  readonly charCount: number;
  readonly wordCount: number;
}

// The tuned recipe (approved on the bench): 80% of a word's characters
// swap, 60% of words re-roll per tick in loop mode, single-line
// decorations at 30% density on swapped chars only, tail scrambling.
const DEFAULT_ACTIVE_PCT = 80;
const DEFAULT_REROLL_PCT = 60;
const DEFAULT_TICK_MS = 70;
const DEFAULT_DECORATION: Required<HighlightGlimmerDecoration> = {
  enabled: true,
  pool: ['underline-solid', 'underline-wavy', 'underline-dotted', 'strike-solid', 'strike-wavy'],
  density: 0.3,
  followSwap: true,
};

export function createHighlightGlimmer(options: HighlightGlimmerOptions): HighlightGlimmer {
  if (!supportsHighlightGlimmer()) throw new Error('CSS Custom Highlight API not available');
  const activePct = options.activePct ?? DEFAULT_ACTIVE_PCT;
  const rerollPct = options.rerollPct ?? DEFAULT_REROLL_PCT;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const deco = { ...DEFAULT_DECORATION, ...options.decoration };
  const prefix = (options.idPrefix ?? 'oc-glimmer') + '-' + (++instanceCounter);
  const doc: Document = options.target instanceof Range
    ? (options.target.commonAncestorContainer.ownerDocument ?? document)
    : (options.target.ownerDocument ?? document);

  let targetRange: Range;
  if (options.target instanceof Range) {
    targetRange = options.target;
  } else {
    targetRange = doc.createRange();
    targetRange.selectNodeContents(options.target);
  }

  // ---- Character cells + word groups: walk every text node the range
  // intersects, so words can span node boundaries ("wil<b>fred</b>").
  const charNode: Text[] = [];
  const charOff: number[] = [];
  let plain = '';
  {
    const walker = doc.createTreeWalker(
      targetRange.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
      { acceptNode: (n) => (targetRange.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) },
    );
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const tn = n as Text;
      const from = tn === targetRange.startContainer ? targetRange.startOffset : 0;
      const to = tn === targetRange.endContainer ? targetRange.endOffset : tn.data.length;
      for (let i = from; i < to; i++) {
        charNode.push(tn);
        charOff.push(i);
        plain += tn.data[i];
      }
    }
  }

  const charRanges: Range[] = [];
  const wordGroups: number[][] = [];
  const wordMeta: { text: string; sameNode: boolean }[] = [];
  {
    const wordRe = /[\p{L}\p{N}]+/gu;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(plain))) {
      const group: number[] = [];
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
      wordMeta.push({ text: m[0], sameNode });
    }
  }
  const N = charRanges.length;
  const W = wordGroups.length;

  const anchorEl = targetRange.startContainer.nodeType === Node.TEXT_NODE
    ? targetRange.startContainer.parentElement
    : (targetRange.startContainer as Element);
  const textColor = options.textColor ?? (anchorEl ? getComputedStyle(anchorEl).color : '#000');
  const decoColor = options.decorationColor ?? textColor;
  // Glyph-hiding color: the field's OWN background, not `transparent` —
  // painting bg-on-bg is visually identical when it works and immune to
  // any special-casing of transparent in highlight paint (live report:
  // `color: transparent` left the underlying text fully visible on a
  // real page while the rest of the effect ran). Walk up to the first
  // ancestor with a real background.
  const hideColor = options.hideColor ?? resolveBackgroundColor(anchorEl);

  const styleEl = doc.createElement('style');
  (options.styleParent ?? doc.head).appendChild(styleEl);
  const sheet = styleEl.sheet as CSSStyleSheet;
  const bucketMap = new Map<number, { h: Highlight; name: string }>();
  const charKey: (number | null)[] = new Array(N).fill(null);
  const wordActive: number[][] = wordGroups.map(() => []);
  const registered: string[] = [];

  function registerHighlight(name: string, h: Highlight): Highlight {
    // Out-prioritize the extension's own span rendering (oc-active
    // paints a background-color over the substituted span; oc-dim
    // recolors). Overlapping custom highlights resolve per-property by
    // priority, so while a glimmer highlight covers a range, its
    // `background-color: transparent` and hide color beat the cue
    // paint — and the moment the animation releases/destroys, the
    // normal rendering shows through again with no coordination code.
    (h as Highlight & { priority: number }).priority = 100;
    CSS.highlights.set(name, h);
    registered.push(name);
    return h;
  }

  const decoBuckets: Record<string, Highlight> = {};
  for (const name of deco.pool) {
    if (!DECORATION_STYLES[name]) throw new Error('unknown decoration: ' + name);
    decoBuckets[name] = registerHighlight(prefix + '-deco-' + name, new Highlight());
    sheet.insertRule(
      `::highlight(${prefix}-deco-${name}) { ${DECORATION_STYLES[name]}; text-decoration-color: ${decoColor}; background-color: transparent !important; }`,
      sheet.cssRules.length,
    );
  }
  const currentBucket: (string | null)[] = new Array(N).fill(null);
  let decoAssigned: number[] = [];

  const hideBucket = registerHighlight(prefix + '-hide', new Highlight());
  sheet.insertRule(
    `::highlight(${prefix}-hide) { color: ${hideColor} !important; background-color: transparent !important; }`,
    sheet.cssRules.length,
  );
  let hiddenChars = new Set<number>();

  function getBucket(key: number): { h: Highlight; name: string } {
    let b = bucketMap.get(key);
    if (b === undefined) {
      const name = prefix + '-off-' + String(key).replace('-', 'n').replace('.', 'p');
      const h = registerHighlight(name, new Highlight());
      sheet.insertRule(
        `::highlight(${name}) { color: ${hideColor} !important; background-color: transparent !important; text-shadow: ${key}px 0 0 ${textColor}; }`,
        sheet.cssRules.length,
      );
      b = { h, name };
      bucketMap.set(key, b);
    }
    return b;
  }

  function assignChar(idx: number, dx: number): void {
    const key = Math.round(dx * 2) / 2;
    const prev = charKey[idx];
    if (prev === key) return;
    if (prev !== null) bucketMap.get(prev)!.h.delete(charRanges[idx]);
    getBucket(key).h.add(charRanges[idx]);
    charKey[idx] = key;
  }

  function releaseChar(idx: number): void {
    const prev = charKey[idx];
    if (prev !== null) {
      bucketMap.get(prev)!.h.delete(charRanges[idx]);
      charKey[idx] = null;
    }
  }

  // ---- Lazy, phase-separated geometry (reads never interleave with
  // the tick's writes — the 534ms-per-tick reflow trap).
  const charPosX = new Float32Array(N).fill(NaN);
  const geoBuilt = new Uint8Array(W);
  const measureCtx = doc.createElement('canvas').getContext('2d')!;
  let measureFontSet = false;

  function ensureGeometry(wi: number): void {
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
          const cs = getComputedStyle(charNode[first].parentElement!);
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

  function shuffleInPlace<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function partialShuffleSelect(arr: number[], k: number): number[] {
    const n = arr.length;
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(Math.random() * (n - i));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr.slice(0, k);
  }

  function scrambleWord(wi: number): void {
    const group = wordGroups[wi];
    const activeCount = Math.min(group.length, Math.max(2, Math.round(group.length * activePct / 100)));
    const active = partialShuffleSelect(group.slice(), activeCount);
    const targets = shuffleInPlace(active.slice()); // permutation of active onto itself — collision-free by bijection
    const newSet = new Set(active);
    for (const idx of wordActive[wi]) if (!newSet.has(idx)) releaseChar(idx);
    for (let i = 0; i < active.length; i++) assignChar(active[i], charPosX[targets[i]] - charPosX[active[i]]);
    wordActive[wi] = active;
  }

  function decorationPass(): void {
    for (const idx of decoAssigned) {
      decoBuckets[currentBucket[idx]!].delete(charRanges[idx]);
      currentBucket[idx] = null;
    }
    decoAssigned = [];
    if (!deco.enabled || deco.density <= 0 || deco.pool.length === 0) return;
    // Follow-swap only: marks land exactly where a glyph is displaced
    // this frame. Doc-wide sampling reads as noise on a span-scoped
    // transition (bench finding) — the API ships the mode that won.
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

  function releaseAll(): void {
    for (let wi = 0; wi < W; wi++) {
      for (const idx of wordActive[wi]) releaseChar(idx);
      wordActive[wi] = [];
    }
    for (const idx of decoAssigned) {
      decoBuckets[currentBucket[idx]!].delete(charRanges[idx]);
      currentBucket[idx] = null;
    }
    decoAssigned = [];
    for (const idx of hiddenChars) hideBucket.delete(charRanges[idx]);
    hiddenChars = new Set();
  }

  // ---- Tick driver: setTimeout cadence with mutations offered to the
  // next real frame via rAF (24ms unaligned fallback — frames can be
  // starved: headless, prerender, background windows). Hidden tabs skip
  // the work but stay armed.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickFn: (() => void) | null = null;
  function loopRound(): void {
    if (!tickFn) return;
    if (doc.hidden) { timer = setTimeout(loopRound, tickMs); return; }
    let done = false;
    let fb: ReturnType<typeof setTimeout> | null = null;
    const raf = requestAnimationFrame(() => {
      if (done || !tickFn) return;
      done = true;
      if (fb !== null) clearTimeout(fb);
      tickFn();
      timer = setTimeout(loopRound, tickMs);
    });
    fb = setTimeout(() => {
      if (done || !tickFn) return;
      done = true;
      cancelAnimationFrame(raf);
      tickFn();
      timer = setTimeout(loopRound, tickMs);
    }, 24);
  }
  function stopLoop(): void {
    tickFn = null;
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  let playResolve: (() => void) | null = null;
  let wordSettled: Uint8Array | null = null;

  function finishPlay(): void {
    stopLoop();
    releaseAll();
    wordSettled = null;
    if (playResolve) { const r = playResolve; playResolve = null; r(); }
  }

  return {
    play({ mode = 'appear', direction = 'fwd', durationMs = 900, tail = true }: HighlightGlimmerPlaySpec = {}): Promise<void> {
      finishPlay(); // one at a time — a second play() skips the first to its end
      if (N === 0) return Promise.resolve();
      const dir = direction === 'rev' ? -1 : 1;
      const hidden = mode === 'appear';
      const bandW = Math.max(2, Math.round(W * 0.12));
      wordSettled = new Uint8Array(W);
      // Appear mode: the span's REAL text is hidden for the ENTIRE run —
      // every char goes into the hide bucket at t=0 and stays there
      // until the animation finishes (finishPlay's releaseAll is what
      // reveals the text, all at once). Scramble shadows layer on top
      // via the offset buckets: a char in both buckets paints the same
      // hide color plus the offset rule's text-shadow, so the dance is
      // visible over the darkness. Nothing is progressively revealed
      // mid-run — the settle-front only governs which words are
      // actively scrambling at any moment.
      if (hidden) {
        for (let i = 0; i < N; i++) { hideBucket.add(charRanges[i]); hiddenChars.add(i); }
      }
      const startTs = performance.now();
      const promise = new Promise<void>((res) => { playResolve = res; });

      tickFn = () => {
        const settled = wordSettled!;
        const t = (performance.now() - startTs) / durationMs;
        if (t >= 1) { finishPlay(); return; }
        // Liveness: if the editor rewrote the span's nodes after we
        // built (a char range collapses when its text node leaves the
        // document), the highlights paint nothing — finish immediately
        // so the real text shows rather than a dead dark span.
        if (charRanges[0].collapsed || charRanges[N - 1].collapsed) { finishPlay(); return; }
        const front = tail ? t * W : t * (W + bandW);
        // Phase 1 — layout reads only.
        const scrambling: number[] = [];
        for (let wi = 0; wi < W; wi++) {
          if (settled[wi]) continue;
          const pos = dir > 0 ? wi : W - 1 - wi;
          const on = tail ? pos <= front : (pos <= front && pos > front - bandW);
          if (on && wordGroups[wi].length >= 2) { ensureGeometry(wi); scrambling.push(wi); }
        }
        // Phase 2 — style writes only. "Settling" mid-run just stops a
        // word's scramble (its shadows go dark until the finish reveals
        // everything) — it never unhides.
        for (let wi = 0; wi < W; wi++) {
          if (settled[wi]) continue;
          const group = wordGroups[wi];
          const pos = dir > 0 ? wi : W - 1 - wi;
          const settleNow = tail
            ? (group.length < 2 && pos <= front)
            : (pos <= front - bandW || (group.length < 2 && pos <= front));
          if (settleNow) {
            for (const idx of wordActive[wi]) releaseChar(idx);
            wordActive[wi] = [];
            settled[wi] = 1;
          }
        }
        for (const wi of scrambling) scrambleWord(wi);
        decorationPass();
      };
      loopRound();
      return promise;
    },

    loopStart(): void {
      finishPlay();
      tickFn = () => {
        const rerollP = rerollPct / 100;
        const scrambling: number[] = [];
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

    loopStop(): void {
      stopLoop();
      releaseAll();
    },

    cancel(): void {
      finishPlay();
    },

    destroy(): void {
      finishPlay();
      for (const name of registered) CSS.highlights.delete(name);
      registered.length = 0;
      styleEl.remove();
    },

    get charCount(): number { return N; },
    get wordCount(): number { return W; },
  };
}
