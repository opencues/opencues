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
  cueControl?: boolean;
}

let el: HTMLDivElement | null = null;

function ensureEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'oc-status-bar';
  el.setAttribute('aria-live', 'polite');
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

/** Hide the bar — payload is "inactive" or empty. */
function hide(): void {
  if (el) el.style.display = 'none';
}

/** Show the bar with the given text. */
function show(text: string): void {
  const div = ensureEl();
  div.textContent = text;
  div.style.display = '';
}

/** Render a runtime Statusline payload into the floating bar. */
export function applyStatuslinePayload(payload: StatuslinePayload): void {
  if (!payload.active) {
    hide();
    return;
  }

  // Cue-control word (volume/brightness blank fill, span fill, etc.)
  // — render the tip alone.
  if (payload.cueControl && payload.cueTip) {
    show(payload.cueTip);
    return;
  }

  const parts: string[] = [];

  // Index/length for words with multiple alts.
  if (payload.alts && payload.alts.length > 1) {
    const idx = (payload.currentAltIndex ?? 0) + 1;
    parts.push(`${idx}/${payload.alts.length}`);
  }

  if (payload.cueTip) parts.push(payload.cueTip);

  if (parts.length === 0) {
    hide();
    return;
  }

  show(parts.join(' '));
}

/** Tear down the floating div — called when extension detaches. */
export function clearStatusbar(): void {
  if (el) {
    el.remove();
    el = null;
  }
}
