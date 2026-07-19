// CE.6 — render runtime Statusline payloads into a floating div.
// Reuses the .oc-status-bar CSS class from the legacy StatusBar so
// styling carries over. The runtime's payload shape is defined at
// packages/opencues-runtime/src/modules/statusline.ts:33.

interface StatuslinePayload {
  active: boolean;
  highlightedWord?: string;
  currentAltIndex?: number;
  alts?: readonly string[];
  cueTip?: string | null;
  cueBlank?: boolean;
  /** Fluid advisory channel (contradiction, …) — shown ALONGSIDE the cue,
   *  not instead of it. Already glyph-prefixed (e.g. "⚠ …"). */
  advisory?: string | null;
  agentTask?: string | null;
  kata?: {
    step: number;
    stepCount: number;
    coach?: string | null;
    coachSegments?: ReadonlyArray<{ text: string; command: boolean }> | null;
    offTrack?: boolean;
  } | null;
  undoConfirmation?: string | null;
}

type Pos = 'right' | 'bottom' | 'top';
let el: HTMLDivElement | null = null;
let position: Pos = 'bottom';
let positionResolver: (() => Pos) | null = null;

/** Set where the bar sits. Applies a --pos-* class. */
export function setStatusbarPosition(pos: Pos): void {
  position = pos;
  if (el) applyPosition(el);
}

/** Register a live resolver for the position — read on every statusline
 *  update so a change to the `statusbar-position` scalar (via
 *  `opencues settings _` or the fluid-config intent classifier) takes
 *  effect immediately. content.ts wires this to bootResult.getSetting. */
export function setPositionResolver(fn: () => Pos): void {
  positionResolver = fn;
  const p = fn();
  if (p !== position) setStatusbarPosition(p);
}

function refreshPosition(): void {
  if (!positionResolver) return;
  const p = positionResolver();
  if (p !== position) setStatusbarPosition(p);
}

function applyPosition(node: HTMLDivElement): void {
  node.classList.remove('oc-status-bar--pos-right', 'oc-status-bar--pos-bottom', 'oc-status-bar--pos-top');
  node.classList.add(`oc-status-bar--pos-${position}`);
}

// Peek-through: the bar stays fully visible AND click-through
// (pointer-events:none), but hides itself whenever the cursor moves over
// its box so the user can read / click what it covers, then reappears
// when the cursor leaves. Done by geometry (a document-level pointermove
// that hittests the bar's rect) rather than :hover — because a
// click-through element never receives hover, and a hover-then-disable
// approach flickers. Only the OpenCues bar reacts; nothing else on the
// page is touched.
function installPeek(node: HTMLDivElement): void {
  const onMove = (e: PointerEvent): void => {
    if (!node.classList.contains('oc-status-bar--visible')) {
      if (node.classList.contains('oc-status-bar--peek')) node.classList.remove('oc-status-bar--peek');
      return;
    }
    const r = node.getBoundingClientRect();
    const over = e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
    node.classList.toggle('oc-status-bar--peek', over);
  };
  document.addEventListener('pointermove', onMove, { passive: true });
}

function ensureEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'oc-status-bar';
  el.setAttribute('aria-live', 'polite');
  applyPosition(el);
  document.body.appendChild(el);
  installPeek(el);
  return el;
}

/** Hide the bar — payload is "inactive" or empty. The base
 *  `.oc-status-bar` rule has opacity:0 so dropping the visible
 *  modifier is enough to fade it out. */
function hide(): void {
  if (el) el.classList.remove('oc-status-bar--visible');
}

/** Show the bar with the given text (single-line tip / cycling mode). */
function show(text: string): void {
  const div = ensureEl();
  div.classList.remove('oc-status-bar--kata');
  div.textContent = text;
  div.classList.add('oc-status-bar--visible');
}

/** Show the bar in kata mode — a bold head row (badge + counter) over a
 *  word-wrapped coach body. Wider + multi-line via the `--kata` modifier. */
function showKata(head: string, body: string): void {
  const div = ensureEl();
  div.textContent = '';
  div.classList.add('oc-status-bar--kata');

  const headEl = document.createElement('div');
  headEl.className = 'oc-kata-head';
  const badge = document.createElement('span');
  badge.className = 'oc-kata-badge';
  badge.textContent = 'C_';
  headEl.appendChild(badge);
  headEl.appendChild(document.createTextNode(head));
  div.appendChild(headEl);

  if (body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'oc-kata-body';
    bodyEl.textContent = body;
    div.appendChild(bodyEl);
  }

  div.classList.add('oc-status-bar--visible');
}

/** Render a runtime Statusline payload into the floating bar.
 *
 * Format mirrors CC's highlight-statusline.sh:
 *   - cueBlank=true        → "<tip>"            (tip alone)
 *   - cycling alts (N>1)     → "<word> (N/M) - <tip>"  (or head when tipless)
 *   - otherwise (no alts)    → tip alone, or hide
 */
export function applyStatuslinePayload(payload: StatuslinePayload): void {
  // Re-read the position scalar on every update so a cycle / fluid-config
  // change to `statusbar-position` takes effect immediately.
  refreshPosition();
  // Kata block is dominant while active — it overrides the normal word/tip
  // content (kata mode; docs/features/kata.md § Status line). The floating
  // bar is a single text element, so the coach renders as one line
  // (`C_ Kata N/M: <coach>`).
  const kata = payload.kata;
  if (kata) {
    const head = kata.stepCount > 0 ? `Kata ${kata.step}/${kata.stepCount}` : 'Kata';
    const body = kata.coach
      ?? (kata.coachSegments ? kata.coachSegments.map(s => s.text).join('') : '');
    showKata(head, body);
    return;
  }

  // Undo/redo confirmation is a transient notification the user just
  // triggered — dominant for its TTL (universal feedback for invisible
  // reverts: a scalar / OS value that doesn't change the buffer).
  if (payload.undoConfirmation) {
    show(payload.undoConfirmation);
    return;
  }

  const agentBadge = payload.agentTask ? `[task: ${payload.agentTask}]` : null;

  let wordPart: string | null = null;
  if (payload.active) {
    const tip = payload.cueTip ?? null;
    if (payload.cueBlank) {
      wordPart = tip;
    } else if (payload.alts && payload.alts.length > 1 && payload.highlightedWord) {
      const idx = (payload.currentAltIndex ?? 0) + 1;
      const head = `${payload.highlightedWord} (${idx}/${payload.alts.length})`;
      wordPart = tip ? `${head} - ${tip}` : head;
    } else {
      wordPart = tip;
    }
  }

  // Advisory (contradiction, …) shows ALONGSIDE the cue/tip — it's the fluid
  // channel, so it coexists rather than replacing. Independent of `active`: a
  // contradiction surfaces even when no cue owns the cursor's span.
  const advisory = payload.advisory ?? null;

  const parts = [wordPart, advisory, agentBadge].filter((p): p is string => !!p);
  const combined = parts.length ? parts.join(' | ') : null;

  if (combined) { show(combined); } else { hide(); }
}

/** Tear down the floating div — called when extension detaches. */
export function clearStatusbar(): void {
  if (el) {
    el.remove();
    el = null;
  }
}
