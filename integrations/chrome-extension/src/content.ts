// Content script entry point — Phase CE.9.
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
} from './opencues-bootstrap';
import { clearStatusbar } from './runtime-statusbar';

function isTextInput(el: HTMLElement): boolean {
  return el.isContentEditable;
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
    console.log('[OpenCues] Attaching to', el.tagName, el.id || el.className || '');
    currentTarget = el;
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

  // Forward 'input' events from the focused target to the runtime.
  // Runtime modules (DimRender, BlankFill, Resolver) subscribe to
  // onTextChange. Use a single document listener to avoid per-attach
  // wiring.
  document.addEventListener('input', () => {
    // execCommand fires the input event synchronously inside writeText,
    // before writeText finishes stashing lastRuntimeSetText with the
    // actual DOM textContent. Defer to a microtask so the stash lands
    // first — guarantees source='runtime' classification works for
    // runtime-driven writes regardless of DOM normalisation.
    queueMicrotask(() => {
      const target = currentTarget;
      if (!target) return;
      const text = target.textContent ?? '';
      runtimeNotify(text);
    });
  });

  // React to popup saves. The runtime's ConfigLoader hot-reloads from
  // chrome.storage on its own; we just need to re-publish the target
  // in case the targetSelector changed.
  onConfigChange((newConfig) => {
    if (newConfig.targetSelector !== config.targetSelector) {
      currentTarget = null;
      publishTarget(null);
      clearRuntimeHighlights();
      clearStatusbar();
      // attachToFocused will fire again on next focusin.
    }
  });
}

// Forward declared — defined as the bootstrap re-export to avoid
// circular import at module load. The runtime owns text-change
// dispatch but we only need to call it once per actual change.
import { notifyOpenCuesTextChange } from './opencues-bootstrap';
function runtimeNotify(text: string): void {
  notifyOpenCuesTextChange(text, 0, 'user');
}

init();
