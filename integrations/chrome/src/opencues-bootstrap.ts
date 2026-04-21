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

import { boot, type BootResult } from '@opencues/runtime/dist/adapters/chrome/v1/boot';
import type {
  ControlInvokeSpec,
  KeyEvent,
  LogLevel,
  ProcessHandle,
  ProcessResult,
} from '@opencues/runtime/dist/src/adapter';
import { createSourceReclassifier } from '@opencues/runtime/dist/src/boot-common';
import { createControlInvoke } from '@opencues/runtime/dist/src/controls';
import { applyDirectives, clearDirectives } from './runtime-renderer';
import { applyStatuslinePayload } from './runtime-statusbar';
import { WebSpeechAdapter } from './adapters/web-speech-adapter';
import { FetchHttpAdapter } from './adapters/fetch-http-adapter';
import { createControls, type BrowserControl } from './controls';

const STORAGE_PREFIX = 'opencues_runtime:';

// Bake-time defines from esbuild — same data the legacy CueEngine
// reads via DEFAULT_CONFIG. Re-using them keeps a single source of
// truth for the project's cues.md / blanks.md / opencues.md.
declare const __DEFAULT_CUES_MD__: string;
declare const __DEFAULT_BLANKS_MD__: string;
declare const __DEFAULT_OPENCUES_MD__: string;
declare const __DEFAULT_CUE_FOLDERS__: Record<string, string>;
declare const __DEFAULT_CONTROL_FOLDERS__: Record<string, string>;

const ROOT = '/chrome-storage';

// Per-readFile trace logging is OFF by default — at ~20 lines per
// boot it was the loudest thing in DevTools. Gated behind the
// user-facing `debug-mode: on` setting. Flip it via the cue-control
// (`opencues settings _` → cycle debug-mode to `on`) or the CLI
// (`opencues debug on`). Reflects both initial boot state and live
// cycling — chrome.storage.onChanged subscription updates the flag
// without an extension reload.
let _readTrace = false;
function tlog(msg: string): void { if (_readTrace) console.log(msg); }
function parseDebugMode(content: string | null | undefined): boolean {
  return /debug-mode:\s*on\b/i.test(content ?? '');
}
async function refreshReadTraceFromStorage(): Promise<void> {
  try {
    const key = `${STORAGE_PREFIX}${ROOT}/opencues.md`;
    const result = await chrome.storage.local.get(key);
    const v = typeof result[key] === 'string' && result[key].length > 0
      ? result[key]
      : __DEFAULT_OPENCUES_MD__;
    _readTrace = parseDebugMode(v);
  } catch { _readTrace = false; }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const key = `${STORAGE_PREFIX}${ROOT}/opencues.md`;
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

/** Replace the current target's text via direct textContent assignment.
 *
 *  Previous attempt: execCommand('insertText'). That fires a synthetic
 *  input event that tiptap/PM editors handle by reconciling the DOM —
 *  replacing the Text nodes execCommand just inserted with their own.
 *  Direct textContent skips the input-event path, but tiptap's
 *  MutationObserver still reconciles on the next microtask.
 *
 *  Either way, the editor's reconciliation runs AFTER our synchronous
 *  forceRender in the same task. So we schedule a follow-up render on
 *  the next animation frame: by then the microtask drain has run,
 *  tiptap has reconciled, and the re-walk lands on tiptap's Text
 *  nodes — Ranges valid, no flash. See `runtimeRender` for the
 *  rAF-paired follow-up. */
function writeText(text: string): void {
  const target = currentTarget;
  if (!target) return;
  target.focus();
  target.textContent = text;
  // Caret is wiped by textContent assignment; the runtime calls
  // setCursorOffset(cursor) right after this for cycle/blank fills.
  sourceReclassifier.markRuntimeWrite(text);
  // Schedule a post-reconciliation re-render. The current synchronous
  // task continues to the runtime's forceRender (sync, walks DOM as
  // it stands now); on the next frame, after tiptap's MO microtask
  // has reconciled, we re-walk and Ranges land on the new nodes.
  schedulePostReconcileRender();
}

/**
 * Read a config file. Resolution order:
 *   1. Bundled dist/configs/<path> — what `opencues sync chrome` wrote
 *   2. chrome.storage.local — writable state (e.g. popup edits)
 *   3. null — caller falls back to bake-time defaults
 *
 * Runtime paths look like `/chrome-storage/cues.md` or
 * `/chrome-storage/cues/grammar/cue.md`; we strip the ROOT prefix and
 * try it as a bundle asset first.
 */
async function readFile(path: string): Promise<string | null> {
  // 1. Synced bundle (opencues sync chrome --wsl) wins if present.
  const bundled = await readBundledConfig(path);
  if (bundled !== null) {
    tlog(`[opencues] readFile(${path}) ← bundle (${bundled.length} chars)`);
    return bundled;
  }

  // 2. Read-only files (cues.md, blanks.md, folder cues, folder
  //    controls, tips.json): read the bake-time constant direct.
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

  // 3. Writable files (opencues.md — OpenCuesSettingsControl cycles
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
  if (rel === 'opencues.md') return false;       // OpenCuesSettingsControl writes
  if (rel === 'controls.md') return false;       // legacy monolithic; write-safe fallback
  return true;
}

// Resolve a runtime-path to its bake-time constant value.
function readBakeTimeDefault(path: string): string | null {
  if (!path.startsWith(ROOT + '/')) return null;
  const rel = path.slice(ROOT.length + 1);
  if (rel === 'cues.md') return __DEFAULT_CUES_MD__ || null;
  if (rel === 'blanks.md') return __DEFAULT_BLANKS_MD__ || null;
  if (rel === 'opencues.md') return __DEFAULT_OPENCUES_MD__ || null;
  const cueMatch = rel.match(/^cues\/([^/]+)\/cue\.md$/);
  if (cueMatch) return __DEFAULT_CUE_FOLDERS__[cueMatch[1]] ?? null;
  const ctrlMatch = rel.match(/^controls\/([^/]+)\/cue\.md$/);
  if (ctrlMatch) return __DEFAULT_CONTROL_FOLDERS__[ctrlMatch[1]] ?? null;
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

// Read a synced file out of dist/configs/. Path is the runtime's
// canonical form (starts with ROOT). Returns null if not in the bundle.
async function readBundledConfig(runtimePath: string): Promise<string | null> {
  if (!runtimePath.startsWith(ROOT + '/')) return null;
  const rel = runtimePath.slice(ROOT.length + 1); // e.g. "cues/grammar/cue.md"
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
 * `${cwd}/cues` + `${cwd}/controls` to discover folder configs. We
 * don't have a real filesystem, so return the names esbuild baked in
 * from the project's cues/* and controls/* directories.
 */
async function readDir(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null> {
  // Try the bundled index.json first — "what did `opencues sync chrome`
  // actually put there?" — and fall back to the bake-time folder maps
  // for extensions booted without a prior sync.
  const bundled = await readBundledDir(path);
  if (bundled) return bundled;

  if (path === `${ROOT}/cues`) {
    return Object.keys(__DEFAULT_CUE_FOLDERS__).map(name => ({ name, isDirectory: true }));
  }
  if (path === `${ROOT}/controls`) {
    return Object.keys(__DEFAULT_CONTROL_FOLDERS__).map(name => ({ name, isDirectory: true }));
  }
  // ConfigLoader's prewalk descends into each folder name and lists it
  // again expecting a `cue.md` entry. Without this branch the discovery
  // returns 0 controls and BlankFill never matches any keyword.
  const cuesPrefix = `${ROOT}/cues/`;
  const ctrlsPrefix = `${ROOT}/controls/`;
  if (path.startsWith(cuesPrefix)) {
    const folder = path.slice(cuesPrefix.length);
    if (folder && Object.prototype.hasOwnProperty.call(__DEFAULT_CUE_FOLDERS__, folder)) {
      return [{ name: 'cue.md', isDirectory: false }];
    }
  }
  if (path.startsWith(ctrlsPrefix)) {
    const folder = path.slice(ctrlsPrefix.length);
    if (folder && Object.prototype.hasOwnProperty.call(__DEFAULT_CONTROL_FOLDERS__, folder)) {
      return [{ name: 'cue.md', isDirectory: false }];
    }
  }
  return null;
}

// Synthesise a readDir result from the bundled index.json file list.
// Returns null if no bundle is present or the path has no matches.
async function readBundledDir(runtimePath: string): Promise<readonly { name: string; isDirectory: boolean }[] | null> {
  if (!runtimePath.startsWith(ROOT + '/') && runtimePath !== ROOT) return null;
  const prefix = runtimePath === ROOT ? '' : runtimePath.slice(ROOT.length + 1);
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
 * for every read-only config path, and writable files (opencues.md)
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
  /** Finnhub API key for the stocks control. */
  finnhubApiKey?: string;
  /** Custom ticker map for the stocks control. */
  customTickers?: Record<string, string>;
}

// Built lazily inside startOpenCues — needs opts. The dispatcher
// (createControlInvoke) lives in the runtime so all hosts share it.
let controlInvoke: ((spec: ControlInvokeSpec) => ProcessHandle | null) | null = null;

/**
 * Construct the runtime if not already running. Idempotent — second
 * call returns the cached BootResult. Call once at content-script
 * load (after publishTarget has been hooked up).
 */
export function startOpenCues(opts: RuntimeStartOptions = {}): BootResult {
  if (bootResult) return bootResult;

  // CE.8 — build the chrome control registry. The runtime's BlankFill
  // + Cycling dispatch into this via controlInvoke. Prompt-improver
  // is opt-in via llmConfig.
  const controls = createControls({
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
    // reads/writes the seeded opencues.md in chrome.storage.
    opencuesMdReadFile: () => readFile(`${ROOT}/opencues.md`),
    opencuesMdWriteFile: (content) => writeFile(`${ROOT}/opencues.md`, content),
  });
  controlInvoke = createControlInvoke(controls);

  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    const tag = `[opencues][${level}]`;
    if (level === 'error') console.error(tag, msg, data ?? '');
    else if (level === 'warn') console.warn(tag, msg, data ?? '');
    else if (level === 'debug') console.debug(tag, msg, data ?? '');
    else console.log(tag, msg, data ?? '');
  };

  // No seed step — readFile() resolves bake-time constants directly
  // for read-only paths, and writable paths (opencues.md) persist
  // through chrome.storage only when they're actually written.
  bootResult = boot({
    hostVersion: '0.1.0',
    cwd: ROOT,
    getText: () => currentTarget?.textContent ?? '',
    getCursorOffset: readCursorOffset,
    setText: writeText,
    setCursorOffset: writeCursorOffset,
    pushText: (text, cursor) => {
      // writeText already calls sourceReclassifier.markRuntimeWrite.
      // Cursor is set synchronously after so the input-event handler
      // reads the post-fill caret position (matters for multi-word fills).
      writeText(text);
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
    llmEndpoint: opts.llmEndpoint,
    llmDefaultModel: opts.llmDefaultModel,
    llmDebounceMs: opts.llmDebounceMs,
    httpAdapter: opts.llmApiKey ? new FetchHttpAdapter() : undefined,
    // CE.8 — controlInvoke routes blank-fill + cycle script calls to
    // the chrome controls registry above (volume / stocks / weather /
    // hackernews / prompt-improver). Returns null for unknown
    // controls so spawnProcess fallback (which the chrome adapter
    // resolves with exitCode 127) takes over visibly.
    controlInvoke: (spec) => controlInvoke?.(spec) ?? null,
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
    const text = target.textContent ?? '';
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
