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
  agentTask?: string | null;
  kata?: {
    step: number;
    stepCount: number;
    coach?: string | null;
    coachSegments?: ReadonlyArray<{ text: string; command: boolean }> | null;
    offTrack?: boolean;
  } | null;
}

let el: HTMLDivElement | null = null;

function ensureEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'oc-status-bar';
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
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

  const combined = wordPart && agentBadge
    ? `${wordPart} | ${agentBadge}`
    : (agentBadge ?? wordPart ?? null);

  if (combined) { show(combined); } else { hide(); }
}

/** Tear down the floating div — called when extension detaches. */
export function clearStatusbar(): void {
  if (el) {
    el.remove();
    el = null;
  }
}
