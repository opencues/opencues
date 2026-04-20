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
declare const __DEFAULT_TIPS_JSON__: string;

const ROOT = '/chrome-storage';
const TIPS_KEY = `${STORAGE_PREFIX}/chrome-storage/.tips.json`;

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
  const bundled = await readBundledConfig(path);
  if (bundled !== null) return bundled;
  const key = STORAGE_PREFIX + path;
  try {
    const result = await chrome.storage.local.get(key);
    const v = result[key];
    if (typeof v !== 'string') return null;
    // Empty strings break parsers (JSON.parse('') → SyntaxError). Treat
    // them as "no content" so ConfigLoader can fall through to defaults.
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// Cache the bundle's index.json. If no index is present (sync never
// run), cache the absence so we don't hammer chrome.runtime.getURL.
let _bundleIndexCache: { files: Set<string>; loaded: boolean } | null = null;
async function getBundleIndex(): Promise<{ files: Set<string>; loaded: boolean }> {
  if (_bundleIndexCache) return _bundleIndexCache;
  _bundleIndexCache = { files: new Set(), loaded: false };
  try {
    const url = chrome.runtime.getURL('dist/configs/index.json');
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.files)) {
        _bundleIndexCache.files = new Set(data.files.map(String));
        _bundleIndexCache.loaded = true;
      }
    }
  } catch { /* bundle not present — fall back to bake-time */ }
  return _bundleIndexCache;
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
    tipsPath: TIPS_KEY.slice(STORAGE_PREFIX.length),
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
        _bundleIndexCache = null;          // force index.json re-fetch
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
