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
  isNormalInput,
  readTargetText,
  updateRuntimeApiKeys,
  updateRuntimeLlmConfig,
  notifyBufferReplacedExternally,
  notifyExternalReplaceUndo,
  cacheValidCursor,
} from './opencues-bootstrap';
import { clearStatusbar, setStatusbarPosition } from './runtime-statusbar';
import { deriveOpenCuesColours } from './derive-colours';
import { walkPlainText, plainOffsetOfPosition } from './dom-walk';
import {
  resolveFocusedFromEvent as _resolveFromEvent,
  resolveFocusedElement as _resolveFromState,
} from './shadow-focus';

function isTextInput(el: HTMLElement): boolean {
  return el.isContentEditable || isNormalInput(el);
}

// Local wrappers — inject the isTextInput predicate into the shared
// shadow-piercing helpers. Lets the shadow-focus module stay
// chrome-host-agnostic + unit-testable.
function resolveFocusedFromEvent(e: Event): HTMLElement | null {
  return _resolveFromEvent(e, isTextInput);
}
function resolveFocusedElement(start: Element | null): HTMLElement | null {
  return _resolveFromState(start, isTextInput);
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

// Captured at boot so the module-scope helpers below can read the
// live opencuesState (cycled via `opencues settings _`).
let _bootResult: ReturnType<typeof startOpenCues> | null = null;
let currentTarget: HTMLElement | null = null;

// Resolve the live dim-mix: runtime OPENCUES.md scalar (cycled via
// `opencues settings _`) wins, fall back to the legacy popup-saved
// config.dimMix for back-compat with older saved configs.
function resolveLiveDimMix(fallback: number): number {
  const raw = _bootResult?.getSetting?.('dim-mix');
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) return parsed / 100;
  }
  return fallback;
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
  log.info('[opencues] content script loaded');
  const config = await loadConfig();
  setStatusbarPosition(config.statusbarPosition ?? 'bottom');

  // Boot the runtime with config from chrome.storage. The runtime
  // owns Navigation, Cycling, BlankFill, Resolver, Statusline, TTS,
  // CursorStateExport, plus all 6 state classes.
  //
  // `llmApiKeys` is the multi-provider bag the resolver actually
  // dispatches against. Without forwarding it, switching
  // `llm-provider:` to anything but groq in CUES.md silently no-op'd
  // on chrome — the resolver would look up the chosen provider's
  // env-key, not find it, and return null without any visible error.
  // When deferToChromeHost is ON, the popup's Provider/Model/API URL
  // fields are NOT forwarded as runtime overrides — OPENCUES.md scalars
  // (pushed by chrome-host from ~/.cues/) become authoritative, matching
  // CC/OC/gemini-cli behaviour. Keys still flow through; only the
  // provider/model/endpoint dispatch trio is deferred. saveConfig
  // continues to persist the field values, so toggling OFF later
  // restores the user's previously-picked combo.
  const deferred = !!config.deferToChromeHost;
  _bootResult = startOpenCues({
    llmApiKey: config.apiKey,
    llmApiKeys: config.llmApiKeys,
    llmEndpoint: deferred ? '' : config.apiUrl,
    llmDefaultModel: deferred ? '' : config.model,
    llmProvider: deferred ? '' : config.provider,
    // Finnhub key is no longer a dedicated field — the chrome
    // bootstrap reads it from `llmApiKeys.FINNHUB_API_KEY` (pushed by
    // chrome-host's env). When the host isn't connected, the key
    // isn't present and StocksBlank silently skips. Matches the
    // shell-env model used by native hosts.
  });

  const attachToFocused = (el: HTMLElement): void => {
    if (el === currentTarget) return;
    if (config.targetSelector && config.targetSelector !== '[contenteditable="true"]') {
      if (!el.matches(config.targetSelector)) return;
    }
    if (!isTextInput(el)) return;
    const normalInput = isNormalInput(el);
    log.info(
      normalInput ? '[OpenCues][normal-input] Attaching to' : '[OpenCues] Attaching to',
      el.tagName, el.id || el.className || '',
    );
    // Strip derived colour vars from any previous CE target before tagging
    // the new one, so the page is free of stale OpenCues styling if
    // focus moved between contenteditables without going through focusout.
    // (Normal-input targets never had colours applied, so nothing to clear.)
    if (currentTarget && !isNormalInput(currentTarget)) clearDerivedColours(currentTarget);
    currentTarget = el;
    // Derive --oc-active / --oc-dim from the host's own computed text +
    // background colour. The active highlight ends up matching the
    // contenteditable's own text colour, so reconciliation gaps don't
    // flash. See derive-colours.ts and content.css.
    //
    // Normal `<input>` / `<textarea>` don't render CSS Custom Highlights,
    // so we skip the colour derivation + style injection entirely.
    if (!normalInput) applyDerivedColours(el, resolveLiveDimMix(config.dimMix));
    publishTarget(el);
  };

  // Snapshot the current cursor into opencues-bootstrap's last-valid-cursor
  // cache from any event whose handler can guarantee the browser selection
  // reflects the user's perceived cursor. The cache is the only reliable
  // cursor source on LinkedIn's Quill share composer, where the editor's
  // Selection module regularly parks the browser selection outside
  // `.ql-editor` between events — leaving `readCursorOffset` to return 0
  // at agent-rewrite tick time without it. See `cacheValidCursor`
  // discussion in opencues-bootstrap.ts.
  const captureCursorIntoCache = (): void => {
    const target = currentTarget;
    if (!target) return;
    if (isNormalInput(target)) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!target.contains(range.startContainer)) return;
    const cursor = plainOffsetOfPosition(target, range.startContainer, range.startOffset);
    cacheValidCursor(target, cursor);
  };

  document.addEventListener('focusin', (e) => {
    const el = resolveFocusedFromEvent(e);
    if (el) attachToFocused(el);
    // Wipe any pending trust-gate credits. A `_` keypress in a
    // different field (e.g. an iframe OpenCues isn't attached to)
    // would otherwise leave credits that fund an injection here.
    // The CREDIT_TTL_MS already limits stale-credit windows, but
    // focus reset is a stronger guarantee for cross-field flows.
    resetTrustGateCredits();
  });

  // Mirror OpenCode's per-component lifecycle by clearing the runtime
  // target when focus moves away from a contenteditable. Without this,
  // currentTarget stays stale and runtime modules read from a detached
  // or backgrounded element. relatedTarget being null OR a non-text
  // input both count as "left the editor".
  document.addEventListener('focusout', (e) => {
    const evt = e as FocusEvent;
    // relatedTarget can be retargeted to a shadow host the same way
    // focusin's target is — resolve before testing isTextInput.
    const next = resolveFocusedElement(evt.relatedTarget as Element | null);
    if (!next || !isTextInput(next)) {
      if (currentTarget) {
        if (!isNormalInput(currentTarget)) clearDerivedColours(currentTarget);
        currentTarget = null;
        publishTarget(null);
        clearRuntimeHighlights();
        clearStatusbar();
      }
      // Wipe credits on real focus-out too. Same rationale as
      // focusin: any unconsumed credits earned in this field are no
      // longer relevant once focus has left.
      resetTrustGateCredits();
    }
  });

  const initialActive = resolveFocusedElement(document.activeElement);
  if (initialActive) attachToFocused(initialActive);

  // Re-derive colours when the user toggles OS dark/light mode — host
  // pages that respect prefers-color-scheme will have flipped their
  // computed text + background colours, and our highlights need to
  // follow or they'll be inverted.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (currentTarget && !isNormalInput(currentTarget)) applyDerivedColours(currentTarget, resolveLiveDimMix(config.dimMix));
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

  // ─── Buffer-replacing input events: undo / redo / paste / IME commit ──
  // The post-mutation text reflects content the runtime didn't author,
  // so every span / DynDef / dim range the runtime tracks is anchored
  // to a character offset that no longer corresponds to the buffer the
  // user is now editing. Without a wipe, the next cycle splices on
  // stale offsets, the next dim repaints a phantom span, or the next
  // blank fill is silently blocked by a leftover `blankName` entry.
  //
  // `beforeinput` fires BEFORE the DOM mutates and carries `inputType`,
  // which lets us key off the precise trigger instead of guessing from
  // keydown. Browser-issued events from real user actions always have
  // `isTrusted: true`; we drop synthetic dispatches from hostile pages
  // (same security model as the `_`-credit gates above).
  //
  // We DO NOT preventDefault — the browser must still perform the
  // native undo / redo / paste / IME commit. We only reset the runtime's
  // in-memory state so the post-mutation buffer is treated as a fresh
  // edit surface. The Resolver re-runs on the next keystroke debounce.
  //
  // Companion to `publishTarget` (same wipe, focus-change trigger).
  // Per-state-object rationale: docs/architecture/universal-integration.md
  // § "Per-buffer state must reset on focus change".
  document.addEventListener('beforeinput', (e) => {
    if (!e.isTrusted) return;
    // Seed the last-valid-cursor cache (opencues-bootstrap) BEFORE the
    // editor processes input. At `beforeinput` time, `window.getSelection()`
    // is guaranteed to reflect where the user's input will land — that's
    // the user's perceived cursor. This is the most reliable signal we
    // have: LinkedIn's Quill regularly parks the browser selection
    // outside `.ql-editor` between events, so neither `selectionchange`
    // nor a polled `readCursorOffset` at agent-rewrite tick time can
    // recover the user's actual cursor. Snapshotting it here means the
    // cache holds the last-keystroke position by the time the agent's
    // debounce fires ~1500ms later. Same path also fires on real paste
    // / IME commit, which is correct — those are intentional user edits
    // that land at the cursor too.
    captureCursorIntoCache();
    const t = (e as InputEvent).inputType;
    // Undo/redo additionally open a brief window during which input
    // events get reclassified to 'runtime' — a restored `_` from a
    // Ctrl+Z must not re-trigger blank fill. Paste and IME commit are
    // intentional user edits; they stay 'user' and go through the
    // trust gate normally.
    if (t === 'historyUndo' || t === 'historyRedo') {
      notifyExternalReplaceUndo();
    } else if (t === 'insertFromPaste' || t === 'insertCompositionText') {
      notifyBufferReplacedExternally();
    }
  }, true);

  // Same snapshot at keyup — covers arrow keys / Home / End / PgUp / PgDn
  // that move the cursor without firing beforeinput. Synchronous capture
  // (no microtask defer) so Quill's selectionchange-driven internal
  // reshuffle doesn't run first.
  document.addEventListener('keyup', () => {
    captureCursorIntoCache();
  }, true);

  // Same snapshot at mouseup — covers click-to-position-cursor on Quill,
  // which also doesn't fire beforeinput. The user just placed the caret
  // where they want it; the browser selection is at that position right
  // now.
  document.addEventListener('mouseup', () => {
    captureCursorIntoCache();
  }, true);

  // Managed editors (Lexical, ProseMirror, Draft.js) bind ctrl/cmd+z and
  // ctrl/cmd+y to their OWN keymap and run history internally — they
  // fire `input` after the model rewinds but the InputEvent's
  // `inputType` is the substituted-text type, not `historyUndo`. So the
  // `beforeinput` filter above misses them, and our per-buffer state
  // (DynDefs / spans / dim ranges) stays bound to offsets that no
  // longer correspond to the live text.
  //
  // Catch the keydown directly as a fallback. We DO NOT preventDefault
  // — the editor still owns the actual undo/redo; we just wipe runtime
  // state in parallel. `isTrusted` filters out synthetic dispatches.
  // Capture phase so editors that stopPropagation in bubble don't
  // swallow it.
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    const cmdOrCtrl = e.metaKey || e.ctrlKey;
    if (!cmdOrCtrl) return;
    const k = e.key.toLowerCase();
    // ctrl+z = undo; ctrl+y or ctrl+shift+z = redo (cross-platform).
    if (k === 'z' || k === 'y') {
      notifyExternalReplaceUndo();
    }
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
      let target = currentTarget;
      // Lazy re-attach for focus-trap modals (LinkedIn share composer,
      // any Ember/Lit dialog that auto-focuses its editor on open):
      // focus is delivered programmatically before our content script
      // loads OR via a path that bypasses document-level focusin (focus
      // traps sometimes restore focus internally without re-dispatching).
      // Result: input event arrives with `currentTarget=null` and the
      // first `_` keystroke silently drops.
      //
      // Defence: walk `document.activeElement` (shadow-piercing-aware)
      // and attach if it IS a text-input. attachToFocused is idempotent
      // (returns early when el===currentTarget) so on the steady-state
      // path this is a single null-check.
      if (!target) {
        const live = resolveFocusedElement(document.activeElement);
        if (live) {
          attachToFocused(live);
          target = currentTarget;
        }
      }
      if (!target) return;
      // readTargetText branches: `.value` for normal inputs, walk for CE.
      // The runtime re-reads cursor via its own getCursorOffset hook,
      // which is likewise branched in opencues-bootstrap — selectionStart
      // for inputs, plain-offset walk for CE.
      const text = readTargetText(target);
      // Per-keystroke trace was useful during normal-input bring-up
      // (May 2026) but is pure noise now that the path is stable —
      // every keystroke logs even when no `_` is present. Kept
      // commented so future debugging can flip it back on without
      // re-deriving the right fields. Real failures show up via the
      // runtime's own bailed/completed event stream.
      // if (isNormalInput(target)) {
      //   log.info('[opencues][normal-input] text-change: len=' + text.length +
      //     ', hasUnderscore=' + text.includes('_') +
      //     ', cursor=' + (target.selectionStart ?? 0));
      // }
      runtimeNotify(text);
    });
  }, true);  // CAPTURE phase — managed editors (Lexical, Quill) may stopPropagation
             // on input events in bubble; without capture we never see them.

  // Cursor-only moves (mouse click, arrow keys without typing) — fire
  // selectionchange. Drives cursor-navigate auto-highlight when on, AND
  // seeds opencues-bootstrap's last-valid-cursor cache (LinkedIn Quill's
  // Selection module doesn't reliably propagate to `window.getSelection()`
  // between events, so the cached value becomes the only reliable source
  // by the time `readCursorOffset` is polled at agent-rewrite tick time).
  document.addEventListener('selectionchange', () => {
    const target = currentTarget;
    if (!target) return;
    // Normal-input mode has no auto-highlight surface, so cursor-only
    // moves don't need to round-trip. The 'input' handler above is
    // enough for typing.
    if (isNormalInput(target)) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!target.contains(range.startContainer)) return;
    const cursor = plainOffsetOfPosition(target, range.startContainer, range.startOffset);
    cacheValidCursor(target, cursor);
    const text = walkPlainText(target).text;
    runtimeNotifyCursor(text, cursor);
  });

  // React to popup saves. The runtime's ConfigLoader hot-reloads from
  // chrome.storage on its own; we just need to re-publish the target
  // in case the targetSelector changed, and re-apply the dim/italic
  // CSS vars so colour-tuning tweaks land without needing a refocus.
  // Track the last-seen apiKey fingerprint so we only push updates
  // into the runtime when the set actually changed (avoids spurious
  // rebuilds on every popup-save).
  let lastApiKeysFingerprint = Object.keys(config.llmApiKeys ?? {}).sort().join(',');
  // Per-field snapshot for the LLM dispatch trio. When
  // deferToChromeHost is ON these are passed as empty strings (the
  // runtime then reads OPENCUES.md). The deferred flag is part of
  // the comparison so flipping the toggle ALSO triggers a runtime
  // update — same write at popup save time, no hard-refresh needed.
  const llmFp = (cfg: typeof config): string => {
    const deferred = !!cfg.deferToChromeHost;
    return [
      deferred ? '' : (cfg.provider ?? ''),
      deferred ? '' : (cfg.model ?? ''),
      deferred ? '' : (cfg.apiUrl ?? ''),
    ].join('|');
  };
  let lastLlmFingerprint = llmFp(config);

  onConfigChange((newConfig) => {
    if (newConfig.targetSelector !== config.targetSelector) {
      currentTarget = null;
      publishTarget(null);
      clearRuntimeHighlights();
      clearStatusbar();
      // attachToFocused will fire again on next focusin.
    }
    config.dimMix = newConfig.dimMix;
    if (currentTarget && !isNormalInput(currentTarget)) applyDerivedColours(currentTarget, resolveLiveDimMix(config.dimMix));

    if (newConfig.statusbarPosition !== config.statusbarPosition) {
      config.statusbarPosition = newConfig.statusbarPosition;
      setStatusbarPosition(newConfig.statusbarPosition ?? 'bottom');
    }

    // Real-time key updates — call into the runtime when the API-key
    // set changed. Fingerprint = sorted env-var names (no values,
    // never want secrets in any log). When unchanged (e.g. popup
    // saved a non-key field like dimMix), skip the runtime call.
    const fp = Object.keys(newConfig.llmApiKeys ?? {}).sort().join(',');
    if (fp !== lastApiKeysFingerprint) {
      log.info('[opencues] apiKeys delta — propagating to runtime (envs: ' + (fp || '<empty>') + ')');
      updateRuntimeApiKeys(newConfig.llmApiKeys ?? {});
      lastApiKeysFingerprint = fp;
      config.llmApiKeys = newConfig.llmApiKeys;
    }

    // Real-time provider/model/endpoint updates — popup save flips
    // any of these (or toggles deferToChromeHost) → resolver rebuild.
    // Avoids the previous hard-refresh requirement after switching
    // provider in the popup.
    const newLlmFp = llmFp(newConfig);
    if (newLlmFp !== lastLlmFingerprint) {
      const deferred = !!newConfig.deferToChromeHost;
      log.info('[opencues] llmConfig delta — propagating to runtime', {
        provider: deferred ? '(deferred to OPENCUES.md)' : newConfig.provider,
        model: deferred ? '(deferred)' : newConfig.model,
        apiUrl: deferred ? '(deferred)' : newConfig.apiUrl,
      });
      updateRuntimeLlmConfig({
        provider: deferred ? '' : (newConfig.provider ?? ''),
        model: deferred ? '' : (newConfig.model ?? ''),
        endpoint: deferred ? '' : (newConfig.apiUrl ?? ''),
      });
      lastLlmFingerprint = newLlmFp;
      config.provider = newConfig.provider;
      config.model = newConfig.model;
      config.apiUrl = newConfig.apiUrl;
      config.deferToChromeHost = newConfig.deferToChromeHost;
    }
  });
}

// Forward declared — defined as the bootstrap re-export to avoid
// circular import at module load. The runtime owns text-change
// dispatch but we only need to call it once per actual change.
import { notifyOpenCuesTextChange, notifyOpenCuesCursorChange, noteUserUnderscoreInsertion, resetTrustGateCredits } from './opencues-bootstrap';
function runtimeNotify(text: string): void {
  notifyOpenCuesTextChange(text, 0, 'user');
}
function runtimeNotifyCursor(text: string, cursor: number): void {
  notifyOpenCuesCursorChange(text, cursor, 'user');
}

init();

// Diagnostic ping handler — popup's "Run Self-Check" button sends
// { type: 'opencues:diagnostic-ping' } and expects a state snapshot
// back. Lets the user verify "is the content script actually running
// on this tab?" without opening devtools.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'opencues:diagnostic-ping') return;
  // Shadow-piercing: Self-Check on shadow-DOM sites (Reddit's
  // <shreddit-composer>, etc.) would otherwise report the wrapper custom
  // element instead of the real focused contenteditable.
  const activeEl = resolveFocusedElement(document.activeElement);
  const isCE = !!activeEl && activeEl.isContentEditable === true;
  const isNI = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
  const activeAttachable = activeEl ? isTextInput(activeEl) : false;
  const attached = !!currentTarget;
  const activeKind = isCE ? 'contenteditable' : isNI ? `<${activeEl!.tagName.toLowerCase()}>` : null;
  const attachedKind = currentTarget
    ? (isNormalInput(currentTarget) ? `<${currentTarget.tagName.toLowerCase()}>` : 'contenteditable')
    : null;

  // Echo back the FIRST 8 + LAST 4 chars of each LLM key the LIVE
  // runtime currently has loaded — by re-running loadConfig() so we
  // see what the runtime would see RIGHT NOW (popup's last save +
  // any host_keys push). Full keys never leave the content script
  // (truncation prevents the popup screenshot from leaking the secret).
  void loadConfig().then(liveConfig => {
    const runtimeKeys: Record<string, string> = {};
    for (const [name, value] of Object.entries(liveConfig.llmApiKeys ?? {})) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (value.length <= 12) {
        runtimeKeys[name] = `${value.length} chars (too short to fingerprint safely)`;
      } else {
        runtimeKeys[name] = `${value.slice(0, 8)}…${value.slice(-4)} (${value.length} chars)`;
      }
    }
    sendResponse({
      bootVersion: chrome.runtime.getManifest().version,
      href: location.href.slice(0, 120),
      currentTarget: activeKind,
      attachedTarget: attachedKind,
      targetAttachable: activeAttachable,
      attachStatus: attached
        ? `attached to ${attachedKind}`
        : activeKind
          ? `${activeKind} focused but OpenCues did not attach (unsupported or sensitive field)`
          : '(none focused)',
      trustGateInstalled: (window as unknown as { __opencuesTrustGateInstalled?: true }).__opencuesTrustGateInstalled === true,
      runtimeKeys,
      // The actual provider/model the runtime would use NOW. Picks up
      // the popup's overrides AND any OPENCUES.md scalar. Lets the
      // Self-Check show "popup picked X but runtime is on Y" mismatches.
      runtimeProvider: liveConfig.provider || '(auto-routing — no popup override)',
      runtimeModel: liveConfig.model || '(provider default)',
    });
  }).catch(() => {
    sendResponse({
      bootVersion: chrome.runtime.getManifest().version,
      runtimeKeys: {},
      error: 'loadConfig threw',
    });
  });
  return true; // async sendResponse — keep channel open
});
