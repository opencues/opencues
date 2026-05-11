// Content script entry point.
//
// All feature logic now lives in opencues-runtime via the chrome
// adapter band. This file is the host shim:
//   1. Load popup config from chrome.storage.
//   2. Boot the runtime once.
//   3. Hook focusin so publishTarget() updates which contenteditable
//      the runtime reads from.
//   4. React to popup saves by re-publishing the target (the runtime
//      re-reads config via ConfigLoader hot-reload automatically).

import { loadConfig, onConfigChange } from './adapters/chrome-storage-adapter';
import {
  startOpenCues,
  publishTarget,
  clearRuntimeHighlights,
  log,
} from './opencues-bootstrap';
import { clearStatusbar } from './runtime-statusbar';
import { deriveOpenCuesColours } from './derive-colours';
import { walkPlainText, plainOffsetOfPosition } from './dom-walk';

function isTextInput(el: HTMLElement): boolean {
  return el.isContentEditable;
}

// CSS Custom Highlight pseudo-elements don't reliably inherit CSS
// custom properties from their originating element in current Chrome,
// so we can't drive ::highlight() colours via var(--oc-dim). Instead
// we write literal values into a runtime <style> tag that we
// overwrite on every attach / config change. ID is stable so updates
// replace, not duplicate.
const HIGHLIGHT_STYLE_ID = 'oc-highlight-styles';

function ensureHighlightStyle(): HTMLStyleElement {
  let el = document.getElementById(HIGHLIGHT_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = HIGHLIGHT_STYLE_ID;
    document.head.appendChild(el);
  }
  return el;
}

function applyDerivedColours(el: HTMLElement, dimMix: number): void {
  const { active, dim, activeBg } = deriveOpenCuesColours(el, dimMix);

  // Active = host text colour on a low-opacity tint of the host text
  // colour as the pill background. Painting at low opacity (rgba)
  // rather than mixing into a flat colour means the visible tint
  // adapts to whatever's actually behind it — works on solid white,
  // dark mode, gradients, and even the rare animated background. On
  // light pages the pill reads as a soft highlighter mark; on dark
  // pages as a brighter selection swatch. Far more visible than the
  // previous flat-mix dim colour, which on light pages collapsed to
  // a low-contrast light gray that didn't look "selected" at all.
  ensureHighlightStyle().textContent = `
    ::highlight(oc-dim) { color: ${dim} !important; }
    ::highlight(oc-active) {
      color: ${active} !important;
      background-color: ${activeBg} !important;
    }
  `;
}

function clearDerivedColours(_el: HTMLElement): void {
  const sheet = document.getElementById(HIGHLIGHT_STYLE_ID);
  if (sheet) sheet.textContent = '';
}

async function init(): Promise<void> {
  console.log('[OpenCues] Content script loaded');
  const config = await loadConfig();

  // Boot the runtime with config from chrome.storage. The runtime
  // owns Navigation, Cycling, BlankFill, Resolver, Statusline, TTS,
  // CursorStateExport, plus all 6 state classes.
  startOpenCues({
    llmApiKey: config.apiKey,
    llmEndpoint: config.apiUrl,
    llmDefaultModel: config.model,
    finnhubApiKey: config.finnhubApiKey,
  });

  let currentTarget: HTMLElement | null = null;

  const attachToFocused = (el: HTMLElement): void => {
    if (el === currentTarget) return;
    if (config.targetSelector && config.targetSelector !== '[contenteditable="true"]') {
      if (!el.matches(config.targetSelector)) return;
    }
    if (!isTextInput(el)) return;
    log.info('[OpenCues] Attaching to', el.tagName, el.id || el.className || '');
    // Strip derived colour vars from any previous target before tagging
    // the new one, so the page is free of stale OpenCues styling if
    // focus moved between contenteditables without going through focusout.
    if (currentTarget) clearDerivedColours(currentTarget);
    currentTarget = el;
    // Derive --oc-active / --oc-dim from the host's own computed text +
    // background colour. The active highlight ends up matching the
    // contenteditable's own text colour, so reconciliation gaps don't
    // flash. See derive-colours.ts and content.css.
    applyDerivedColours(el, config.dimMix);
    publishTarget(el);
  };

  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    if (el) attachToFocused(el);
  });

  // Mirror OpenCode's per-component lifecycle by clearing the runtime
  // target when focus moves away from a contenteditable. Without this,
  // currentTarget stays stale and runtime modules read from a detached
  // or backgrounded element. relatedTarget being null OR a non-text
  // input both count as "left the editor".
  document.addEventListener('focusout', (e) => {
    const evt = e as FocusEvent;
    const next = evt.relatedTarget as HTMLElement | null;
    if (!next || !isTextInput(next)) {
      if (currentTarget) {
        clearDerivedColours(currentTarget);
        currentTarget = null;
        publishTarget(null);
        clearRuntimeHighlights();
        clearStatusbar();
      }
    }
  });

  if (document.activeElement && document.activeElement instanceof HTMLElement) {
    attachToFocused(document.activeElement);
  }

  // Re-derive colours when the user toggles OS dark/light mode — host
  // pages that respect prefers-color-scheme will have flipped their
  // computed text + background colours, and our highlights need to
  // follow or they'll be inverted.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (currentTarget) applyDerivedColours(currentTarget, config.dimMix);
  });

  // SECURITY GATE — two layers to prevent hostile-page-triggered blanks.
  //
  // Layer 1 (here): drop isTrusted=false input events. Blocks the
  // cheapest attack — a page dispatching a synthetic InputEvent on a
  // hidden contenteditable.
  //
  // Layer 2 (opencues-bootstrap.ts): blanks are triggered by `_`. A
  // hostile page can still call `execCommand('insertText', false, '_')`
  // (after a user gesture) and the input event will be isTrusted=true.
  // So we track trusted `_` introductions (keydown, paste, drop) and
  // notifyOpenCuesTextChange ignores changes whose `_` count went up
  // without a recent trusted introduction. Runtime writes bypass
  // because sourceReclassifier reclassifies them as 'runtime'.
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.key !== '_') return;
    noteUserUnderscoreInsertion(1);
  }, true);
  document.addEventListener('paste', (e) => {
    if (!e.isTrusted) return;
    const text = e.clipboardData?.getData('text') ?? '';
    const n = (text.match(/_/g) || []).length;
    if (n > 0) noteUserUnderscoreInsertion(n);
  }, true);
  document.addEventListener('drop', (e) => {
    if (!e.isTrusted) return;
    const text = e.dataTransfer?.getData('text') ?? '';
    const n = (text.match(/_/g) || []).length;
    if (n > 0) noteUserUnderscoreInsertion(n);
  }, true);

  // Forward 'input' events from the focused target to the runtime.
  // Runtime modules (DimRender, BlankFill, Resolver) subscribe to
  // onTextChange. Use a single document listener to avoid per-attach
  // wiring.
  document.addEventListener('input', (e) => {
    if (e.isTrusted === false) return;
    // execCommand fires the input event synchronously inside writeText,
    // before writeText finishes stashing lastRuntimeSetText with the
    // actual DOM textContent. Defer to a microtask so the stash lands
    // first — guarantees source='runtime' classification works for
    // runtime-driven writes regardless of DOM normalisation.
    queueMicrotask(() => {
      const target = currentTarget;
      if (!target) return;
      const text = walkPlainText(target).text;
      runtimeNotify(text);
    });
  });

  // Cursor-only moves (mouse click, arrow keys without typing) — fire
  // selectionchange. Drives cursor-navigate auto-highlight when on.
  document.addEventListener('selectionchange', () => {
    const target = currentTarget;
    if (!target) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!target.contains(range.startContainer)) return;
    const cursor = plainOffsetOfPosition(target, range.startContainer, range.startOffset);
    const text = walkPlainText(target).text;
    runtimeNotifyCursor(text, cursor);
  });

  // React to popup saves. The runtime's ConfigLoader hot-reloads from
  // chrome.storage on its own; we just need to re-publish the target
  // in case the targetSelector changed, and re-apply the dim/italic
  // CSS vars so colour-tuning tweaks land without needing a refocus.
  onConfigChange((newConfig) => {
    if (newConfig.targetSelector !== config.targetSelector) {
      currentTarget = null;
      publishTarget(null);
      clearRuntimeHighlights();
      clearStatusbar();
      // attachToFocused will fire again on next focusin.
    }
    config.dimMix = newConfig.dimMix;
    if (currentTarget) applyDerivedColours(currentTarget, config.dimMix);
  });
}

// Forward declared — defined as the bootstrap re-export to avoid
// circular import at module load. The runtime owns text-change
// dispatch but we only need to call it once per actual change.
import { notifyOpenCuesTextChange, notifyOpenCuesCursorChange, noteUserUnderscoreInsertion } from './opencues-bootstrap';
function runtimeNotify(text: string): void {
  notifyOpenCuesTextChange(text, 0, 'user');
}
function runtimeNotifyCursor(text: string, cursor: number): void {
  notifyOpenCuesCursorChange(text, cursor, 'user');
}

init();
