import { CueEngine } from './core/cue-engine';
import { HighlightRenderer } from './ui/highlight-renderer';
import { WordNavigator } from './ui/word-navigator';
import { StatusBar } from './ui/status-bar';
import { loadConfig, onConfigChange } from './adapters/chrome-storage-adapter';
import { getControlKeywords, type ControlKeywordConfig } from './controls';
import type { StoredConfig } from './types';

/**
 * Content script entry point.
 * Finds the target element, bootstraps OpenCues components, manages lifecycle.
 *
 * Analysis trigger cascade (ported from dynamicHighlight.ts):
 *   Tier 1: Space typed → 50ms debounce → analyze completed word
 *   Tier 2: Idle → 300ms debounce → analyze last word
 *   Tier 3: Word edited → 50ms debounce → re-analyze changed word
 */

let engine: CueEngine | null = null;
let renderer: HighlightRenderer | null = null;
let nav: WordNavigator | null = null;
let statusBar: StatusBar | null = null;
let domObserver: MutationObserver | null = null;
let bodyObserver: MutationObserver | null = null;
let abortController: AbortController | null = null;

// Debounce timers (matching dynamicHighlight.ts cascade)
let spaceTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let blankTimer: ReturnType<typeof setTimeout> | null = null;
let checkBlanksInFlight = false;
let lastInputText = '';

function teardown(): void {
  // Abort all event listeners registered with the AbortController
  abortController?.abort();
  abortController = null;
  nav?.destroy();
  renderer?.destroy();
  statusBar?.destroy();
  domObserver?.disconnect();
  bodyObserver?.disconnect();
  engine?.clear();
  if (spaceTimer) clearTimeout(spaceTimer);
  if (idleTimer) clearTimeout(idleTimer);
  if (blankTimer) clearTimeout(blankTimer);
  checkBlanksInFlight = false;
  nav = null;
  renderer = null;
  statusBar = null;
  domObserver = null;
  bodyObserver = null;
  engine = null;
}

function bootstrap(target: HTMLElement, config: StoredConfig): void {
  teardown();

  abortController = new AbortController();
  const { signal } = abortController;

  engine = new CueEngine();
  engine.configure(config);

  renderer = new HighlightRenderer(target);
  nav = new WordNavigator(target, engine, config.ttsRate);
  statusBar = new StatusBar();

  // Synchronous render callback — called by navigator right after text change
  // to rebuild highlights before the browser paints (prevents white flash)
  nav.onRender = () => {
    const state = nav!.getState();
    renderer!.render('', state, engine!.words, engine!.spans);
    updateStatus(state);
  };

  // Wire: engine updates → re-render highlights + status
  // CSS Custom Highlight API doesn't modify DOM — safe to render during typing
  engine.onUpdate(() => {
    const state = nav!.getState();
    renderer!.render(lastInputText, state, engine!.words, engine!.spans);
    updateStatus(state);
  });

  // Wire: navigation state changes → re-render + status
  nav.onChange((state, newText) => {
    if (newText) lastInputText = newText;
    renderer!.render(lastInputText, state, engine!.words, engine!.spans);
    updateStatus(state);
  });

  // Three-tier analysis trigger on input
  target.addEventListener('input', () => {
    // Skip analysis during cycling — text change is from cycling, not user typing
    if (nav?.cycling) return;

    let text = getText(target);

    // Execute pending blankClearOnEdit removal (unconditional — outside highlight guard)
    if (engine?.pendingClearOnEdit) {
      const cleaned = engine.executeClearOnEdit(text);
      if (cleaned) {
        replaceTargetText(target, cleaned);
        text = cleaned;
      }
    }

    const curWords = text.split(/\s+/).filter(w => w);
    const prevWords = lastInputText.split(/\s+/).filter(w => w);
    lastInputText = text;

    // Instant tips lookup — synchronous, no debounce
    engine?.lookupTipsSync(text);

    // Clear existing timers
    if (spaceTimer) { clearTimeout(spaceTimer); spaceTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    // Tier 1: Space typed (word count increased) — 50ms debounce
    let tieredHit = false;
    if (curWords.length > prevWords.length) {
      tieredHit = true;
      spaceTimer = setTimeout(() => {
        const now = getText(target);
        if (now === text) engine?.analyze(text);
      }, 50);
    }

    // Tier 3: Word edited mid-text — 50ms debounce
    if (!tieredHit && curWords.length === prevWords.length && curWords.length > 0) {
      for (let i = 0; i < curWords.length; i++) {
        if (curWords[i] !== prevWords[i]) {
          tieredHit = true;
          spaceTimer = setTimeout(() => {
            const now = getText(target);
            if (now === text) engine?.analyze(text);
          }, 50);
          break;
        }
      }
    }

    // Tier 2: Idle pause — 300ms, only if tier 1/3 didn't already fire
    if (!tieredHit && curWords.length > 0) {
      idleTimer = setTimeout(() => {
        const now = getText(target);
        if (now.length > 0) engine?.analyze(now);
      }, 300);
    }
  }, { signal });

  // MutationObserver for external text changes (framework updates)
  domObserver = new MutationObserver(() => {
    if (nav?.cycling) return; // DOM change from cycling, not external
    const text = getText(target);
    if (text !== lastInputText) {
      lastInputText = text;
      nav?.clear();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => engine?.analyze(text), 300);
    }
  });
  domObserver.observe(target, { childList: true, characterData: true, subtree: true });

  // Blank auto-populate with keyword expansion, clearing, and consume-all support.
  // Ported from wordHighlight.ts lines 695-817.
  const controlKeywords = getControlKeywords();

  const checkBlanks = async () => {
    if (!engine || checkBlanksInFlight) return;
    checkBlanksInFlight = true;
    try {
    let text = getText(target);
    const words = text.split(/\s+/).filter(w => w);
    const blankIdx = words.indexOf('_');
    if (blankIdx < 0) return;
    if (engine.dismissedBlanks.has(blankIdx)) return;

    // Match blank to a control by checking keywords in proximity
    const matched = matchControlKeyword(words, blankIdx, controlKeywords);
    if (!matched) return;

    const { config: kwConfig, matchedKeyword, keywordIndices } = matched;
    const context = words.filter((_, idx) => idx !== blankIdx);

    // Fetch value from control
    const value = await engine.controlGet(kwConfig.controlName, matchedKeyword, context);
    if (!value || value.length === 0) return;

    // --- Keyword expansion: replace shorthand with display name ---
    let workText = text;
    let workWords = [...words];
    let adjustedBlankIdx = blankIdx;

    if (kwConfig.expansions[matchedKeyword.toLowerCase()]) {
      const expansion = kwConfig.expansions[matchedKeyword.toLowerCase()];
      // Find the keyword word index and replace in text
      for (const kwIdx of keywordIndices) {
        if (workWords[kwIdx]?.toLowerCase() === matchedKeyword.toLowerCase()) {
          let pos = 0;
          for (let j = 0; j < kwIdx; j++) { pos = workText.indexOf(workWords[j], pos) + workWords[j].length; }
          const kwStart = workText.indexOf(workWords[kwIdx], pos);
          if (kwStart >= 0) {
            workText = workText.slice(0, kwStart) + expansion + workText.slice(kwStart + workWords[kwIdx].length);
            workWords[kwIdx] = expansion;
          }
          break; // only expand the first matching keyword word
        }
      }
    }

    // --- Keyword clearing: remove keyword words from text (descending order) ---
    if (kwConfig.clearKeywords && keywordIndices.length > 0) {
      const sortedDesc = [...keywordIndices].sort((a, b) => b - a);
      for (const kwIdx of sortedDesc) {
        if (kwIdx === adjustedBlankIdx) continue; // don't remove the blank itself
        if (kwIdx >= workWords.length) continue;

        let pos = 0;
        for (let j = 0; j < kwIdx; j++) { pos = workText.indexOf(workWords[j], pos) + workWords[j].length; }
        let wStart = workText.indexOf(workWords[kwIdx], pos);
        let wEnd = wStart + workWords[kwIdx].length;
        // Remove adjacent whitespace
        if (wEnd < workText.length && workText[wEnd] === ' ') wEnd++;
        else if (wStart > 0 && workText[wStart - 1] === ' ') wStart--;

        workText = workText.slice(0, wStart) + workText.slice(wEnd);
        workWords.splice(kwIdx, 1);
        // Shift blank index if keyword was before it
        if (kwIdx < adjustedBlankIdx) adjustedBlankIdx--;
      }
    }

    // --- Replace _ with value ---
    let pos = 0;
    for (let j = 0; j < adjustedBlankIdx; j++) {
      pos = workText.indexOf(workWords[j], pos) + workWords[j].length;
    }
    const uStart = workText.indexOf('_', pos);
    if (uStart < 0) return;

    let newText: string;

    if (kwConfig.consumeAll) {
      // Consume-all: replace entire text with value, populate consumeAllAlts
      const alts = value.split('\n').filter(l => l.trim());
      if (alts.length === 0) return;
      newText = alts[0]; // display first alternative

      const wc = alts[0].split(/\s+/).filter(w => w).length;

      engine.consumeAllAlts = {
        index: 0,
        alts,
        currentAltIndex: 0,
        spanLength: wc,
        cueTip: kwConfig.controlName,
        controlName: kwConfig.controlName,
      };

      // Set up spans for multi-word first alt
      if (wc > 1) {
        for (let i = 0; i < wc; i++) {
          engine.spans[i] = { originalIndex: 0, spanLength: wc };
        }
      }

      // Create WordDef so renderer dims the span and per-word invalidation protects it.
      // def.word = current alt text (first in alts) so invalidation finds it and keeps the def.
      // WordDef for renderer dimming + per-word invalidation + LLM protection.
      // controlName protects from LLM overwrite; cycling routed via consumeAllAlts in navigator.
      const caDef = {
        index: 0,
        word: alts[0],
        alts,
        cueTip: kwConfig.tip || kwConfig.controlName,
        currentAltIndex: 0,
        source: 'control' as const,
        metadata: { controlName: kwConfig.controlName, consumeAll: true },
        ...(wc > 1 && { spanLength: wc }),
      };
      engine.words = [caDef as any];
    } else {
      // Multi-line values are list alts (e.g. hackernews headlines): display first, cycle rest
      const lines = value.split('\n').filter(l => l.trim());
      const displayValue = lines[0] || value;

      newText = workText.slice(0, uStart) + displayValue + workText.slice(uStart + 1);

      // Set up span + WordDef for multi-word blank result
      const valueWc = displayValue.split(/\s+/).filter(w => w).length;
      if (valueWc >= 1) {
        const blankAlts = lines.length > 1
          ? [...lines, ...(kwConfig.dismissible ? ['_'] : [])]
          : (kwConfig.dismissible ? [displayValue, '_'] : [displayValue]);
        const blankWordDef = {
          index: adjustedBlankIdx,
          word: displayValue,
          alts: blankAlts,
          cueTip: kwConfig.tip || kwConfig.controlName,
          currentAltIndex: 0,
          source: 'control' as const,
          metadata: {
            controlName: kwConfig.controlName,
            blankReadOnly: kwConfig.readOnly,
            ...(kwConfig.dismissible && { listControl: true, blankDismissible: true }),
          },
        };
        if (valueWc > 1) {
          (blankWordDef as any).spanLength = valueWc;
          for (let i = 0; i < valueWc; i++) {
            engine.spans[adjustedBlankIdx + i] = { originalIndex: adjustedBlankIdx, spanLength: valueWc };
          }
        }
        // Remove stale defs at ALL span-covered positions (not just origin)
        // Prevents grammar alts from a pre-fill LLM call from persisting at span positions
        const spanEnd = adjustedBlankIdx + valueWc;
        engine.words = engine.words.filter(w => w.index < adjustedBlankIdx || w.index >= spanEnd);
        engine.words.push(blankWordDef as any);
      }
    }

    // Invalidate any in-flight LLM call and update lastAnalyzed BEFORE DOM change
    // Prevents stale LLM callback from overwriting lastAnalyzed and triggering re-analysis
    engine.invalidateAnalysis(newText.split(/\s+/).filter(w => w));

    // Apply to DOM
    replaceTargetText(target, newText);
    lastInputText = newText;

    // Remove any stale def (LLM, tips, or old control) at the word immediately before the fill.
    // Skip for consume-all — entire text was replaced, no context word to clear.
    if (!kwConfig.consumeAll && kwConfig.clearKeywords && adjustedBlankIdx > 0) {
      const ctxIdx = adjustedBlankIdx - 1;
      engine.words = engine.words.filter(d => d.index !== ctxIdx);
      delete engine.spans[ctxIdx];
    }

    // Render with updated defs — no auto-activation (matches Claude Code behavior).
    // Deferred to rAF: execCommand DOM changes need a frame to settle before
    // CSS Custom Highlight ranges stick reliably.
    if (renderer && nav) {
      renderer.clearStyles(); // prevent flash of stale highlights
      requestAnimationFrame(() => {
        if (renderer && nav && engine) {
          renderer.render(lastInputText, nav.getState(), engine.words, engine.spans);
          updateStatus(nav.getState());
        }
      });
    }
    } finally { checkBlanksInFlight = false; }
  };

  // Check for blanks on input with a longer debounce (500ms — wait for user to finish typing keyword)
  target.addEventListener('input', () => {
    if (nav?.cycling) return;
    if (blankTimer) clearTimeout(blankTimer);
    blankTimer = setTimeout(checkBlanks, 500);
  }, { signal });

  // Initial analysis
  lastInputText = getText(target);
  if (lastInputText) engine.analyze(lastInputText);
}

function updateStatus(state: { active: boolean; wordIndex: number | null }): void {
  if (!statusBar || !engine) return;
  const def = state.wordIndex != null ? engine.getWordDef(state.wordIndex) : undefined;
  statusBar.update(state as any, def);
}

function getText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return el.textContent || '';
}

/** Replace target element text */
function replaceTargetText(target: HTMLElement, newText: string): void {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    target.value = newText;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, newText);
}

/**
 * Match a blank (_) to a control by searching for keywords in proximity.
 * Multi-word keywords: proximity is measured from the LAST word of the phrase
 * to the blank (matching cues-core control-blank-source.ts behavior).
 * When multiple keywords match, the closest one wins.
 * Returns the matched config, keyword text, and keyword word indices.
 */
function matchControlKeyword(
  words: string[],
  blankIdx: number,
  configs: ControlKeywordConfig[],
): { config: ControlKeywordConfig; matchedKeyword: string; keywordIndices: number[] } | null {
  let best: { config: ControlKeywordConfig; matchedKeyword: string; keywordIndices: number[]; gap: number } | null = null;

  for (const cfg of configs) {
    for (const kw of cfg.keywords) {
      const kwWords = kw.split(/\s+/);

      if (kwWords.length === 1) {
        for (let i = 0; i < words.length; i++) {
          if (i === blankIdx) continue;
          if (words[i].toLowerCase() !== kw.toLowerCase()) continue;
          const gap = Math.abs(i - blankIdx) - 1;
          if (gap <= cfg.proximity && (best === null || gap < best.gap)) {
            best = { config: cfg, matchedKeyword: words[i], keywordIndices: [i], gap };
          }
        }
      } else {
        for (let i = 0; i <= words.length - kwWords.length; i++) {
          if (i === blankIdx) continue;
          let match = true;
          const indices: number[] = [];
          for (let k = 0; k < kwWords.length; k++) {
            const wi = i + k;
            if (wi === blankIdx || wi >= words.length || words[wi].toLowerCase() !== kwWords[k].toLowerCase()) {
              match = false;
              break;
            }
            indices.push(wi);
          }
          if (match) {
            const endIdx = i + kwWords.length - 1;
            const gap = Math.abs(endIdx - blankIdx) - 1;
            if (gap <= cfg.proximity && (best === null || gap < best.gap)) {
              best = { config: cfg, matchedKeyword: kw, keywordIndices: indices, gap };
            }
          }
        }
      }
    }
  }
  return best ? { config: best.config, matchedKeyword: best.matchedKeyword, keywordIndices: best.keywordIndices } : null;
}

/** Check if an element is a text input we should attach to */
function isTextInput(el: HTMLElement): boolean {
  // Contenteditable divs only — textarea/input not supported yet
  if (el.isContentEditable) return true;
  return false;
}

/** Find and attach to the target element */
async function init(): Promise<void> {
  console.log('[OpenCues] Content script loaded');
  let config = await loadConfig();

  // Attach to whichever text input gets focus
  let currentTarget: HTMLElement | null = null;

  const attachToFocused = (el: HTMLElement) => {
    if (el === currentTarget) return;
    // Don't re-bootstrap if focusing the swapped contenteditable div
    if (renderer && el === renderer.target) return;
    // If targetSelector is set and specific (not the default), only match it
    if (config.targetSelector && config.targetSelector !== '[contenteditable="true"]') {
      if (!el.matches(config.targetSelector)) return;
    }
    if (!isTextInput(el)) return;
    console.log('[OpenCues] Attaching to', el.tagName, el.id || el.className || '');
    currentTarget = el;
    bootstrap(el, config);
  };

  // Listen for focus on any text input
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    if (el) attachToFocused(el);
  });

  // Also check if something already has focus
  if (document.activeElement && document.activeElement instanceof HTMLElement) {
    attachToFocused(document.activeElement);
  }

  // React to config changes (user saves in popup)
  onConfigChange((newConfig) => {
    config = newConfig;
    if (currentTarget) bootstrap(currentTarget, newConfig);
  });
}

init();
