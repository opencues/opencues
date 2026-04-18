// Phase CE.1 — bootstrap the opencues-runtime alongside the existing
// CueEngine. The runtime is opt-in: this file builds a HostInfo from
// browser APIs, calls boot(), and exposes the BootResult for content.ts
// to wire into its existing key/text/render plumbing.
//
// What runs at this phase:
//   - boot() constructs the runtime: ConfigLoader, Navigation,
//     DimRender, Cycling, BlankFill, etc. all subscribe.
//   - getText/getCursorOffset are closures over a "current target"
//     pointer that content.ts updates via publishTarget().
//   - readFile/writeFile route through chrome.storage.local using
//     the path as the storage key.
//   - log writes to console with [opencues] prefix.
//
// What does NOT run yet:
//   - dispatchKey is exposed but no document-level keydown listener
//     is registered — the existing WordNavigator still owns keys.
//     CE.2 wires the listener and removes the navigator's left/right.
//   - notifyOpenCuesTextChange is exposed but content.ts doesn't call
//     it yet. CE.3+ wires it.
//   - statusSnapshotHook fires; the floating StatusBar div doesn't
//     read from it yet (CE.6).
//
// The runtime modules subscribe to onTextChange / onRender / onKey via
// the adapter. Without text/key dispatch from content.ts they're
// dormant — exactly what we want for CE.1: prove the boot path works
// in a content-script context without changing observable behavior.

import { boot, type BootResult } from 'opencues-runtime/dist/adapters/chrome/v1/boot';
import type { LogLevel } from 'opencues-runtime/dist/src/adapter';

const STORAGE_PREFIX = 'opencues_runtime:';

let bootResult: BootResult | undefined;
let currentTarget: HTMLElement | null = null;

/** Called by content.ts when the focused contenteditable changes. */
export function publishTarget(el: HTMLElement | null): void {
  currentTarget = el;
}

/** Inspect — returns the current target the bootstrap is reading from. */
export function getCurrentTarget(): HTMLElement | null {
  return currentTarget;
}

/** True once boot() has run. content.ts uses this for log gating. */
export function isRuntimeStarted(): boolean {
  return bootResult !== undefined;
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
  // Count text length up to the caret using a TreeWalker.
  const pre = range.cloneRange();
  pre.selectNodeContents(target);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** Move the caret to the given plain-text offset within the current target. */
function writeCursorOffset(offset: number): void {
  const target = currentTarget;
  if (!target) return;
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = Math.max(0, offset);
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const len = (node.textContent ?? '').length;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode();
  }
}

/** Replace the current target's text via execCommand selectAll + insertText. */
function writeText(text: string): void {
  const target = currentTarget;
  if (!target) return;
  // Use execCommand so the host page sees a synthetic input event —
  // matches what the existing engine does in WordNavigator.cycle.
  target.focus();
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, text);
}

/** chrome.storage.local-backed readFile. Path is the storage key suffix. */
async function readFile(path: string): Promise<string | null> {
  const key = STORAGE_PREFIX + path;
  try {
    const result = await chrome.storage.local.get(key);
    const v = result[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
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
 * Construct the runtime if not already running. Idempotent — second
 * call returns the cached BootResult. Call once at content-script
 * load (after publishTarget has been hooked up).
 */
export function startOpenCuesRuntime(): BootResult {
  if (bootResult) return bootResult;

  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    const tag = `[opencues][${level}]`;
    if (level === 'error') console.error(tag, msg, data ?? '');
    else if (level === 'warn') console.warn(tag, msg, data ?? '');
    else if (level === 'debug') console.debug(tag, msg, data ?? '');
    else console.log(tag, msg, data ?? '');
  };

  bootResult = boot({
    hostVersion: '0.1.0',
    cwd: '/chrome-storage',
    getText: () => currentTarget?.textContent ?? '',
    getCursorOffset: readCursorOffset,
    setText: writeText,
    setCursorOffset: writeCursorOffset,
    pushText: (text, cursor) => {
      writeText(text);
      if (cursor !== undefined) writeCursorOffset(cursor);
    },
    forceRender: () => {
      // CE.3 wires this to the existing HighlightRenderer (or its
      // replacement). For now: no-op. The existing engine.onUpdate
      // path still drives renders via lastInputText reads.
    },
    readFile,
    writeFile,
    log,
    // statusSnapshotHook intentionally omitted — CE.6 will route to
    // the StatusBar div. Without the hook, the Statusline module
    // skips both the file write (no exportPath) and the in-process
    // sink (no onSnapshot), so it sits dormant.
  });

  return bootResult;
}

/** Call from content.ts's input handler to forward text changes. */
export function notifyOpenCuesTextChange(
  text: string,
  cursorOffset: number,
  source: 'user' | 'runtime' = 'user',
): void {
  bootResult?.notifyTextChange(text, cursorOffset, source);
}
