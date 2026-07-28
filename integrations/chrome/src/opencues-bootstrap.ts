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
import { createTrustGate } from './trust-gate';
import { applySiteCompatFilter as siteFilter } from './site-filter';
import { parseSingleCueMd, listProviders, buildCalendarContextSnapshot } from '@opencues/core';
import { ChromeUserBlank } from './user-blank-loader';
import { createBlankInvoke } from '@opencues/runtime/dist/src/blanks';
import { wordDiff } from '@opencues/runtime/dist/src/modules/word-diff';
import { applyDirectives, clearDirectives, clearInlineNote, consumePushDiag } from './runtime-renderer';
import { applyStatuslinePayload } from './runtime-statusbar';
import { WebSpeechAdapter } from './adapters/web-speech-adapter';
import { FetchHttpAdapter } from './adapters/fetch-http-adapter';
import { setCoreWarn } from '@opencues/core';
import { createBlanks, type BrowserBlank } from './blanks';
import { walkPlainText, plainOffsetOfPosition, domPositionOfPlainOffset } from './dom-walk';

const STORAGE_PREFIX = 'opencues_runtime:';

// Bake-time defines from esbuild. OPENCUES.md holds runtime settings
// (system-wide YAML); per-cue and per-blank source files live in
// __DEFAULT_WORD_CUES__ and __DEFAULT_BLANKS__ (post-layout-migration).
declare const __DEFAULT_OPENCUES_MD__: string;
declare const __DEFAULT_AUDITORS_MD__: string;
declare const __DEFAULT_CUE_FOLDERS__: Record<string, string>;
declare const __DEFAULT_BLANK_FOLDERS__: Record<string, string>;
declare const __DEFAULT_KATA_FOLDERS__: Record<string, string>;

const ROOT = '/chrome-storage';

// Per-readFile trace logging is OFF by default — at ~20 lines per
// boot it was the loudest thing in DevTools. Gated behind the
// user-facing `debug-mode: on` setting. Flip it via the opencues
// settings blank (`opencues settings _` → cycle debug-mode to `on`)
// or the CLI (`opencues debug on`). Reflects both initial boot state
// and live cycling — chrome.storage.onChanged subscription updates
// the flag without an extension reload.
// Logging gate — toggled by `debug-mode: on/off` in ~/.cues/OPENCUES.md
// (settable from any host via `opencues settings _`). When off (the
// default), the page console stays clean: info, debug AND warn lines
// are suppressed. The popup's self-check + connection indicators
// surface the actionable subset (host status, runtime keys,
// provider/model mismatches); raw console noise the user can't act
// on is hidden. Every level still mirrors to /tmp/opencues.log via
// the native host, so the durable record is intact regardless.
//
// Only true errors (console.error) ignore the flag — they signal a
// real failure that the popup can't already represent.
let _readTrace = false;
function tlog(msg: string): void { if (_readTrace) console.log(msg); }

// readFile aggregation — at boot we hit 20-50 files (cues, blanks,
// auditors, OPENCUES.md, etc.). Per-file tlog lines flooded the
// console even when debug-mode is on. Aggregate into a single summary
// that flushes after a 250ms quiet period:
//   [opencues] readFile ×24: bundle×18 baketime×4 storage×1 null×1 (avg 3.4KB)
// `tlogRead` is the new per-readFile call site; the dedicated tlog
// stays available for one-off paths that genuinely want a per-line
// emit. Failures go through log.warn (gated like everything else), never aggregated.
type ReadSource = 'bundle' | 'storage' | 'baketime' | 'merge' | 'null';
const _readCounts: Record<ReadSource, { count: number; totalChars: number }> = {
  bundle: { count: 0, totalChars: 0 },
  storage: { count: 0, totalChars: 0 },
  baketime: { count: 0, totalChars: 0 },
  merge: { count: 0, totalChars: 0 },
  null: { count: 0, totalChars: 0 },
};
let _readFlushTimer: ReturnType<typeof setTimeout> | null = null;
function tlogRead(source: ReadSource, chars: number): void {
  if (!_readTrace) return;
  _readCounts[source].count += 1;
  _readCounts[source].totalChars += chars;
  if (_readFlushTimer) clearTimeout(_readFlushTimer);
  _readFlushTimer = setTimeout(() => {
    let total = 0, totalChars = 0;
    const parts: string[] = [];
    for (const k of Object.keys(_readCounts) as ReadSource[]) {
      const c = _readCounts[k];
      if (!c.count) continue;
      parts.push(`${k}×${c.count}`);
      total += c.count;
      totalChars += c.totalChars;
      _readCounts[k] = { count: 0, totalChars: 0 };
    }
    const avg = total ? Math.round(totalChars / total) : 0;
    const avgStr = avg > 1024 ? `${(avg / 1024).toFixed(1)}KB` : `${avg}c`;
    console.log(`[opencues] readFile ×${total}: ${parts.join(' ')} (avg ${avgStr})`);
    _readFlushTimer = null;
  }, 250);
}
// Strip non-serialisable payload (DOM nodes, circular refs) into a
// shape sendMessage's structured clone can carry. Errors are the
// common case the naive `JSON.parse(JSON.stringify(data))` clobbers:
// `message` / `stack` / `name` are non-enumerable, so stringify
// returns `{}` and the log line carries zero diagnostic info — which
// is exactly how `forceRender failed {}` appeared in the log for
// months. Pull those fields out explicitly first.
function serialiseLogData(data: unknown): unknown {
  if (data === undefined) return undefined;
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  try { return JSON.parse(JSON.stringify(data)); }
  catch { return String(data); }
}

// Forward a log line to the SW → native host → /tmp/opencues.log.
// Fire-and-forget; silently drops when no host listener. We need this
// at module scope so the exported `log` object below can use it from
// outside startOpenCues (e.g. applyMarkdownStyling). Same shape as the
// host-adapter log callback inside startOpenCues.
function mirrorToHostLog(level: 'info' | 'debug' | 'warn' | 'error', args: unknown[]): void {
  const msg = args.map(a => typeof a === 'string' ? a : '').filter(Boolean).join(' ');
  const data = args.find(a => typeof a !== 'string');
  const safeData = serialiseLogData(data);
  try {
    chrome.runtime.sendMessage({ type: 'opencues:log', level, msg, data: safeData })
      .catch(() => { /* no listener */ });
  } catch { /* sendMessage threw */ }
}
export const log = {
  info(...args: unknown[]): void {
    if (_readTrace) console.log(...args);
    mirrorToHostLog('info', args);
  },
  debug(...args: unknown[]): void {
    if (_readTrace) console.debug(...args);
    mirrorToHostLog('debug', args);
  },
  warn(...args: unknown[]): void {
    if (_readTrace) console.warn(...args);
    mirrorToHostLog('warn', args);
  },
  error(...args: unknown[]): void {
    console.error(...args);
    mirrorToHostLog('error', args);
  },
};

// Route @opencues/core's host-agnostic warns (missing provider key,
// unknown provider, custom endpoint, …) through chrome's debug-gated
// logger. Default core behaviour is `console.warn`, which floods the
// devtools console for every page-load with a misconfigured provider
// — visible without any debug opt-in, confusing for users who didn't
// ask for diagnostics. Routing through `log.warn` honours the
// `debug-mode: on/off` scalar in OPENCUES.md.
setCoreWarn((msg) => log.warn(msg));
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
  // Native-messaging host pushed a new bundle. Invalidate the cached
  // index promise + ask the runtime to re-walk every source so the
  // new alts/tips/blanks take effect on the next keystroke.
  //
  // ALSO converge chrome.storage's OPENCUES.md per-key entry to the
  // bundle's value. Without this sync, in-page scalar values written
  // before host install (or written by past versions of the extension
  // that only knew about chrome.storage) would mask the bundle's
  // scalars via mergeOpencuesMd, surfacing as "I edited the file but
  // chrome shows the old value". With host present, the file is the
  // source of truth — storage just caches it.
  if ('opencues_bundle' in changes) {
    _bundleIndexPromise = null;
    const newBundle = changes['opencues_bundle'].newValue as { files?: Record<string, string> } | undefined;
    const bundledOpencuesMd = newBundle?.files?.['OPENCUES.md'];
    if (typeof bundledOpencuesMd === 'string') {
      const key = `${STORAGE_PREFIX}${ROOT}/.cues/OPENCUES.md`;
      void chrome.storage.local.set({ [key]: bundledOpencuesMd }).catch(() => { /* swallow */ });
    }
    if (bootResult) {
      void bootResult.reloadConfig().catch(err => {
        log.warn('[opencues] reloadConfig after bundle push failed', err);
      });
    }
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

/** Called by content.ts when the focused contenteditable changes.
 *
 *  Chrome's normal-input mode (May 2026) attaches to MANY independent
 *  `<input>` / `<textarea>` elements per page — each is its own buffer
 *  with its own word-position semantics. The runtime's per-buffer
 *  state (DynDefs, HighlightState, SpanFillState,
 *  SelectorSatelliteState) is keyed by word-index in the current
 *  buffer, so leftover entries from the prior field silently corrupt
 *  the new one.
 *
 *  Worst observed failure (caught May 2026 testing): user fluid-blanks
 *  `_` on a LinkedIn URL field → DynDef[0] = `https://linkedin.com/...`
 *  with `blankName: 'fluid-blank'`. User tabs to a GitHub URL field on
 *  the same page → types `_` → Resolver's `if (existing.blankName)
 *  continue` guard blocks the new substitution silently. Symptom:
 *  bare `_` returns nothing, `answer _` works (because `answer _` has
 *  `_` at wordIndex 1, not 0).
 *
 *  `bootResult.resetBufferState()` clears the per-buffer state objects
 *  while leaving session-scoped state (agent task, dismissed blanks)
 *  intact. See `packages/opencues-runtime/adapters/chrome/v1/boot.ts`
 *  for the full clear list + rationale per object.
 *
 *  Skip the reset when there's no change of element (el === currentTarget)
 *  — focusin can fire spuriously during typing in some sites and we
 *  don't want to clear state on those.
 */
/** True between a blur (suspendTarget) and the next focus. While suspended the
 *  buffer's per-buffer state (DynDefs = cue spans) is PRESERVED — we just hid
 *  the paint — so refocusing the SAME element reuses the result. The guard
 *  keeps a stray render from painting a blurred field. */
let _suspended = false;

/** Focus left the buffer but we are NOT dropping its state. Hide the paint and
 *  mark suspended; the DynDefs survive so a refocus of the same element repaints
 *  the already-computed spans instead of re-resolving. A focus change to a
 *  DIFFERENT element still resets + re-resolves via publishTarget. */
export function suspendTarget(): void {
  _suspended = true;
  clearDirectives();
}

export function publishTarget(el: HTMLElement | null): void {
  if (el === currentTarget) {
    // Same buffer refocused after a suspend — its DynDefs (cue spans) were
    // preserved, so un-suspend and repaint the existing result. No reset, no
    // re-resolve: reuse what we already computed (no extra LLM calls).
    if (el) { _suspended = false; runtimeRender(); }
    return;
  }
  _suspended = false;
  currentTarget = el;
  if (bootResult) bootResult.resetBufferState();
  // Genuine change to a DIFFERENT (or first) buffer. resetBufferState() wiped
  // the DynDefs and the resolver only runs on a text change, so re-feed the
  // buffer to re-register cues immediately (also makes a pre-existing draft
  // show cues without a keystroke). resetBufferState() zeroed the resolver's
  // _lastInputText, so the identical text isn't deduped by `text === prev`.
  // The blank `_`-trigger only fires on a buffer that ENDS with `_`, so `_`-
  // free prose (every passive cue) re-registers with no side effect. Normal
  // inputs (no paint surface) + empty buffers skip.
  if (el && bootResult && !isNormalInput(el)) {
    try {
      const text = walkPlainText(el).text;
      if (text.trim().length > 0) {
        notifyOpenCuesTextChange(text, readCursorOffset(), 'user');
      }
    } catch { /* DOM not readable this tick — next text change resolves */ }
  }
}

/** Called by content.ts when a `beforeinput` event signals the focused
 *  buffer is about to be mutated outside the runtime's `setText` /
 *  `pushText` pipeline. The triggering inputTypes today:
 *
 *    historyUndo           — Ctrl+Z / Cmd+Z / Edit-menu Undo
 *    historyRedo           — Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y / Edit-menu Redo
 *    insertFromPaste       — Ctrl+V / right-click→Paste / middle-click on Linux
 *                            (paste-event-trusted gating is done upstream)
 *    insertCompositionText — CJK / IME composition commit (each composed
 *                            chunk is owned by the browser, not the runtime)
 *
 *  In every case the post-mutation text reflects content the runtime
 *  didn't author, so the per-buffer state objects (`DynDefs`,
 *  `HighlightState`, `SpanFillState`, `SelectorSatelliteState`) anchor
 *  to character offsets that no longer correspond to the buffer the
 *  user is now editing. Without this wipe, the next cycle splices
 *  against stale offsets, the next dim repaints against a phantom
 *  span, or the next blank fill blocks on a leftover `blankName`
 *  entry from before the undo. Same failure class as the focus-change
 *  bug `publishTarget` fixes, different trigger.
 *
 *  Session-scoped state (`AgentTaskState`, `dismissedBlanks`)
 *  intentionally survives — an armed `agentically X _` task should
 *  outlive Ctrl+Z so the user can experiment without re-arming. Per-
 *  state-object rationale: `docs/architecture/universal-integration.md`
 *  § "Per-buffer state must reset on focus change" (same wipe set
 *  applies to both triggers).
 *
 *  No-op when boot hasn't completed yet (rare race during initial
 *  attach) or there's no current target (event fired against an
 *  unattached field).
 */
export function notifyBufferReplacedExternally(): void {
  if (!bootResult) return;
  bootResult.resetBufferState();
}

// Tracks an undo/redo edit window. When set, the next input event(s) within
// EXTERNAL_REPLACE_WINDOW_MS are reclassified to source='runtime' so the
// resolver and BlankFill skip them — restored `_` characters from a Ctrl+Z
// must not fire the blank pipeline (the user didn't TYPE them; they came
// back via history). Trust-gate baseline updates via the isRuntimeWrite
// path so subsequent real user `_` typing is still gated correctly.
//
// Distinct from paste/IME (which stay source='user' — those ARE user
// intent). Set by notifyExternalReplaceUndo, consumed in
// notifyOpenCuesTextChange.
const EXTERNAL_REPLACE_WINDOW_MS = 250;
let _externalReplaceUntil = 0;

/** Stronger sibling of notifyBufferReplacedExternally — wired to
 *  historyUndo/historyRedo (beforeinput) and Ctrl+Z/Ctrl+Y keydown.
 *  Resets per-buffer state AND opens a brief window during which input
 *  events get reclassified to 'runtime' so a restored `_` does not
 *  re-trigger blank fill. Also wipes pending trust-gate credits — any
 *  credit the user earned with the original `_` keypress was already
 *  consumed by the substitution they just undid; carrying it forward
 *  would let the restored `_` fund itself. */
export function notifyExternalReplaceUndo(): void {
  if (!bootResult) return;
  bootResult.resetBufferState();
  trustGate.resetCredits();
  _externalReplaceUntil = Date.now() + EXTERNAL_REPLACE_WINDOW_MS;
}

/** Real-time API-key update — called by content.ts when chrome.storage
 *  reports a host-push or popup-save changed the LLM key bag. The
 *  runtime's BootResult exposes `updateApiKeys` which mutates the
 *  resolver's live apiKeys ref and force-rebuilds sources, so the
 *  next LLM dispatch uses the new credentials without a tab reload.
 *
 *  No-op when boot hasn't completed yet (rare race — content.ts
 *  schedules updates after `startOpenCues` returns). Also no-op if
 *  the runtime didn't construct a resolver at boot (the user had no
 *  keys at all); that case requires a tab reload to wire the
 *  resolver up fresh, and we surface a warn via the runtime side. */
export function updateRuntimeApiKeys(newKeys: Readonly<Record<string, string>>): void {
  // Keep the model blank's live key ref in step with the resolver —
  // assigned BEFORE the boot guard so a pre-boot push still lands.
  _liveLlmKeys = newKeys;
  if (!bootResult) return;
  bootResult.updateApiKeys(newKeys);
}

/** Live LLM key bag for the `model` blank's effective-routing walk.
 *  Seeded from boot opts in startOpenCues; replaced wholesale by
 *  updateRuntimeApiKeys on every host-push / popup-save so the blank
 *  answers from current credentials without a tab reload. */
let _liveLlmKeys: Readonly<Record<string, string | undefined>> | null = null;

/** Real-time provider/model/endpoint update — called by content.ts
 *  when the popup saves a change to those fields. Mirrors
 *  `updateRuntimeApiKeys` (same in-place mutate + rebuildResolver
 *  pattern on the runtime side). Pass empty strings to clear an
 *  override and fall back to OPENCUES.md scalars. */
export function updateRuntimeLlmConfig(patch: {
  provider?: string;
  model?: string;
  endpoint?: string;
}): void {
  if (!bootResult) return;
  bootResult.updateLlmConfig(patch);
}

/** Editors that own their contenteditable as a fully-managed surface
 *  (their model is the source of truth, DOM is rendered output, and
 *  their MutationObserver REVERTS direct text-node mutations that
 *  span multiple blocks or don't match expected shape). Detected on
 *  the target's ancestry so per-call routing can choose the
 *  editor-API path instead of the generic in-place splice. */
function isManagedEditor(el: HTMLElement): boolean {
  return !!el.closest(
    '[data-lexical-editor="true"], .ProseMirror, [data-slate-editor="true"], .public-DraftEditor-content, .ql-editor'
  );
}

/** Normal `<input>` / `<textarea>` mode. CSS Custom Highlights don't
 *  paint on these (browsers render input value via internal text
 *  layout, not DOM text nodes), so cues are not surfaced — but blanks
 *  still work via `.value` mutation + an `input` event dispatch. See
 *  `docs/features/chrome-normal-inputs.md` for the supported subset.
 *
 *  Sensitive-input exclusion: we DO NOT attach to password fields, OTP
 *  one-time codes, payment fields (autocomplete=cc-*), or anything the
 *  page has marked autocomplete="new-password" / similar. The runtime
 *  would be reading + writing the user's credentials/PII through the
 *  LLM pipeline — a clear no. `autocomplete="off"` is only sensitive
 *  when the field or its form also looks credential/payment-related;
 *  generic search boxes commonly use it and must remain attachable.
 *  Defensive heuristic for name/id is layered on top of the formal type
 *  + autocomplete signal.
 *
 *  Allowed input types: text, email, search, url. Textarea always
 *  allowed. Everything else (number, date, tel, color, hidden,
 *  password, etc.) skipped — semantic inputs would have surprising
 *  fill behaviour. */
export function isNormalInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !isSensitiveField(el);
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    if (t !== 'text' && t !== 'email' && t !== 'search' && t !== 'url') return false;
    if (isSensitiveField(el)) return false;
    return true;
  }
  return false;
}

/** Defensive heuristic: should we refuse to attach to this field even
 *  though its `type=` is allowed? Triggers on:
 *  - autocomplete tokens for credentials / payment / OTP
 *  - name/id substring match for password / cvv / ssn / pin / otp /
 *    secret / token / api[-_]?key
 *
 *  The autocomplete check is the formal signal (pages following web
 *  standards mark these correctly); the name/id heuristic is the
 *  fallback for pages that don't bother. False positives (e.g. a
 *  search box named "search-token") are acceptable trade-offs vs the
 *  risk of feeding credentials through an LLM. */
/**
 * Sensitive-field autocomplete tokens. Match a field's
 * `autocomplete="X"` attribute against these (per the WHATWG
 * autofill spec) and refuse attach when one matches. SINGLE SOURCE
 * OF TRUTH for the autocomplete deny-list — every doc that
 * enumerates these should reference this export, not re-list them.
 * See docs/architecture/chrome-security.md § Sensitive-field gate.
 */
export const SENSITIVE_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set<string>([
  'current-password', 'new-password', 'one-time-code',
  'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
  'cc-csc', 'cc-name', 'cc-given-name', 'cc-family-name',
]);

/**
 * Name/id heuristic regex — case-insensitive word-boundary match
 * against credential-related tokens. The fallback for pages that
 * don't honour the autocomplete spec. SINGLE SOURCE OF TRUTH; every
 * doc that quotes the token list should link to this export.
 */
export const SENSITIVE_FIELD_NAME_PATTERN: RegExp =
  /\b(password|passwd|pwd|cvv|cvc|ssn|sin|pin|otp|secret|token|api[_-]?key|access[_-]?key|auth)\b/;

/**
 * Extra context used only for `autocomplete="off"`.
 *
 * Many normal search boxes set autocomplete=off, so treating that token
 * as a hard deny-list entry blocks legitimate OpenCues use. We still
 * honour it for likely payment/account forms by checking nearby field
 * and form metadata for high-signal sensitive terms.
 */
export const SENSITIVE_AUTOCOMPLETE_OFF_CONTEXT_PATTERN: RegExp =
  /\b(card|cardnumber|card-number|credit|debit|payment|billing|bank|account|iban|routing|sort-code|sortcode|security|verification|2fa|mfa)\b/;

function isSensitiveField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  // Comma- or space-separated tokens per spec.
  const tokens = autocomplete.split(/[\s,]+/).filter(Boolean);
  for (const tok of tokens) {
    if (SENSITIVE_AUTOCOMPLETE_TOKENS.has(tok)) return true;
  }
  // Name/id heuristic — case-insensitive substring match against
  // sensitive patterns. Captures sites that don't use autocomplete=*.
  const name = (el.getAttribute('name') || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const haystack = name + '|' + id;
  if (SENSITIVE_FIELD_NAME_PATTERN.test(haystack)) {
    return true;
  }
  // Bank/payment forms sometimes set autocomplete="off" on the whole
  // form. Generic site search boxes do too, so require an additional
  // sensitive-context signal before refusing. The input's own name/id
  // are part of the haystack — `SENSITIVE_FIELD_NAME_PATTERN` (above)
  // only matches credential tokens (password/cvv/otp/secret/…); a
  // `name="account-number"` or `name="iban"` field would otherwise
  // slip through with `autocomplete=off` and no surrounding context.
  if (tokens.includes('off')) {
    const form = el.form;
    const context = [
      name,
      id,
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('aria-describedby') || '',
      form?.id || '',
      form?.getAttribute('name') || '',
      form?.className || '',
      form?.getAttribute('aria-label') || '',
    ].join('|').toLowerCase();
    if (SENSITIVE_AUTOCOMPLETE_OFF_CONTEXT_PATTERN.test(context)) return true;
  }
  return false;
}

/**
 * Gather sanitized ambient context for the currently focused field.
 * Returns null when:
 *   - No target is focused
 *   - The target is a sensitive field (password / CC / OTP)
 *   - Nothing usable can be read (all fields empty)
 *
 * SCOPE — single-field metadata + page-level metadata only. NO sibling
 * field labels, NO sibling field values. The adjacent "email" input
 * next to the focused `_` field does not appear here.
 *
 * The runtime gates this method via the `ambient-context-mode` scalar
 * BEFORE calling — when off, we never get here. This gatherer is also
 * called only when the bootstrap-level feature is enabled (chrome
 * surfaces it via `getAmbientContext` only when the runtime asks).
 *
 * Sanitization (NFKC + length caps + sentinel escape) happens
 * core-side in `renderAmbientBlock`. We return raw-but-trimmed values
 * here; the trust boundary is at the core, not at the gatherer.
 */
export function gatherAmbientContext(target: HTMLElement | null): {
  label?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescription?: string;
  inputType?: string;
  pageTitle?: string;
  pageUrl?: string;
  pageDescription?: string;
} | null {
  if (!target) return null;

  // Sensitive-field exclusion — passwords/CC/OTP/etc never get an
  // ambient block built. The cycleability gate already prevents the
  // runtime from attaching to these, but be defence-in-depth here:
  // a future code path that surfaces ambient context outside the
  // attach gate would still skip them.
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (isSensitiveField(target)) return null;
  }

  const out: Record<string, string> = {};

  // Field-level metadata.
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const ph = target.getAttribute('placeholder');
    if (ph) out.placeholder = ph;
    if (target instanceof HTMLInputElement) {
      out.inputType = (target.type || 'text').toLowerCase();
    } else {
      out.inputType = 'textarea';
    }
  } else {
    out.inputType = 'contenteditable';
  }

  const aria = target.getAttribute('aria-label');
  if (aria) out.ariaLabel = aria;
  const ariaDesc = target.getAttribute('aria-description');
  if (ariaDesc) out.ariaDescription = ariaDesc;
  const ariaLabelledBy = target.getAttribute('aria-labelledby');
  if (ariaLabelledBy && !aria) {
    // Resolve aria-labelledby IDs into a concatenated string. Spec
    // allows multiple IDs space-separated.
    const ids = ariaLabelledBy.split(/\s+/).filter(Boolean);
    const parts: string[] = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el?.textContent) parts.push(el.textContent.trim());
    }
    if (parts.length) out.ariaLabel = parts.join(' ');
  }

  // `<label for>` resolution.
  if (target.id) {
    const lbl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(target.id)}"]`);
    if (lbl?.textContent) out.label = lbl.textContent.trim();
  }
  // Wrapping `<label>` resolution. Only checked when explicit `for=`
  // didn't find one.
  if (!out.label) {
    let walk: HTMLElement | null = target;
    for (let i = 0; i < 4 && walk; i++) {
      if (walk instanceof HTMLLabelElement) {
        // Strip the input's own text from the label (e.g. textContent
        // includes the input's placeholder echo).
        const labelText = (walk.textContent || '').replace(/\s+/g, ' ').trim();
        if (labelText) out.label = labelText;
        break;
      }
      walk = walk.parentElement;
    }
  }

  // Page-level metadata.
  try {
    if (document.title) out.pageTitle = document.title;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (meta?.content) out.pageDescription = meta.content;
    // Origin + pathname only. Query string + fragment stripped here
    // even though the core re-strips defensively — better to never
    // ship sensitive query-string tokens (auth tokens, search terms)
    // over the wire even momentarily.
    out.pageUrl = location.origin + location.pathname;
  } catch {
    // location/document access can throw in some sandboxed contexts;
    // omit page-level fields rather than crash the gatherer.
  }

  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Read the plain text of whichever kind of target is focused.
 *  Inputs surface `.value`; contenteditables walk the DOM. */
export function readTargetText(target: HTMLElement): string {
  if (isNormalInput(target)) return target.value;
  return walkPlainText(target).text;
}

/** Write `.value` through the native prototype setter — frameworks
 *  (React/Vue/Svelte) stash a tracker on the setter that watches for
 *  programmatic writes, then suppress their re-render unless the
 *  tracker sees the change. The naive `el.value = x` bypasses the
 *  setter on tracked inputs. Dispatching 'input' + 'change' is then
 *  what cues the framework's onChange handler — synthetic events are
 *  isTrusted=false so the document-level input listener filters them
 *  out (no double-notify), but the framework's own event system runs
 *  on the captured handler regardless. */
function writeNormalInputValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  // NO `sourceReclassifier.markRuntimeWrite(text)` here — deliberately.
  // The synthetic `input` event below is `isTrusted=false`, so content.ts's
  // input listener drops it (the trust gate) and it NEVER round-trips to
  // `notifyOpenCuesTextChange`. So on a normal `<input>`/`<textarea>` there
  // is no runtime-write DOM echo to reclassify — marking here could only
  // ever seed the reclassifier's `recent` list with short runtime-written
  // strings that then FALSE-MATCH a later real keystroke. That is exactly
  // what silently swallowed the user's `_`: the loading-animation blank
  // writes its bounce frame `'_'` (BOUNCE_FRAMES[0]) as a runtime write, and
  // within RUNTIME_WRITE_TTL_MS (1.5s) the next real `_` matched it, got
  // reclassified `runtime`, and the resolver skipped the blank (runtime
  // writes must never fire blanks). Delete+retype "fixed" it only because
  // the stale frame had aged out. Managed editors (Gmail/Reddit/PM/Quill/
  // Draft) write through different paths that DO fire trusted echoes and
  // legitimately keep their own markRuntimeWrite — this omission is scoped
  // to the normal-input path.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  log.info('[opencues][normal-input] writeValue: newLen=' + text.length);
}

function isLexicalEditor(el: HTMLElement): boolean {
  return !!el.closest('[data-lexical-editor="true"]');
}

function isDraftJsEditor(el: HTMLElement): boolean {
  return !!el.closest('.public-DraftEditor-content');
}

/** LinkedIn messaging composer (`<div class="msg-form__contenteditable" ...>`).
 *  No public marker for the underlying editor framework (LinkedIn ships a
 *  private build). Empty-state shape is `<p><br></p>` and the Send button
 *  is driven by React state that only flips when the editor's input
 *  pipeline observes content. Generic `execCommand('insertHTML')` lands
 *  the DOM but doesn't trip React's state — Send stays disabled even
 *  though text is visible. The carve-out below uses per-line
 *  `execCommand('insertText')` + `insertParagraph`, which fire trusted
 *  `beforeinput`/`input` events whose `inputType` is the same shape real
 *  typing produces — React's listener catches them and flips the state. */
function isLinkedInMessaging(el: HTMLElement): boolean {
  return !!el.closest('.msg-form__contenteditable');
}

function isQuillEditor(el: HTMLElement): boolean {
  return !!el.closest('.ql-editor');
}

/**
 * Narrower variant: the SPECIFIC Quill instance LinkedIn ships in its
 * share composer (the post-creation modal at the top of the feed).
 * That's the surface PR #125 disabled agent-rewrite on — Delta-model
 * + MutationObserver fighting the multi-tick replaceAllText path.
 *
 * Comment boxes ARE Quill too but they live in a different DOM context
 * (`.comments-comment-box`, `.comments-comment-texteditor`, …) with a
 * different lifecycle and don't show the same caret-snap bug at agent
 * cadence. Without the narrowing, "agentically X _" in a LinkedIn
 * comment was silently wiped instead of running — symptom reported
 * 2026-06-12.
 *
 * Detection markers (any one is sufficient — LinkedIn ships multiple
 * variants of the share composer DOM across A/B rollouts):
 *   - `.share-creation-state`         — modal share composer wrapper
 *   - `.share-box-feed-entry__form`   — inline "Start a post" surface
 *   - `.share-box`                    — broadest historical class; covers
 *                                       the legacy widget shape too.
 *
 * Any `.ql-editor` outside one of those ancestors (today: comment boxes,
 * messaging compose, article editor) is treated as agent-rewrite-eligible.
 * If a different Quill site later reproduces the same caret-snap class
 * of bug, add its detection marker here.
 */
function isLinkedInShareComposerQuill(el: HTMLElement): boolean {
  if (!el.closest('.ql-editor')) return false;
  return !!(
    el.closest('.share-creation-state') ||
    el.closest('.share-box-feed-entry__form') ||
    el.closest('.share-box')
  );
}

/** Walk up from a `.ql-editor` to find the Quill editor instance. Quill
 *  stashes itself on the container element (`.ql-container`) as
 *  `__quill`. Falls back to checking the immediate root + walking
 *  ancestors. Returns null if the instance isn't reachable (Quill
 *  was destroyed, or LinkedIn's bundle uses a custom private name). */
type QuillInstance = {
  setText: (text: string, source?: string) => unknown;
  setContents?: (delta: unknown, source?: string) => unknown;
  getLength?: () => number;
  getSelection?: (focus?: boolean) => { index: number; length: number } | null;
  root?: HTMLElement;
  clipboard?: { dangerouslyPasteHTML?: (html: string, source?: string) => unknown };
};
function findQuillInstance(el: HTMLElement): QuillInstance | null {
  const editor = el.closest('.ql-editor') as HTMLElement | null;
  if (!editor) return null;
  // Common location: on the .ql-container element (the editor's parent).
  const container = editor.closest('.ql-container') as HTMLElement | null;
  const probes = [container, editor.parentElement, editor];
  for (const node of probes) {
    if (!node) continue;
    const inst = (node as unknown as { __quill?: QuillInstance }).__quill;
    if (inst && typeof inst.setText === 'function') return inst;
  }
  return null;
}

/** In-place hunk-level mutation for Quill targets.
 *
 *  Uses the runtime's `wordDiff` to split the old → new buffer change
 *  into a sequence of small, targeted hunks (typically word-level for
 *  agent-rewrite). For each hunk, find the SINGLE text-node segment
 *  whose plain range contains it and splice in the replacement via a
 *  direct `.data` assignment. Apply right-to-left so the unchanged
 *  positions in earlier segments stay valid as we mutate later ones.
 *
 *  This is the structural equivalent of how transform-blank works on
 *  Quill — a small targeted change inside one text node, picked up by
 *  Quill's MutationObserver, fed into its Delta model, with Quill's
 *  internal selection shifting naturally for inserts/deletes before
 *  the cursor. Cursor preservation comes for free because we only
 *  touch text nodes that actually need to change; nodes containing
 *  the caret are either untouched OR mutate with the caret offset
 *  riding along.
 *
 *  Returns `true` when every hunk could be applied as a single-segment
 *  splice. Returns `false` (DOM untouched) if any hunk spans multiple
 *  segments — that means the change crosses a `<p>` boundary (e.g.
 *  the LLM joined two paragraphs by removing a `\n`) or hits inline
 *  formatting we can't safely traverse. Caller falls back to the
 *  legacy select-all + per-line storm. The fallback is destructive
 *  to cursor but acceptable for paragraph-restructuring cases (rare
 *  during agent-rewrite, common for `draft email _`).
 *
 *  Why hunk-level granularity (vs. paragraph or line-level earlier
 *  attempts): agent-rewrite typically produces multiple INDEPENDENT
 *  small changes scattered across the buffer. A prefix/suffix LCP
 *  diff would compute one big change region covering everything from
 *  the first changed word to the last (potentially spanning paragraphs
 *  via `\n`), forcing routing to the destructive storm. `wordDiff`
 *  returns separate hunks for separate changes — each hunk small
 *  enough to fit in one text node. */
/** Module-level signal: was the most recent `diffWriteText` /
 *  `replaceAllText` handled by an in-place text-node mutation path that
 *  naturally preserves the user's caret position? `pushText` reads this
 *  to decide whether to fire an explicit `reapplyCursor` afterwards.
 *
 *  Why this exists: agent-rewrite passes a cursor value derived from
 *  `translateCursor(cursorBefore, ...)` where `cursorBefore` is
 *  `chrome.readCursorOffset()`. On LinkedIn's Quill share composer
 *  `window.getSelection()` regularly lands outside `.ql-editor` between
 *  events (Quill's private bundle parks selection in a scratch location
 *  during idle), so `readCursorOffset` returns 0 and the runtime
 *  propagates 0 through. The in-place hunk fast path correctly mutates
 *  the buffer AND preserves the user's actual caret via browser
 *  text-node-offset preservation — but a follow-up `reapplyCursor(0)`
 *  then drags the caret to start-of-buffer, exactly the symptom users
 *  reported. Setting this flag tells `pushText` to trust the fast
 *  path's natural cursor preservation and skip the explicit move. */
let _diffPreservedCursor = false;

function quillInPlaceUpdate(target: HTMLElement, newText: string): boolean {
  const { text: currentText, segments } = walkPlainText(target);
  if (currentText === newText) {
    _diffPreservedCursor = true;
    return true;
  }

  const hunks = wordDiff(currentText, newText);
  if (hunks.length === 0) {
    _diffPreservedCursor = true;
    return true;
  }

  // Pre-flight: every hunk must fit cleanly inside a single Text-node
  // segment. Collect mutations atomically so we never half-apply.
  // Apply right-to-left below so the earlier hunks' segment-relative
  // offsets stay valid (later mutations don't shift earlier ranges).
  type Mut = { node: Text; startOff: number; endOff: number; replacement: string };
  const muts: Mut[] = [];
  for (const h of hunks) {
    let foundSeg: { node: Node; plainStart: number; plainEnd: number } | null = null;
    for (const s of segments) {
      // A hunk that's a pure insertion (aStart === aEnd) needs a
      // segment whose range CONTAINS that point. A hunk with extent
      // needs a segment that fully contains the [aStart, aEnd) range.
      const overlaps = h.aStart === h.aEnd
        ? (s.plainStart <= h.aStart && s.plainEnd >= h.aStart)
        : (s.plainStart <= h.aStart && s.plainEnd >= h.aEnd);
      if (overlaps) {
        if (foundSeg !== null) return false;
        foundSeg = s;
      }
    }
    if (foundSeg === null) return false;
    if (foundSeg.node.nodeType !== Node.TEXT_NODE) return false;

    const node = foundSeg.node as Text;
    const startOff = h.aStart - foundSeg.plainStart;
    const endOff = h.aEnd - foundSeg.plainStart;
    if (startOff < 0 || endOff > node.data.length) return false;
    muts.push({ node, startOff, endOff, replacement: h.replacement });
  }

  // Apply right-to-left. Same node may receive multiple mutations
  // (e.g. two corrections in the same paragraph); processing
  // right-to-left keeps the left ones' offsets valid because we
  // haven't disturbed text to the left of them yet.
  for (let i = muts.length - 1; i >= 0; i--) {
    const m = muts[i];
    const before = m.node.data.slice(0, m.startOff);
    const after = m.node.data.slice(m.endOff);
    const newData = before + m.replacement + after;
    if (m.node.data !== newData) m.node.data = newData;
  }
  _diffPreservedCursor = true;
  return true;
}

/**
 * Read the caret offset (in plain-text characters) from the current
 * contenteditable. Returns 0 when no target or no selection.
 *
 * Quill fallback (LinkedIn share composer): LinkedIn ships a private
 * Quill bundle whose Selection module doesn't reliably propagate its
 * internal cursor model to `window.getSelection()` between events —
 * the browser selection's `startContainer` regularly lands OUTSIDE
 * the `.ql-editor` between user actions, which used to make this
 * function return 0 via the "outside target" guard. The agent-rewrite
 * tick then captured cursorBefore=0, the runtime's
 * `AgentRewrite.translateCursor` propagated 0 through its hunk-delta
 * math (no hunks before position 0 to shift the cursor positive), and
 * `pushText(text, 0)` landed the caret at start-of-buffer on every
 * ~1500ms debounce — visible as "cursor jumps to start" while typing.
 *
 * Fix: cache the last cursor we successfully read for each target,
 * populated on every `selectionchange` the user fires (see
 * `cacheValidCursor` callers in content.ts). When
 * `window.getSelection()` has wandered, return the cache instead of
 * the misleading 0. Non-Quill editors are unaffected — their
 * `window.getSelection()` is reliable so the fallback path never
 * fires for them.
 */
const _lastValidCursor = new WeakMap<HTMLElement, number>();

export function cacheValidCursor(target: HTMLElement, offset: number): void {
  if (offset >= 0) _lastValidCursor.set(target, offset);
}

let _cursorFallbackLoggedAt = 0;
// Was the LAST readCursorOffset a fresh, real read (true) or a fabricated
// fallback because the caret couldn't be mapped (false)? runtimeRender reads
// this immediately after to decide whether the cursor-gated note + auto-select
// can be trusted. On LinkedIn Posts (Quill parks the browser selection outside
// .ql-editor AND hides its instance) every read is a fallback, so the note is
// suppressed rather than painted at a bogus offset. Assume reliable until a
// read proves otherwise (default true keeps every well-behaved editor unchanged).
// Whether the LAST readCursorOffset returned a fresh real read (true) or a
// fabricated fallback because the caret couldn't be mapped (false). Kept as a
// diagnostic signal; no rendering gate consumes it right now (the LinkedIn-Posts
// note-suppression + caret-disable were removed 2026-07 to observe raw output).
let _lastCursorReliable = true;
export function lastCursorReliable(): boolean { return _lastCursorReliable; }

function readCursorOffset(): number {
  const target = currentTarget;
  if (!target) { _lastCursorReliable = false; return 0; }
  if (isNormalInput(target)) { _lastCursorReliable = true; return target.selectionStart ?? 0; }
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (target.contains(range.startContainer)) {
      const offset = plainOffsetOfPosition(target, range.startContainer, range.startOffset);
      _lastValidCursor.set(target, offset);
      _lastCursorReliable = true;
      return offset;
    }
    // Selection landed OUTSIDE our target. For Quill (LinkedIn's private bundle
    // parks window.getSelection() outside .ql-editor between events) read
    // Quill's OWN selection model — authoritative and real-time, unlike the
    // lagging cache the browser-selection fallback would otherwise return.
    // Quill's index counts each char incl. `\n`, matching walkPlainText's plain
    // offset for prose. This is what lets the cursor-gated inline note track the
    // caret on LinkedIn Posts instead of reading a stale offset.
    let quillReason = '';
    if (isQuillEditor(target)) {
      try {
        const q = findQuillInstance(target);
        if (!q) quillReason = 'no-instance';
        else if (typeof q.getSelection !== 'function') quillReason = 'no-getSelection';
        else {
          const qs = q.getSelection();
          if (qs && typeof qs.index === 'number' && qs.index >= 0) {
            _lastValidCursor.set(target, qs.index);
            _lastCursorReliable = true;
            const now = Date.now();
            if (now - _cursorFallbackLoggedAt > 1000) {
              _cursorFallbackLoggedAt = now;
              log.debug('[chrome] cursorQuillNative', { index: qs.index });
            }
            return qs.index;
          }
          quillReason = 'qs-null';
        }
      } catch (e) { quillReason = 'threw:' + String((e as Error)?.message ?? e).slice(0, 40); }
    }
    // Still can't map the caret → fall back to the cache/0 (which makes
    // cursor-gated features mis-fire). Diagnose WHY: shadow DOM? a wrong attach
    // target? Quill instance unreachable? Throttled so the hot path isn't spammed.
    try {
      const now = Date.now();
      if (now - _cursorFallbackLoggedAt > 1000) {
        _cursorFallbackLoggedAt = now;
        const anchor = range.startContainer as Node & { getRootNode?: () => Node };
        const root = anchor.getRootNode ? anchor.getRootNode() : null;
        const anchorEl = (anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor) as HTMLElement | null;
        // Identify the anchor: is the caret actually in a DIFFERENT editable we
        // should have attached to? Capture its class/id, whether it's an
        // ancestor/descendant of our target, its own contenteditable ancestor,
        // and whether it lives under a SEPARATE .ql-editor.
        const ceAncestor = anchorEl?.closest('[contenteditable="true"], [contenteditable=""]') as HTMLElement | null;
        const otherQl = anchorEl?.closest('.ql-editor') as HTMLElement | null;
        log.debug('[chrome] cursorReadFallback', {
          anchorNode: (anchor as Node).nodeName,
          anchorClass: (anchorEl?.className || '').slice(0, 60),
          anchorId: (anchorEl?.id || '').slice(0, 40),
          anchorContainsTarget: !!anchorEl && anchorEl.contains(target),
          targetContainsAnchorEl: !!anchorEl && target.contains(anchorEl),
          anchorCeClass: (ceAncestor?.className || '').slice(0, 60),
          anchorCeIsTarget: ceAncestor === target,
          anchorOtherQl: !!otherQl && otherQl !== target,
          anchorInShadow: typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot,
          targetTag: target.tagName,
          targetClass: (target.className || '').slice(0, 60),
          quillReason: quillReason || null,
        });
      }
    } catch { /* diagnostic must never throw */ }
  }
  // No fresh read was possible — the returned value is a fabricated fallback.
  _lastCursorReliable = false;
  return _lastValidCursor.get(target) ?? 0;
}

/** Move the caret to the given plain-text offset within the current target.
 *  Offsets agree with walkPlainText's coordinates: each BR / block-boundary
 *  \n consumes one offset character even though no Text node holds it.
 *
 *  Managed editors (Lexical, ProseMirror/TipTap, Slate) own their cursor
 *  via internal selection models that sync model→DOM, never the other
 *  way. For SINGLE-segment in-place splices the editor naturally keeps
 *  the caret at its prior character offset within the mutated node —
 *  so on those splices we no-op here. Internal callers (diffWriteText
 *  after a single-segment splice) leave `force=false` so the editor's
 *  natural behavior wins.
 *
 *  Runtime-driven cursor jumps (transform-blank substitution → set
 *  cursor at end of new buffer past preserved separators) MUST be
 *  honored even on managed editors. Those callers pass `force=true` to
 *  bypass the early bail. Managed editors usually accept browser
 *  Selection on end-of-content positions during reconcile. */
function writeCursorOffset(offset: number, force: boolean = false): void {
  const target = currentTarget;
  if (!target) return;
  if (isNormalInput(target)) {
    const o = Math.max(0, Math.min(offset, target.value.length));
    target.setSelectionRange(o, o);
    return;
  }
  if (isManagedEditor(target) && !force) return;
  const sel = window.getSelection();
  if (!sel) return;
  // Use the proper plain-offset-to-DOM-position resolver. Handles all
  // three cases that used to be broken: inside text nodes, at virtual
  // \n boundaries (BR / block edges), and past the entire plain-text
  // length (trailing empty <div><br></div> blocks that have no text
  // nodes). Before this we'd fall through to "end of last text node"
  // which left the caret BEFORE the trailing structure — perceived as
  // a backward cursor jump.
  const pos = domPositionOfPlainOffset(target, Math.max(0, offset));
  const range = document.createRange();
  try { range.setStart(pos.node, pos.offset); }
  catch {
    // Defensive: if the offset is out of range for the chosen
    // container (browser-quirk edge case), anchor at end of target.
    range.selectNodeContents(target);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Re-apply the caret in a microtask + on the next frame.
 *
 *  Why microtask, not sync: LinkedIn's Quill share composer intercepts
 *  every `execCommand('insertText'|'insertParagraph')` via a
 *  `beforeinput` handler that `preventDefault`s the browser action and
 *  applies the change through its own Delta model. The model commit +
 *  DOM rerender is scheduled as a microtask, so at the synchronous
 *  moment immediately after `replaceAllText`'s per-line execCommand
 *  storm finishes (i.e. when `pushText` calls into here),
 *  `target.textContent` still holds the OLD content. A sync
 *  `writeCursorOffset(translatedCursor)` would then ask
 *  `domPositionOfPlainOffset` to find an offset that lies beyond the
 *  current DOM's plain length — the walker falls off the end and the
 *  fallback path lands the caret at position 0. The user perceives
 *  this as a flash to start-of-buffer, then a "reset" to the right
 *  spot when our second (RAF) reapply fires after Quill has rendered.
 *
 *  Scheduling a microtask AFTER Quill's beforeinput handler queued ITS
 *  microtasks (during the execCommand storm) means ours runs LAST in
 *  the microtask queue — Quill's reconcile is done, DOM has the new
 *  text, `domPositionOfPlainOffset` finds the right node. The
 *  RAF call is belt-and-braces against any post-reconcile Quill
 *  selection-observer snap-back (idempotent on editors that don't
 *  fight). Other hosts (Lexical, ProseMirror, generic CE) don't queue
 *  this kind of model-deferred DOM update — for them the microtask
 *  delay is sub-millisecond and not perceptible.
 *
 *  See PR #122 (0.2.6) for the prior over-eager 4-layer schedule that
 *  treated the flash as a "snap-back" — wrong root cause, didn't help. */
function reapplyCursor(offset: number): void {
  queueMicrotask(() => writeCursorOffset(offset, true));
  requestAnimationFrame(() => writeCursorOffset(offset, true));
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

  // Route to replaceAllText whenever the change touches \n boundaries
  // (either insert OR removed region). Contenteditables don't render
  // a literal \n as a line break, and an in-place splice that only
  // mutates text nodes leaves the SURROUNDING block structure
  // (empty <div><br></div> blocks) intact in the DOM tree — BUT
  // Gmail's reconciler (and similar generic-contenteditable engines)
  // GC empty paragraph blocks shortly after the splice, eating the
  // structural \n's the runtime carefully preserved. Symptom: "the
  // line I was on disappeared" after a transform-blank substitution
  // that consumed a trigger line.
  //
  // replaceAllText emits explicit `<div><br></div>` / `<p><br></p>`
  // blocks per empty line and pastes the whole HTML. The reconciler
  // accepts the explicit block markup and the trailing empty paragraphs
  // survive.
  const removedRegion = current.slice(removeStart, removeEnd);
  if (insert.includes('\n') || removedRegion.includes('\n')) {
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
    const seg = segments[startSegIdx];
    const textNode = seg.node;

    // IMG-segment guard: walkPlainText emits an emoji's <img alt>
    // content as a synthetic text segment whose "node" is the IMG
    // element, not a real Text. We can't mutate `.data` on an IMG.
    // Route to replaceAllText so the new full body gets pasted and
    // the receiving editor (Gmail etc.) re-renders emojis from the
    // plain unicode.
    if (textNode.nodeType !== Node.TEXT_NODE) {
      replaceAllText(newText);
      return true;
    }

    // Empty-segment guard: if the splice would WIPE the entire text
    // node (startOff=0, endOff=textNode.data.length, insert=""), the
    // containing block ends up as `<div></div>` — no BR, no text —
    // which contenteditables (Gmail) render as a ZERO-HEIGHT block
    // (the line "vanishes"). Route to replaceAllText so the new HTML
    // emits an explicit `<div><br></div>` for that line, which
    // renders as a visible empty paragraph.
    if (insert.length === 0 && startOff === 0 && endOff === textNode.data.length) {
      replaceAllText(newText);
      return true;
    }

    // Managed editors (Lexical, ProseMirror/TipTap, Slate): explicitly
    // restore the cursor synchronously after the splice. Their MOs
    // reconcile in a microtask, so a selection set in the same
    // synchronous turn lands first and the editor normally honors it
    // during reconcile. Without this, cycles where the cursor is past
    // the splice region (mid-buffer cycle) leave the caret wherever
    // the reconciler picks — sometimes correct, sometimes snapped to
    // end-of-block, which is the "periodic cursor jump" bug.
    //
    // Cursor adjustment depends on where the cursor sat relative to
    // the splice region:
    //   before splice  → unchanged
    //   inside splice  → land at end of inserted text (matches typing
    //                    a replacement over a selection)
    //   after  splice  → shift by (insertLen - removedLen)
    const managed = isManagedEditor(target);
    const cursorBefore = managed ? readCursorOffset() : 0;

    textNode.data = textNode.data.slice(0, startOff) + insert + textNode.data.slice(endOff);

    if (managed) {
      // Find the segment that originally contained the cursor. The
      // segments array is in OLD (pre-splice) plain-text coords, which
      // matches cursorBefore. Text nodes outside the spliced one are
      // unchanged; only the spliced node's content shifted.
      let cursorSeg = segments[segments.length - 1];
      let cursorWithin = cursorSeg.node.data.length;
      for (const s of segments) {
        if (cursorBefore <= s.plainEnd) {
          cursorSeg = s;
          cursorWithin = cursorBefore - s.plainStart;
          break;
        }
      }

      // If the cursor lived in the spliced segment, adjust within for
      // the splice: before-splice unchanged, inside lands at end of
      // insert (like typing over a selection), after shifts by delta.
      if (cursorSeg === seg) {
        if (cursorWithin <= startOff) {
          // unchanged
        } else if (cursorWithin >= endOff) {
          cursorWithin += insert.length - (endOff - startOff);
        } else {
          cursorWithin = startOff + insert.length;
        }
      }

      cursorWithin = Math.max(0, Math.min(cursorWithin, cursorSeg.node.data.length));
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.setStart(cursorSeg.node, cursorWithin);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
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
    // IMG-segment guard: if any segment in the splice range is a
    // synthetic IMG-emoji segment (not a Text node), the .data
    // mutations below will throw. Route to replaceAllText.
    for (let i = startSegIdx; i <= endSegIdx; i++) {
      if (segments[i].node.nodeType !== Node.TEXT_NODE) {
        replaceAllText(newText);
        return true;
      }
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
  // Reset the in-place-preservation signal at the top of each write so
  // `pushText` reads a fresh value. Set to `true` by paths that handle
  // cursor naturally via text-node `.data` mutation (Quill in-place
  // hunk fast path); left `false` for paths that destroy + reinsert
  // (storm fallback) where `pushText` must explicitly restore cursor.
  _diffPreservedCursor = false;
  const target = currentTarget;
  if (!target) return;
  if (isNormalInput(target)) {
    const cBefore = target.selectionStart ?? text.length;
    writeNormalInputValue(target, text);
    const o = Math.max(0, Math.min(cBefore, text.length));
    target.setSelectionRange(o, o);
    return;
  }
  target.focus();
  log.info('[opencues] diffWriteText: newLen=' + text.length + ', hasNewline=' + text.includes('\n'));
  const cBefore = readCursorOffset();
  const routedToReplaceAll = applyTextDiff(target, text);
  if (routedToReplaceAll) {
    log.info('[opencues] diffWriteText → routed to replaceAllText');
    return;
  }
  log.info('[opencues] diffWriteText: in-place splice complete, post-DOM textLen=' + (target.textContent?.length ?? 0));
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
export function replaceAllText(text: string): void {
  const target = currentTarget;
  if (!target) return;
  if (isNormalInput(target)) {
    writeNormalInputValue(target, text);
    return;
  }
  // Drop a TRAILING blank-line run before writing. Without this, a
  // contenteditable that appends its own trailing placeholder block on
  // paste (Gmail adds a `<div><br></div>` after an insertHTML) creates a
  // compounding feedback loop: the runtime reads the buffer back
  // (walkPlainText counts the trailing block as a `\n`), bakes that into
  // the next cycle's text, re-emits it as another trailing `<div><br></div>`,
  // the editor appends ANOTHER placeholder, and the blank lines grow every
  // cycle ("cycling on Gmail adds lots of newlines", June 2026 — observed
  // climbing from a clean body to 20+ trailing blank lines over a few
  // English↔Japanese transform cycles). Trimming the trailing run caps it:
  // each write emits no trailing blanks, so the editor's one placeholder
  // can't accumulate. Interior blank lines (paragraph breaks) are
  // untouched. Empty body is preserved as empty.
  text = text.replace(/\n+$/, '');
  target.focus();
  log.info('[opencues] replaceAllText: newLen=' + text.length + ', preDomLen=' + (target.textContent?.length ?? 0));
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
    // One BLOCK per line, including empty lines. Empty lines need
    // explicit `<div><br></div>` / `<p><br></p>` blocks — a bare
    // `<br>`-chain like "X<br><br>" gets compacted by Gmail's
    // contenteditable into just "X" (trailing structure collapsed),
    // and a bare `<div></div>` (no BR) renders as zero-height.
    //
    // We emit the EXACT structure the runtime asked for. Various
    // contenteditables may add their own trailing placeholder
    // paragraph after paste (Gmail does sometimes, others don't);
    // we don't try to predict that. Net layout closely tracks the
    // runtime intent; the occasional +1 trailing placeholder is
    // less disruptive than the alternative (losing user-intended
    // empty lines).
    // Block emission. Two strategies based on editor flavor:
    //
    // - MANAGED (Lexical/Reddit, ProseMirror, Slate, Quill): each `<p>`
    //   block already has a default margin/padding that visually
    //   *is* the paragraph break. Emitting an empty `<p><br></p>`
    //   between every paragraph stacks block-margin + block-margin =
    //   visible double-spacing ("too linebreaky" on Reddit). Split on
    //   `\n\n+` for paragraph breaks and use inline `<br>` for soft
    //   breaks within a paragraph. Result for `Hi\n\nHope\n\nBest,\nWilfred`:
    //   `<p>Hi</p><p>Hope</p><p>Best,<br>Wilfred</p>` — three paragraphs
    //   with single-margin gaps, signature stacked.
    //
    // - GENERIC contenteditable (Gmail, YouTube, plain CE): no default
    //   block-margin styling, so explicit `<div><br></div>` blocks are
    //   what carry the visible paragraph break. Keep the per-line emit.
    let html: string;
    if (isManaged) {
      html = text.split(/\n\n+/).map(para =>
        '<p>' + para.split('\n').map(line => escape(line)).join('<br>') + '</p>',
      ).join('');
    } else {
      html = text.split('\n').map(line =>
        line.length === 0 ? `<div><br></div>` : `<div>${escape(line)}</div>`,
      ).join('');
    }

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
      // Single history entry per editor.update() — Lexical groups every
      // mutation inside one update into one history step. Try the
      // editor API (richest path: clear + insert in one transaction)
      // and fall back to a selection-replacing synthetic paste.
      const lex = (target as unknown as { __lexicalEditor?: {
        update: (fn: () => void, opts?: { discrete?: boolean }) => void;
      } }).__lexicalEditor;
      type LexicalGlobals = {
        $getRoot?: () => { clear: () => void; append?: (n: unknown) => void };
        $createParagraphNode?: () => { append: (n: unknown) => void };
        $createTextNode?: (s: string) => unknown;
      };
      const lexGlobals = window as unknown as LexicalGlobals;
      const canInsertViaApi = lex && typeof lex.update === 'function'
        && typeof lexGlobals.$getRoot === 'function'
        && typeof lexGlobals.$createParagraphNode === 'function'
        && typeof lexGlobals.$createTextNode === 'function';
      if (canInsertViaApi) {
        try {
          lex!.update(() => {
            const root = lexGlobals.$getRoot!();
            root.clear();
            for (const line of text.split('\n')) {
              const p = lexGlobals.$createParagraphNode!();
              p.append(lexGlobals.$createTextNode!(line));
              (root as { append: (n: unknown) => void }).append(p);
            }
          }, { discrete: true });
          sourceReclassifier.markRuntimeWrite(text);
          schedulePostReconcileRender();
          return;
        } catch (err) {
          log.warn('[opencues] Lexical editor.update insert failed, falling back:', err);
        }
      }
      // Fallback: Ctrl+A selection (NO history entry — selection only) +
      // synthetic paste. Lexical's paste handler reads the now-set
      // internal selection and REPLACES it in a single transaction → one
      // history entry total. The previous Backspace step landed its own
      // history entry on top of the paste, causing the first Ctrl+Z to
      // leave the buffer empty (the blank-screen bug).
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
        bubbles: true, cancelable: true,
      }));
    } else if (isQuillEditor(target)) {
      // Quill (LinkedIn share composer). Quill is a managed editor
      // with a Delta-based document model and a strict MutationObserver
      // that reverts external DOM mutations on the next microtask. The
      // generic `execCommand('insertHTML')` path lands briefly then
      // gets reverted as Quill reconciles its internal state.
      //
      // Preferred path: find the Quill instance via `__quill` and call
      // its `clipboard.dangerouslyPasteHTML` API with the managed-shape
      // HTML (`<p>para</p><p>para<br>soft</p>` — same `\n\n+`-split +
      // `<br>` soft-break emission built above). This writes through
      // Quill's HTML paste pipeline (Delta model under the hood, no
      // MutationObserver fight) AND inherits the new paragraph rendering
      // — Quill's blot tree gives each `<p>` a single margin, no
      // double-spacing from empty paragraph blocks.
      //
      // Fallback ladder when the instance/clipboard isn't reachable
      // (e.g. LinkedIn ships a custom Quill bundle that renames the
      // private slot): synthetic Ctrl+A + paste with `text/html`. Quill's
      // ClipboardModule reads HTML first, falls back to text/plain — so
      // we send HTML primarily and text as a tail-end fallback.
      const quill = findQuillInstance(target);
      if (quill?.clipboard?.dangerouslyPasteHTML) {
        try {
          quill.clipboard.dangerouslyPasteHTML(html, 'user');
          log.info('[opencues] replaceAllText: quill API dangerouslyPasteHTML, htmlLen=' + html.length);
          sourceReclassifier.markRuntimeWrite(text);
          schedulePostReconcileRender();
          return;
        } catch (err) {
          log.warn('[opencues] Quill dangerouslyPasteHTML failed, trying setText:', err);
        }
      }
      // Secondary API: setText with the original `\n+`-collapsed text
      // (Quill setText takes plain text; `\n` → block boundary in Delta).
      // Used when clipboard module isn't exposed but setText is. Same
      // collapse the managed-paragraph emission uses so empty
      // paragraph blocks don't double up Quill's block margins.
      if (quill?.setText) {
        try {
          const condensed = text.replace(/\n\n+/g, '\n');
          quill.setText(condensed, 'user');
          log.info('[opencues] replaceAllText: quill API setText (condensed), len=' + condensed.length);
          sourceReclassifier.markRuntimeWrite(text);
          schedulePostReconcileRender();
          return;
        } catch (err) {
          log.warn('[opencues] Quill setText failed, falling back to paste:', err);
        }
      }
      // Fallback ladder when no `__quill` is reachable (LinkedIn ships a
      // private bundle that doesn't expose the instance):
      //
      // STRATEGY: select-all via the Range API (NOT synthetic Ctrl+A —
      // Quill ignores it because untrusted keydowns don't trigger
      // Quill's selectAll handler), then for each line of text:
      // `execCommand('insertText', false, line)` followed by
      // `execCommand('insertParagraph')` between lines. Quill's
      // `beforeinput` handler reads these inputTypes and routes them
      // through its Delta model — the same code path real typing +
      // Enter uses, so the model accepts the writes and the
      // MutationObserver doesn't fight (DOM mutation is the *result*
      // of a model write, not a foreign mutation).
      //
      // Why per-line: browsers strip embedded `\n` characters from
      // `execCommand('insertText', false, 'a\nb')` — the newlines
      // become non-text and Quill never sees them. Splitting on `\n`
      // and emitting `insertParagraph` between is the cross-engine
      // way to actually get block boundaries.
      //
      // Prior approaches that DIDN'T work on LinkedIn:
      // - Synthetic Ctrl+A + ClipboardEvent paste (text/html): Quill
      //   rejected untrusted paste, substitute reverted.
      // - Single `execCommand('insertText', '...\n...')`: `\n`s
      //   stripped, all text rendered as one run-on paragraph.
      // Structural fast path: use the runtime's `wordDiff` to split
      // the old → new change into small targeted hunks, then apply
      // each as a single-segment text-node splice. This is the same
      // shape of write transform-blank uses on Quill — small, targeted,
      // picked up by Quill's MutationObserver, fed into its Delta
      // model. Quill's internal selection shifts naturally for
      // inserts/deletes before the cursor, so the user's logical
      // typing position is preserved.
      //
      // Avoiding the legacy select-all + per-line execCommand storm
      // matters because that storm leaves Quill's internal selection
      // model at end-of-buffer. Quill processes each
      // `execCommand('insertText')` through its Delta pipeline,
      // advancing its internal cursor with every op; the browser-side
      // `reapplyCursor` we do afterwards sets the BROWSER selection
      // but Quill's selection observer doesn't reliably sync that
      // back into its model. Result on LinkedIn share composer: every
      // keystroke after an agent-rewrite tick lands at end-of-buffer
      // regardless of where the user sees their caret — feature
      // unusable.
      //
      // Hunk-level granularity matters specifically for agent-rewrite,
      // which typically produces multiple INDEPENDENT small changes
      // scattered across the buffer. The prefix/suffix LCP diff in
      // `applyTextDiff` would compute one big change region covering
      // the entire span from first to last change (potentially crossing
      // paragraph boundaries via `\n`), forcing routing to the storm.
      // `wordDiff` returns separate hunks for separate changes — each
      // small enough to live inside one text node.
      if (quillInPlaceUpdate(target, text)) {
        log.info('[opencues] replaceAllText: quill in-place hunk-level mutation');
        sourceReclassifier.markRuntimeWrite(text);
        schedulePostReconcileRender();
        return;
      }
      // Hunk crossed text-node boundaries (paragraph join/split, or
      // inline formatting in the changed region). Fall through to the
      // legacy select-all + per-line storm — destructive to cursor on
      // agent-rewrite but correct for full-body rewrites (`draft email _`,
      // transform-blank substitutes that restructure the buffer) where
      // cursor-at-end-of-substitute is the expected outcome.
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch { /* selection unavailable */ }
      // Preserve the paragraph-vs-soft-break distinction:
      //   - `\n\n+` in LLM source → paragraph break (blank line between)
      //     emitted via `execCommand('insertParagraph')` → `<p>` block.
      //   - single `\n` (soft break within a paragraph — e.g. signature
      //     lines) → emitted via `execCommand('insertLineBreak')` → `<br>`,
      //     adjacent line with no margin gap.
      //
      // Why this matters: an LLM email body emits `\n\n` between
      // paragraphs (Subject / Dear / body / Thank you / signature
      // group) and `\n` within the signature (Best regards / Name /
      // Title / email). Treating every break as a paragraph creates
      // excessive gaps in the signature. Treating every break as a
      // soft break loses the body paragraph structure.
      //
      // Split-on-double-then-single preserves both. ExecCommand alone
      // (no synthetic Enter keydown, no beforeinput dispatch) — those
      // caused stale-cursor / reversed-order issues on LinkedIn's
      // Quill in prior iterations.
      // LinkedIn's Quill: every text run becomes a `<p>` block, and
      // LinkedIn's CSS collapses the default `<p>` margin so consecutive
      // `<p>`s render stacked tight (no visible blank between them).
      // To create the visible blank line a reader expects between body
      // paragraphs, we need an empty `<p><br></p>` block between them
      // — which is exactly what hitting Enter on an empty line produces
      // in Quill (and what the user reproduces when they manually press
      // Enter twice). We emit that by calling `insertParagraph` TWICE
      // for paragraph breaks (the second call creates the empty middle
      // `<p>`), and ONCE for soft breaks within a paragraph (tight
      // signature stacking with no blank line between).
      const paragraphs = text.split(/\n\n+/);
      let totalSoftBreaks = 0;
      for (let p = 0; p < paragraphs.length; p++) {
        const lines = paragraphs[p].split('\n');
        for (let l = 0; l < lines.length; l++) {
          if (lines[l].length > 0) {
            document.execCommand('insertText', false, lines[l]);
          }
          if (l < lines.length - 1) {
            // Soft break within a paragraph (signature lines): single
            // paragraph-end → stacked tight via LinkedIn's CSS collapse.
            document.execCommand('insertParagraph');
            totalSoftBreaks++;
          }
        }
        if (p < paragraphs.length - 1) {
          // Body paragraph break: TWICE → blank `<p><br></p>` middle
          // block. Visible blank line in the rendered editor.
          document.execCommand('insertParagraph');
          document.execCommand('insertParagraph');
        }
      }
      log.info('[opencues] replaceAllText: quill fallback (selectAll + per-line insertText), paragraphs='
        + paragraphs.length + ' softBreaks=' + totalSoftBreaks);
      sourceReclassifier.markRuntimeWrite(text);
      schedulePostReconcileRender();
      return;
    } else if (isDraftJsEditor(target)) {
      // Draft.js (Twitter/X). Internal selection model doesn't sync
      // from browser selection — set it via synthetic Ctrl+A keydown
      // (which Draft's keymap honours and updates internal selection
      // to span the buffer). Then the paste's replaceText call below
      // replaces the selection in one history entry. The previous
      // pattern fired Backspace before paste, landing two history
      // entries (Ctrl+Z → empty buffer = blank-screen bug).
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
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
      log.info('[opencues] replaceAllText: draftjs path, preLen=' + pre + ', postLen=' + postFinal);
      sourceReclassifier.markRuntimeWrite(text);
      schedulePostReconcileRender();
      return;
    } else if (isLinkedInMessaging(target)) {
      // LinkedIn messaging composer (`.msg-form__contenteditable`).
      // No public marker for the underlying framework (LinkedIn ships a
      // private build); empty-state shape is `<p><br></p>` and the Send
      // button is gated by React state that only flips when the editor's
      // input pipeline observes content. Generic `execCommand('insertHTML')`
      // lands the DOM mutation but DOES NOT flip the React state — text
      // appears in the box but Send stays disabled, like the placeholder
      // is still active. Mirrors the Quill fallback's typing-simulation
      // approach: Range-API select-all + per-line `insertText` +
      // `insertParagraph` between. These fire `beforeinput`/`input`
      // events whose `inputType` matches real typing
      // (`"insertText"` / `"insertParagraph"`), so LinkedIn's React
      // listener catches them and updates the state.
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch { /* selection unavailable */ }
      const paragraphs = text.split(/\n\n+/);
      for (let p = 0; p < paragraphs.length; p++) {
        const lines = paragraphs[p].split('\n');
        for (let l = 0; l < lines.length; l++) {
          if (lines[l].length > 0) {
            document.execCommand('insertText', false, lines[l]);
          }
          if (l < lines.length - 1) {
            document.execCommand('insertParagraph');
          }
        }
        if (p < paragraphs.length - 1) {
          document.execCommand('insertParagraph');
          document.execCommand('insertParagraph');
        }
      }
      log.info('[opencues] replaceAllText: linkedin-messaging path, paragraphs=' + paragraphs.length);
      sourceReclassifier.markRuntimeWrite(text);
      schedulePostReconcileRender();
      return;
    } else if (isManaged) {
      // ProseMirror/TipTap, Slate.
      //
      // DEFAULT (May 2026 update): execCommand('insertHTML') over the
      // select-all selection. insertHTML dispatches beforeinput with
      // inputType "insertReplacementText" — PM's default handler treats
      // this as ONE replace transaction. The previous `insertText` path
      // fired inputType "insertText" which on SOME PM-using sites
      // (claude.ai specifically) hit a custom handleTextInput that
      // split delete + insert into two transactions, producing a
      // "blank flash" on the first Ctrl+Z. insertHTML's inputType is
      // less commonly intercepted; observed atomic on claude.ai,
      // ChatGPT, LinkedIn.
      //
      // Block shape ('<p>...</p>' per line, set earlier in `html`)
      // matches what these editors emit natively for Enter, so
      // paragraph structure round-trips correctly.
      //
      // EXCEPTION — Luma's TipTap: still uses keyboard-sim + paste
      // (below) because Luma's TipTap config rejects insertHTML.
      const host = location.hostname;
      const isLuma = host === 'lu.ma' || host.endsWith('.lu.ma');
      const isClaudeAI = host === 'claude.ai' || host.endsWith('.claude.ai');
      if (!isLuma) {
        // claude.ai's PM is the canonical case for the insertHTML fix —
        // the prior insertText path produced a 2-entry undo stack.
        // For other PM-using sites (ChatGPT/LinkedIn) insertHTML is
        // expected to also work AND was the May 2026 unified default.
        log.info('[opencues] replaceAllText: managed insertHTML (host=' + host + ', claude.ai=' + isClaudeAI + ')');
        document.execCommand('insertHTML', false, html);
        sourceReclassifier.markRuntimeWrite(text);
        schedulePostReconcileRender();
        return;
      }
      // Luma: Ctrl+A keydown sets TipTap's internal selection to the
      // whole buffer (selection-only — no history entry). The paste
      // below replaces the selection in one history step. Dropping the
      // earlier Backspace keydown collapses two undo entries into one
      // (Ctrl+Z → original instead of Ctrl+Z → empty body).
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true,
        bubbles: true, cancelable: true,
      }));
    } else {
      // Generic contenteditable (Gmail, YouTube, plain <div contenteditable>).
      // Single execCommand('insertHTML') over the select-all range
      // REPLACES the body in ONE undo entry. The previous wipe-then-paste
      // pattern landed two entries on the native undo stack, so a user's
      // first Ctrl+Z reverted only the paste and left the buffer empty
      // (blank-screen bug). insertHTML routes through the same
      // beforeinput/input pipeline Gmail's compose surface expects.
      document.execCommand('insertHTML', false, html);
      log.info('[opencues] replaceAllText: generic insertHTML');
      sourceReclassifier.markRuntimeWrite(text);
      schedulePostReconcileRender();
      return;
    }

    // Managed-editor fallthrough (Lexical fallback, Luma TipTap). These
    // reached here AFTER an explicit clear above; we still dispatch a
    // synthetic paste because their paste handlers read clipboardData
    // directly. Single-undo atomicity for these editors is handled in
    // the per-engine branches above; this is the residual paste step.
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
    log.info('[opencues] replaceAllText: ' + (isManaged ? 'managed' : 'generic') + ' paste dispatched');
  }

  sourceReclassifier.markRuntimeWrite(text);
  schedulePostReconcileRender();
}

/**
 * Read a config file. Two paths depending on whether the file is
 * mutable from the runtime:
 *
 * Read-only files (CUES.md, BLANKS.md, folder cues / folder blanks):
 *   1. Bundle (via readBundledConfig):
 *      a. chrome.storage.local['opencues_bundle']  ← native-messaging host
 *      b. chrome.runtime.getURL('dist/configs/<rel>')  ← bake-time bundle
 *   2. Bake-time __DEFAULT_*__ esbuild constants
 *   3. null
 *
 * Writable files (OPENCUES.md — runtime cycles voice-mode etc. via
 * writeFile):
 *   1. Bundle (same a/b as above)
 *   2. chrome.storage.local[STORAGE_PREFIX + path]  ← user saved state
 *   3. Bake-time __DEFAULT_OPENCUES_MD__
 *   4. null
 *
 * Runtime paths look like `/chrome-storage/CUES.md` or
 * `/chrome-storage/cues/grammar/CUE.md`; we strip the ROOT prefix and
 * try the bundle first.
 */
async function readFile(path: string): Promise<string | null> {
  // OPENCUES.md is the cross-host writable schema file. Three sources:
  //   - bundle  ← latest schema from ~/.cues/ (pushed by chrome-host)
  //   - storage ← user's chrome-side cycled scalar values
  //   - bake    ← compiled-in fallback
  // When bundle exists AND storage exists, MERGE: bundle's settings:
  // block + bake's structure win for schema, storage's scalar values
  // win for cycled state. Without the merge, bundle would mask chrome
  // cycling (bug class "storage starvation"); storage alone would mask
  // disk edits made from CC/OC.
  if (path === ROOT + '/.cues/OPENCUES.md') {
    const bundled = await readBundledConfig(path);
    const storageKey = STORAGE_PREFIX + path;
    let stored: string | null = null;
    try {
      const result = await chrome.storage.local.get(storageKey);
      const v = result[storageKey];
      if (typeof v === 'string' && v.length > 0) stored = v as string;
    } catch (err) { log.warn(`[opencues] readFile(${path}) threw:`, err); }
    if (bundled !== null && stored !== null) {
      const merged = mergeOpencuesMd(bundled, stored);
      tlogRead('merge', merged.length);
      return merged;
    }
    if (bundled !== null) {
      tlogRead('bundle', bundled.length);
      return bundled;
    }
    if (stored !== null) {
      tlogRead('storage', stored.length);
      return stored;
    }
    const bake = readBakeTimeDefault(path);
    if (bake !== null) {
      tlogRead('baketime', bake.length);
      return bake;
    }
    return null;
  }

  // 1. Synced bundle (opencues sync chrome --wsl) wins if present.
  const bundled = await readBundledConfig(path);
  if (bundled !== null) {
    tlogRead('bundle', bundled.length);
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
      tlogRead('baketime', bake.length);
      return bake;
    }
    tlogRead('null', 0);
    return null;
  }

  // 3. Writable files. Storage wins so the user's saved setting persists
  //    across reloads, falling back to bake-time before the first write.
  const key = STORAGE_PREFIX + path;
  try {
    const result = await chrome.storage.local.get(key);
    const v = result[key];
    if (typeof v === 'string' && v.length > 0) {
      tlogRead('storage', v.length);
      return v;
    }
  } catch (err) {
    log.warn(`[opencues] readFile(${path}) threw:`, err);
  }
  const bake = readBakeTimeDefault(path);
  if (bake !== null) {
    tlogRead('baketime', bake.length);
    return bake;
  }
  tlogRead('null', 0);
  return null;
}

// Merge OPENCUES.md content from `defaults` (schema source — e.g. the
// chrome-host bundle pushed from disk) with `user` (storage — e.g.
// chrome-side cycled scalar values). Algorithm mirrors the cjs version
// in packages/opencues-cli/src/commands/seed-configs.cjs:
//   - Preserve scalar values from `user` for any key both files have.
//   - Replace the `settings:` block wholesale from `defaults` (it's
//     runtime-owned schema).
//   - Append user-only scalars just above the settings: line so they
//     survive future merges.
//   - Use `user`'s body if present, else `defaults`'s.
function mergeOpencuesMd(defaultsContent: string, userContent: string): string {
  const split = (text: string): { fm: string; body: string } => {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { fm: '', body: text };
    return { fm: m[1], body: m[2] };
  };
  const d = split(defaultsContent);
  const u = split(userContent);
  const SCALAR_RE = /^([a-z][a-z0-9_-]*):\s*(.*)$/;

  const userScalars = new Map<string, string>();
  {
    let inSettings = false;
    for (const line of u.fm.split('\n')) {
      if (/^settings\s*:/.test(line)) { inSettings = true; continue; }
      if (inSettings) continue;
      const m = line.match(SCALAR_RE);
      if (m) userScalars.set(m[1], m[2]);
    }
  }

  const matchedKeys = new Set<string>();
  const mergedLines: string[] = [];
  let inSettingsBlock = false;
  for (const line of d.fm.split('\n')) {
    if (!inSettingsBlock && /^settings\s*:/.test(line)) {
      const extras: string[] = [];
      for (const [k, v] of userScalars) {
        if (!matchedKeys.has(k)) extras.push(`${k}: ${v}`);
      }
      if (extras.length > 0) {
        mergedLines.push('# ── User-only scalars (preserved by chrome bundle/storage merge) ──');
        mergedLines.push(...extras);
        mergedLines.push('');
      }
      inSettingsBlock = true;
      mergedLines.push(line);
      continue;
    }
    if (inSettingsBlock) { mergedLines.push(line); continue; }
    const m = line.match(SCALAR_RE);
    if (m && userScalars.has(m[1])) {
      matchedKeys.add(m[1]);
      mergedLines.push(`${m[1]}: ${userScalars.get(m[1])}`);
    } else {
      mergedLines.push(line);
    }
  }
  if (!inSettingsBlock) {
    for (const [k, v] of userScalars) {
      if (!matchedKeys.has(k)) mergedLines.push(`${k}: ${v}`);
    }
  }

  const body = u.body !== '' ? u.body : d.body;
  return `---\n${mergedLines.join('\n')}\n---\n${body}`;
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
  // NOTES.md is writable: the note collection blank appends/removes
  // bullet entries. Without this, chrome-side writes land in storage
  // but reads fall through to bake-time (null) — add works, recall
  // finds nothing. Caught by the note E2E scenario.
  if (rel === '.cues/NOTES.md') return false;
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
  if (rel === '.cues/AUDITORS.md') return __DEFAULT_AUDITORS_MD__ || null;
  const cueFolder = rel.match(/^\.cues\/cues\/([^/]+)\/CUE\.md$/);
  if (cueFolder) return __DEFAULT_CUE_FOLDERS__[cueFolder[1]] ?? null;
  const blankFolder = rel.match(/^\.cues\/blanks\/([^/]+)\/BLANK\.md$/);
  if (blankFolder) return __DEFAULT_BLANK_FOLDERS__[blankFolder[1]] ?? null;
  const kataFolder = rel.match(/^\.cues\/katas\/([^/]+)\/KATA\.md$/);
  if (kataFolder) return __DEFAULT_KATA_FOLDERS__[kataFolder[1]] ?? null;
  return null;
}

// Cache the bundle index + native-messaging bundle. Crucially we cache
// the PROMISE, not the resolved value: ConfigLoader fires every
// readFile() in parallel via Promise.all on boot, so multiple concurrent
// callers must await the same in-flight fetch (otherwise the second+
// callers would see an empty-cache snapshot before the first call's
// await resolves).
//
// Resolution order, highest priority first:
//   1. chrome.storage.local['opencues_bundle']  ← pushed by native host
//      (`opencues install chrome-host`). Contains files: { [rel]: content }.
//   2. chrome.runtime.getURL('dist/configs/...')  ← bake-time bundle
//      written by `opencues sync chrome` at extension-build time.
//   3. bake-time __DEFAULT_*__ constants (handled by readBakeTimeDefault).
const BUNDLE_STORAGE_KEY = 'opencues_bundle';
type StoredBundle = { files: Record<string, string>; root?: string };

/** Apply the site-compat filter against the current location.
 *  Pure function lives in site-filter.ts; this is the chrome-specific
 *  thin wrapper that supplies the SiteCompatContext. */
function applySiteCompatFilter(files: Record<string, string>): Record<string, string> {
  return siteFilter(files, {
    hostName: 'chrome',
    hostname: location.hostname || null,
    path: location.pathname || null,
  });
}

/**
 * Walk the storage bundle for `~/.cues/blanks/<name>/BLANK.md` entries
 * that declare `impl: ./<file>.js` and register each as a host-side
 * user-blank PROXY. The blank's code lives on the chrome-host
 * (Node process via native messaging) — no Worker, no blob URL, no
 * page-CSP issue. Built-in TS-class blanks (registered upstream by
 * createBlanks) take precedence; only blanks WITHOUT a TS class get
 * a proxy here.
 *
 * The runtime's blankInvoke map is shared by reference — entries we
 * `.set()` here become visible to BlankFill on the next invocation.
 *
 * Hard dependency on chrome-host: without it, the proxy's invoke
 * relay fails with "native host not connected" (similar shape to a
 * scripted blank failing without the host). User-visible behaviour:
 * the keyword doesn't fire; built-in blanks still work.
 */
async function registerUserBlanksFromBundle(
  blanksRegistry: Map<string, BrowserBlank>,
  _llmApiKeys: Readonly<Record<string, string>>,
): Promise<void> {
  const stored = await chrome.storage.local.get(['opencues_bundle']);
  const bundle = stored.opencues_bundle as { files?: Record<string, string> } | undefined;
  if (!bundle || !bundle.files) return;

  const registeredUserNames = new Set<string>();
  let registered = 0;
  for (const [rel, content] of Object.entries(bundle.files)) {
    const m = rel.match(/^blanks\/([^/]+)\/BLANK\.md$/i);
    if (!m) continue;
    const blankName = m[1];

    let parsed;
    try { parsed = parseSingleCueMd(content, `/chrome-storage/.cues/blanks/${blankName}`); }
    catch { continue; }
    const cfg = parsed.blanks?.[blankName];
    if (!cfg?.impl) continue;

    // Only treat relative paths as user-shipped JS. Bare names fall
    // through to the built-in registry.
    const isRelative = cfg.impl.includes('/');
    if (!isRelative) continue;

    if (registeredUserNames.has(blankName)) {
      log.warn(
        `[opencues] user blank name collision: "${blankName}" already registered ` +
        `from an earlier bundle entry; ignoring ${cfg.impl}. Rename one of the duplicates.`,
      );
      continue;
    }

    // Built-in TS class already registered upstream — prefer it. The
    // host-side path is for custom user JS that has no TS equivalent.
    if (blanksRegistry.has(blankName)) {
      log.info(`[opencues] user blank "${blankName}" has a built-in TS class — using that`);
      registeredUserNames.add(blankName);
      continue;
    }

    // Required secret bindings still validated here (defence in depth
    // — the host validates too). Same rationale as registry.ts: unbound
    // secrets are author error and refused at load time.
    if (cfg.userBlankSecrets && cfg.userBlankSecrets.length > 0) {
      const unbound = cfg.userBlankSecrets.filter(name =>
        !cfg.userBlankSecretBindings?.[name] || cfg.userBlankSecretBindings[name].length === 0,
      );
      if (unbound.length > 0) {
        log.warn(
          `[opencues] user blank "${blankName}": secrets [${unbound.join(', ')}] declared without ` +
          `secret-hosts.<NAME> bindings — refusing to register. Add e.g. ` +
          `secret-hosts.${unbound[0]}: [api.example.com] to BLANK.md.`,
        );
        continue;
      }
    }

    const userBlank = new ChromeUserBlank(blankName, {
      output: cfg.userBlankOutput ?? 'safe',
    });
    blanksRegistry.set(blankName, userBlank as unknown as BrowserBlank);
    registeredUserNames.add(blankName);
    registered++;
    log.info(`[opencues] user blank "${blankName}" registered (host-side proxy)`);
  }
  if (registered > 0) log.info(`[opencues] ${registered} host-side user blank(s) wired`);
}

// Within a tab, SPAs change location.pathname without a page reload.
// Re-filter the bundle when that happens so path-scoped entries
// activate / deactivate as the user navigates. popstate covers back /
// forward; we wrap pushState / replaceState because they fire no
// event natively.
let _lastFilterScope = '';
function maybeReloadOnUrlChange(): void {
  const scope = (location.hostname || '') + (location.pathname || '');
  if (scope === _lastFilterScope) return;
  _lastFilterScope = scope;
  _bundleIndexPromise = null;
  if (bootResult) {
    void bootResult.reloadConfig().catch(err => log.warn('[opencues] reloadConfig on URL change failed', err));
  }
}
(() => {
  _lastFilterScope = (location.hostname || '') + (location.pathname || '');
  window.addEventListener('popstate', maybeReloadOnUrlChange);
  window.addEventListener('hashchange', maybeReloadOnUrlChange);
  const wrap = (name: 'pushState' | 'replaceState') => {
    const orig = history[name];
    history[name] = function patched(this: History, ...args: Parameters<typeof orig>) {
      const r = orig.apply(this, args);
      queueMicrotask(maybeReloadOnUrlChange);
      return r;
    } as typeof orig;
  };
  wrap('pushState');
  wrap('replaceState');
})();

let _bundleIndexPromise: Promise<{ files: Set<string>; storage: StoredBundle | null; loaded: boolean }> | null = null;
function getBundleIndex(): Promise<{ files: Set<string>; storage: StoredBundle | null; loaded: boolean }> {
  if (_bundleIndexPromise) return _bundleIndexPromise;
  _bundleIndexPromise = (async () => {
    const result: { files: Set<string>; storage: StoredBundle | null; loaded: boolean } =
      { files: new Set<string>(), storage: null, loaded: false };

    // 1. Native-messaging push lives in chrome.storage.local. If
    //    present, it wholly replaces the bake-time bundle — the host
    //    knows the user's current ~/.cues/ state. Per-file site-compat
    //    filtering happens here so the runtime never sees entries that
    //    aren't scoped to the current location.
    try {
      const stored = await chrome.storage.local.get(BUNDLE_STORAGE_KEY);
      const bundle = stored[BUNDLE_STORAGE_KEY] as StoredBundle | undefined;
      if (bundle && bundle.files && typeof bundle.files === 'object') {
        const filtered = applySiteCompatFilter(bundle.files);
        result.storage = { ...bundle, files: filtered };
        result.files = new Set(Object.keys(filtered));
        result.loaded = true;
        const dropped = Object.keys(bundle.files).length - Object.keys(filtered).length;
        log.info(`[opencues] storage bundle loaded: ${result.files.size} files (root=${bundle.root ?? 'unknown'}, scope=${location.hostname}${location.pathname}, dropped=${dropped})`);
        return result;
      }
    } catch (err) {
      log.warn(`[opencues] storage bundle read failed: ${(err as Error).message}`);
    }

    // 2. Bake-time bundle from dist/configs/.
    try {
      const url = chrome.runtime.getURL('dist/configs/index.json');
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.files)) {
          result.files = new Set(data.files.map(String));
          result.loaded = true;
          log.info(`[opencues] bundled configs loaded: ${result.files.size} files from dist/configs/`);
        } else {
          log.warn('[opencues] dist/configs/index.json malformed:', data);
        }
      } else {
        log.warn(`[opencues] dist/configs/index.json fetch returned ${res.status}`);
      }
    } catch (err) {
      log.warn(`[opencues] dist/configs/index.json fetch failed: ${(err as Error).message}`);
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

// Read a synced file out of the bundle. Path is the runtime's canonical
// form (starts with ROOT). When the native-messaging host has pushed a
// bundle into chrome.storage, that wins; otherwise we fetch from the
// bake-time dist/configs/. Returns null if not in either.
async function readBundledConfig(runtimePath: string): Promise<string | null> {
  if (!runtimePath.startsWith(ROOT + '/')) return null;
  const rel = bundleRelative(runtimePath.slice(ROOT.length + 1));
  const idx = await getBundleIndex();
  if (!idx.loaded || !idx.files.has(rel)) return null;

  if (idx.storage) {
    const content = idx.storage.files[rel];
    if (typeof content === 'string') return content;
    return null;
  }

  try {
    const url = chrome.runtime.getURL(`dist/configs/${rel}`);
    const res = await fetch(url);
    if (res.ok) return await res.text();
  } catch { /* ignore */ }
  return null;
}

/** writeFile — host-first, storage-fallback.
 *
 *  For OPENCUES.md (the only writable schema file shared with the
 *  native hosts), we try the chrome-host's `write-file` protocol
 *  first. The host writes to ~/.cues/OPENCUES.md on disk; its own
 *  fs.watch fires, a fresh bundle gets pushed back, and the
 *  content-script ConfigLoader hot-reloads with the new value. Single
 *  source of truth = the file.
 *
 *  When the host isn't connected (user hasn't run `opencues install
 *  chrome-host`), we fall back to writing chrome.storage — the legacy
 *  cycling-persists-locally behavior. When the user later installs
 *  the host, its first bundle push converges the two: the host reads
 *  the on-disk file, pushes it, content script reloads from the
 *  bundle, storage's stale overlay is overwritten on the next write.
 *
 *  For non-OPENCUES paths (rare — debug-mode flag, etc.) we keep the
 *  storage-only path for now. None of the cross-host-shared scalars
 *  use them.
 */
async function writeFile(path: string, content: string): Promise<void> {
  // Files relayed to the chrome-host for a DISK write (the file is the
  // single source of truth; storage is a cache). The host validates
  // the basename against WRITABLE_BASENAMES + path-sandboxes to
  // CUE_ROOT. Falls back to storage-only when the host is absent.
  if (path === ROOT + '/.cues/OPENCUES.md' || path === ROOT + '/.cues/NOTES.md') {
    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'opencues:write-file',
        path, content,
      }) as { ok?: boolean; error?: string } | undefined;
      if (reply?.ok) {
        // Host wrote to disk. Storage gets refreshed when the
        // host's next bundle push arrives — keep storage in
        // sync immediately too so the in-page UI doesn't read a
        // stale value before the round-trip completes.
        const key = STORAGE_PREFIX + path;
        try { await chrome.storage.local.set({ [key]: content }); } catch { /* */ }
        return;
      }
      // Host disconnected → fall through to storage-only.
      log.info(`[opencues] writeFile(${path}): host unavailable (${reply?.error ?? 'no reply'}), falling back to chrome.storage`);
    } catch (err) {
      log.info(`[opencues] writeFile(${path}): sendMessage threw, falling back to chrome.storage: ${String(err)}`);
    }
  }
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
  // KataCoach reads `.cues/katas` to build its catalogue; each entry is a
  // folder holding a KATA.md (fetched via readFile → readBakeTimeDefault).
  if (path === `${ROOT}/.cues/katas`) {
    return Object.keys(__DEFAULT_KATA_FOLDERS__).map(name => ({
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
  const kataInner = path.match(new RegExp(`^${ROOT}/\\.cues/katas/([^/]+)$`));
  if (kataInner && __DEFAULT_KATA_FOLDERS__[kataInner[1]]) {
    return [{ name: 'KATA.md', isDirectory: false }];
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
  /**
   * Provider override from the popup's Provider dropdown
   * ('groq' | 'cerebras' | 'openai' | 'anthropic' | 'gemini' | 'openrouter').
   * Empty string / undefined → no override, runtime auto-routes via
   * `pickAutoProvider(apiKeys)`. When set, this OVERRIDES OPENCUES.md's
   * `llm-provider:` scalar — popup is the higher-priority source.
   */
  llmProvider?: string;
  llmDebounceMs?: number;
  /**
   * Multi-provider key bag. The popup writes these to chrome.storage
   * and the content-script forwards them through. Runtime picks the
   * right one based on CUES.md `llm-provider:` / `<feature>-provider:`.
   */
  llmApiKeys?: Readonly<Record<string, string | undefined>>;
  /** Custom ticker map for the stocks blank. */
  customTickers?: Record<string, string>;
}

// Built lazily inside startOpenCues — needs opts. The dispatcher
// (createBlankInvoke) lives in the runtime so all hosts share it.
let blankInvoke: ((spec: BlankInvokeSpec) => ProcessHandle | null) | null = null;

/** Provider metadata slices derived from @opencues/core's PROVIDERS
 *  registry (already in this bundle via the runtime's resolver — the
 *  old hand-synced copies drifted whenever core added a provider).
 *  CLI-transport providers are excluded: external auth, no env key. */
const ENV_KEYED_PROVIDERS = listProviders().filter((p) => p.envKeyName && p.transport !== 'cli');
const PROVIDER_ENV_KEY: Record<string, string> = Object.fromEntries(
  ENV_KEYED_PROVIDERS.map((p) => [p.id, p.envKeyName]),
);
/** env-var name → provider id (inverse of PROVIDER_ENV_KEY). */
const ENV_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  ENV_KEYED_PROVIDERS.map((p) => [p.envKeyName, p.id]),
);
/** Providers that work keyless (free pool / local) — a missing key is a
 *  supported state, not a misconfiguration the audit should warn about. */
const OPTIONAL_AUTH_PROVIDERS = new Set<string>(
  ENV_KEYED_PROVIDERS.filter((p) => p.optionalAuth).map((p) => p.id),
);

/** Scan the user's merged CUES.md / OPENCUES.md for provider directives
 *  (`llm-provider:` and `<feature>-provider:`), cross-check against the
 *  apiKeys bag, and emit one summary warn enumerating misconfigurations.
 *  Catches "gemini set in CUES.md but no GEMINI_API_KEY on chrome" at
 *  boot — before the user types a trigger and gets nothing back.
 *
 *  Reads from chrome.storage's merged OPENCUES.md key. Falls back to
 *  the bake-time default. Tolerant of parse errors — best effort. */
async function auditProvidersAgainstKeys(keys: Record<string, string>): Promise<void> {
  const storageKey = `${STORAGE_PREFIX}${ROOT}/.cues/OPENCUES.md`;
  let content: string;
  try {
    const result = await chrome.storage.local.get(storageKey);
    content = typeof result[storageKey] === 'string' ? result[storageKey] : __DEFAULT_OPENCUES_MD__;
  } catch { content = __DEFAULT_OPENCUES_MD__ ?? ''; }
  if (!content) return;

  // Extract frontmatter only — provider directives live there, NOT in
  // the markdown body which can describe them in prose.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : content;

  // Match `<word>-?provider: <id>` lines. Captures both the feature
  // name (or empty for global `provider:`) and the provider id.
  const directives: { feature: string; provider: string }[] = [];
  const re = /^(?:([\w-]+)-)?provider:\s*([a-z]+)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fm)) !== null) {
    const feature = m[1] ?? 'global';
    const provider = m[2].toLowerCase();
    directives.push({ feature, provider });
  }
  if (directives.length === 0) return;

  const problems: string[] = [];
  for (const d of directives) {
    // `inherit` is the fall-through sentinel (use the next tier down / the
    // global) — a documented value for the bucket + per-feature provider
    // scalars, NOT a real provider. Don't flag it as unknown.
    if (d.provider === 'inherit') continue;
    if (!(d.provider in PROVIDER_ENV_KEY)) {
      problems.push(`  - "${d.feature === 'global' ? 'llm-provider' : d.feature + '-provider'}: ${d.provider}" — unknown provider`);
      continue;
    }
    // Keyless-capable providers (opencode-zen free pool, local ollama)
    // are valid without a key — don't flag them.
    if (OPTIONAL_AUTH_PROVIDERS.has(d.provider)) continue;
    // `keys` is keyed by PROVIDER ID — the caller translates env-var
    // names via ENV_TO_PROVIDER before handing the map over. (The
    // pre-registry version looked up by env-var name here, which never
    // matched the id-keyed map: every directive warned "needs KEY"
    // even when the key was present.)
    if (!keys[d.provider]) {
      problems.push(`  - "${d.feature === 'global' ? 'llm-provider' : d.feature + '-provider'}: ${d.provider}" — needs ${PROVIDER_ENV_KEY[d.provider]}`);
    }
  }
  if (problems.length === 0) return;
  // Prefix the warning with [chrome] so it's unambiguous WHICH host is
  // complaining when /tmp/opencues.log is shared with CC/OC/gemini-cli
  // — those hosts read process.env directly so they see different
  // keys-available state than chrome (which reads chrome.storage).
  // Before June 2026 this warning landed in the shared log as a
  // generic "[opencues]" line; users on CC with the env var SET saw
  // "needs CEREBRAS_API_KEY" and assumed their CC install was broken.
  // The host tag pins the warning to the actual misconfigured host.
  log.warn(
    `[opencues][chrome] CUES.md provider audit found ${problems.length} ` +
    `misconfigured ${problems.length === 1 ? 'directive' : 'directives'} ` +
    `(chrome reads keys from chrome.storage — env vars do NOT propagate):\n` +
    problems.join('\n') + '\n' +
    `Fix: save the missing keys in the OpenCues popup. (Native hosts ` +
    `CC/OC/gemini-cli read process.env / ~/.cues/.env independently; ` +
    `if a key is set in your shell, those hosts already have it — ` +
    `only chrome needs the popup save.) Cues/blanks routed to these ` +
    `providers will silently no-op on chrome until fixed.`,
  );
}

/** Each provider's lightest read-only endpoint (model list, free) —
 *  derived from the registry's `keyProbe` (the same table `opencues
 *  check-keys` probes from), so a new core provider auto-flows here.
 *  INFOSEC F8 (keys in headers, never URLs) is enforced at the
 *  registry entries. */
const PROVIDER_KEY_CHECKS: Record<string, (key: string) => { url: string; headers: Record<string, string> }> = Object.fromEntries(
  listProviders()
    .filter((p) => p.keyProbe)
    .map((p) => [p.id, (k: string) => ({ url: p.keyProbe!.url, headers: p.keyProbe!.headers(k) })]),
);

/** Verify LLM keys at boot — runs once after the runtime is constructed.
 *  Mirrors `opencues check-keys` so chrome users get the same up-front
 *  signal as terminal users: missing key → warn loudly; configured but
 *  invalid → error loudly; works → quiet info line.
 *
 *  Without this, a stale/typo'd GROQ_API_KEY silently turned every
 *  fluid-blank / transform-blank / word-cue resolve into a no-op. The
 *  failure was invisible because the FetchHttpAdapter's throw was
 *  swallowed inside the resolver and there was no boot-time probe. */
async function verifyLlmKeyAtBoot(opts: RuntimeStartOptions): Promise<void> {
  // Build the {provider → key} map the resolver will actually use.
  // Single-key opts.llmApiKey is treated as groq by convention (the
  // shipped default endpoint).
  const keys: Record<string, string> = {};
  if (opts.llmApiKey) keys.groq = opts.llmApiKey;
  // opts.llmApiKeys is keyed by ENV-VAR NAME (`GROQ_API_KEY`,
  // `CEREBRAS_API_KEY`, …) because the runtime resolver looks up keys
  // by env-var name. But PROVIDER_KEY_CHECKS below is keyed by
  // PROVIDER ID (`groq`, `cerebras`, …). Translate via the
  // registry-derived ENV_TO_PROVIDER (module scope) before iterating
  // — otherwise every non-legacy provider silently misses the check
  // and the boot audit only ever reports `OK (groq)`.
  if (opts.llmApiKeys) {
    for (const [envOrId, key] of Object.entries(opts.llmApiKeys)) {
      if (!key) continue;
      const provider = ENV_TO_PROVIDER[envOrId] ?? envOrId;
      keys[provider] = key;
    }
  }

  if (Object.keys(keys).length === 0) {
    log.warn(
      '[opencues] no LLM provider key set — fluid-blank, transform-blank, ' +
      'and word-cues will silently do nothing. Open the OpenCues popup ' +
      'and paste a GROQ_API_KEY (free tier at https://console.groq.com/keys).',
    );
    return;
  }

  // Eager audit of the user's CUES.md provider directives: surfaces the
  // "you set llm-provider: gemini but have no GEMINI_API_KEY" failure at
  // boot time, BEFORE the user types a trigger and silently waits. The
  // resolver also emits a one-time warn on first dispatch (lazy backstop
  // in case CUES.md edits land mid-session) — this just makes the
  // problem visible immediately.
  await auditProvidersAgainstKeys(keys);

  // Probe each configured provider in parallel. We route through the
  // background SW because content scripts can't bypass CORS for
  // cross-origin Authorization headers — same path the runtime LLM
  // calls use. Probes fire in parallel and one summary log line lands
  // when they all settle: `[opencues] LLM keys: ok=[groq, cerebras, …]
  // invalid=[gemini (401)] failed=[]`. Per-provider errors still log
  // their full diagnostic separately so the summary stays scannable.
  const probeResults: Array<{ provider: string; status: 'ok' | 'invalid' | 'failed'; detail?: string }> = [];
  await Promise.all(Object.entries(keys).map(async ([provider, key]) => {
    const spec = PROVIDER_KEY_CHECKS[provider];
    if (!spec) return; // unknown provider — skip silently
    const { url, headers } = spec(key);
    try {
      const reply = await chrome.runtime.sendMessage<unknown, { ok: boolean; status: number; statusText: string; text: string }>({
        type: 'opencues:fetch',
        method: 'GET',
        url,
        headers,
      });
      if (reply?.ok) {
        probeResults.push({ provider, status: 'ok' });
      } else {
        const status = reply?.status ?? 0;
        const statusText = reply?.statusText ?? 'unknown';
        const body = (reply?.text ?? '').slice(0, 200);
        probeResults.push({ provider, status: 'invalid', detail: `HTTP ${status}` });
        console.error(
          `[opencues] LLM key INVALID for ${provider} — HTTP ${status} ${statusText}. ` +
          `Open the OpenCues popup and check the ${provider.toUpperCase()}_API_KEY. ` +
          (body ? `Server said: ${body}` : ''),
        );
      }
    } catch (err) {
      probeResults.push({ provider, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
      console.error(
        `[opencues] LLM key probe failed for ${provider} — ${err instanceof Error ? err.message : String(err)}. ` +
        `Possible causes: extension service worker not running, no internet, provider down.`,
      );
    }
  }));

  // One-line summary. Each bucket is empty-suppressed so a clean run
  // collapses to `LLM keys ok: groq, cerebras, gemini` without trailing
  // empties. Sorted by provider name for stability across reloads.
  const fmt = (st: 'ok' | 'invalid' | 'failed'): string => probeResults
    .filter(r => r.status === st)
    .map(r => r.detail ? `${r.provider} (${r.detail})` : r.provider)
    .sort()
    .join(', ');
  const parts: string[] = [];
  const ok = fmt('ok');       if (ok) parts.push(`ok: ${ok}`);
  const bad = fmt('invalid'); if (bad) parts.push(`invalid: ${bad}`);
  const err = fmt('failed');  if (err) parts.push(`failed: ${err}`);
  if (parts.length > 0) log.info(`[opencues] LLM keys — ${parts.join('; ')}`);
}

/**
 * Construct the runtime if not already running. Idempotent — second
 * call returns the cached BootResult. Call once at content-script
 * load (after publishTarget has been hooked up).
 */
export function startOpenCues(opts: RuntimeStartOptions = {}): BootResult {
  if (bootResult) return bootResult;

  // HostAdapter `log` callback — the runtime's primary logging channel.
  // Declared early so the user-blank registration IIFE below (which
  // may surface its failure via this callback) can reach it. Levels:
  //   error           → always hit the page console
  //   warn/info/debug → page console only when `debug-mode: on`
  // The mirror to /tmp/opencues.log via the SW fires regardless of
  // the gate, so the durable record is intact at every level.
  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    const tag = `[opencues][${level}]`;
    if (level === 'error') console.error(tag, msg, data ?? '');
    else if (level === 'warn') { if (_readTrace) console.warn(tag, msg, data ?? ''); }
    else if (level === 'debug') { if (_readTrace) console.debug(tag, msg, data ?? ''); }
    else if (_readTrace) console.log(tag, msg, data ?? '');
    try {
      const safeData = serialiseLogData(data);
      chrome.runtime.sendMessage({ type: 'opencues:log', level, msg, data: safeData })
        .catch(() => { /* port closed or no listener — local console still has it */ });
    } catch { /* ditto */ }
  };

  // CE.8 — build the chrome blank registry. The runtime's BlankFill
  // + Cycling dispatch into this via blankInvoke.
  // Stocks is a non-LLM API blank backed by Finnhub. Chrome reads its
  // key from the same multi-provider bag the LLM resolver uses
  // (`opencues_host_keys.FINNHUB_API_KEY`, pushed by chrome-host); the
  // popup never carries it. Without chrome-host installed there's no
  // FINNHUB_API_KEY → StocksBlank factory returns null → keyword
  // silently no-ops, same as native hosts without the env-var.
  const blanks = createBlanks({
    finnhubApiKey: opts.llmApiKeys?.FINNHUB_API_KEY ?? undefined,
    customTickers: opts.customTickers,
    // OpenCues settings selector/satellite (`opencues settings _`)
    // reads/writes the seeded OPENCUES.md in chrome.storage.
    opencuesMdReadFile: () => readFile(`${ROOT}/.cues/OPENCUES.md`),
    opencuesMdWriteFile: (content) => writeFile(`${ROOT}/.cues/OPENCUES.md`, content),
    // Sentinel-write blank — keyword-bound `set sentinel _` /
    // `remove sentinel _`. Writes go through @opencues/core's
    // validateSentinelWrite chokepoint BEFORE this writer is called;
    // do not add a parallel write path. Security-audit.md row #24.
    identityMdReadFile: () => readFile(`${ROOT}/.cues/IDENTITY.md`),
    identityMdWriteFile: (content) => writeFile(`${ROOT}/.cues/IDENTITY.md`, content),
    // Note collection blank — keyword-bound `note add/…/delete _`.
    // Writes go through @opencues/runtime's validateNoteWrite
    // chokepoint BEFORE this writer is called. chrome.storage-backed:
    // the store is per-browser until chrome-host push/pull covers
    // NOTES.md (same situation as IDENTITY.md writes).
    notesMdReadFile: () => readFile(`${ROOT}/.cues/NOTES.md`),
    notesMdWriteFile: (content) => writeFile(`${ROOT}/.cues/NOTES.md`, content),
    // Model-visibility blank ("whats my model _") — thunk over the
    // LIVE key ref (kept current by updateRuntimeApiKeys), not a boot
    // snapshot: chrome keys arrive async post-boot and rotate live
    // (docs/architecture/chrome-llm-keys.md). Seeded here with the
    // boot bag, incl. the legacy single-key popup field as
    // GROQ_API_KEY — mirrors the resolver's own bag construction.
    getLlmApiKeys: () => _liveLlmKeys ?? {
      ...(opts.llmApiKey ? { GROQ_API_KEY: opts.llmApiKey } : {}),
      ...(opts.llmApiKeys ?? {}),
    },
  });
  blankInvoke = createBlankInvoke(blanks);

  // Register user-shipped JS blanks discovered in the storage bundle.
  // Same architecture as native hosts (CC/OC/Gemini) — walks every
  // BLANK.md, finds entries with `impl: ./xxx.js`, instantiates a
  // ChromeUserBlank for each (Web Worker + capability bridge). The
  // map is shared by reference with createBlankInvoke so dynamic
  // additions are visible to the runtime without re-wiring.
  void (async () => {
    try {
      // Assemble the LLM credential map the user-blank LLM bridge
      // uses. Combines primary (opts.llmApiKey → GROQ default) with
      // any per-provider overrides (opts.llmApiKeys). Mirrors the
      // shape resolveLLM expects.
      const llmApiKeys: Record<string, string> = {};
      if (opts.llmApiKey) llmApiKeys.GROQ_API_KEY = opts.llmApiKey;
      if (opts.llmApiKeys) {
        for (const [k, v] of Object.entries(opts.llmApiKeys)) {
          if (typeof v === 'string' && v.length > 0) llmApiKeys[k] = v;
        }
      }
      await registerUserBlanksFromBundle(blanks, llmApiKeys);
    } catch (err) {
      log('warn', 'user-blank registration failed', err);
    }
  })();

  // Calendar-context (calendar) — a MUTABLE holder passed by reference so the
  // resolver reads it fresh each resolve. Chrome does NOT fetch feeds; the
  // shared `~/.cues/calendar.json` is produced OpenCues-side by
  // `opencues calendar sync` and pushed here by the chrome-host. loadCalendarContext()
  // (below, after boot + on storage change) refills this holder in place.
  const calendarContextHolder: { events: Array<{ token: string; title: string; start: string; end: string; allDay?: boolean; location?: string }>; catalog: Map<string, string>; ingestedAt?: string } =
    { events: [], catalog: new Map(), ingestedAt: undefined };

  // No seed step — readFile() resolves bake-time constants directly
  // for read-only paths, and writable paths (OPENCUES.md) persist
  // through chrome.storage only when they're actually written.
  bootResult = boot({
    hostVersion: '0.1.0',
    cwd: ROOT,
    calendarContext: calendarContextHolder,
    getText: () => currentTarget ? readTargetText(currentTarget) : '',
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
    // Runtime-requested cursor jumps (transform/fluid substitution
    // landing-position) must be honored even on managed editors —
    // pass force=true to bypass the natural in-segment-stay behavior.
    // We also re-apply after a frame so the managed editor's
    // post-reconcile cursor snap doesn't override us.
    setCursorOffset: (offset) => {
      reapplyCursor(offset);
    },
    pushText: (text, cursor) => {
      // diffWriteText already calls sourceReclassifier.markRuntimeWrite.
      // Cursor is set synchronously after so the input-event handler
      // reads the post-fill caret position (matters for multi-word fills).
      diffWriteText(text);
      // Skip the explicit cursor restore when the write was handled by
      // an in-place text-node mutation path (e.g. Quill hunk fast path)
      // that preserves the user's caret naturally. The runtime-provided
      // `cursor` is derived from `translateCursor(cursorBefore, ...)`
      // which on Quill can be `0` (chrome.readCursorOffset returns 0
      // when Quill parks `window.getSelection` outside `.ql-editor` —
      // a regular occurrence with LinkedIn's private bundle). Applying
      // `reapplyCursor(0)` after a successful in-place mutation would
      // drag the caret to start-of-buffer, exactly the symptom users
      // see on agent-rewrite ticks. When the in-place path mutated text
      // nodes directly, the browser preserved text-node-offset for the
      // caret AND Quill's MutationObserver fed the change into its
      // Delta model with selection-shifting — so caret is already at
      // the right place. Don't second-guess it.
      //
      // For storm fallback + transform-blank single-segment paths the
      // flag stays `false`, so the explicit reapply runs as before —
      // those paths need it. Transform-blank specifically passes a
      // cursor value derived from the substitute span (NOT from
      // getCursorOffset), so it's always meaningful.
      if (cursor !== undefined && !_diffPreservedCursor) reapplyCursor(cursor);
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
    // CE.7 — Resolver constructs ALWAYS (even keyless) so the
    // MissingKeyFallbackSource can paint the "open the popup" hint
    // in-buffer when the user types `_`. Pass FetchHttpAdapter
    // unconditionally — the gate that previously withheld it when
    // no keys were present caused rebuildResolver to lazy-load the
    // NodeHttpAdapter stub (throws on chrome), which (a) spammed a
    // confusing error log and (b) bailed out of rebuildResolver
    // BEFORE the fallback source was registered, so the user-facing
    // hint never appeared either. The adapter is a thin fetch
    // wrapper; cost of always constructing is negligible.
    llmApiKey: opts.llmApiKey,
    llmApiKeys: opts.llmApiKeys,
    llmEndpoint: opts.llmEndpoint,
    llmDefaultModel: opts.llmDefaultModel,
    llmProvider: opts.llmProvider,
    llmDebounceMs: opts.llmDebounceMs,
    httpAdapter: new FetchHttpAdapter(),
    // SW-routed GET for contradiction world-data caches (GOV.UK bank holidays,
    // open-meteo weather). A content-script fetch to those origins is blocked by
    // the host page's CSP; hopping through the SW (opencues:fetch; both origins
    // in host_permissions + the SW allow-list) bypasses it.
    worldDataFetch: async (url: string) => {
      const reply = await chrome.runtime.sendMessage<unknown, { ok?: boolean; text?: string }>({
        type: 'opencues:fetch', method: 'GET', url,
      });
      return { ok: !!reply?.ok, json: async () => JSON.parse(reply?.text ?? 'null') };
    },
    // CE.8 — blankInvoke routes blank-fill + cycle script calls to
    // the chrome blanks registry above (volume / stocks / weather /
    // hackernews / prompt-improver). Returns null for unknown
    // blanks so the spawnProcess fallback takes over.
    blankInvoke: (spec) => blankInvoke?.(spec) ?? null,
    // Universal-Integration filter: tell the runtime whether the
    // currently focused target supports cycling. Contenteditables
    // get the full feature set; normal `<input>` / `<textarea>` get
    // single-answer blanks only (no word-cues, no selector blanks,
    // no volume/brightness, no list cycling). The runtime resolver
    // reads this per-build and rebuilds sources when focus moves
    // between the two kinds — sources/blanks pruned reactively
    // without any popup save or page reload.
    supportsCycling: () => !isNormalInput(currentTarget),
    // Quill (LinkedIn share composer) opt-out for background agent
    // rewrites. Quill's Delta-model selection doesn't sync from browser
    // selections we set after a write, so every keystroke following an
    // agent-rewrite tick lands at Quill's internal cursor position
    // rather than where the user sees the caret — typing into the
    // wrong location, feature unusable. Inline single-substitution
    // flows on the same target (transform-blank `translate to
    // japanese _`, fluid-blank `weather _`, word-cues) still work
    // because their cursor is computed deterministically from the
    // substitute span and they mutate one text node which Quill's
    // Delta-model selection-shift handles correctly. The runtime gate
    // wipes the `agentically X _` trigger phrase cleanly but doesn't
    // arm an AgentTask on Quill. See adapter.ts § supportsAgentRewrite.
    supportsAgentRewrite: () => !(currentTarget && isLinkedInShareComposerQuill(currentTarget)),
    // Ambient-context gatherer — gated by the `ambient-context-mode`
    // scalar on the runtime side. Returns null for sensitive fields
    // and when no usable metadata is present. See gatherAmbientContext
    // for the read scope; see AmbientContext in @opencues/runtime for
    // the security contract.
    getAmbientContext: () => gatherAmbientContext(currentTarget),
    // CE.9 — spawnProcess routes through the native-messaging host
    // when installed (`opencues install chrome-host`). Without it,
    // the adapter returns exitCode 127. Content scripts can't talk
    // to chrome.runtime.connectNative directly (SW-only API), so we
    // proxy via chrome.runtime.sendMessage → SW forwards over the
    // native port → SW relays the matching exec-result back here.
    spawnProcess: (spec) => {
      const result = (async () => {
        try {
          const reply: { exitCode: number; stdout: string; stderr: string; timedOut: boolean } =
            await chrome.runtime.sendMessage({
              type: 'opencues:exec',
              command: spec.command,
              args: Array.from(spec.args ?? []),
              env: spec.env,
              timeoutMs: spec.timeoutMs,
              sandbox: spec.sandbox,
            });
          // When chrome-host isn't connected, the SW returns 127 with
          // a known stderr. BlankFill's `res.exitCode !== 0 → return`
          // path would otherwise drop this silently — the user types
          // `volume _` and nothing happens. Translate into a successful
          // stdout so BlankFill splices a user-visible hint instead.
          // Same treatment for the upstream sendMessage-failed case
          // (SW unreachable / extension reloaded mid-call).
          if (reply.exitCode === 127 && /native host not connected/i.test(reply.stderr)) {
            return {
              exitCode: 0,
              stdout: '[OpenCues: this blank requires chrome-host — install via `opencues install chrome-host`]',
              stderr: '',
              timedOut: false,
            };
          }
          return reply;
        } catch (err) {
          return {
            exitCode: 0,
            stdout: '[OpenCues: extension messaging failed — reload the tab and try again]',
            stderr: '',
            timedOut: false,
          };
        }
      })();
      return { result, kill: () => { /* native host owns the lifecycle */ } };
    },
    // statusSnapshotHook intentionally omitted — CE.6 will route to
    // the StatusBar div. Without the hook, the Statusline module
    // skips both the file write (no exportPath) and the in-process
    // sink (no onSnapshot), so it sits dormant.
  });

  // One-shot read of debug-mode from storage — subsequent flips are
  // picked up by the chrome.storage.onChanged listener registered
  // near the top of this file.
  //
  // Live config sync from ~/.cues/ is delivered by the native-messaging
  // host: background.ts opens the port, writes pushed bundles to
  // chrome.storage.local['opencues_bundle'], and the storage-onChanged
  // listener above invalidates _bundleIndexPromise + calls
  // bootResult.reloadConfig().
  void refreshReadTraceFromStorage();

  // Load the shared calendar snapshot into the calendar-context holder, and
  // re-load whenever the pushed bundle changes (OpenCues-side `calendar sync`
  // → chrome-host push → storage.onChanged). Chrome consumes; it never fetches.
  const loadCalendarContext = async (): Promise<void> => {
    try {
      let raw = await readFile(ROOT + '/.cues/calendar.json');
      // The live storage bundle (chrome-host) may not carry calendar.json
      // (a host predating this feature, or a different clone). Fall back to the
      // packaged, `opencues sync chrome`-produced copy so the calendar still
      // loads. The chrome-host path takes over once it pushes the file.
      if (!raw) {
        try {
          const r = await fetch(chrome.runtime.getURL('dist/configs/calendar.json'));
          if (r.ok) raw = await r.text();
        } catch { /* ignore */ }
      }
      const parsed = raw ? JSON.parse(raw) : null;
      const events = (parsed && Array.isArray(parsed.events)) ? parsed.events : [];
      const snap = buildCalendarContextSnapshot(events, parsed?.ingestedAt);
      calendarContextHolder.events.length = 0;
      for (const e of snap.events) calendarContextHolder.events.push({ token: e.token, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location });
      calendarContextHolder.catalog.clear();
      for (const [k, v] of snap.catalog) calendarContextHolder.catalog.set(k, v);
      calendarContextHolder.ingestedAt = snap.ingestedAt;
      if (snap.events.length > 0) log('info', `[opencues] calendar-context: ${snap.events.length} calendar event(s) loaded`);
    } catch (err) { log('warn', '[opencues] calendar-context load failed', err); }
  };
  void loadCalendarContext();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes['opencues_bundle']) void loadCalendarContext(); });

  // Mirror `opencues check-keys` — ping the LLM provider at boot
  // so users find out about missing/invalid keys without having to
  // type a `_` and silently wait for nothing. The CLI hits each
  // provider's lightest endpoint; we do the same for whichever
  // provider key chrome has.
  void verifyLlmKeyAtBoot(opts);

  // Eager bundle-to-storage sync at boot. chrome.storage.onChanged
  // only fires for CHANGES from this point forward — if the bundle
  // was pushed by the SW before the content script loaded, we'd never
  // see it via onChanged and the stale per-key OPENCUES.md storage
  // overlay would mask the bundle's value. Read once on boot and
  // overwrite the per-key entry so storage and bundle agree.
  void chrome.storage.local.get('opencues_bundle').then(stored => {
    const b = stored['opencues_bundle'] as { files?: Record<string, string> } | undefined;
    const bundledOpencuesMd = b?.files?.['OPENCUES.md'];
    if (typeof bundledOpencuesMd === 'string') {
      const key = `${STORAGE_PREFIX}${ROOT}/.cues/OPENCUES.md`;
      return chrome.storage.local.set({ [key]: bundledOpencuesMd });
    }
  }).catch(() => { /* swallow — best-effort */ });

  // Markdown styling — substituting modules (TransformBlank / FluidBlank
  // via @opencues/runtime applyMarkdownAwareSubstitution) emit
  // `markdown.styled` with the stripped text + per-style ranges in
  // stripped-text coords. The runtime has already written the stripped
  // buffer; chrome's job is to apply native bold/italic/strike markup
  // to the live DOM so the page renders the styles the LLM intended.
  bootResult.onModuleEvent((type, body) => {
    if (type === 'markdown.styled' && body) {
      try { applyMarkdownStyling(body as unknown as MarkdownStyledPayload); }
      catch (err) { log('warn', 'applyMarkdownStyling failed', err); }
      return;
    }
    // Span-as-unit indication. The runtime tells us when a blank just
    // substituted a result that's clearOnEdit-flagged (the whole span
    // wipes when any char inside is edited) and when such a span got
    // wiped. Both surface via `log.info` so they only appear when
    // `debug-mode: on` — chrome devtools stays clean by default.
    if (type === 'blank.substituted' && body && (body as { spanAsUnit?: boolean }).spanAsUnit) {
      const b = body as { blankName?: string; output?: string };
      log('info', `✏︎ span-as-unit fill: "${b.blankName ?? '?'}" — editing inside it wipes the whole span`);
      return;
    }
    if (type === 'blank.span-wiped' && body) {
      const b = body as { reason?: string; wipedCharCount?: number };
      log('info', `⌫ span-as-unit wiped (${b.wipedCharCount ?? '?'} chars, reason: ${b.reason ?? '?'})`);
      return;
    }
  });

  return bootResult;
}

// ─── Markdown styling on the live DOM ───────────────────────────────────
//
// Payload shape (mirrors markdown-substitute's `markdown.styled` event):
//   { text, bold[], italic[], code[], strike[], heading[], list[] }
// Ranges are in stripped-text coords — they index into the buffer the
// runtime just wrote (which is `payload.text`). We translate those
// coords into the live target's plain-text offsets via the same
// walkPlainText pass diffWriteText uses, then drive execCommand on the
// browser Selection for each style range.

type MdRange = { start: number; end: number };
interface MarkdownStyledPayload {
  text: string;
  bold?: readonly MdRange[];
  italic?: readonly MdRange[];
  code?: readonly MdRange[];
  strike?: readonly MdRange[];
  heading?: readonly MdRange[];
  list?: readonly MdRange[];
}

function applyMarkdownStyling(payload: MarkdownStyledPayload): void {
  const target = currentTarget;
  if (!target) { log.info('[opencues] markdown.styled: no currentTarget — drop'); return; }
  if (typeof payload.text !== 'string') { log.info('[opencues] markdown.styled: no payload.text — drop'); return; }

  // Verify the live buffer still matches the stripped text. Tolerant
  // prefix match: when the contenteditable preserves trailing empty
  // paragraph blocks from before the substitution (Gmail / Lexical /
  // ProseMirror commonly do), walkPlainText reports the trailing \n
  // characters but the styled ranges all sit within the matching
  // prefix, so the apply is still correct. We refuse only when the
  // prefix itself diverges (user typed mid-substitution, replaceAll
  // hasn't finished, etc).
  const { text: live } = walkPlainText(target);
  if (!live.startsWith(payload.text)) {
    log.info(`[opencues] markdown.styled: live drift — live="${live.slice(0,60)}" payload="${payload.text.slice(0,60)}"`);
    return;
  }
  log.info(`[opencues] markdown.styled: applying bold=${(payload.bold ?? []).length} italic=${(payload.italic ?? []).length} strike=${(payload.strike ?? []).length}`);

  // Snapshot the user's selection so we can restore it after styling.
  const sel = window.getSelection();
  const saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

  // Always use the contentEditable native capability — execCommand on
  // a browser Selection. On generic contenteditables (Gmail, plain
  // <div contenteditable>) it directly wraps the selection in a
  // <b> / <i> / <strike> tag. On managed editors that intercept
  // beforeinput (PM/Lexical/Slate), it silently no-ops — accepted
  // when those editors are configured plain-text-only with no
  // formatting capability. The styling intent is communicated;
  // editors that can render it do, editors that can't ignore it.
  const apply = (ranges: readonly MdRange[] | undefined, command: 'bold' | 'italic' | 'strikethrough'): void => {
    if (!ranges || ranges.length === 0) return;
    for (const r of ranges) {
      if (!selectPlainRange(target, r.start, r.end)) continue;
      try { document.execCommand(command); } catch { /* fails silently */ }
    }
  };

  apply(payload.bold, 'bold');
  apply(payload.italic, 'italic');
  apply(payload.strike, 'strikethrough');
  // code / heading / list are skipped on chrome for now — execCommand has
  // no equivalents and per-engine wrapping (<code>, <h1>, <li>) is too
  // editor-specific for a generic implementation. Native-host adapters
  // render these via ANSI; chrome can pick them up site-by-site later.

  if (saved && sel) {
    try { sel.removeAllRanges(); sel.addRange(saved); }
    catch { /* selection restore can fail if DOM shifted */ }
  }

  // Format-state reset. `execCommand('bold')` over a range toggles the
  // browser's GLOBAL typing-mode for bold — after the selection is
  // restored to the cursor's pre-styling position, the next character
  // the user types would inherit that mode (becomes bold). Same for
  // italic / strikethrough. Query each format's current state and
  // toggle it off when set. Collapsed-selection execCommand calls
  // only flip the typing flag; they don't touch the rendered DOM.
  const resetIfActive = (cmd: 'bold' | 'italic' | 'strikethrough'): void => {
    try {
      if (document.queryCommandState(cmd)) document.execCommand(cmd);
    } catch { /* both APIs can throw on detached docs / sandboxes */ }
  };
  resetIfActive('bold');
  resetIfActive('italic');
  resetIfActive('strikethrough');

  sourceReclassifier.markRuntimeWrite(walkPlainText(target).text);
}

/** Position the browser Selection over [start, end) plain-text offsets
 *  inside target. Returns true on success. */
function selectPlainRange(target: HTMLElement, start: number, end: number): boolean {
  if (start >= end) return false;
  const sel = window.getSelection();
  if (!sel) return false;
  const { segments } = walkPlainText(target);
  let startNode: Text | null = null, startOff = 0;
  let endNode: Text | null = null, endOff = 0;
  for (const seg of segments) {
    if (startNode === null && start >= seg.plainStart && start <= seg.plainEnd) {
      startNode = seg.node;
      startOff = Math.min(start - seg.plainStart, seg.node.data.length);
    }
    if (end >= seg.plainStart && end <= seg.plainEnd) {
      endNode = seg.node;
      endOff = Math.min(end - seg.plainStart, seg.node.data.length);
      break;
    }
  }
  if (!startNode || !endNode) return false;
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

// ─── Trust gate: underscore credit ──────────────────────────────────────
//
// Blank fires are triggered by `_` in the text. A hostile page can
// call `execCommand('insertText', false, '_')` (after a user gesture)
// and the resulting input event is isTrusted=true with no preceding
// `_` keystroke, defeating a naive timestamp-based gate. Worse, after
// any legitimate `_` keystroke the page would have a "blessed window"
// it could exploit.
//
// Solution: credit-based. Each trusted `_` introduction adds N credits
// (count of `_` characters introduced):
//
//   - trusted keydown of '_'                    → +1
//   - trusted paste whose data contains '_'     → +<count in data>
//   - trusted drop  whose data contains '_'     → +<count in data>
//
// Every accepted text-change consumes credits equal to (new underscore
// count − last accepted count) when that delta is positive. If the
// delta exceeds available credits, the change is silently dropped.
//
// Runtime writes are reclassified to source='runtime' by
// sourceReclassifier; they don't consume credits and don't change the
// baseline gate — the count tracker resets to whatever the runtime
// wrote so the next user-typed `_` is still detected as a fresh
// addition.

const trustGate = createTrustGate();
// Diagnostic-only sentinel — the popup's Self-Check reads this to
// confirm the bootstrap loaded. Boolean, not the live gate object:
// page scripts can't reach this property (Chrome content-script
// isolated world), but a future code path that runs in MAIN world
// would otherwise get noteUnderscoreInsertion / reset on a silver
// platter and could forge credits to bypass the gate.
(window as unknown as { __opencuesTrustGateInstalled?: true }).__opencuesTrustGateInstalled = true;

/** Called from content.ts on every trusted `_` introduction. `count`
 *  is the number of `_` characters introduced (1 for keydown of '_',
 *  N for paste/drop with N underscores). */
export function noteUserUnderscoreInsertion(count = 1): void {
  trustGate.noteUnderscoreInsertion(count);
}

/** Wipe pending trust-gate credits without clearing the baseline.
 *  Wired to focusin/focusout in content.ts so a credit earned in
 *  field A can't fund an injection in field B. Closes the
 *  "cross-field stale credit" attack. */
export function resetTrustGateCredits(): void {
  trustGate.resetCredits();
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
  let actualSource = sourceReclassifier.reclassify(text, source);

  // Undo/redo window — if a recent historyUndo/historyRedo opened the
  // window, reclassify to 'runtime' so the resolver and BlankFill skip
  // (a restored `_` must not fire the blank pipeline). Trust gate then
  // takes the runtime-write path and updates baseline without consuming
  // credits.
  if (actualSource === 'user' && Date.now() < _externalReplaceUntil) {
    actualSource = 'runtime';
  }

  // Trust gate. Only applies to user-classified changes; runtime
  // writes bypass + reset the baseline. See trust-gate.ts.
  if (!trustGate.checkAndConsume(text, actualSource === 'runtime')) return;

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
  // Suspended = focus left this buffer but we kept its state. Don't repaint a
  // blurred field; the next focus un-suspends and repaints.
  if (_suspended) return;
  const target = currentTarget;
  if (!target || !bootResult) return;
  // Normal `<input>` / `<textarea>` can't host CSS Custom Highlights —
  // their value is laid out by the browser's internal text-rendering,
  // not from DOM text nodes Range can address. So we skip every render
  // tick. Cues are computed by the runtime but never painted; blank
  // fills still land via writeNormalInputValue.
  if (isNormalInput(target)) { clearInlineNote(); return; }
  const text = walkPlainText(target).text;
  const cursor = readCursorOffset();
  // NOTE: the caret-unreadable DISABLE gate and the unreliable-cursor note
  // SUPPRESSION were removed (2026-07) so the raw rendering is observable while
  // debugging LinkedIn. readCursorOffset still tracks reliability + logs
  // diagnostics; nothing consumes them for rendering right now. Re-add a gate
  // here if the LinkedIn-Posts mis-fire needs handling again.
  const directives = bootResult.collectRenderDirectives(text, cursor);
  // Push-down mode for the inline note (make room so it doesn't occlude the
  // line below). Plain contenteditables host a real spacer NODE; managed
  // editors (Lexical/PM/Quill) revert external nodes AND we don't own their
  // send button, so there we nudge the containing block's bottom MARGIN via
  // inline style instead (layout only — can't ship, no undo entry).
  applyDirectives(target, directives, isManagedEditor(target) ? 'margin' : 'node');
  const pushDiag = consumePushDiag();
  if (pushDiag) log.debug('[chrome] marginPush', pushDiag);
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
    // Normal `<input>` / `<textarea>` mode has no painted cues / cycling
    // band / navigation overlay, so the runtime's key dispatch has
    // nothing to act on (cycling would mutate text invisibly — worse
    // than no-op). Let browser-default key behavior pass through —
    // EXCEPT a bare `_` keypress, which the resolver's explicit-`_`
    // gate (runtime PR #52) requires to arm blank dispatch. Without
    // this carve-out every blank silently no-ops in normal-input mode.
    const normalInput = isNormalInput(target);
    const isBareUnderscore = e.key === '_' && !e.ctrlKey && !e.altKey && !e.metaKey;
    // Always forward the salient keys the kata coach observes (Enter / Tab
    // / Escape / arrows) — UNCONDITIONALLY, not gated on any "kata active"
    // flag. A dropped keypress is worse than a forwarded one: these are
    // passively observed (the coach's observeKey returns false, and does
    // nothing at all when no kata is running), so dispatchKey below never
    // consumes them and browser-default behaviour (newline, cursor move,
    // focus change) is always preserved. The runtime decides what to do
    // with the key; the host just delivers it.
    const isSalientKey = e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape'
      || e.key === 'ArrowUp' || e.key === 'ArrowDown'
      || e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (normalInput && !isBareUnderscore && !isSalientKey) return;
    // Shadow-DOM piercing: on web-component editors with
    // delegatesFocus (Reddit's <shreddit-composer>), document.activeElement
    // reports the shadow HOST — usually an ANCESTOR of `target` —
    // and target.contains(host) is false, so every key event silently
    // no-ops. composedPath()[0] is the actual leaf the event came from
    // (a Node, possibly Text), which IS inside target.
    const path = (e as Event).composedPath();
    const leaf = path.length > 0 ? path[0] as Node : document.activeElement;
    const inTarget = leaf === target || (leaf instanceof Node && target.contains(leaf));
    if (!inTarget) return;
    const text = readTargetText(target);
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
