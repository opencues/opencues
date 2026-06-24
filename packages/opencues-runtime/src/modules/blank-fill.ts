// BlankFill — auto-populate `_` slots when a keyword-bound blank claims them.
//
// Scans the input text on every change for `_` placeholders. For each `_`,
// walks backward word-by-word looking for a match against any blank's
// blankKeywords (single or multi-word). When matched, records a BlankSlot
// with the blank name + match positions for downstream consumers
// (auto-populate, blank-script fetch, span tracking, dismiss, etc.).

import type { HostAdapter, KeyEvent, TextChangeEvent, Unsubscribe } from '../adapter';
import type { ConfigLoader } from './config-loader';
import { splitWords } from './navigation';
import { resolveReplaceMode, isBlankConfigCycleable, type EffectiveReplaceMode } from '@opencues/core';
import type { SpanFillState } from '../state/span-fill';
import type { DismissedBlanks } from '../state/dismissed-blanks';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import type { DynDefs } from '../state/dyn-defs';
import { BlankLoadingAnimator, parseCustomFrames, parseRgbColors, parseAnsiColors, parseFrameIntervalMs, DEFAULT_RGB_PALETTE, DEFAULT_ANSI_PALETTE, type BlankLoadingMode } from './blank-loading';
import { buildSafeScriptEnv } from '../security/safe-env';

export interface BlankSlot {
  /** Word index of the `_`. */
  readonly index: number;
  /** Matched keyword string (lowercased, may contain spaces for multi-word). */
  readonly keyword: string;
  /** Lowercased blank name. */
  readonly blankName: string;
  /** First word index of the matched keyword. */
  readonly keywordStart: number;
  /** Last word index of the matched keyword. */
  readonly keywordEnd: number;
  /** Words between keywordEnd and the `_` (0 = adjacent). */
  readonly proximity: number;
}

/**
 * The decision the BlankIntent gate returns to `maybeRunScripts`.
 *   - `cede`   → suppress the blank (the keyword was prose).
 *   - `invoke` → run it. `action`/`value` are the classifier's extracted
 *     intent; `set` + a numeric `value` performs a real set on a SETTABLE
 *     blank (one with `blankStep`), otherwise the default `get` runs.
 */
export type BlankIntentDecision =
  | { verdict: 'cede' }
  | { verdict: 'invoke'; action: 'get' | 'set' | 'step'; value: string | null };

export class BlankFill {
  private _slots: readonly BlankSlot[] = [];
  private _unsubText: Unsubscribe | null = null;
  private _unsubKey: Unsubscribe | null = null;
  /** One-shot flag: armed on a plain `_` keystroke, cleared at the end
   *  of the next `onTextChange`. Mirrors the resolver's gate — script-
   *  backed blanks (volume, brightness, etc.) only dispatch when the `_`
   *  in the buffer was placed by an explicit user keystroke. A `_`
   *  exposed via cursor-relocation (`volume_` → split to `volume _`),
   *  paste, or programmatic setText MUST NOT fire the script. */
  private _underscoreKeyArmed = false;
  /** Last user-typed text — used by the diff-based gate fallback so
   *  that host adapters which can't reliably deliver every `_` keydown
   *  (chrome's focus-trap modals — LinkedIn share composer, Reddit's
   *  shreddit composer) don't silently block legit blank dispatch.
   *  See `_onTextChangeImpl` for the fallback logic. */
  private _lastInputText = '';
  /** Dedup key (text + slot index) → in-flight script promise. */
  private _pendingScripts = new Set<string>();
  private _warnedSandboxBlanks = new Set<string>();
  /** INFOSEC F9: blank names we've already warned about for missing
   *  `sandbox:` declaration. One warn per name per process. */
  private _warnedMissingSandboxBlanks = new Set<string>();

  /**
   * Per-blank result cache. Keyed by `<blankName>::<argsKey>` where
   * argsKey is `<keyword>|<contextWords-joined>`. Entries carry the
   * stdout string + fetchedAt timestamp + the TTL the entry was
   * cached against.
   *
   * Why: every keystroke that creates a fillable slot spawns the
   * blank's `get` script (bash → external binary on WSL = ~150ms
   * fork+exec; network blanks like weather/stocks = ~500ms HTTP).
   * Repeat invocations with identical args within the TTL (user
   * backspaces the substitution and re-types `_`, or re-cycles the
   * same `_`) returned the SAME stdout but paid the spawn cost again.
   *
   * Cache invariants:
   *  - GET path only — BlankFill never calls `set` here, so cached
   *    entries are always idempotent read-results.
   *  - Per-blank TTL (frontmatter `blankCacheTtlMs`, default 2000ms,
   *    0 disables). Tuned for "instant on re-cycle" without masking
   *    real-world value drift (system volume changed externally, BTC
   *    moved 30s ago). Action blanks (volume/brightness) keep the
   *    default; ambient blanks (weather/stocks) may opt for higher
   *    values in their BLANK.md frontmatter.
   *  - LRU eviction at 32 entries — far above the typical
   *    keyword-bound blank count (<10) so steady-state is no eviction.
   */
  private _resultCache = new Map<string, { output: string; fetchedAt: number; ttlMs: number }>();
  private static readonly RESULT_CACHE_MAX_ENTRIES = 32;
  private static readonly DEFAULT_CACHE_TTL_MS = 2000;
  /**
   * Loading-animation owner for in-flight blank slots. Lazily created
   * on first dispatch; mode read from OPENCUES.md's
   * `blank-loading-animation` scalar (bounce | braille-rotate | off).
   * Default is bounce.
   */
  private _loading: BlankLoadingAnimator | null = null;

  constructor(
    private adapter: HostAdapter,
    private configLoader: ConfigLoader,
    private spanFillState?: SpanFillState,
    private dismissedBlanks?: DismissedBlanks,
    private selectorSatelliteState?: SelectorSatelliteState,
    private dynDefs?: DynDefs,
    /** Shared loading-animator. Injected by boot-common so BlankFill +
     *  Resolver share one instance and avoid racing on slots that span
     *  both paths. When omitted, BlankFill lazily creates its own (kept
     *  for backward compat with external callers that haven't wired the
     *  shared owner). */
    blankLoading?: BlankLoadingAnimator,
    /** BlankIntent gate (off by default; wired by boot-common only when
     *  `blank-intent-mode: on`). Consulted in `maybeRunScripts` BEFORE a
     *  keyword-matched script-blank runs. Returns the extracted verdict:
     *  `cede` suppresses the blank (keyword behaves as prose); `invoke`
     *  runs it, and for a SETTABLE blank (one with `blankStep`) an
     *  `action: 'set'` + numeric `value` performs a real set (`volume 30
     *  _`) instead of a get. When omitted, every keyword-matched slot runs
     *  a plain get unconditionally (the proximity gate — today's
     *  behaviour). NEVER throws (the classifier degrades to a get-invoke
     *  on any LLM failure). */
    private blankIntentGate?: (text: string, blankName: string) => Promise<BlankIntentDecision>,
  ) {
    if (blankLoading) this._loading = blankLoading;
  }

  private _loadingAnimator(): BlankLoadingAnimator {
    if (this._loading !== null) return this._loading;
    this._loading = new BlankLoadingAnimator({
      adapter: this.adapter,
      mode: () => {
        const raw = this.configLoader.opencuesState.settings.get('blank-loading-animation');
        if (raw === 'off' || raw === 'braille-rotate' || raw === 'flipper' || raw === 'custom') return raw;
        return 'bounce';
      },
      customFrames: () => parseCustomFrames(
        this.configLoader.opencuesState.settings.get('blank-loading-frames'),
      ),
      rgbColors: () => parseRgbColors(
        this.configLoader.opencuesState.settings.get('blank-loading-colors-rgb'),
      ) ?? DEFAULT_RGB_PALETTE,
      ansiColors: () => parseAnsiColors(
        this.configLoader.opencuesState.settings.get('blank-loading-colors-ansi'),
      ) ?? DEFAULT_ANSI_PALETTE,
      frameIntervalMs: () => parseFrameIntervalMs(
        this.configLoader.opencuesState.settings.get('blank-loading-interval-ms'),
      ),
      log: msg => this.adapter.log('debug', msg),
    });
    return this._loading;
  }

  subscribe(): void {
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
    // Auto-populate path: intercept the '_' key BEFORE the host
    // applies it. If the simulated insertion would create a fillable slot,
    // we fill it ourselves and consume the keystroke. Otherwise return
    // false and let the host insert '_' normally.
    this._unsubKey = this.adapter.onKey({ keys: ['_'] }, e => this.onUnderscoreKey(e));
    // Also scan immediately in case text already has blanks at boot.
    this.scan(this.adapter.getText());
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._unsubKey) { this._unsubKey(); this._unsubKey = null; }
  }

  /** Full state reset — wipes per-buffer / per-keystroke state +
   *  the script-result cache so the next text-change runs from a
   *  clean slate. Called as part of a full runtime reset (keep-alive
   *  host session boundary, off-process bridge `reset` command).
   *  Subscriptions stay live — this only wipes data; the module is
   *  still attached to the adapter. */
  resetState(): void {
    this._slots = [];
    this._underscoreKeyArmed = false;
    this._lastInputText = '';
    this._pendingScripts.clear();
    this._resultCache.clear();
    if (this._loading) this._loading.stopAll();
  }

  /** Currently-detected slots (latest scan). */
  get slots(): readonly BlankSlot[] { return this._slots; }

  private explicitUnderscoreRecent(): boolean {
    return this._underscoreKeyArmed;
  }

  /** Pure scanner — exposed for unit tests. */
  scan(text: string): readonly BlankSlot[] {
    const cleanText = text.replace(/[\u200B\u200C]/g, '');
    const words = cleanText.split(/\s+/).filter(Boolean);
    const slots: BlankSlot[] = [];
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] !== '_') continue;
      const found = this.matchKeyword(words, i);
      if (found) slots.push(found);
    }
    this._slots = slots;
    return slots;
  }

  private onTextChange(e: TextChangeEvent): void {
    let keepArmed = false;
    try {
      keepArmed = this._onTextChangeImpl(e);
    } finally {
      // One-shot: clear the keystroke flag at the END of this dispatch so
      // the NEXT text-change (one not paired with a `_` keystroke) sees
      // `explicitUnderscoreRecent()` = false. Exception: spaced-mode
      // unconfirmed `_` — the user explicitly typed `_` and is waiting
      // for the confirming space; we MUST keep the flag through one
      // extra dispatch (mirrors the same exception in Resolver.onTextChange).
      if (!keepArmed) this._underscoreKeyArmed = false;
    }
  }

  private _onTextChangeImpl(e: TextChangeEvent): boolean {
    // Span-fill invalidation: if the span fill is live and the
    // current text doesn't match what we last filled (cycle or initial),
    // try to preserve the span (user edited OUTSIDE it — just re-anchor
    // the word index). If preservation fails, drop the stash AND any
    // dismissed-blank flags tied to the old span.
    const cleaned = e.text.replace(/[\u200B\u200C]/g, '');
    if (this.spanFillState && this.spanFillState.current && cleaned !== this.spanFillState.lastFilledText) {
      const entry = this.spanFillState.current;
      const oldText = this.spanFillState.lastFilledText;
      // blankClearOnEdit-flagged entries get tolerant preservation
      // first: edits BEFORE / AFTER the pair leave it intact (just
      // re-anchor positions). Edits INSIDE the pair invalidate AND
      // splice the substituted region out — so a mid-keyword typo
      // doesn't leave a stale answer next to a broken question.
      // Mirrors maybePreserveSatellitePair / applyClearOnEdit which
      // already implement this for the selector/satellite path.
      if (entry.clearOnEdit
          && entry.pairCharStart !== undefined
          && entry.pairCharEnd !== undefined) {
        if (!this.maybePreserveBlankFillPair(oldText, cleaned, entry)) {
          this.spanFillState.clear();
          this.dismissedBlanks?.clear();
          this.applyClearOnEdit(oldText, cleaned, entry.pairCharStart, entry.pairCharEnd);
        }
      } else if (!this.maybePreserveSpanFill(cleaned)) {
        this.spanFillState.clear();
        this.dismissedBlanks?.clear();
      }
    }
    // Selector/satellite stash. Tolerate edits OUTSIDE
    // the pair (typing a space after, prepending text before): pair is
    // preserved, positions updated. Only invalidate when the edit
    // touches the pair itself; if blankClearOnEdit, splice the broken
    // pair out by char range.
    if (this.selectorSatelliteState && this.selectorSatelliteState.current && cleaned !== this.selectorSatelliteState.lastFilledText) {
      const entry = this.selectorSatelliteState.current;
      const oldText = this.selectorSatelliteState.lastFilledText;
      if (!this.maybePreserveSatellitePair(oldText, cleaned, entry)) {
        this.selectorSatelliteState.clear();
        if (entry.clearOnEdit) {
          this.applyClearOnEdit(oldText, cleaned, entry.pairCharStart, entry.pairCharEnd);
        }
      }
    }
    const slots = this.scan(e.text);
    if (e.source === 'user') {
      // `blank-trigger-mode: spaced` — gate text-change-based blank
      // fills per-slot, mirroring the keypress handler's gate at the
      // text-change level. Without this, any programmatic text-set
      // (off-process bridge driver, external paste, a host that
      // delivers the buffer as a single text-change after composing)
      // bypasses the spaced-mode gate.
      //
      // Per-slot rule (mirrors `keypress` semantics): a `_` is
      // "confirmed" iff something follows it — either another word
      // (slot.index < lastWordIdx) or trailing whitespace
      // (text has trailing whitespace AFTER the slot's `_`).
      // The trailing `_` at end of buffer with no whitespace is the
      // unconfirmed case — skip it.
      let filteredSlots: readonly BlankSlot[] = slots;
      if (slots.length > 0 && this.configLoader?.opencuesState.blankTriggerMode === 'spaced') {
        const cleanText = e.text.replace(/[\u200B\u200C]/g, '');
        const words = cleanText.split(/\s+/).filter(Boolean);
        const lastWordIdx = words.length - 1;
        const hasTrailingWs = /\s$/.test(cleanText);
        filteredSlots = slots.filter(s => s.index < lastWordIdx || hasTrailingWs);
      }
      // Explicit-`_` gate: only dispatch scripts when the `_` was placed
      // by an explicit user keystroke. A `_` exposed via cursor-relocation
      // (`volume_` → split to `volume _`) MUST NOT fire the volume /
      // brightness / etc. scripts. Mirrors the resolver's gate so the
      // runtime is consistent across both blank dispatch paths. See
      // `_underscoreKeyArmed`.
      //
      // Diff-based fallback: some host adapters (chrome's focus-trap
      // modals — LinkedIn share composer, Reddit's <shreddit-composer>)
      // drop `_` keydowns during focus shuffle, so the keystroke arm
      // never gets set. Accept "underscore count just went UP" as an
      // implicit arm: PR #52's cursor-split case doesn't add a new `_`
      // (count stays the same), so this is structurally distinct.
      // Mirror of the resolver-side fallback in resolver.ts:onTextChange.
      const prevU = (this._lastInputText.match(/_/g) || []).length;
      const newU = (e.text.match(/_/g) || []).length;
      const freshUnderscoreInserted = newU > prevU;
      if (filteredSlots.length > 0 && !this.explicitUnderscoreRecent() && !freshUnderscoreInserted) {
        this.adapter.log('debug', `BlankFill: explicit-_ gate BLOCKED ${filteredSlots.length} slot(s) (no recent _ keystroke)`);
        filteredSlots = [];
      } else if (filteredSlots.length > 0 && !this.explicitUnderscoreRecent() && freshUnderscoreInserted) {
        this.adapter.log('debug', `BlankFill: explicit-_ gate auto-armed via diff (fresh _ inserted; host adapter may have missed keydown)`);
      }
      this._lastInputText = e.text;
      this.maybeRunScripts(e.text, filteredSlots);

      // Spaced-mode unconfirmed `_` (text ends with `_` without trailing
      // whitespace): keep the armed flag so the next text-change (the
      // confirming space) can still dispatch. Without this, spaced-mode
      // legitimate usage would permanently fail the explicit-`_` gate.
      if (this.configLoader?.opencuesState.blankTriggerMode === 'spaced') {
        const cleanText = e.text.replace(/[\u200B\u200C]/g, '');
        if (cleanText.endsWith('_')) return true;
      }
    }
    return false;
  }

  /**
   * For any blank slot with a `blankScript` (and no `stepValues`,
   * since the stepValues path was already handled by onUnderscoreKey),
   * spawn `bash <script> get <keyword>` async and splice
   * stdout into the `_` position when the call returns. The pendingScripts
   * dedupe stops repeated spawns for the same (text, slotIndex) pair.
   */
  private maybeRunScripts(text: string, slots: readonly BlankSlot[]): void {
    if (slots.length > 0) this.adapter.log('debug', `BlankFill: ${slots.length} slot(s) on text-change`, slots);
    // Chrome (and other sandboxed hosts) advertise 'blank-invoke' instead
    // of 'spawn-process'. Either is enough to dispatch a fill; we try
    // blankInvoke first below and only fall through to spawnProcess if
    // the host returns null.
    if (!this.adapter.capabilities.includes('spawn-process')
        && !this.adapter.capabilities.includes('blank-invoke')) return;

    // Pre-split words for context extraction (used for every slot).
    const cleaned = text.replace(/[\u200B\u200C]/g, '');
    const words = cleaned.split(/\s+/).filter(Boolean);
    const home = process.env.HOME ?? '~';

    for (const slot of slots) {
      // Skip slots the user has dismissed by cycling
      // the fill back to `_`. Without this, the script re-spawns immediately
      // and the dismissal sticks for ~zero milliseconds.
      if (this.dismissedBlanks?.has(slot.index)) continue;
      const blank = this.configLoader.blanks.get(slot.blankName) as
        | (Record<string, unknown> & {
            stepValues?: readonly string[];
            blankScript?: string;
            blankAutoPopulate?: boolean;
            blankClearKeywords?: boolean;
            model?: string;
            apiUrl?: string;
            apiKeyEnv?: string;
            altCount?: number;
            includeOriginal?: boolean;
            prompts?: Record<string, string>;
          })
        | undefined;
      if (!blank) continue;
      if (blank.blankAutoPopulate === false) continue;
      // stepValues path is handled synchronously in onUnderscoreKey.
      if (Array.isArray(blank.stepValues) && blank.stepValues.length > 0) continue;
      const script = blank.blankScript;
      const canBlankInvoke = this.adapter.capabilities.includes('blank-invoke');
      // Need EITHER a shell script (legacy spawnProcess path) OR a
      // blankInvoke-capable host (modern shared-runtime blanks).
      // Without either, no way to fetch the fill.
      if (!script && !canBlankInvoke) continue;

      const dedupKey = `${text}::${slot.index}`;
      if (this._pendingScripts.has(dedupKey)) continue;
      this._pendingScripts.add(dedupKey);

      // The actual `get` dispatch for this slot, wrapped so the
      // BlankIntent gate (below) can run it conditionally. The dedup key
      // is already reserved above, so a re-scan during the gate's latency
      // won't double-dispatch. (`continue` inside this closure becomes
      // `return` — it's a function body now, not the loop.)
      const doDispatch = (): void => {

      // Context words: every word except the matched keyword span and the blank.
      // Index-based filter (vs v1's string-match) handles multi-word keywords
      // correctly (multi-word keywords would be incorrectly filtered
      // by a string-match approach).
      const contextWords: string[] = [];
      for (let wi = 0; wi < words.length; wi += 1) {
        if (wi >= slot.keywordStart && wi <= slot.keywordEnd) continue;
        if (wi === slot.index) continue;
        contextWords.push(words[wi]);
      }

      // Expand ~ in script path. Empty when the blank is
      // blankInvoke-only (shared runtime blank, no shell fallback);
      // we just won't reach the spawnProcess branch below.
      const scriptPath = script
        ? (script.startsWith('~') ? home + script.slice(1) : script)
        : '';

      // INFOSEC F2: build per-blank env from a tight allow-list rather
      // than spreading process.env. Without this, every scripted blank
      // received every *_API_KEY the user had configured, regardless of
      // whether the blank declared `secrets:`. Now: PATH/HOME/LC_* and
      // the explicitly-declared `secrets: [NAME]` provider keys reach
      // the child; everything else (`*_API_KEY` outside the declaration,
      // `LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`, …) is dropped.
      const processEnv: Readonly<Record<string, string | undefined>> =
        (typeof process !== 'undefined' && process.env) ? process.env : {};
      const declaredSecrets = (blank as { userBlankSecrets?: readonly string[] })
        .userBlankSecrets ?? [];
      const extras: Record<string, string> = {};
      if (blank.model) extras.CUES_MODEL = blank.model;
      if (blank.apiUrl) extras.CUES_API_URL = blank.apiUrl;
      if (blank.apiKeyEnv) extras.CUES_API_KEY_ENV = blank.apiKeyEnv;
      if (blank.altCount !== undefined) extras.CUES_ALT_COUNT = String(blank.altCount);
      if (blank.includeOriginal !== undefined) extras.CUES_INCLUDE_ORIGINAL = String(blank.includeOriginal);
      if (blank.prompts) {
        for (const [k, v] of Object.entries(blank.prompts)) {
          const envKey = 'CUES_PROMPT_' + k.toUpperCase().replace(/[^A-Z0-9]/g, '_');
          extras[envKey] = String(v);
        }
      }
      const env: Record<string, string> = buildSafeScriptEnv(processEnv, declaredSecrets, extras);

      // Cache lookup. Args identical to a recent call → reuse the
      // stored stdout instead of paying the spawn cost again. Per-blank
      // TTL via frontmatter `blankCacheTtlMs` (default 2000ms; 0 = disabled).
      // Frontmatter parser may pass the value through as either a
      // number or a string-of-digits depending on the YAML shape, so
      // coerce here.
      const cacheKey = `${slot.blankName}::${slot.keyword}|${contextWords.join('|')}`;
      const rawTtl = (blank as { blankCacheTtlMs?: unknown }).blankCacheTtlMs;
      const parsedTtl = typeof rawTtl === 'number'
        ? rawTtl
        : typeof rawTtl === 'string' && /^-?\d+$/.test(rawTtl)
          ? parseInt(rawTtl, 10)
          : null;
      const ttlMs = parsedTtl !== null ? parsedTtl : BlankFill.DEFAULT_CACHE_TTL_MS;
      if (ttlMs > 0) {
        const entry = this._resultCache.get(cacheKey);
        if (entry && Date.now() - entry.fetchedAt < entry.ttlMs) {
          this.adapter.log('debug', `BlankFill: cache HIT for ${slot.blankName} get ${slot.keyword} (age=${Date.now() - entry.fetchedAt}ms, ttl=${entry.ttlMs}ms)`);
          this.adapter.emitEvent?.('blank.invoked', {
            blankName: slot.blankName,
            keyword: slot.keyword,
            contextWords: contextWords.slice(0, 8),
            cacheHit: true,
          });
          // Apply the cached stdout directly — same path as the
          // post-spawn success branch. Bump LRU recency so freshly used
          // entries survive eviction.
          this._resultCache.delete(cacheKey);
          this._resultCache.set(cacheKey, entry);
          // Drop the dedup entry: we never started a spawn for this
          // key, so the matching delete in the .then/.catch path won't
          // ever fire. Without this, subsequent identical-arg keystrokes
          // see `_pendingScripts.has(dedupKey)` and skip even after the
          // cached value is fresh.
          this._pendingScripts.delete(dedupKey);
          this.applyAsyncFill(slot, entry.output);
          return;
        }
      }

      this.adapter.log('debug', `BlankFill: invoke ${slot.blankName} get ${slot.keyword}`, { contextWords, envExtras: extraEnvKeys(blank), scriptPath });
      this.adapter.emitEvent?.('blank.invoked', {
        blankName: slot.blankName,
        keyword: slot.keyword,
        contextWords: contextWords.slice(0, 8),
      });
      // Loading indicator — start animating the slot while the source
      // resolves. No-op when blank-loading-animation is 'off'. Stopped
      // in the .then/.catch handlers below. Owner tag keeps Resolver's
      // own start/stop on the same slot from racing this one — the slot
      // animates until BOTH owners release (refcounted in animator).
      this._loadingAnimator().start(slot.index, 'blank-fill');

      // Try host-native blank invocation first (Chrome, Electron,
      // anything without shell access). Fall through to spawnProcess
      // when the host returns null or doesn't implement blankInvoke.
      let handle = this.adapter.blankInvoke?.({
        blankName: slot.blankName,
        action: 'get',
        args: [slot.keyword, ...contextWords],
        env,
        timeoutMs: 8000,
      }) ?? null;
      if (!handle) {
        if (!script) {
          // blankInvoke didn't recognise the blank AND there's no
          // shell fallback. Drop the dedup so a later state change can
          // retry, and skip cleanly. Release the loading claim we
          // just took — without this, the slot would animate forever
          // (no .then/.catch ever fires to stop it).
          this._pendingScripts.delete(dedupKey);
          this._loadingAnimator().stop(slot.index, 'blank-fill');
          return;
        }
        // OS-level sandbox config — populated when the blank's
        // frontmatter declares `sandbox: strict`. The host's spawn
        // wrapper picks this up and applies bwrap (Linux/WSL) or
        // falls back to unwrapped where no sandbox is available.
        // blank-fill stays host-agnostic — no fs.statSync or shell
        // detection here. See packages/opencues-runtime/src/security/
        // sandbox-runner.ts.
        const sandbox = blank.sandbox === 'strict' ? {
          mode: 'strict' as const,
          net: blank.sandboxNet === 'allow' ? 'allow' as const : 'deny' as const,
          fs: blank.sandboxFs === 'rw' ? 'rw' as const : 'ro' as const,
          workdir: scriptPath ? scriptPath.replace(/\/[^/]+$/, '') : undefined,
        } : undefined;
        // sandbox: strict is honoured on linux (bwrap) and darwin
        // (sandbox-exec). On other platforms — Windows native, etc. —
        // the spawn falls through unwrapped. Emit a one-time warn
        // per blank so authors don't think their script is sandboxed
        // when it isn't.
        if (sandbox && typeof process !== 'undefined' && process.platform
            && process.platform !== 'linux' && process.platform !== 'darwin') {
          if (!this._warnedSandboxBlanks.has(slot.blankName)) {
            this._warnedSandboxBlanks.add(slot.blankName);
            this.adapter.log('warn',
              `sandbox: strict requested for "${slot.blankName}" but platform is ${process.platform} ` +
              `— OS-level confinement only on linux (bwrap) + darwin (sandbox-exec). ` +
              `Running unwrapped (path sandbox + audit log still apply).`,
            );
          }
        }
        // INFOSEC F9 (real fix — Option B, runtime side): warn loudly
        // when a blankScript: blank hasn't declared `sandbox:`. The
        // install-time gate in `opencues review` is the structural
        // refusal; this warn handles pre-existing installs where the
        // blank slipped past review (typically because review hadn't
        // been run yet on that pack). One warn per blank-name per
        // process — enough for the user to notice without spamming.
        // The v2 plan is to flip this to a refusal once all shipped
        // defaults and the broader pack ecosystem have migrated.
        const declared = (blank as { sandbox?: unknown }).sandbox;
        if (declared === undefined || declared === null || declared === '') {
          if (!this._warnedMissingSandboxBlanks.has(slot.blankName)) {
            this._warnedMissingSandboxBlanks.add(slot.blankName);
            this.adapter.log('warn',
              `BlankFill: "${slot.blankName}" declares blankScript: without sandbox: — ` +
              `running UNCONFINED with the user's full filesystem + network privileges. ` +
              `INFOSEC F9: authors should declare \`sandbox: strict\` (confined under ` +
              `bwrap/sandbox-exec) or \`sandbox: off\` (acknowledge full host privileges). ` +
              `Run \`opencues review <pack>\` for install-time guidance.`,
            );
          }
          // Pre-existing installs continue to spawn (back-compat). The
          // review-time refusal catches new packs structurally.
        }
        handle = this.adapter.spawnProcess({
          command: 'bash',
          args: [scriptPath, 'get', slot.keyword, ...contextWords],
          env,
          timeoutMs: 8000,
          sandbox,
        });
      }
      handle.result.then(res => {
        this._pendingScripts.delete(dedupKey);
        this._loadingAnimator().stop(slot.index, 'blank-fill');
        this.adapter.log('debug', `BlankFill: script result for ${slot.blankName}`, { exitCode: res.exitCode, timedOut: res.timedOut, stdoutLen: res.stdout?.length ?? 0, stdoutPreview: res.stdout?.slice(0, 80) });
        if (res.exitCode !== 0 || res.timedOut) return;
        const stdout = res.stdout.trim();
        if (!stdout) return;
        // Cache the successful result. Only cache successes —
        // an exit-1 / empty-stdout case is more useful to retry
        // (the user may have just fixed whatever upstream condition
        // caused the failure). TTL was captured at dispatch time,
        // not now, so a frontmatter edit between dispatch + return
        // doesn't change THIS entry's lifetime.
        if (ttlMs > 0) {
          this._resultCache.set(cacheKey, { output: stdout, fetchedAt: Date.now(), ttlMs });
          // LRU evict — drop the oldest entries until we're at cap.
          // Map preserves insertion order; deleting + re-inserting
          // bumps recency on hits (see cache-lookup branch above).
          while (this._resultCache.size > BlankFill.RESULT_CACHE_MAX_ENTRIES) {
            const oldest = this._resultCache.keys().next().value;
            if (oldest === undefined) break;
            this._resultCache.delete(oldest);
          }
        }
        this.applyAsyncFill(slot, stdout);
      }).catch(err => {
        this._pendingScripts.delete(dedupKey);
        this._loadingAnimator().stop(slot.index, 'blank-fill');
        this.adapter.log('error', `BlankFill: script promise rejected for ${slot.blankName}`, err);
      });

      }; // end doDispatch

      // BlankIntent gate (off by default). When wired (blank-intent-mode
      // on, native host with a resolved blanks-bucket LLM), ask the
      // classifier whether this `_` is a genuine invocation before running
      // the blank. INVOKE → doDispatch(); CEDE → suppress (the keyword
      // behaves as prose). Every slot that reaches here is an exec/fetch
      // tier blank — list blanks (stepValues) were skipped above, and only
      // script / impl / built-in-by-convention blanks get this far (the
      // dispatch requires `script || canBlankInvoke`). We do NOT gate on
      // `blankScript || impl`: the shipped fetch blanks (weather, stocks,
      // countries, …) OMIT `impl:` and resolve to a built-in class by
      // convention, so gating on the field would leave the entire fetch
      // tier ungated. The classifier never throws (it degrades to invoke on
      // any LLM failure); a thrown gate is caught here and also treated as
      // invoke. The staleness re-check drops a verdict that arrived after
      // the user kept typing, so we never splice a fill against a changed
      // buffer.
      if (this.blankIntentGate) {
        const gate = this.blankIntentGate;
        const gateText = text;
        const gateBlank = blank;
        void (async () => {
          let decision: BlankIntentDecision = { verdict: 'invoke', action: 'get', value: null };
          try {
            decision = await gate(gateText, slot.blankName);
          } catch (err) {
            this.adapter.log('debug', `BlankFill: BlankIntent gate threw — degrading to get-invoke for ${slot.blankName}`, err);
            decision = { verdict: 'invoke', action: 'get', value: null };
          }
          if (this._lastInputText !== gateText) {
            this._pendingScripts.delete(dedupKey);
            return;
          }
          if (decision.verdict === 'cede') {
            this.adapter.log('debug', `BlankFill: BlankIntent CEDE — suppressing ${slot.blankName} for "${gateText}"`);
            this._pendingScripts.delete(dedupKey);
            return;
          }
          // Typed-SET: an `action: 'set'` + numeric value on a SETTABLE
          // blank (one with `blankStep` — volume / brightness) performs a
          // real set, then falls through to doDispatch's `get` to read the
          // (possibly clamped) value back and splice it. `set` only ever
          // reaches a blank whose keyword the user typed (consent), and
          // only settable blanks honour it — a `set` verdict on a lookup
          // blank (weather/stocks/…) degrades to a plain get. Non-numeric
          // values also degrade to get (defensive; the gate extracts
          // numbers for set but providers vary).
          const isSettable = (gateBlank as { blankStep?: unknown }).blankStep !== undefined
            && (gateBlank as { blankStep?: unknown }).blankStep !== null;
          if (decision.action === 'set' && decision.value && /^\d+$/.test(decision.value.trim()) && isSettable) {
            this.adapter.log('debug', `BlankFill: BlankIntent SET ${slot.blankName} → ${decision.value} (then read back)`);
            await this.runBlankSet(slot.blankName, decision.value.trim(), gateBlank as Record<string, unknown>);
            if (this._lastInputText !== gateText) { this._pendingScripts.delete(dedupKey); return; }
          }
          doDispatch();
        })();
      } else {
        doDispatch();
      }
    }
  }

  /**
   * Dispatch a `set <value>` for a settable blank (BlankIntent typed-SET)
   * and await it, so the subsequent `get` read-back reflects the new
   * (clamped) value. Mirrors Cycling's `invokeOrSpawn('set', …)` — host-
   * native `blankInvoke` first, shell `set` fallback. The set scripts emit
   * nothing on stdout (they set + exit 0), so this returns void; the value
   * shown comes from the read-back `get`. Never throws — a failed set
   * still falls through to the get (which shows the unchanged value).
   */
  private async runBlankSet(blankName: string, value: string, blank: Record<string, unknown>): Promise<void> {
    const script = blank.blankScript as string | undefined;
    const home = process.env.HOME ?? '~';
    const scriptPath = script ? (script.startsWith('~') ? home + script.slice(1) : script) : '';
    const processEnv: Readonly<Record<string, string | undefined>> =
      (typeof process !== 'undefined' && process.env) ? process.env : {};
    const declaredSecrets = (blank as { userBlankSecrets?: readonly string[] }).userBlankSecrets ?? [];
    const env = buildSafeScriptEnv(processEnv, declaredSecrets, {});
    try {
      let handle = this.adapter.blankInvoke?.({
        blankName,
        action: 'set',
        args: [value],
        env,
        timeoutMs: 4000,
      }) ?? null;
      if (!handle) {
        if (!script || !this.adapter.capabilities.includes('spawn-process')) return;
        handle = this.adapter.spawnProcess({
          command: 'bash',
          args: [scriptPath, 'set', value],
          env,
          timeoutMs: 4000,
        });
      }
      await handle.result;
    } catch (e) {
      this.adapter.log('debug', `BlankFill: typed-SET dispatch failed for ${blankName}`, e);
    }
  }

  /**
   * Apply an async fill: re-read the host's text via getText, find the
   * matching `_` at the slot's word index, splice stdout in. Push via
   * adapter.pushText (calls onChange), since this runs outside any
   * dispatch.
   */
  private applyAsyncFill(slot: BlankSlot, fillValue: string): void {
    const currentText = this.adapter.getText();
    const cleaned = currentText.replace(/[\u200B\u200C]/g, '');
    const words = splitWords(cleaned);
    const target = words[slot.index];
    const blank = this.configLoader.blanks.get(slot.blankName) as
      | (Record<string, unknown> & {
          blankClearKeywords?: boolean;
          blankConsumeContext?: boolean;
          blankConsumeAll?: boolean;
          blankDismissible?: boolean;
          blankSatellite?: boolean;
          blankSatelliteSeparator?: string;
          blankClearOnEdit?: boolean;
          blankScript?: string;
          blankTip?: string;
          blankSuffix?: string;
          tip?: string;
          blankKeywordExpansions?: Record<string, string>;
        })
      | undefined;

    // Staleness guard — if the user moved on or already filled the slot,
    // drop the late callback. Applies to all downstream paths
    // (selector/satellite, consume-all, range-clear, char-splice). A
    // loading-frame char in the slot position is NOT stale: it means
    // the resolver-owned animation is still painting (refcount kept
    // it alive past BlankFill's own release) — the splice below uses
    // target.start/end to overwrite the frame char with the answer.
    // Without this carve-out, the animator's frame char would defeat
    // the substitute on every keyword-bound `_` resolve where the
    // resolver outlives BlankFill's release — the silent-drop bug
    // introduced by the 2026-05-28 owner-refcount commit.
    if (!target) return;
    const ourSlot = target.word === '_'
      || (this._loading?.isOurSlotChar(slot.index, target.word) ?? false);
    if (!ourSlot) return;

    // Selector/satellite fill. When the script returns a
    // tab-separated `<setting>\t<value>` and the blank declares
    // blankSatellite, splice TWO words separated by blankSatelliteSeparator
    // (default ' ') and stash the pair so cycling can write back via
    // `script set` / `script get`.
    if (blank?.blankSatellite === true && fillValue.includes('\t')) {
      this.applySatelliteFill(slot, blank, fillValue, cleaned, target);
      return;
    }

    // Parse stdout into lines once. Both consume-all and
    // splice paths use line[0] as the visible fill; alternates stash if
    // the script returned multiple lines (hackernews) or the blank is
    // dismissible (so the user can cycle back to `_`).
    const lines = fillValue.split(/\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    let primaryFill = lines[0];
    const isDismissible = blank?.blankDismissible === true;
    // Append blankSuffix when the blank declares one and the primary
    // fill looks numeric (volume, brightness — script returns "50",
    // displayed as "50%").
    if (blank?.blankSuffix && /^-?\d+(?:\.\d+)?$/.test(primaryFill)) {
      primaryFill = primaryFill + blank.blankSuffix;
    }

    // New unified `blankReplace` field, when set explicitly, supersedes
    // the legacy flag path (consumeAll/consumeContext/clearKeywords).
    // Resolves via the fluid heuristic when set to 'auto'. Existing
    // blanks with no `blankReplace` continue to use the legacy flags
    // unchanged — this is purely additive.
    const blankFlags = blank as
      | (Record<string, unknown> & {
          blankReplace?: 'keep' | 'wipe' | 'wipe-all' | 'auto';
          blankConsumeAll?: boolean;
          blankConsumeContext?: boolean;
          blankClearKeywords?: boolean;
        })
      | undefined;
    const explicitMode: EffectiveReplaceMode | null = blankFlags?.blankReplace !== undefined
      ? resolveReplaceMode(blankFlags, cleaned)
      : null;

    // Consume-all short-circuits the splice/expand/clear pipeline.
    if (explicitMode === 'wipe-all' || (explicitMode === null && blank?.blankConsumeAll === true)) {
      this.adapter.log('info', `BlankFill: consume-all ${slot.blankName} → "${preview(primaryFill, 60)}" (${lines.length} alt(s))`);
      const newText = primaryFill;
      const newCursor = newText.length;
      const altsForSpan = isDismissible ? [...lines, '_'] : lines;
      if (this.spanFillState && altsForSpan.length > 1) {
        this.spanFillState.set({
          index: 0,
          alternatives: altsForSpan,
          currentAltIndex: 0,
          spanLength: newText.split(/\s+/).filter(Boolean).length,
          blankTip: blank?.blankTip ?? blank?.tip,
        }, newText);
      } else if (this.spanFillState) {
        this.spanFillState.clear();
      }
      if (this.adapter.pushText) {
        this.adapter.pushText(newText, newCursor);
      } else {
        this.adapter.setText(newText);
        this.adapter.setCursorOffset(newCursor);
        this.adapter.forceRender();
      }
      return;
    }

    const { clearEnd, expansion } = explicitMode !== null
      ? computeFillRangeForMode(blank ?? {}, slot, explicitMode)
      : computeFillRange(blank ?? {}, slot);
    this.adapter.log('info', `BlankFill: substituting "${slot.keyword} _" → "${preview(primaryFill, 60)}" (blank=${slot.blankName}${lines.length > 1 ? `, ${lines.length} alt(s)` : ''}${isDismissible ? ', dismissible' : ''})`);
    this.adapter.emitEvent?.('blank.substituted', {
      blankName: slot.blankName,
      keyword: slot.keyword,
      input: `${slot.keyword} _`,
      output: primaryFill.slice(0, 200),
      altCount: lines.length,
      dismissible: isDismissible,
      // True when the resulting span behaves as a single unit:
      // editing any character inside it wipes the whole substituted
      // region. Hosts use this to render a distinct visual treatment
      // (dashed underline, status pill) so users aren't surprised
      // when one backspace deletes 20+ chars at once.
      spanAsUnit: blank?.blankClearOnEdit === true,
    });

    const { newText, newCursor } = clearEnd !== undefined || expansion != null
      ? buildClearKeywordText(cleaned, slot, primaryFill, expansion, clearEnd)
      : { newText: cleaned.slice(0, target.start) + primaryFill + cleaned.slice(target.end),
          newCursor: target.start + primaryFill.length };

    // Populate span for non-consume-all fills when there's
    // anything cycleable to do: multi-word fill, multiple lines from
    // the script, or blankDismissible. Index = post-fill word index of
    // primaryFill's first word (re-derive from the new text since
    // clear/expansion may have shifted positions).
    const fillStart = newCursor - primaryFill.length;
    const newWords = splitWords(newText);
    const startWord = newWords.find(w => w.start === fillStart);
    // Char range of the substituted region in newText. Anchored at the
    // keyword's first char (so deleting any character of the keyword
    // counts as a touch, even though the answer text starts at fillStart).
    // For blankClearKeywords:true the keyword is gone in newText, so
    // both kwStartChar and the answer collapse to fillStart.
    const kwStartChar = newWords[slot.keywordStart]?.start ?? fillStart;
    const wantsClearOnEdit = blank?.blankClearOnEdit === true;
    if (this.spanFillState) {
      const fillWordCount = primaryFill.split(/\s+/).filter(Boolean).length;
      const altsForSpan = isDismissible ? [...lines, '_'] : lines;
      // wantsSpan widens to ALSO track single-alt fills when
      // blankClearOnEdit is set — otherwise the clearOnEdit machinery
      // has nothing in spanFillState to react to on the next text
      // change.
      const wantsSpan = fillWordCount > 1 || altsForSpan.length > 1 || wantsClearOnEdit;
      if (startWord && wantsSpan) {
        this.spanFillState.set({
          index: startWord.index,
          alternatives: altsForSpan,
          currentAltIndex: 0,
          spanLength: Math.max(1, fillWordCount),
          blankTip: blank?.blankTip ?? blank?.tip,
          clearOnEdit: wantsClearOnEdit,
          pairCharStart: wantsClearOnEdit ? kwStartChar : undefined,
          pairCharEnd: wantsClearOnEdit ? newCursor : undefined,
        }, newText);
      } else {
        this.spanFillState.clear();
      }
    }

    // When blankSuffix produced a numeric+unit fill (volume,
    // brightness), attribute the resulting word to its source blank
    // via a DynDef so cycling routes to the originating blank.
    if (this.dynDefs && startWord && blank?.blankSuffix && primaryFill.endsWith(blank.blankSuffix)) {
      this.dynDefs.set(startWord.index, {
        originalWord: primaryFill,
        alternatives: [primaryFill],
        currentIndex: 0,
        spanStart: startWord.start,
        spanEnd: startWord.end,
        blankName: slot.blankName,
      });
    }

    if (this.adapter.pushText) {
      this.adapter.pushText(newText, newCursor);
    } else {
      this.adapter.setText(newText);
      this.adapter.setCursorOffset(newCursor);
      this.adapter.forceRender();
    }
  }

  /**
   * Try to preserve a SpanFillState entry when the user typed OUTSIDE
   * the span (continuing a sentence, prepending text, etc.). Returns
   * true when the span's current alt text still appears exactly once
   * in the new text as a contiguous word sequence — in that case the
   * entry's `index` is re-anchored to the new position and
   * `lastFilledText` is updated. Returns false when the span is
   * genuinely broken (alt text edited, duplicate matches, missing) so
   * the caller invalidates.
   *
   * Fixes the "typing breaks the span into two words" regression: the
   * old behaviour cleared SpanFillState on any text mismatch, so
   * adding a single character after a multi-word alt dropped the span
   * entirely and left the N words floating as independent nav units.
   */
  private maybePreserveSpanFill(newText: string): boolean {
    if (!this.spanFillState) return false;
    const entry = this.spanFillState.current;
    if (!entry) return false;
    // Only static-alt spans (cue words cycled to multi-word alts)
    // preserve on outside edits. Blank-fill spans (consume-all,
    // stepValues, blankScript) stick to strict-equality invalidation.
    if (entry.kind !== 'static-alt') return false;
    const currentAlt = entry.alternatives[entry.currentAltIndex];
    if (!currentAlt) return false;
    const altWords = currentAlt.split(/\s+/).filter(Boolean);
    if (altWords.length === 0) return false;

    const words = splitWords(newText);
    let matchIndex = -1;
    for (let i = 0; i <= words.length - altWords.length; i += 1) {
      let ok = true;
      for (let j = 0; j < altWords.length; j += 1) {
        if (words[i + j]?.word !== altWords[j]) { ok = false; break; }
      }
      if (ok) {
        if (matchIndex !== -1) return false; // ambiguous — clear
        matchIndex = i;
      }
    }
    if (matchIndex === -1) return false;

    // index is readonly on SpanFillEntry — construct a fresh entry
    // with the re-anchored index, preserving everything else.
    this.spanFillState.set({
      ...entry,
      index: matchIndex,
      spanLength: altWords.length,
    }, newText);
    return true;
  }

  /**
   * Return true if the edit happened entirely OUTSIDE the
   * pair's char range (so the pair text is intact in newText). Mutates
   * the entry's char positions and word indices to match the new text
   * and updates lastFilledText. Returns false when the pair was
   * touched, leaving caller to invalidate.
   */
  private maybePreserveSatellitePair(
    oldText: string,
    newText: string,
    entry: { pairCharStart: number; pairCharEnd: number; selectorIndex: number; selectorLength: number; satelliteIndex: number; satelliteLength: number },
  ): boolean {
    let prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldText.length - prefix &&
      suffix < newText.length - prefix &&
      oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) suffix += 1;

    const intactAfter = prefix >= entry.pairCharEnd;
    const intactBefore = suffix >= oldText.length - entry.pairCharStart;
    if (!intactAfter && !intactBefore) return false;

    if (!intactAfter && intactBefore) {
      // Edit happened before the pair. Shift positions by the full
      // length diff and re-derive word indices from the new char start.
      const lenDiff = newText.length - oldText.length;
      entry.pairCharStart += lenDiff;
      entry.pairCharEnd += lenDiff;
      const newWords = splitWords(newText);
      const newSelectorWord = newWords.find(w => w.start === entry.pairCharStart);
      if (!newSelectorWord) return false;
      entry.selectorIndex = newSelectorWord.index;
      entry.satelliteIndex = entry.selectorIndex + entry.selectorLength;
    }
    // intactAfter case: pair sits at the same chars + word indices in
    // newText (text added/removed only after the pair). No mutation
    // needed beyond updating lastFilledText.
    this.selectorSatelliteState!.set(entry as any, newText);
    return true;
  }

  /**
   * Tolerant-preserve a blank-fill clearOnEdit pair on outside edits
   * (text added/removed entirely BEFORE or entirely AFTER the
   * substituted region). Returns true when preservation succeeded
   * and the SpanFillState was re-anchored; false when the edit
   * touched the pair (caller invalidates + splices).
   *
   * Logic mirrors maybePreserveSatellitePair: common-prefix /
   * common-suffix matching against the old text identifies which
   * side the edit landed on. The pair char range is the source of
   * truth — word indices are derived from it because edits before
   * the pair shift everything by lenDiff.
   */
  private maybePreserveBlankFillPair(
    oldText: string,
    newText: string,
    entry: { pairCharStart?: number; pairCharEnd?: number; index: number; spanLength: number },
  ): boolean {
    if (!this.spanFillState) return false;
    if (entry.pairCharStart === undefined || entry.pairCharEnd === undefined) return false;
    let prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < oldText.length - prefix &&
      suffix < newText.length - prefix &&
      oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) suffix += 1;

    const intactAfter = prefix >= entry.pairCharEnd;
    const intactBefore = suffix >= oldText.length - entry.pairCharStart;
    if (!intactAfter && !intactBefore) return false;

    let newPairStart = entry.pairCharStart;
    let newPairEnd = entry.pairCharEnd;
    let newIndex = entry.index;
    if (!intactAfter && intactBefore) {
      // Edit landed before the pair — shift positions by the length
      // diff and re-derive the word index from the shifted char start.
      const lenDiff = newText.length - oldText.length;
      newPairStart += lenDiff;
      newPairEnd += lenDiff;
      const newWords = splitWords(newText);
      const newStartWord = newWords.find(w => w.start === newPairStart);
      if (!newStartWord) return false;
      newIndex = newStartWord.index;
    }
    // intactAfter case: pair sits at the same chars + word indices in
    // newText. Just update lastFilledText below.
    this.spanFillState.set({
      ...(entry as any),
      index: newIndex,
      pairCharStart: newPairStart,
      pairCharEnd: newPairEnd,
    }, newText);
    return true;
  }

  /**
   * When a selector/satellite pair was edited and the
   * blank declared `blankClearOnEdit`, splice the (broken) pair out
   * of the new text. Uses common-prefix/suffix matching against the
   * last filled text, with a min-of-(prefix, pairStart) / min-of-
   * (suffix, oldTail) clamp so the wipe always covers AT LEAST the
   * original pair range — robust under space-insertion edits that
   * shift word boundaries (v1 lesson).
   */
  private applyClearOnEdit(oldText: string, newText: string, pairStart: number, pairEnd: number): void {
    const range = computeCleanupRange(oldText, newText, pairStart, pairEnd);
    if (range.start >= range.end) return;
    const cleaned = newText.slice(0, range.start) + newText.slice(range.end);
    this.adapter.log('debug', 'BlankFill: applyClearOnEdit', {
      pairStart,
      pairEnd,
      cleanupStart: range.start,
      cleanupEnd: range.end,
      newLen: cleaned.length,
    });
    // Surface the wipe as a module event — hosts subscribe to render
    // a transient "span dismissed" indicator so the user understands
    // why their typed keystroke wiped 20+ chars (rather than thinking
    // backspace went haywire). Carries the same shape as
    // blank.substituted's spanAsUnit for symmetry.
    this.adapter.emitEvent?.('blank.span-wiped', {
      reason: 'edit-inside-span',
      pairStart,
      pairEnd,
      wipedCharCount: range.end - range.start,
    });
    if (this.adapter.pushText) {
      this.adapter.pushText(cleaned, range.start);
    } else {
      this.adapter.setText(cleaned);
      this.adapter.setCursorOffset(range.start);
      this.adapter.forceRender();
    }
  }

  /**
   * Splice `<selector><sep><satellite>` into the slot and stash a
   * SelectorSatelliteEntry. Caller already verified blankSatellite
   * + presence of \t. Honours `blankClearKeywords` on the keyword span.
   */
  private applySatelliteFill(
    slot: BlankSlot,
    blank: {
      blankClearKeywords?: boolean;
      blankConsumeContext?: boolean;
      blankSatellite?: boolean;
      blankSatelliteSeparator?: string;
      blankClearOnEdit?: boolean;
      blankScript?: string;
      blankKeywordExpansions?: Record<string, string>;
    },
    fillValue: string,
    cleaned: string,
    target: { start: number; end: number; word: string; index: number },
  ): void {
    const tabIdx = fillValue.indexOf('\t');
    const selectorRaw = fillValue.slice(0, tabIdx).trim();
    const satelliteRaw = fillValue.slice(tabIdx + 1).split('\n')[0].trim();
    if (!selectorRaw || !satelliteRaw) return;
    const sep = blank.blankSatelliteSeparator || ' ';
    const pair = `${selectorRaw}${sep}${satelliteRaw}`;
    const { clearEnd, expansion } = computeFillRange(blank, slot);
    const { newText, newCursor } = clearEnd !== undefined || expansion != null
      ? buildClearKeywordText(cleaned, slot, pair, expansion, clearEnd)
      : { newText: cleaned.slice(0, target.start) + pair + cleaned.slice(target.end),
          newCursor: target.start + pair.length };

    if (this.selectorSatelliteState) {
      const newWords = splitWords(newText);
      const fillStart = newCursor - pair.length;
      const startWord = newWords.find(w => w.start === fillStart);
      if (startWord) {
        const home = process.env.HOME ?? '~';
        const scriptPath = blank.blankScript
          ? (blank.blankScript.startsWith('~') ? home + blank.blankScript.slice(1) : blank.blankScript)
          : '';
        const selectorLength = Math.max(1, selectorRaw.split(/\s+/).filter(Boolean).length);
        const satelliteLength = Math.max(1, satelliteRaw.split(/\s+/).filter(Boolean).length);
        const pairCharStart = startWord.start;
        const pairCharEnd = startWord.start + pair.length;
        this.selectorSatelliteState.set({
          blankName: slot.blankName,
          scriptPath,
          selectorIndex: startWord.index,
          selectorLength,
          satelliteIndex: startWord.index + selectorLength,
          satelliteLength,
          currentSetting: selectorRaw,
          currentValue: satelliteRaw,
          separator: sep,
          clearOnEdit: blank.blankClearOnEdit === true,
          pairCharStart,
          pairCharEnd,
        }, newText);
      }
    }
    this.adapter.log('info', `BlankFill: selector+satellite ${slot.blankName} → "${preview(selectorRaw, 30)}${sep}${preview(satelliteRaw, 30)}"`);
    if (this.adapter.pushText) {
      this.adapter.pushText(newText, newCursor);
    } else {
      this.adapter.setText(newText);
      this.adapter.setCursorOffset(newCursor);
      this.adapter.forceRender();
    }
  }

  /**
   * Handler for the '_' key. Simulates the insertion that the host would
   * make, scans the result, and if a fillable slot lands at the inserted
   * position we replace '_' with the blank's stepValues[0] in the same
   * dispatch. Returns true to consume the key (host's default insert is
   * skipped); false otherwise (host inserts '_' normally).
   */
  onUnderscoreKey(event: KeyEvent): boolean {
    // Only intercept plain '_' presses (no nav modifiers etc.).
    const m = event.modifiers;
    if (m.ctrl || m.alt || m.meta) return false;
    // Simulate the insertion FIRST, then arm the one-shot flag only when
    // the resulting `_` would be a standalone word. A `_` typed adjacent
    // to existing letters (`volume` + `_` → `volume_`, or inside a word
    // like `vol_ume`) is structurally NOT a blank trigger; arming on
    // those would re-open the cursor-split bug for script-backed blanks.
    const insertedText =
      event.text.slice(0, event.cursorOffset) +
      '_' +
      event.text.slice(event.cursorOffset);
    const insertedWord = findUnderscoreAtChar(insertedText, event.cursorOffset);
    if (insertedWord) {
      this._underscoreKeyArmed = true;
    }

    // `blank-trigger-mode: spaced` defers blank firing until a space
    // follows the `_`. Letting the keypress fall through to the host's
    // default insert keeps markdown `_italic_` typing intact — the
    // resolver's onTextChange path will pick up the trigger once the
    // user types a confirming space.
    if (this.configLoader.opencuesState.blankTriggerMode === 'spaced') {
      return false;
    }

    // Find the word index of our just-inserted '_' in the simulated text.
    // Only count it as a blank when it's surrounded by whitespace (or BOL/EOL).
    if (!insertedWord) return false;

    const slots = this.scan(insertedText);
    const slot = slots.find(s => s.index === insertedWord.index);
    if (!slot) return false;

    const blank = this.configLoader.blanks.get(slot.blankName) as
      | (Record<string, unknown> & {
          stepValues?: readonly string[];
          blankAutoPopulate?: boolean;
          blankClearKeywords?: boolean;
          blankConsumeContext?: boolean;
          blankDismissible?: boolean;
          blankTip?: string;
          tip?: string;
          blankKeywordExpansions?: Record<string, string>;
        })
      | undefined;
    if (!blank) return false;
    if (blank.blankAutoPopulate === false) return false;
    if (this.dismissedBlanks?.has(slot.index)) return false;
    const stepValues = blank.stepValues;
    if (!Array.isArray(stepValues) || stepValues.length === 0) return false;
    const fillValue = stepValues[0];

    // Mirror applyAsyncFill: when `blankReplace` is set explicitly,
    // route through the new mode dispatcher. Otherwise fall back to
    // the legacy flag-driven computeFillRange so unmigrated blanks
    // (stepValues + no flags) keep their current behaviour.
    const blankFlags = blank as {
      blankReplace?: 'keep' | 'wipe' | 'wipe-all' | 'auto';
      blankConsumeAll?: boolean;
      blankConsumeContext?: boolean;
      blankClearKeywords?: boolean;
    };
    const explicitMode: EffectiveReplaceMode | null = blankFlags.blankReplace !== undefined
      ? resolveReplaceMode(blankFlags, insertedText)
      : null;

    // wipe-all on a stepValues blank is unusual but coherent — entire
    // buffer becomes the fill. Short-circuit before the splice logic.
    if (explicitMode === 'wipe-all' || (explicitMode === null && blank.blankConsumeAll === true)) {
      const newText = fillValue;
      const newCursor = newText.length;
      this.adapter.log('info', `BlankFill: wipe-all (sync stepValues) ${slot.blankName} → "${preview(fillValue, 60)}"`);
      this.adapter.setText(newText);
      this.adapter.setCursorOffset(newCursor);
      this.adapter.forceRender();
      return true;
    }

    const { clearEnd, expansion } = explicitMode !== null
      ? computeFillRangeForMode(blank, slot, explicitMode)
      : computeFillRange(blank, slot);

    const { newText, newCursor } = clearEnd !== undefined || expansion != null
      ? buildClearKeywordText(insertedText, slot, fillValue, expansion, clearEnd)
      : { newText: insertedText.slice(0, insertedWord.start) + fillValue + insertedText.slice(insertedWord.end),
          newCursor: insertedWord.start + fillValue.length };

    // When the fill or the alternative pool is multi-word OR the blank
    // is dismissible, register a span so Cycling and DimRender can
    // treat the whole fill as a single navigable, cycleable unit.
    // Affirmations are the canonical case: stepValues[0] = "I am strong"
    // doesn't cycle via path 2 (lookupBlank on inner words returns
    // nothing). Without a span entry, Ctrl+Alt+Up after the fill falls
    // through to no-op. blankDismissible appends `_` so cycling can dismiss.
    const dismissible = blank.blankDismissible === true;
    const altsForSpan = dismissible ? [...stepValues, '_'] : stepValues;
    // blankClearOnEdit promotes single-alt blanks into a span entry too,
    // so the wipe-on-edit machinery (maybePreserveBlankFillPair +
    // applyClearOnEdit) has something to react against. Without this the
    // sync stepValues path would silently lose the wipe behaviour the
    // async / LLM-resolved path already supports.
    const wantsClearOnEdit = (blank as { blankClearOnEdit?: boolean }).blankClearOnEdit === true;
    const wantsSpan = altsForSpan.length > 1 || wantsClearOnEdit;
    if (this.spanFillState && wantsSpan) {
      const fillStart = newCursor - fillValue.length;
      const newWords = splitWords(newText);
      const startWord = newWords.find(w => w.start === fillStart);
      // Char range of the substituted region — anchored at the keyword's
      // first char so a backspace inside the keyword counts as a touch.
      const kwStartChar = newWords[slot.keywordStart]?.start ?? fillStart;
      if (startWord) {
        const spanLength = fillValue.split(/\s+/).filter(Boolean).length;
        this.spanFillState.set({
          index: startWord.index,
          alternatives: altsForSpan,
          currentAltIndex: 0,
          spanLength: Math.max(1, spanLength),
          blankTip: blank.blankTip ?? blank.tip,
          clearOnEdit: wantsClearOnEdit,
          pairCharStart: wantsClearOnEdit ? kwStartChar : undefined,
          pairCharEnd: wantsClearOnEdit ? newCursor : undefined,
        }, newText);
      }
    }

    this.adapter.log('info', `BlankFill: substituting "${slot.keyword} _" → "${preview(fillValue, 60)}" (blank=${slot.blankName}, sync stepValues, ${stepValues.length} alt(s)${dismissible ? ', dismissible' : ''})`);
    // Emit the same `blank.substituted` event the async path emits so
    // hosts have one consistent surface for the "span-as-unit"
    // indication regardless of which fill path ran.
    this.adapter.emitEvent?.('blank.substituted', {
      blankName: slot.blankName,
      keyword: slot.keyword,
      input: `${slot.keyword} _`,
      output: fillValue.slice(0, 200),
      altCount: stepValues.length,
      dismissible,
      spanAsUnit: wantsClearOnEdit,
    });
    this.adapter.setText(newText);
    this.adapter.setCursorOffset(newCursor);
    this.adapter.forceRender();
    return true;
  }

  /** Walk backward from blankIdx looking for a blank's blankKeywords match. */
  private matchKeyword(words: readonly string[], blankIdx: number): BlankSlot | null {
    // Universal-Integration filter: when the host has no cycling
    // surface (chrome's normal-`<input>` branch), skip cycleable blanks
    // (volume, brightness, opencues-settings, list blanks). The same
    // check runs in `buildSourcesFromConfig` for the resolver path, but
    // BlankFill detects keyword-bound blanks DIRECTLY from
    // configLoader.blanks — independent code path that needs its own
    // filter. Without this, `volume _` in a normal input would still
    // auto-populate the system volume even though the user can't see
    // or cycle the result.
    const supportsCycling = this.adapter.supportsCycling?.() ?? true;
    // Skip candidate keyword matches that fall inside an already-
    // substituted multi-word span. Without this guard, BlankFill loops
    // on substituted output that contains a registered keyword:
    // `nvda _` → `Nvidia NVDA: $200.42`; then `nvidia` (inside the
    // substituted text) re-matches the stocks blank's `nvidia`
    // keyword on every next text-change, re-firing the substitute
    // forever and clobbering any sibling blanks (`+ apple _`, `= _`)
    // that try to fire alongside it. The stocks-chain regression
    // (June 2026) is the canonical incident — `nvda _ + apple _ = _`
    // produced "apple •" + "= •" stuck loading because nvda kept
    // re-substituting and reset the resolver's state.
    const indexInsideSubstitutedSpan = (idx: number): boolean => {
      if (!this.dynDefs) return false;
      const span = this.dynDefs.findSpanContaining(idx);
      return span !== null;
    };
    for (let j = blankIdx - 1; j >= 0; j -= 1) {
      for (const [name, blank] of this.configLoader.blanks.entries()) {
        const blankKeywords = (blank as { blankKeywords?: readonly string[] }).blankKeywords;
        if (!blankKeywords || blankKeywords.length === 0) continue;
        if (!supportsCycling && isBlankConfigCycleable(blank as Parameters<typeof isBlankConfigCycleable>[0])) continue;
        // Default blankProximity to 0 (keyword must be DIRECTLY adjacent
        // to _, no words between) when not explicitly set. The previous
        // default (no limit, when the field was undefined) caused
        // accidental claims when a registered keyword appeared earlier
        // in the user's prose — e.g. a poem containing "bright" 13 words
        // back claimed `_` for the brightness blank. Blanks that
        // legitimately need wider proximity (e.g. "what is X _"
        // dictionary, where the user types extra words between the
        // trigger phrase and `_`) MUST set blankProximity explicitly.
        // Matches the cede default in blank-source.ts.
        const blankProximity = (blank as { blankProximity?: number }).blankProximity ?? 0;
        if ((blankIdx - j - 1) > blankProximity) continue;
        for (const kw of blankKeywords) {
          const kwLc = kw.toLowerCase();
          const kwWords = kwLc.split(/\s+/);
          const start = j - kwWords.length + 1;
          if (start < 0) continue;
          let matches = true;
          for (let k = 0; k < kwWords.length; k += 1) {
            if ((words[start + k] ?? '').toLowerCase() !== kwWords[k]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            // Reject the match if any word in the keyword span sits
            // inside an already-substituted multi-word DynDef span.
            // See `indexInsideSubstitutedSpan` declaration above for
            // the bug class this prevents.
            let insideSubstitute = false;
            for (let k = 0; k < kwWords.length; k += 1) {
              if (indexInsideSubstitutedSpan(start + k)) {
                insideSubstitute = true;
                break;
              }
            }
            if (insideSubstitute) continue;
            return {
              index: blankIdx,
              keyword: kwLc,
              blankName: name,
              keywordStart: start,
              keywordEnd: j,
              proximity: blankIdx - j - 1,
            };
          }
        }
      }
    }
    return null;
  }
}

/** Debug helper — keys actually injected into the script env. */
function extraEnvKeys(blank: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (blank.model) keys.push('CUES_MODEL');
  if (blank.apiUrl) keys.push('CUES_API_URL');
  if (blank.apiKeyEnv) keys.push('CUES_API_KEY_ENV');
  if (blank.altCount !== undefined) keys.push('CUES_ALT_COUNT');
  if (blank.includeOriginal !== undefined) keys.push('CUES_INCLUDE_ORIGINAL');
  if (blank.prompts && typeof blank.prompts === 'object') {
    for (const k of Object.keys(blank.prompts as object)) {
      keys.push('CUES_PROMPT_' + k.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
    }
  }
  return keys;
}

/**
 * Derive the (clearEnd, expansion) pair that the helper loop will
 * apply, given a blank's flags. Lets callers stay short.
 *
 *   - blankConsumeContext: clearEnd = slot.index - 1 (drop keyword +
 *     anything between it and the blank).
 *   - blankClearKeywords (alone): clearEnd = slot.keywordEnd (just the
 *     keyword span).
 *   - blankKeywordExpansions[keyword] (alone): no clear range widening
 *     beyond the keyword span; expansion fills the start.
 *   - Both clear flags + expansion: expansion is suppressed (clear wins).
 */
export function computeFillRange(
  blank: {
    blankClearKeywords?: boolean;
    blankConsumeContext?: boolean;
    blankKeywordExpansions?: Record<string, string>;
  },
  slot: { index: number; keyword: string; keywordEnd: number },
): { clearEnd: number | undefined; expansion: string | undefined } {
  const consumeContext = blank.blankConsumeContext === true;
  const clearKw = blank.blankClearKeywords === true;
  let clearEnd: number | undefined;
  if (consumeContext) clearEnd = slot.index - 1;
  else if (clearKw) clearEnd = slot.keywordEnd;
  const expansion = (clearKw || consumeContext)
    ? undefined
    : blank.blankKeywordExpansions?.[slot.keyword];
  return { clearEnd, expansion };
}

/**
 * Derive `(clearEnd, expansion)` from the resolved `EffectiveReplaceMode`:
 *
 *   - 'keep'     — no clearing. Expansion applies (display-name override).
 *   - 'wipe'     — drop the full keyword + context range (= legacy
 *                  blankConsumeContext). Expansion suppressed.
 *   - 'wipe-all' — handled upstream as a short-circuit; not expected here.
 *
 * This is the new dispatcher built on top of `resolveReplaceMode`. The
 * older `computeFillRange` stays for tests + any caller that wants the
 * raw legacy-flag behaviour, but applyAsyncFill routes through this
 * function so explicit `blankReplace:` + the fluid heuristic win.
 */
export function computeFillRangeForMode(
  blank: {
    blankKeywordExpansions?: Record<string, string>;
  },
  slot: { index: number; keyword: string; keywordEnd: number },
  mode: EffectiveReplaceMode,
): { clearEnd: number | undefined; expansion: string | undefined } {
  if (mode === 'wipe') {
    return { clearEnd: slot.index - 1, expansion: undefined };
  }
  // 'keep' (or 'wipe-all' which the caller should have short-circuited).
  // Expansion (rddt → Reddit etc.) applies only in keep mode.
  return {
    clearEnd: undefined,
    expansion: blank.blankKeywordExpansions?.[slot.keyword],
  };
}

/**
 * Char-position splice that handles keyword clearing, keyword
 * expansion, and consume-context while preserving
 * surrounding whitespace structure (newlines, paragraph breaks,
 * indentation, bullet markers). v1 used a word-split + word-join
 * approach which collapsed all whitespace runs to single spaces —
 * that destroyed bullet/paragraph layouts whenever `config _` (or any
 * blank with blankClearKeywords / blankConsumeContext) fired inside
 * formatted prose. Char-position splice fixes it.
 *
 *   - The range [keywordStart..clearEnd] (word indices) is dropped
 *     (default clearEnd = keywordEnd → clears just the keyword span).
 *     When clearEnd = slot.index - 1, words between keyword and blank
 *     are also dropped — that's blankConsumeContext.
 *   - If `expansion` is given, it's inserted at keywordStart (replacing
 *     the dropped keyword). Callers should suppress `expansion` when
 *     consume-context is widening clearEnd to the blank — leaving an
 *     expansion in place after dropping its surrounding context produces
 *     incoherent output.
 *   - The slot.index entry (the `_` token) is replaced with `fillValue`.
 *
 * Whitespace handling:
 *   - When the cleared range is contiguous with the blank (consumeContext
 *     case), one drop+insert: drop chars [kwStart..blankEnd), insert
 *     fillValue. Surrounding whitespace preserved as-is.
 *   - When the cleared range is NOT contiguous with the blank
 *     (clearKeywords-only case), drop the keyword + one trailing
 *     horizontal whitespace char (space/tab — NOT newline) so we don't
 *     leave a double-space behind. Newlines stay intact.
 */
export function buildClearKeywordText(
  text: string,
  slot: { index: number; keywordStart: number; keywordEnd: number },
  fillValue: string,
  expansion?: string,
  clearEnd?: number,
): { newText: string; newCursor: number } {
  const cleaned = text.replace(/[\u200B\u200C]/g, '');
  const wordSpans = splitWords(cleaned);
  const lastClearedWord = clearEnd ?? slot.keywordEnd;

  const kwStart = wordSpans[slot.keywordStart]?.start ?? 0;
  const kwEnd = wordSpans[lastClearedWord]?.end ?? kwStart;
  const blankStart = wordSpans[slot.index]?.start ?? kwEnd;
  const blankEnd = wordSpans[slot.index]?.end ?? blankStart;

  // When the cleared range reaches up to (or past) the blank, do a
  // single contiguous drop. consumeContext sets clearEnd = slot.index - 1
  // explicitly; clearKeywords + adjacent keyword (kwEnd === slot.index)
  // also collapses to this case.
  const clearReachesBlank = lastClearedWord >= slot.index - 1;

  let newText: string;
  let cursor: number;

  if (clearReachesBlank) {
    const expansionPart = expansion ?? '';
    // Space between expansion and fillValue when both present, so
    // "Reddit" + "$180.50" reads "Reddit $180.50" not "Reddit$180.50".
    const sep = expansionPart && fillValue ? ' ' : '';
    newText = cleaned.slice(0, kwStart) + expansionPart + sep + fillValue + cleaned.slice(blankEnd);
    cursor = kwStart + expansionPart.length + sep.length + fillValue.length;
  } else {
    // Drop keyword + one trailing horizontal whitespace char so we don't
    // leave a double-space when the kept text follows. Newlines NEVER
    // get consumed — formatted prose stays intact.
    let kwSkipEnd = kwEnd;
    const trailing = cleaned[kwSkipEnd];
    if (trailing === ' ' || trailing === '\t') kwSkipEnd += 1;
    const middle = cleaned.slice(kwSkipEnd, blankStart);
    const expansionPart = expansion ?? '';
    // If we have an expansion AND middle doesn't already start with a
    // separator, add a space so expansion + middle don't run together.
    const expansionSep = expansionPart && middle && !/^\s/.test(middle) ? ' ' : '';
    const prefix = cleaned.slice(0, kwStart) + expansionPart + expansionSep + middle;
    newText = prefix + fillValue + cleaned.slice(blankEnd);
    cursor = prefix.length + fillValue.length;
  }
  return { newText, newCursor: cursor };
}

/**
 * Char-range diff for blankClearOnEdit cleanup. Computes
 * the slice of `newText` that the user "broke" relative to oldText's
 * pair range [pairStart..pairEnd]. The result is always ⊇ the
 * original pair, even when the user's edit happened entirely outside
 * the visual pair range — that's the v1 invariant ("wipe the pair plus
 * any user-typed chars inside it").
 */
export function computeCleanupRange(
  oldText: string,
  newText: string,
  pairStart: number,
  pairEnd: number,
): { start: number; end: number } {
  let prefix = 0;
  while (
    prefix < oldText.length &&
    prefix < newText.length &&
    oldText[prefix] === newText[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix += 1;
  const start = Math.min(prefix, pairStart);
  const oldTail = oldText.length - pairEnd;
  const end = newText.length - Math.min(suffix, oldTail);
  return { start, end };
}

/**
 * Find the word in `text` containing the character at `charOffset` IF that
 * character is the lone '_' word at its position. Returns null if the '_'
 * is part of a larger word (e.g. `affirm_xyz`).
 */
export function findUnderscoreAtChar(text: string, charOffset: number): { index: number; start: number; end: number } | null {
  const words = splitWords(text);
  for (const w of words) {
    if (w.start <= charOffset && charOffset < w.end && w.word === '_') {
      return { index: w.index, start: w.start, end: w.end };
    }
  }
  return null;
}

/** Truncate a substituted value for the info-level log so a long
 *  paragraph (prompt-improver, dictionary) doesn't blow out the line. */
function preview(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + '…';
}
