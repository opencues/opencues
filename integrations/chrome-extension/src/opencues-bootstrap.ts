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
import type { KeyEvent, LogLevel } from 'opencues-runtime/dist/src/adapter';
import { applyDirectives, clearDirectives } from './runtime-renderer';

const STORAGE_PREFIX = 'opencues_runtime:';

// Bake-time defines from esbuild — same data the legacy CueEngine
// reads via DEFAULT_CONFIG. Re-using them keeps a single source of
// truth for the project's cues.md / blanks.md / opencues.md.
declare const __DEFAULT_CUES_MD__: string;
declare const __DEFAULT_BLANKS_MD__: string;
declare const __DEFAULT_OPENCUES_MD__: string;
declare const __DEFAULT_CUE_FOLDERS__: Record<string, string>;
declare const __DEFAULT_CONTROL_FOLDERS__: Record<string, string>;
declare const __DEFAULT_TIPS_JSON__: string;

const ROOT = '/chrome-storage';
const TIPS_KEY = `${STORAGE_PREFIX}/chrome-storage/.tips.json`;

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
 * Synthetic readDir over the bake-time folder maps. ConfigLoader walks
 * `${cwd}/cues` + `${cwd}/controls` to discover folder configs. We
 * don't have a real filesystem, so return the names esbuild baked in
 * from the project's cues/* and controls/* directories.
 */
async function readDir(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null> {
  if (path === `${ROOT}/cues`) {
    return Object.keys(__DEFAULT_CUE_FOLDERS__).map(name => ({ name, isDirectory: true }));
  }
  if (path === `${ROOT}/controls`) {
    return Object.keys(__DEFAULT_CONTROL_FOLDERS__).map(name => ({ name, isDirectory: true }));
  }
  return null;
}

/**
 * Seed chrome.storage with the bake-time config defaults on first
 * boot. Idempotent — only writes keys that don't already exist so a
 * popup-edited config isn't clobbered on extension reload.
 */
async function seedDefaults(): Promise<void> {
  const seeds: Record<string, string> = {
    [`${STORAGE_PREFIX}${ROOT}/cues.md`]: __DEFAULT_CUES_MD__,
    [`${STORAGE_PREFIX}${ROOT}/blanks.md`]: __DEFAULT_BLANKS_MD__,
    [`${STORAGE_PREFIX}${ROOT}/opencues.md`]: __DEFAULT_OPENCUES_MD__,
    [TIPS_KEY]: __DEFAULT_TIPS_JSON__,
  };
  for (const [name, content] of Object.entries(__DEFAULT_CUE_FOLDERS__)) {
    seeds[`${STORAGE_PREFIX}${ROOT}/cues/${name}/cue.md`] = content;
  }
  for (const [name, content] of Object.entries(__DEFAULT_CONTROL_FOLDERS__)) {
    seeds[`${STORAGE_PREFIX}${ROOT}/controls/${name}/cue.md`] = content;
  }

  const keys = Object.keys(seeds);
  let existing: Record<string, unknown> = {};
  try { existing = await chrome.storage.local.get(keys); } catch { /* swallow */ }
  const toWrite: Record<string, string> = {};
  for (const key of keys) {
    if (typeof existing[key] !== 'string') {
      toWrite[key] = seeds[key];
    }
  }
  if (Object.keys(toWrite).length > 0) {
    try { await chrome.storage.local.set(toWrite); } catch { /* swallow */ }
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

  // Fire-and-forget seed; ConfigLoader.load tolerates empty stores
  // and will re-load once the seeded data lands. The runtime's own
  // first read may briefly see no config — same behaviour as the
  // legacy CueEngine which also debounces its initial analyse.
  void seedDefaults();

  bootResult = boot({
    hostVersion: '0.1.0',
    cwd: ROOT,
    getText: () => currentTarget?.textContent ?? '',
    getCursorOffset: readCursorOffset,
    setText: writeText,
    setCursorOffset: writeCursorOffset,
    pushText: (text, cursor) => {
      writeText(text);
      if (cursor !== undefined) writeCursorOffset(cursor);
    },
    forceRender: () => {
      runtimeRender();
    },
    readFile,
    writeFile,
    readDir,
    tipsPath: TIPS_KEY.slice(STORAGE_PREFIX.length),
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
  // Re-render after every text change so DimRender's freshly-computed
  // ranges (post-tip lookup, post-cycling) paint immediately.
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
  const text = target.textContent ?? '';
  const cursor = readCursorOffset();
  const directives = bootResult.collectRenderDirectives(text, cursor);
  applyDirectives(target, directives);
}

/** Tear down runtime highlights — called when extension detaches. */
export function clearRuntimeHighlights(): void {
  clearDirectives();
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
    const text = target.textContent ?? '';
    const cursor = readCursorOffset();
    const ev: KeyEvent = {
      key: e.key.toLowerCase(),
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
      runtimeRender();
    }
  }, true);
}

// Install once at module load. publishTarget gates which target the
// listener acts on, so this is safe before any focus/attach.
installKeyListener();
