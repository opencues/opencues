// Bootstrap the opencues-runtime in the Chrome content script context.
// This file builds a HostInfo from browser APIs, calls boot(), and
// exposes the BootResult for content.ts to wire into its key/text/render
// plumbing.
//
// What this layer provides:
//   - boot() constructs the runtime: ConfigLoader, Navigation,
//     DimRender, Cycling, BlankFill, etc. all subscribe.
//   - getText/getCursorOffset are closures over a "current target"
//     pointer that content.ts updates via publishTarget().
//   - readFile/writeFile route through chrome.storage.local using
//     the path as the storage key.
//   - log writes to console with [opencues] prefix.
//
// The runtime modules subscribe to onTextChange / onRender / onKey via
// the adapter. content.ts forwards browser events into those subscriptions.

import { boot, type BootResult } from '@opencues/runtime/dist/adapters/chrome/v1/boot';
import type {
  BlankInvokeSpec,
  KeyEvent,
  LogLevel,
  ProcessHandle,
  ProcessResult,
} from '@opencues/runtime/dist/src/adapter';
import { createSourceReclassifier } from '@opencues/runtime/dist/src/boot-common';
import { createBlankInvoke } from '@opencues/runtime/dist/src/blanks';
import { applyDirectives, clearDirectives } from './runtime-renderer';
import { applyStatuslinePayload } from './runtime-statusbar';
import { WebSpeechAdapter } from './adapters/web-speech-adapter';
import { FetchHttpAdapter } from './adapters/fetch-http-adapter';
import { createBlanks, type BrowserBlank } from './blanks';
import { walkPlainText, plainOffsetOfPosition } from './dom-walk';

const STORAGE_PREFIX = 'opencues_runtime:';

// Bake-time defines from esbuild. OPENCUES.md holds runtime settings
// (system-wide YAML); per-cue and per-blank source files live in
// __DEFAULT_WORD_CUES__ and __DEFAULT_BLANKS__ (post-layout-migration).
declare const __DEFAULT_OPENCUES_MD__: string;
declare const __DEFAULT_CUE_FOLDERS__: Record<string, string>;
declare const __DEFAULT_BLANK_FOLDERS__: Record<string, string>;

const ROOT = '/chrome-storage';

// Per-readFile trace logging is OFF by default — at ~20 lines per
// boot it was the loudest thing in DevTools. Gated behind the
// user-facing `debug-mode: on` setting. Flip it via the opencues
// settings blank (`opencues settings _` → cycle debug-mode to `on`)
// or the CLI (`opencues debug on`). Reflects both initial boot state
// and live cycling — chrome.storage.onChanged subscription updates
// the flag without an extension reload.
let _readTrace = false;
function tlog(msg: string): void { if (_readTrace) console.log(msg); }
function parseDebugMode(content: string | null | undefined): boolean {
  return /debug-mode:\s*on\b/i.test(content ?? '');
}
async function refreshReadTraceFromStorage(): Promise<void> {
  try {
    const key = `${STORAGE_PREFIX}${ROOT}/.cues/OPENCUES.md`;
    const result = await chrome.storage.local.get(key);
    const v = typeof result[key] === 'string' && result[key].length > 0
      ? result[key]
      : __DEFAULT_OPENCUES_MD__;
    _readTrace = parseDebugMode(v);
  } catch { _readTrace = false; }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const key = `${STORAGE_PREFIX}${ROOT}/.cues/OPENCUES.md`;
  if (key in changes && typeof changes[key].newValue === 'string') {
    _readTrace = parseDebugMode(changes[key].newValue);
  }
});

let bootResult: BootResult | undefined;
let currentTarget: HTMLElement | null = null;
const speech = new WebSpeechAdapter();

// Source reclassifier — shared helper from boot-common. Stashes the text
// the runtime just wrote so the next 'input' event from the
// contenteditable is reclassified as source='runtime'. Chrome calls
// markRuntimeWrite AFTER the execCommand insertText so the post-DOM
// (potentially whitespace-normalised) text is what gets compared.
const sourceReclassifier = createSourceReclassifier();

/** Called by content.ts when the focused contenteditable changes. */
export function publishTarget(el: HTMLElement | null): void {
  currentTarget = el;
}

/** Editors that own their contenteditable as a fully-managed surface
 *  (their model is the source of truth, DOM is rendered output, and
 *  their MutationObserver REVERTS direct text-node mutations that
 *  span multiple blocks or don't match expected shape). Detected on
 *  the target's ancestry so per-call routing can choose the
 *  editor-API path instead of the generic in-place splice. */
function isManagedEditor(el: HTMLElement): boolean {
  return !!el.closest(
    '[data-lexical-editor="true"], .ProseMirror, [data-slate-editor="true"], .public-DraftEditor-content'
  );
}

function isLexicalEditor(el: HTMLElement): boolean {
  return !!el.closest('[data-lexical-editor="true"]');
}

function isDraftJsEditor(el: HTMLElement): boolean {
  return !!el.closest('.public-DraftEditor-content');
}

/**
 * Read the caret offset (in plain-text characters) from the current
 * contenteditable. Returns 0 when no target or no selection.
 */
function readCursorOffset(): number {
  const target = currentTarget;
  if (!target) return 0;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!target.contains(range.startContainer)) return 0;
  return plainOffsetOfPosition(target, range.startContainer, range.startOffset);
}

/** Move the caret to the given plain-text offset within the current target.
 *  Offsets agree with walkPlainText's coordinates: each BR / block-boundary
 *  \n consumes one offset character even though no Text node holds it. */
function writeCursorOffset(offset: number): void {
  const target = currentTarget;
  if (!target) return;
  // Managed editors (Lexical, ProseMirror/TipTap) own their cursor
  // via internal selection models that sync model→DOM, never the
  // other way. Setting the browser Selection externally fights with
  // their next render, and the model wins (often snapping to
  // end-of-buffer). For single-text-node splices the editor
  // naturally keeps the caret at its prior character offset within
  // the mutated node, which is what we want anyway. So no-op here.
  if (isManagedEditor(target)) return;
  const sel = window.getSelection();
  if (!sel) return;
  const { segments, text } = walkPlainText(target);
  const clamped = Math.max(0, Math.min(offset, text.length));
  for (const seg of segments) {
    if (clamped <= seg.plainEnd) {
      const within = Math.max(0, clamped - seg.plainStart);
      const range = document.createRange();
      range.setStart(seg.node, Math.min(within, seg.node.data.length));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }
  // Past the last segment — anchor at end of the last text node, if any.
  const last = segments[segments.length - 1];
  if (last) {
    const range = document.createRange();
    range.setStart(last.node, last.node.data.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** Apply newText to the target by mutating existing text nodes in
 *  place — common-prefix/common-suffix diff, splice the difference
 *  into whichever node(s) the change falls in.
 *
 *  Why not `target.textContent = newText` (the previous approach):
 *  textContent assignment destroys the entire child-node tree and
 *  replaces it with a single flat Text node. Multi-paragraph
 *  contenteditables (Luma, Notion, gmail compose, …) collapse into
 *  one line on the first cycle / blank-fill. Diff-and-splice keeps
 *  every <p>, <div>, <br> intact.
 *
 *  Falls back to textContent when the change can't be expressed as
 *  in-place text-node mutation (no existing text nodes, or a span
 *  that crosses non-text content like images or widgets). */
/** Returns true when the diff routed to replaceAllText (full-body
 *  fallback path) — caller should skip its own markRuntimeWrite /
 *  schedule calls because replaceAllText already issued them. */
function applyTextDiff(target: HTMLElement, newText: string): boolean {
  // Use walkPlainText so the "current" snapshot agrees with what the
  // runtime sees (BR + block boundaries as \n). Otherwise the diff
  // would compute an offset against textContent and splice the wrong
  // characters in.
  const { text: current, segments } = walkPlainText(target);

  if (segments.length === 0) {
    target.textContent = newText;
    return false;
  }
  if (current === newText) return false;

  // Longest common prefix/suffix.
  const minLen = Math.min(current.length, newText.length);
  let prefix = 0;
  while (prefix < minLen && current.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    current.charCodeAt(current.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) suffix++;

  const removeStart = prefix;
  const removeEnd = current.length - suffix;
  const insert = newText.slice(prefix, newText.length - suffix);

  // If the change includes \n chars, the runtime is asking for new
  // block structure that can't be expressed by splicing a literal \n
  // into a single text node (contenteditables don't render it as a
  // line break). Route to the paragraph-aware whole-body replace path
  // instead — Gmail / Lexical / ProseMirror will rebuild the right
  // <br> / <div> / <p> structure via their own input pipeline.
  // (TransformBlank in particular uses pushText for whole-body
  // rewrites that include paragraph breaks — see resolver.ts.)
  if (insert.includes('\n')) {
    replaceAllText(newText);
    return true;
  }

  // Locate which segment(s) hold [removeStart, removeEnd]. Segments
  // only cover Text nodes; a removeStart/End landing in a virtual \n
  // slot maps to "between segments". Snap onto the nearest segment.
  let startSegIdx = -1, endSegIdx = -1, startOff = 0, endOff = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (startSegIdx === -1 && removeStart <= seg.plainEnd) {
      startSegIdx = i;
      startOff = Math.max(0, removeStart - seg.plainStart);
    }
    if (removeEnd <= seg.plainEnd) {
      endSegIdx = i;
      endOff = Math.max(0, removeEnd - seg.plainStart);
      break;
    }
  }
  if (startSegIdx === -1 || endSegIdx === -1) {
    target.textContent = newText;
    return false;
  }

  if (startSegIdx === endSegIdx) {
    // Single-segment change — splice in place. Lexical's
    // MutationObserver accepts single text-node .data mutations
    // (looks like normal user typing) and updates its model.
    const t = segments[startSegIdx].node;
    t.data = t.data.slice(0, startOff) + insert + t.data.slice(endOff);
  } else {
    // Multi-segment change — would touch multiple text nodes.
    // Lexical's MutationObserver REVERTS this kind of multi-block
    // mutation (it doesn't match its model's expected shape and
    // gets reconciled away, often leaving only one span changed
    // and the rest restored). Route to replaceAllText for Lexical
    // so the write goes through the editor API instead. Generic
    // contenteditables tolerate the multi-node splice fine.
    if (isManagedEditor(target)) {
      replaceAllText(newText);
      return true;
    }
    const startNode = segments[startSegIdx].node;
    const endNode = segments[endSegIdx].node;
    startNode.data = startNode.data.slice(0, startOff) + insert;
    for (let i = startSegIdx + 1; i < endSegIdx; i++) segments[i].node.data = '';
    endNode.data = endNode.data.slice(endOff);
  }
  return false;
}

/** Incremental write — used by pushText (cycling, span replacement,
 *  blank-fill at cursor). Mutates existing text nodes in place via
 *  applyTextDiff; preserves DOM structure and cursor.
 *
 *  This is the "I changed a word" path. Use replaceAllText for
 *  whole-body rewrites (transform-blank, generate-draft). */
function diffWriteText(text: string): void {
  const target = currentTarget;
  if (!target) return;
  target.focus();
  console.log('[opencues] diffWriteText: newLen=' + text.length + ', hasNewline=' + text.includes('\n'));
  const cBefore = readCursorOffset();
  const routedToReplaceAll = applyTextDiff(target, text);
  if (routedToReplaceAll) {
    console.log('[opencues] diffWriteText → routed to replaceAllText');
    return;
  }
  console.log('[opencues] diffWriteText: in-place splice complete, post-DOM textLen=' + (target.textContent?.length ?? 0));
  writeCursorOffset(Math.min(cBefore, text.length));
  sourceReclassifier.markRuntimeWrite(text);
  // Schedule a post-reconciliation re-render. The current synchronous
  // task continues to the runtime's forceRender (sync, walks DOM as
  // it stands now); on the next frame, after tiptap's MO microtask
  // has reconciled, we re-walk and Ranges land on the new nodes.
  schedulePostReconcileRender();
}

/** Whole-body rewrite — used by setText (transform-blank, generate-
 *  draft, fluid-blank). Selects the entire contenteditable contents
 *  and routes the replacement through `execCommand('insertHTML')` so
 *  the editor's own beforeinput / input pipeline picks it up. This is
 *  the path Gmail / Lexical / ProseMirror / Slate accept as
 *  legitimate user-like input — direct DOM mutation gets reconciled
 *  away by these editors when the change is body-scale.
 *
 *  Multi-paragraph text comes in as plain `\n`-separated runtime view;
 *  we convert each `\n` to `<br>` so the editor builds the right
 *  block structure. The editor decides whether to wrap the result in
 *  `<div>` / `<p>` per its own conventions.
 *
 *  Falls back to direct textContent assignment when execCommand is
 *  blocked (rare on contenteditables, but defensive). */
function replaceAllText(text: string): void {
  const target = currentTarget;
  if (!target) return;
  target.focus();
  console.log('[opencues] replaceAllText: newLen=' + text.length + ', preDomLen=' + (target.textContent?.length ?? 0));
  const sel = window.getSelection();
  if (!sel) {
    target.textContent = text;
    sourceReclassifier.markRuntimeWrite(text);
    schedulePostReconcileRender();
    return;
  }

  // Select everything so the write replaces the whole body.
  const range = document.createRange();
  range.selectNodeContents(target);
  sel.removeAllRanges();
  sel.addRange(range);

  if (text === '') {
    document.execCommand('delete');
  } else {
    // Pick the per-editor paragraph form. Block-paragraph editors
    // (Lexical/Reddit, ProseMirror/TipTap/Luma) wrap each paragraph
    // in its own block element and strictly expect <p> blocks on
    // paste — <br>-only collapses into one paragraph. Gmail and
    // generic contenteditables prefer <br> (matches Enter-key
    // emission and avoids extra paragraph-margin spacing).
    const isManaged = isManagedEditor(target);
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = isManaged
      // Adjacent <p> blocks; collapse runs of newlines into one
      // paragraph boundary so we don't emit empty <p><br></p>
      // between paragraphs (which would render as double spacing).
      ? text.split(/\n+/).filter(line => line.length > 0).map(line => `<p>${escape(line)}</p>`).join('')
      : text.split('\n').map(escape).join('<br>');

    // Wipe the existing content first.
    //
    // Managed editors own the contenteditable: their model is the
    // source of truth and their MutationObserver REVERTS direct DOM
    // mutations (removeChild, innerHTML='', textContent=''). Their
    // `beforeinput { inputType: "deleteContent" }` handler reads
    // their INTERNAL selection model — which doesn't sync from a
    // manually-set browser Selection — so `execCommand('delete')`
    // is a no-op too.
    //
    // Strategy:
    //   - Lexical: try its private `__lexicalEditor` instance to call
    //     editor.update() + $getRoot().clear() through the model.
    //   - Lexical fallback / ProseMirror / Slate: synthesize Ctrl+A +
    //     Backspace keyboard events. The editor's keydown handler
    //     may honour these even with isTrusted=false because it
    //     reads key/modifier fields, not the trust flag. ProseMirror
    //     particularly handles synthetic Ctrl+A → selectAll command
    //     and Backspace → deleteSelection through its own pipeline.
    //   - Generic contenteditable: execCommand('delete') with the
    //     browser select-all range.
    // Wipe the existing content. Strategy depends on editor:
    //   - Lexical: editor.update($getRoot().clear()) via private
    //     `__lexicalEditor` instance. Falls back to Ctrl+A +
    //     Backspace keyboard sim if the instance isn't accessible.
    //   - Other managed (ProseMirror/TipTap, Slate): Ctrl+A +
    //     Backspace keyboard sim. ProseMirror's keymap honours these
    //     synthetic events (its handler reads key/modifiers, not
    //     isTrusted) and routes through its own selectAll +
    //     deleteSelection commands. Works for Luma; LinkedIn's
    //     TipTap appears to reject the resulting paste — likely a
    //     custom paste extension specific to that integration.
    //   - Generic contenteditable: execCommand('delete') with the
    //     browser select-all range works normally.
    if (isLexicalEditor(target)) {
      const lex = (target as unknown as { __lexicalEditor?: {
        update: (fn: () => void, opts?: { discrete?: boolean }) => void;
      } }).__lexicalEditor;
      type LexicalGlobals = {
        $getRoot?: () => { clear: () => void };
      };
      const lexGlobals = window as unknown as LexicalGlobals;
      if (lex && typeof lex.update === 'function' && typeof lexGlobals.$getRoot === 'function') {
        try {
          lex.update(() => { lexGlobals.$getRoot!().clear(); }, { discrete: true });
        } catch (err) {
          console.warn('[opencues] Lexical editor.update clear failed:', err);
        }
      } else {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
          bubbles: true, cancelable: true,
        }));
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', code: 'Backspace', keyCode: 8,
          bubbles: true, cancelable: true,
        }));
      }
    } else if (isDraftJsEditor(target)) {
      // Draft.js (Twitter/X). Same managed-editor pattern as
      // Lexical: its internal selection model doesn't sync from
      // browser-side selectNodeContents, so paste lands at the
      // editor's internal cursor (end of buffer) and APPENDS
      // rather than REPLACING. Synthetic Ctrl+A + Backspace
      // keydown events route through Draft.js's keydown pipeline
      // (which sets internal selection to all then deletes),
      // clearing the buffer before paste lands.
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
        bubbles: true, cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', code: 'Backspace', keyCode: 8,
        bubbles: true, cancelable: true,
      }));

      // Plain-text paste — Draft.js's React-level onPaste handler
      // reads e.clipboardData.getData('text') and runs its own
      // block-splitting paste pipeline.
      const pre = target.textContent?.length ?? 0;
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        target.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }));
      } catch { /* ClipboardEvent unavailable */ }

      const postPaste = target.textContent?.length ?? 0;
      if (postPaste === pre) {
        // Fallback: beforeinput insertFromPaste.
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          target.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertFromPaste',
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
          }));
        } catch { /* InputEvent constructor unavailable */ }
      }

      const postFinal = target.textContent?.length ?? 0;
      console.log('[opencues] replaceAllText: draftjs path, preLen=' + pre + ', postLen=' + postFinal);
      sourceReclassifier.markRuntimeWrite(text);
      schedulePostReconcileRender();
      return;
    } else if (isManaged) {
      // ProseMirror/TipTap, Slate.
      //
      // DEFAULT: execCommand('insertText'). Routes through the
      // editor's plain-text-insertion command (the same pipeline
      // user keystrokes flow through). With selection set to all
      // via selectNodeContents above, insertText replaces. The
      // browser dispatches inputType: insertParagraph for each \n;
      // \n\n in LLM output produces one paragraph break (standard
      // web convention). Verified on LinkedIn, ChatGPT, claude.ai
      // — these all reject programmatic paste events outright but
      // accept insertText cleanly.
      //
      // EXCEPTION — Luma's TipTap: insertText paragraph handling
      // creates double-spacing on every \n\n. Luma's standard
      // paste handler accepts <p>-per-paragraph HTML cleanly with
      // correct single-paragraph spacing, so route Luma through
      // the keyboard-sim + paste path instead.
      const host = location.hostname;
      const isLuma = host === 'lu.ma' || host.endsWith('.lu.ma');
      if (!isLuma) {
        document.execCommand('insertText', false, text);
        sourceReclassifier.markRuntimeWrite(text);
        schedulePostReconcileRender();
        return;
      }
      // Luma: keyboard sim clear + paste below.
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
        bubbles: true, cancelable: true,
      }));
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', code: 'Backspace', keyCode: 8,
        bubbles: true, cancelable: true,
      }));
    } else {
      document.execCommand('delete');
    }

    // Synthetic paste event with DataTransfer is the universally
    // honoured programmatic write into modern contenteditables —
    // Lexical, ProseMirror, Slate all have first-class paste handlers,
    // and Gmail accepts it too. We don't have a synchronous "did it
    // work" signal: Lexical's handler is async (queues a React state
    // update), so a post-dispatch DOM-length check would fire while
    // the paste is still in-flight and trigger spurious fallbacks
    // that double-render. Trust the paste; only fall back if
    // ClipboardEvent itself isn't constructible (very rare).
    //
    // NOTE: do NOT also dispatch an InputEvent('input', {
    // inputType: 'insertFromPaste', data: text }) afterwards —
    // Lexical's input handler reads the `data` field and inserts
    // it AS PLAIN TEXT on top of whatever the paste handler did,
    // duplicating the entire body inside the last paragraph.
    let pasted = false;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      dt.setData('text/html', html);
      const pasteEvent = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(pasteEvent);
      pasted = true;
    } catch { /* ClipboardEvent constructor unsupported — fall through */ }

    if (!pasted) {
      // No ClipboardEvent support. Last-resort: textContent.
      // Destroys structure but at least the text appears.
      target.textContent = text;
    }
    console.log('[opencues] replaceAllText: ' + (isManaged ? 'managed' : 'generic') + ' paste dispatched');
  }

  sourceReclassifier.markRuntimeWrite(text);
  schedulePostReconcileRender();
}

/**
 * Read a config file. Resolution order:
 *   1. Bundled dist/configs/<path> — what `opencues sync chrome` wrote
 *   2. chrome.storage.local — writable state (e.g. popup edits)
 *   3. null — caller falls back to bake-time defaults
 *
 * Runtime paths look like `/chrome-storage/CUES.md` or
 * `/chrome-storage/cues/grammar/CUE.md`; we strip the ROOT prefix and
 * try it as a bundle asset first.
 */
async function readFile(path: string): Promise<string | null> {
  // 1. Synced bundle (opencues sync chrome --wsl) wins if present.
  const bundled = await readBundledConfig(path);
  if (bundled !== null) {
    tlog(`[opencues] readFile(${path}) ← bundle (${bundled.length} chars)`);
    return bundled;
  }

  // 2. Read-only files (CUES.md, BLANKS.md, folder cues, folder
  //    blanks, tips.json): read the bake-time constant direct.
  //    No storage cache — that's what used to go stale when the repo's
  //    prompt changed but chrome.storage still held the old seeded
  //    copy. Bake-time is in-memory, always fresh per build.
  if (isReadOnlyPath(path)) {
    const bake = readBakeTimeDefault(path);
    if (bake !== null) {
      tlog(`[opencues] readFile(${path}) ← bake-time (${bake.length} chars)`);
      return bake;
    }
    tlog(`[opencues] readFile(${path}) ← null (no bundle, no bake-time)`);
    return null;
  }

  // 3. Writable files (CUES.md — OpenCuesSettingsBlank cycles
  //    voice-mode / tips-mode / debug-mode via writeFile). Storage
  //    wins so the user's saved setting persists across reloads,
  //    falling back to bake-time before the first write.
  const key = STORAGE_PREFIX + path;
  try {
    const result = await chrome.storage.local.get(key);
    const v = result[key];
    if (typeof v === 'string' && v.length > 0) {
      tlog(`[opencues] readFile(${path}) ← storage (${v.length} chars)`);
      return v;
    }
  } catch (err) {
    console.warn(`[opencues] readFile(${path}) threw:`, err);
  }
  const bake = readBakeTimeDefault(path);
  if (bake !== null) {
    tlog(`[opencues] readFile(${path}) ← bake-time (${bake.length} chars, storage empty)`);
    return bake;
  }
  tlog(`[opencues] readFile(${path}) ← null (no bundle, no storage, no bake-time)`);
  return null;
}

// Is this path a READ-ONLY config? Read-only paths bypass storage
// entirely — they resolve directly from the bake-time constant when
// the sync bundle doesn't cover them. This kills the staleness class
// of bug where storage held an old seeded copy forever.
function isReadOnlyPath(path: string): boolean {
  if (!path.startsWith(ROOT + '/')) return false;
  const rel = path.slice(ROOT.length + 1);
  // OPENCUES.md is writable: OpenCuesSettingsBlank cycles voice-mode /
  // tips-mode / debug-mode etc. by rewriting the YAML scalar.
  if (rel === '.cues/OPENCUES.md') return false;
  return true;
}

// Resolve a runtime-path to its bake-time constant value.
//
// Folder-based shape, matching discover.ts on the native hosts:
//   .cues/cues/<name>/CUE.md      → __DEFAULT_CUE_FOLDERS__[name]
//   .cues/blanks/<name>/BLANK.md  → __DEFAULT_BLANK_FOLDERS__[name]
function readBakeTimeDefault(path: string): string | null {
  if (!path.startsWith(ROOT + '/')) return null;
  const rel = path.slice(ROOT.length + 1);
  if (rel === '.cues/OPENCUES.md') return __DEFAULT_OPENCUES_MD__ || null;
  const cueFolder = rel.match(/^\.cues\/cues\/([^/]+)\/CUE\.md$/);
  if (cueFolder) return __DEFAULT_CUE_FOLDERS__[cueFolder[1]] ?? null;
  const blankFolder = rel.match(/^\.cues\/blanks\/([^/]+)\/BLANK\.md$/);
  if (blankFolder) return __DEFAULT_BLANK_FOLDERS__[blankFolder[1]] ?? null;
  return null;
}

// Cache the bundle index. Crucially we cache the PROMISE, not the
// resolved value: ConfigLoader fires every readFile() in parallel via
// Promise.all on boot, so multiple concurrent callers must await the
// same in-flight fetch (otherwise the second+ callers would see an
// empty-cache snapshot before the first call's await resolves).
let _bundleIndexPromise: Promise<{ files: Set<string>; loaded: boolean }> | null = null;
function getBundleIndex(): Promise<{ files: Set<string>; loaded: boolean }> {
  if (_bundleIndexPromise) return _bundleIndexPromise;
  _bundleIndexPromise = (async () => {
    const result = { files: new Set<string>(), loaded: false };
    try {
      const url = chrome.runtime.getURL('dist/configs/index.json');
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.files)) {
          result.files = new Set(data.files.map(String));
          result.loaded = true;
          console.log(`[opencues] bundled configs loaded: ${result.files.size} files from dist/configs/`);
        } else {
          console.warn('[opencues] dist/configs/index.json malformed:', data);
        }
      } else {
        console.warn(`[opencues] dist/configs/index.json fetch returned ${res.status}`);
      }
    } catch (err) {
      // Bundle not present — fall back to bake-time. Log so we know.
      console.warn(`[opencues] dist/configs/index.json fetch failed: ${(err as Error).message}`);
    }
    return result;
  })();
  return _bundleIndexPromise;
}

// Strip a leading `.cues/` segment from a path relative to ROOT.
// The runtime's configSearchPaths point at `${ROOT}/.cues`, but the
// bundle layout (dist/configs/) is "what's INSIDE .cues/" — no
// repeated segment. This collapses the two views.
function bundleRelative(rel: string): string {
  return rel.startsWith('.cues/') ? rel.slice('.cues/'.length) : rel;
}

// Read a synced file out of dist/configs/. Path is the runtime's
// canonical form (starts with ROOT). Returns null if not in the bundle.
async function readBundledConfig(runtimePath: string): Promise<string | null> {
  if (!runtimePath.startsWith(ROOT + '/')) return null;
  const rel = bundleRelative(runtimePath.slice(ROOT.length + 1));
  const idx = await getBundleIndex();
  if (!idx.loaded || !idx.files.has(rel)) return null;
  try {
    const url = chrome.runtime.getURL(`dist/configs/${rel}`);
    const res = await fetch(url);
    if (res.ok) return await res.text();
  } catch { /* ignore */ }
  return null;
}

/** chrome.storage.local-backed writeFile. */
async function writeFile(path: string, content: string): Promise<void> {
  const key = STORAGE_PREFIX + path;
  try {
    await chrome.storage.local.set({ [key]: content });
  } catch {
    // Swallow — extension might not have storage permission in some contexts.
  }
}

/**
 * Synthetic readDir over the bake-time folder maps. ConfigLoader walks
 * `${cwd}/cues` + `${cwd}/blanks` to discover folder configs. We
 * don't have a real filesystem, so return the names esbuild baked in
 * from the project's cues/* and blanks/* directories.
 */
async function readDir(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null> {
  // Try the bundled index.json first — "what did `opencues sync chrome`
  // actually put there?" — and fall back to the bake-time folder maps
  // for extensions booted without a prior sync.
  const bundled = await readBundledDir(path);
  if (bundled) return bundled;

  // Folder-based shape: discover.ts walks `.cues/cues` + `.cues/blanks`
  // and only descends into entries reported as directories. Each name
  // is the folder name (no `.md` suffix) — the inner CUE.md / BLANK.md
  // is fetched separately via readFile, served by readBakeTimeDefault.
  if (path === `${ROOT}/.cues/cues`) {
    return Object.keys(__DEFAULT_CUE_FOLDERS__).map(name => ({
      name,
      isDirectory: true,
    }));
  }
  if (path === `${ROOT}/.cues/blanks`) {
    return Object.keys(__DEFAULT_BLANK_FOLDERS__).map(name => ({
      name,
      isDirectory: true,
    }));
  }

  // Inner folder readDir — ConfigLoader's prewalk recurses into each
  // bake-time entry above, then asks for that folder's contents to
  // discover the CUE.md / BLANK.md inside. Without these branches the
  // inner files never enter the prewalk file cache and discoverFolder-
  // Configs sees no content (sync-bundle path is unaffected, since it
  // routes via readBundledDir's index lookup).
  const cueInner = path.match(new RegExp(`^${ROOT}/\\.cues/cues/([^/]+)$`));
  if (cueInner && __DEFAULT_CUE_FOLDERS__[cueInner[1]]) {
    return [{ name: 'CUE.md', isDirectory: false }];
  }
  const blankInner = path.match(new RegExp(`^${ROOT}/\\.cues/blanks/([^/]+)$`));
  if (blankInner && __DEFAULT_BLANK_FOLDERS__[blankInner[1]]) {
    return [{ name: 'BLANK.md', isDirectory: false }];
  }
  return null;
}

// Synthesise a readDir result from the bundled index.json file list.
// Returns null if no bundle is present or the path has no matches.
async function readBundledDir(runtimePath: string): Promise<readonly { name: string; isDirectory: boolean }[] | null> {
  if (!runtimePath.startsWith(ROOT + '/') && runtimePath !== ROOT) return null;
  const rawPrefix = runtimePath === ROOT ? '' : runtimePath.slice(ROOT.length + 1);
  const prefix = bundleRelative(rawPrefix);
  const idx = await getBundleIndex();
  if (!idx.loaded) return null;

  const base = prefix ? prefix + '/' : '';
  const childFiles = new Set<string>();
  const childDirs = new Set<string>();
  for (const f of idx.files) {
    if (!f.startsWith(base)) continue;
    const rest = f.slice(base.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) childFiles.add(rest);
    else childDirs.add(rest.slice(0, slash));
  }
  if (childFiles.size === 0 && childDirs.size === 0) return null;

  const out: { name: string; isDirectory: boolean }[] = [];
  for (const d of childDirs) out.push({ name: d, isDirectory: true });
  for (const f of childFiles) out.push({ name: f, isDirectory: false });
  return out;
}

/**
 * No storage seeding. readFile() resolves bake-time constants directly
 * for every read-only config path, and writable files (OPENCUES.md)
 * flow through chrome.storage only when the runtime actually writes
 * them. The previous seedDefaults() call was deleted in Apr 2026 — it
 * cached bake-time values into storage where they went stale on the
 * next prompt rewrite. See docs/features/chrome-sync.md for the
 * simplified model.
 */

/**
 * Optional runtime config the content script can supply at boot time.
 * All fields optional — runtime modules degrade gracefully (Resolver
 * stays dormant without llmApiKey, etc.).
 */
export interface RuntimeStartOptions {
  llmApiKey?: string;
  llmEndpoint?: string;
  llmDefaultModel?: string;
  llmDebounceMs?: number;
  /**
   * Multi-provider key bag. The popup writes these to chrome.storage
   * and the content-script forwards them through. Runtime picks the
   * right one based on CUES.md `llm-provider:` / `<feature>-provider:`.
   */
  llmApiKeys?: Readonly<Record<string, string | undefined>>;
  /** Finnhub API key for the stocks blank. */
  finnhubApiKey?: string;
  /** Custom ticker map for the stocks blank. */
  customTickers?: Record<string, string>;
}

// Built lazily inside startOpenCues — needs opts. The dispatcher
// (createBlankInvoke) lives in the runtime so all hosts share it.
let blankInvoke: ((spec: BlankInvokeSpec) => ProcessHandle | null) | null = null;

/**
 * Construct the runtime if not already running. Idempotent — second
 * call returns the cached BootResult. Call once at content-script
 * load (after publishTarget has been hooked up).
 */
export function startOpenCues(opts: RuntimeStartOptions = {}): BootResult {
  if (bootResult) return bootResult;

  // CE.8 — build the chrome blank registry. The runtime's BlankFill
  // + Cycling dispatch into this via blankInvoke. Prompt-improver
  // is opt-in via llmConfig.
  const blanks = createBlanks({
    finnhubApiKey: opts.finnhubApiKey,
    customTickers: opts.customTickers,
    llmConfig: opts.llmApiKey ? {
      apiKey: opts.llmApiKey,
      // PromptImproverConfig field is `apiUrl`, NOT `endpoint`. The
      // mismatch left cfg.apiUrl undefined → fetch(undefined,...) threw
      // → catch returned the original fullContext → consume-all replaced
      // the buffer with the unchanged original ("improve prompt
      // resolves to original word").
      apiUrl: opts.llmEndpoint ?? 'https://api.groq.com/openai/v1/chat/completions',
      model: opts.llmDefaultModel ?? 'openai/gpt-oss-120b',
    } : undefined,
    // OpenCues settings selector/satellite (`opencues settings _`)
    // reads/writes the seeded OPENCUES.md in chrome.storage.
    opencuesMdReadFile: () => readFile(`${ROOT}/.cues/OPENCUES.md`),
    opencuesMdWriteFile: (content) => writeFile(`${ROOT}/.cues/OPENCUES.md`, content),
  });
  blankInvoke = createBlankInvoke(blanks);

  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    const tag = `[opencues][${level}]`;
    if (level === 'error') console.error(tag, msg, data ?? '');
    else if (level === 'warn') console.warn(tag, msg, data ?? '');
    else if (level === 'debug') console.debug(tag, msg, data ?? '');
    else console.log(tag, msg, data ?? '');
  };

  // No seed step — readFile() resolves bake-time constants directly
  // for read-only paths, and writable paths (OPENCUES.md) persist
  // through chrome.storage only when they're actually written.
  bootResult = boot({
    hostVersion: '0.1.0',
    cwd: ROOT,
    getText: () => currentTarget ? walkPlainText(currentTarget).text : '',
    getCursorOffset: readCursorOffset,
    // Both setText and pushText route through diffWriteText so the
    // diff itself decides per-call whether the change is small
    // enough for an in-place text-node splice (cycling, single-word
    // edits) or large enough to need replaceAllText's editor-API
    // path (transform-blank, generate-draft). Originally we routed
    // setText straight to replaceAllText on the assumption it always
    // meant "whole body replace", but cycling.ts uses setText for
    // every cycle — that put the cursor at end-of-buffer in Lexical
    // editors on every word cycle. The diff's single-segment vs
    // multi-segment check is the right discriminator.
    setText: diffWriteText,
    setCursorOffset: writeCursorOffset,
    pushText: (text, cursor) => {
      // diffWriteText already calls sourceReclassifier.markRuntimeWrite.
      // Cursor is set synchronously after so the input-event handler
      // reads the post-fill caret position (matters for multi-word fills).
      diffWriteText(text);
      if (cursor !== undefined) writeCursorOffset(cursor);
    },
    forceRender: () => {
      runtimeRender();
    },
    readFile,
    writeFile,
    readDir,
    log,
    // CE.6 — render statusline tip into the floating div.
    statusSnapshotHook: (payload) => applyStatuslinePayload(payload as Parameters<typeof applyStatuslinePayload>[0]),
    // CE.6 — TTS via Web Speech, gated on host providing the speak fn.
    speakFn: (text, rate) => speech.speak(text, rate ? Number(rate) : 2),
    // CE.7 — Resolver only constructs when llmApiKey is set. Pass our
    // FetchHttpAdapter so the runtime doesn't try to load the
    // node-http-adapter stub that throws.
    llmApiKey: opts.llmApiKey,
    llmApiKeys: opts.llmApiKeys,
    llmEndpoint: opts.llmEndpoint,
    llmDefaultModel: opts.llmDefaultModel,
    llmDebounceMs: opts.llmDebounceMs,
    httpAdapter: (opts.llmApiKey || (opts.llmApiKeys && Object.values(opts.llmApiKeys).some(Boolean)))
      ? new FetchHttpAdapter() : undefined,
    // CE.8 — blankInvoke routes blank-fill + cycle script calls to
    // the chrome blanks registry above (volume / stocks / weather /
    // hackernews / prompt-improver). Returns null for unknown
    // blanks so spawnProcess fallback (which the chrome adapter
    // resolves with exitCode 127) takes over visibly.
    blankInvoke: (spec) => blankInvoke?.(spec) ?? null,
    // statusSnapshotHook intentionally omitted — CE.6 will route to
    // the StatusBar div. Without the hook, the Statusline module
    // skips both the file write (no exportPath) and the in-process
    // sink (no onSnapshot), so it sits dormant.
  });

  startVersionPoll(bootResult);

  // One-shot read of debug-mode from storage — subsequent flips are
  // picked up by the chrome.storage.onChanged listener registered
  // near the top of this file.
  void refreshReadTraceFromStorage();

  return bootResult;
}

// Poll configs/.version every few seconds. When the hash changes,
// invalidate the bundle index cache + call reloadConfig() so the
// runtime re-reads everything. Lets `opencues sync chrome --watch`
// drive live config changes into already-open tabs without a page
// refresh.
const VERSION_POLL_MS = 2500;
let _lastKnownVersion: string | null = null;
function startVersionPoll(bootResult: BootResult): void {
  const tick = async () => {
    try {
      const url = chrome.runtime.getURL('dist/configs/.version');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const version = (await res.text()).trim();
      if (_lastKnownVersion === null) {
        _lastKnownVersion = version;
        return;
      }
      if (version !== _lastKnownVersion) {
        _lastKnownVersion = version;
        _bundleIndexPromise = null;        // force index.json re-fetch
        await bootResult.reloadConfig();   // re-read every source
      }
    } catch { /* bundle absent / offline — next tick tries again */ }
  };
  // Kick once after boot to seed _lastKnownVersion, then poll.
  void tick();
  setInterval(tick, VERSION_POLL_MS);
}

/** Call from content.ts's input handler to forward text changes.
 *
 * Two corrections applied vs the naive "always source='user', cursor=0"
 * forwarder:
 *
 *   1. Use the shared sourceReclassifier — if the incoming text matches
 *      what the runtime just wrote (markRuntimeWrite), the source flips
 *      to 'runtime'. Otherwise Navigation.onTextChange treats the write
 *      as a user edit and clears the highlight + DynDefs.
 *   2. Read the actual caret offset from the contenteditable instead of
 *      trusting the caller-supplied cursor. Multi-word fills
 *      (`"Hacker News"`, affirmations, etc.) need the post-fill caret
 *      so subsequent cycles know where the cursor sits.
 */
export function notifyOpenCuesTextChange(
  text: string,
  cursorOffset: number,
  source: 'user' | 'runtime' = 'user',
): void {
  const actualSource = sourceReclassifier.reclassify(text, source);
  const actualCursor = readCursorOffset() || cursorOffset;
  bootResult?.notifyTextChange(text, actualCursor, actualSource);
  // Repaint after every text change. OpenCode skips this because its
  // SolidJS reactive layer auto-paints when the textarea signal updates,
  // so DimRender always sees the latest text via the next render frame.
  // Chrome has no such reactive loop — without an explicit repaint,
  // dim/highlight ranges stay stale until the user presses a navigation
  // key. CSS Highlight API writes are cheap and idempotent so an extra
  // paint per keystroke is fine.
  runtimeRender();
}

/** Notify runtime of cursor-only moves (mouse click, arrow keys without
 *  typing). Fired by the content script's selectionchange listener.
 *  Drives cursor-navigate auto-highlight. */
export function notifyOpenCuesCursorChange(
  text: string,
  cursorOffset: number,
  source: 'user' | 'runtime' = 'user',
): void {
  bootResult?.notifyCursorChange(text, cursorOffset, source);
  runtimeRender();
}

/**
 * Read current text + cursor from the focused target, ask the runtime
 * for render directives, apply them via the CSS Highlight API. Called
 * from forceRender (modules ask for re-paint) and after every text/key
 * change.
 */
function runtimeRender(): void {
  const target = currentTarget;
  if (!target || !bootResult) return;
  const text = walkPlainText(target).text;
  const cursor = readCursorOffset();
  const directives = bootResult.collectRenderDirectives(text, cursor);
  applyDirectives(target, directives);
}

/**
 * Queue exactly one re-render on the next animation frame. Called after
 * writeText so that — by the time it fires — the editor's MutationObserver
 * microtask has run and reconciled the DOM. The re-walk inside
 * runtimeRender then picks up the editor's Text nodes (not ours) and the
 * Highlight Ranges land on live nodes.
 *
 * Coalesced via a single rAF id so multiple writeTexts in the same task
 * (rare, but possible during span/blank fills) collapse to one frame.
 */
let _postReconcileRafId: number | null = null;
function schedulePostReconcileRender(): void {
  if (_postReconcileRafId !== null) return;
  _postReconcileRafId = requestAnimationFrame(() => {
    _postReconcileRafId = null;
    runtimeRender();
  });
}

/** Tear down runtime highlights — called when extension detaches. */
export function clearRuntimeHighlights(): void {
  clearDirectives();
}

/**
 * Map a browser KeyboardEvent key string to the runtime's expected
 * keys. Runtime uses 'up'/'down'/'left'/'right'/'escape' (OpenCode/CC
 * naming). Browser uses 'ArrowUp'/'ArrowDown'/etc. + 'Escape'. Unknown
 * keys pass through lowercased so single-char keys ('_', 'a', etc.)
 * still match.
 */
function normaliseKey(k: string): string {
  switch (k) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'Escape': return 'escape';
    case 'Enter': return 'enter';
    case 'Tab': return 'tab';
    case 'Backspace': return 'backspace';
    case ' ': return 'space';
    default: return k.toLowerCase();
  }
}

/**
 * Document-level keydown listener (capture phase). Fires before the
 * existing WordNavigator's target listener, so consumed events get
 * blocked via stopPropagation. Installed once per content-script load.
 */
function installKeyListener(): void {
  document.addEventListener('keydown', (e) => {
    if (!bootResult) return;
    // Only handle events that touch the current target. This avoids
    // hijacking keys on parts of the page outside our contenteditable.
    const target = currentTarget;
    if (!target) return;
    const active = document.activeElement;
    if (active !== target && !target.contains(active)) return;
    const text = walkPlainText(target).text;
    const cursor = readCursorOffset();
    const ev: KeyEvent = {
      key: normaliseKey(e.key),
      modifiers: {
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      },
      text,
      cursorOffset: cursor,
    };
    if (bootResult.dispatchKey(ev)) {
      e.preventDefault();
      e.stopPropagation();
      // No render here — runtime modules (Cycling, Navigation, etc.)
      // call forceRender themselves when they want a repaint.
    }
  }, true);
}

// Install once at module load. publishTarget gates which target the
// listener acts on, so this is safe before any focus/attach.
installKeyListener();
