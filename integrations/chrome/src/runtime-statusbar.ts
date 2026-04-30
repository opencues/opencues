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

/** Show the bar with the given text. */
function show(text: string): void {
  const div = ensureEl();
  div.textContent = text;
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
  if (!payload.active) {
    hide();
    return;
  }

  const tip = payload.cueTip ?? null;

  if (payload.cueBlank) {
    if (tip) { show(tip); } else { hide(); }
    return;
  }

  if (payload.alts && payload.alts.length > 1 && payload.highlightedWord) {
    const idx = (payload.currentAltIndex ?? 0) + 1;
    const head = `${payload.highlightedWord} (${idx}/${payload.alts.length})`;
    show(tip ? `${head} - ${tip}` : head);
    return;
  }

  if (!tip) { hide(); return; }
  show(tip);
}

/** Tear down the floating div — called when extension detaches. */
export function clearStatusbar(): void {
  if (el) {
    el.remove();
    el = null;
  }
}
