// BlankFill — auto-populate `_` slots when a keyword-bound blank claims them.
//
// Scans the input text on every change for `_` placeholders. For each `_`,
// walks backward word-by-word looking for a match against any blank's
// blankKeywords (single or multi-word). When matched, records a BlankSlot
// with the blank name + match positions for downstream consumers
// (auto-populate, blank-script fetch, span tracking, dismiss, etc.).

import type { BlankWriteInverse, HostAdapter, KeyEvent, TextChangeEvent, Unsubscribe } from '../adapter';
import { diffSplice, type UndoEntry, type UndoJournal } from '../state/undo-journal';
import type { ConfigLoader } from './config-loader';
import { splitWords } from './navigation';
import { isBlankConfigCycleable, keywordInWindow, lineOfWords, matchBlankShape, segmentStart } from '@opencues/core';
import type { SpanFillState } from '../state/span-fill';
import type { DismissedBlanks } from '../state/dismissed-blanks';
import type { SelectorSatelliteState } from '../state/selector-satellite';
import type { DynDefs } from '../state/dyn-defs';
import { BlankLoadingAnimator, parseCustomFrames, parseRgbColors, parseAnsiColors, parseFrameIntervalMs, DEFAULT_RGB_PALETTE, DEFAULT_ANSI_PALETTE, type BlankLoadingMode } from './blank-loading';
import { buildSafeScriptEnv } from '../security/safe-env';
import { WEAVE_VALUE_TOKEN, type BlankWeaver } from './blank-weave';

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
  /** Set when this slot was claimed by a DETERMINISTIC blankShape match
   *  (type-based routing). Carries the shape's action/value so the dispatch
   *  runs with ZERO LLM. `shapeValue` holds the set value or step direction. */
  readonly shapeAction?: 'get' | 'set' | 'step';
  readonly shapeValue?: string;
  /** Word index where the shape-matched command SEGMENT begins (shape slots
   *  only). Shapes match the sentence containing `_`, so this may PRECEDE
   *  keywordStart for trailing-keyword shapes ("east finchley iceland
   *  location _") — clearing the command span starts here, not at the
   *  keyword. */
  readonly commandStart?: number;
}

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
  /** Once-per-blank warn dedup for the config-without-implementation
   *  case (registry miss + no blankScript). */
  private _warnedUnavailableBlanks = new Set<string>();

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
   *  - Fixed process-wide TTL (DEFAULT_CACHE_TTL_MS, 2000ms).
   *    Tuned for "instant on re-cycle" without masking
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
  // Bound on the integration-weave LLM call. On timeout the fill lands as the
  // static template, so a hung/slow provider can't leave the `_` spinning.
  private static readonly WEAVE_TIMEOUT_MS = 6000;
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
    /** Optional LLM weaver (blanks bucket) for `integration-weave`. Built by
     *  the boot layer from `buildBlankWeaver`; null on hosts/configs with no
     *  blanks-bucket key. When absent, `integration:` stays a static template.
     *  The real value is never passed to it — see `blank-weave.ts`. */
    private weave?: BlankWeaver | null,
    /** Undo journal — every fill commit records a transaction (buffer
     *  diff + any os-set / file-write side-effect entries) so `undo _`
     *  can revert it. Omit to disable recording. */
    private undoJournal?: UndoJournal,
  ) {
    if (blankLoading) this._loading = blankLoading;
  }

  /** Record a fill into the undo journal (no-op without a journal). */
  private recordUndo(label: string, before: string, after: string, extra?: readonly UndoEntry[]): void {
    if (!this.undoJournal) return;
    const entries: UndoEntry[] = [];
    const buf = diffSplice(before, after, this.undoJournal.currentEpoch);
    if (buf) entries.push(buf);
    if (extra) entries.push(...extra);
    this.undoJournal.record({ label, entries });
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
    // Per-word line numbers (same order as the flat split) for the shared
    // line-scoped keyword window.
    const lineOf = lineOfWords(cleanText);
    const slots: BlankSlot[] = [];
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] !== '_') continue;
      const found = this.matchKeyword(words, i, lineOf);
      if (found) slots.push(found);
    }
    // TYPE-BASED ROUTING (experiment) — deterministic blankShape match. If the
    // whole buffer matches a blank's declared invocation grammar, that blank
    // is the unambiguous owner of the `_`: ZERO LLM, NO blankProximity. This
    // both (a) supplies a deterministic action/value (set/step/get) and (b)
    // CREATES the slot when keyword+proximity missed it (e.g. `volume 30 _`,
    // where the `30` between keyword and `_` fails proximity:0). A non-match
    // changes nothing — the `_` falls through to the normal sources.
    const shape = matchBlankShape(cleanText, this.configLoader.blanks as ReadonlyMap<string, { blankShapes?: import('@opencues/core').BlankShape[] }>);
    if (shape) {
      // matchBlankShape anchors on the LAST `_` (lineWithBlank uses
      // lastIndexOf) — attach the verdict to that same `_`. Using the
      // FIRST `_` mis-claimed an earlier, unrelated `_` in the buffer
      // ("fill later _ ok. note add snack _" fired the blank on the
      // "later" slot with a nonsense query) — found by the note-blank
      // dumb-user gauntlet.
      const usIdx = words.lastIndexOf('_');
      if (usIdx >= 0) {
        // Locate the blank's keyword span in the buffer so applyAsyncFill's
        // clearing behaves exactly as the keyword path would. Shapes are
        // anchored at the buffer start, so the keyword is at/near word 0.
        const blankCfg = this.configLoader.blanks.get(shape.blankName) as { blankKeywords?: readonly string[] } | undefined;
        let kwStart = 0, kwEnd = 0;
        const kws = blankCfg?.blankKeywords ?? [];
        outer: for (const kw of kws) {
          const parts = kw.toLowerCase().split(/\s+/);
          for (let i = 0; i + parts.length <= usIdx; i++) {
            if (parts.every((p, j) => words[i + j]?.toLowerCase() === p)) { kwStart = i; kwEnd = i + parts.length - 1; break outer; }
          }
        }
        // Word index where the shape-matched SEGMENT begins. matchBlankShape
        // anchors on the segment containing the last `_` (lineWithBlank), so
        // the command span the shape owns starts here — which may precede the
        // keyword for trailing-keyword shapes ("east finchley iceland
        // location _"). segmentStart boundaries fall between words (terminator
        // + whitespace, or newline), so the word count before it is exact.
        const segChar = segmentStart(cleanText, cleanText.lastIndexOf('_'));
        const commandStart = cleanText.slice(0, segChar).split(/\s+/).filter(Boolean).length;
        const existing = slots.find(s => s.index === usIdx && s.blankName === shape.blankName);
        if (existing) {
          // Keyword scan already made the slot — just attach the shape verdict.
          slots[slots.indexOf(existing)] = { ...existing, shapeAction: shape.action, shapeValue: shape.value, commandStart };
        } else {
          // Proximity missed it — create the slot (the bypass that fixes
          // `volume 30 _` / `brightness 50 _`).
          slots.push({
            index: usIdx, keyword: kws[0] ?? shape.blankName, blankName: shape.blankName,
            keywordStart: kwStart, keywordEnd: kwEnd, proximity: Math.max(0, usIdx - kwEnd - 1),
            shapeAction: shape.action, shapeValue: shape.value, commandStart,
          });
        }
      }
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
      // TYPE-BASED ROUTING (opt-in per blank). A blank that DECLARES shapes is
      // shape-gated: it fires ONLY on a deterministic shape match, so a keyword
      // merely present in conversational prose does NOT fire it (it falls to
      // fluid). A blank WITHOUT shapes keeps the legacy keyword behavior — so
      // existing blanks migrate to shapes one at a time. (List/stepValues
      // blanks are handled separately in onUnderscoreKey.)
      {
        const sc = this.configLoader.blanks.get(slot.blankName) as { blankShapes?: unknown[] } | undefined;
        if (sc?.blankShapes?.length && !slot.shapeAction) continue;
      }
      // Skip slots the user has dismissed by cycling
      // the fill back to `_`. Without this, the script re-spawns immediately
      // and the dismissal sticks for ~zero milliseconds.
      if (this.dismissedBlanks?.has(slot.index)) continue;
      const blank = this.configLoader.blanks.get(slot.blankName) as
        | (Record<string, unknown> & {
            stepValues?: readonly string[];
            blankScript?: string;
            blankClearKeywords?: boolean;
          })
        | undefined;
      if (!blank) continue;
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
      // `undoExtras` carries side-effect journal entries the shaped
      // set/step path captured (os-set with the prior value) so the
      // eventual fill transaction reverts BOTH the text and the OS state.
      const doDispatch = (typedAction?: 'set' | 'step', undoExtras?: readonly UndoEntry[]): void => {

      // Context words: ONLY the words between the keyword and the `_` — the
      // captured arg region (e.g. ["france"] in `capital of france _`). This
      // mirrors the anchored shape's valueGroup. The pre-#216 collector
      // gathered the WHOLE buffer minus the keyword span, so words from
      // EARLIER LINES leaked in: a shaped blank's command is line-scoped (it
      // only reaches this dispatch via a `matchBlankShape` hit — the gate
      // above — and a shape leads + ends its own line), but the context still
      // swept up every prior line. Live repro: a `countries` blank whose
      // `capital of france _` sat below a paragraph of website-design prose
      // got that whole paragraph as "context" and the script echoed back a
      // 495-char garbage fill. Bounding context to (keywordEnd, `_`) keeps it
      // to the actual argument; prior lines and any trailing text are excluded.
      const contextWords: string[] = [];
      if (slot.shapeAction === 'get' && slot.shapeValue) {
        // Shaped get: the shape's valueGroup capture IS the arg. For
        // keyword-first shapes this equals the positional walk below; for
        // trailing-keyword shapes ("east finchley iceland location _") the
        // arg PRECEDES the keyword and the positional walk finds nothing.
        contextWords.push(...slot.shapeValue.split(/\s+/).filter(Boolean));
      } else {
        for (let wi = slot.keywordEnd + 1; wi < slot.index; wi += 1) {
          contextWords.push(words[wi]);
        }
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
      const env: Record<string, string> = buildSafeScriptEnv(processEnv, declaredSecrets, {});

      // Cache lookup. Args identical to a recent call → reuse the
      // stored stdout instead of paying the spawn cost again. Fixed
      // process-wide TTL (DEFAULT_CACHE_TTL_MS).
      const cacheKey = `${slot.blankName}::${slot.keyword}|${contextWords.join('|')}`;
      const ttlMs = BlankFill.DEFAULT_CACHE_TTL_MS;
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
          // Defer the fill to a macrotask. The fresh (post-spawn) path is
          // naturally deferred via the spawn promise, so it lands AFTER the
          // triggering keystroke's own buffer write settles. Applying the
          // cache hit SYNCHRONOUSLY here instead races that write and gets
          // clobbered — the cached value never appeared on a quick re-type
          // (cache-hit-fill race). setTimeout(0) mirrors the fresh path's
          // timing; applyAsyncFill's staleness guard still drops it if the
          // user moved on.
          const cachedOutput = entry.output;
          setTimeout(() => {
            this.applyAsyncFill(slot, cachedOutput, typedAction, undoExtras);
            // End the gate-window loader (started before the gate on the
            // gated path). No-op on the ungated path, where it was never started.
            this._loadingAnimator().stop(slot.index, 'blank-fill');
          }, 0);
          return;
        }
      }

      this.adapter.log('debug', `BlankFill: invoke ${slot.blankName} get ${slot.keyword}`, { contextWords, scriptPath });
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
          // shell fallback: the CONFIG for this blank exists (a
          // BLANK.md matched and formed the slot) but the host has no
          // IMPLEMENTATION — either the installed bundle predates the
          // blank (shared ~/.cues is seeded by ANY host's install, so
          // configs can legitimately run ahead of another host's
          // bundle), or the blank's factory skipped registration over
          // a missing prerequisite (e.g. stocks without a Finnhub
          // key). This used to skip in TOTAL SILENCE — no log, no
          // fill — and read as "OpenCues is broken" (July 2026, the
          // loading-animation blank on a stale CC fork). Name it:
          // an [err] fill replaces only the `_` (the typed command
          // survives) and a once-per-blank warn carries the detail.
          // Drop the dedup so a later state change can retry, and
          // release the loading claim we just took — without this,
          // the slot would animate forever (no .then/.catch ever
          // fires to stop it).
          this._pendingScripts.delete(dedupKey);
          this._loadingAnimator().stop(slot.index, 'blank-fill');
          if (!this._warnedUnavailableBlanks.has(slot.blankName)) {
            this._warnedUnavailableBlanks.add(slot.blankName);
            this.adapter.log('warn',
              `BlankFill: "${slot.blankName}" has config but no implementation on this host — ` +
              `blankInvoke doesn't know it and its BLANK.md declares no blankScript. ` +
              `Stale bundle (config newer than the installed runtime) or an unmet ` +
              `registration prerequisite. Fix: \`opencues install ${this.adapter.hostName}\`.`,
            );
          }
          // DEFER the [err] fill — this branch is the only fill that
          // would otherwise run SYNCHRONOUSLY inside the text-change
          // dispatch. On live CC (found 2026-07-15) adapter.getText()
          // is still one keystroke stale at that instant (the host's
          // buffer state catches up after the handler returns), so
          // `words[slot.index]` missed and applyAsyncFill's staleness
          // guard silently dropped the fill — warn logged, buffer
          // untouched, and the MockAdapter's synchronous text state
          // hid it from the unit journeys. Every OTHER fill path is
          // naturally deferred past the state update by script/LLM
          // latency; match that timing. One guarded retry covers hosts
          // whose state settles later than a tick — if the buffer
          // legitimately moved on instead, the retry is dropped by the
          // same staleness guard that protects late script callbacks.
          {
            const errFill = `[err] ${slot.blankName}: not available on this host — stale bundle or missing prerequisite. Try \`opencues install ${this.adapter.hostName}\``;
            setTimeout(() => {
              if (this.tryErrFill(slot, errFill, typedAction)) return;
              setTimeout(() => { this.tryErrFill(slot, errFill, typedAction); }, 50);
            }, 0);
          }
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
        // A file-writing blank (sentinel, note) attaches the inverse of
        // the write this invocation performed — journal it alongside the
        // fill so `undo _` reverts the file through the blank's own
        // validator path.
        const inverseEntries: UndoEntry[] = res.writeInverse
          ? [...(undoExtras ?? []), {
              kind: 'file-write',
              file: res.writeInverse.file,
              blankName: res.writeInverse.blankName,
              inverseOp: res.writeInverse.inverseOp,
              forwardOp: res.writeInverse.forwardOp,
            }]
          : [...(undoExtras ?? [])];
        this.applyAsyncFill(slot, stdout, typedAction, inverseEntries.length > 0 ? inverseEntries : undefined);
      }).catch(err => {
        this._pendingScripts.delete(dedupKey);
        this._loadingAnimator().stop(slot.index, 'blank-fill');
        this.adapter.log('error', `BlankFill: script promise rejected for ${slot.blankName}`, err);
      });

      }; // end doDispatch

      // TYPE-BASED ROUTING — deterministic shape dispatch (ZERO LLM). When
      // scan() tagged this slot from a blankShape match, run its action/value
      // directly: no BlankIntent classify, no proximity. This is the measurable
      // Tier-1 — a real set/step/get invocation resolved with no model call.
      // Mirrors the gate's typed-set/step path, but the verdict is the regex's.
      if (slot.shapeAction) {
        const stepRaw0 = (blank as { blankStep?: unknown }).blankStep;
        const stepSize0 = typeof stepRaw0 === 'number' ? stepRaw0
          : (typeof stepRaw0 === 'string' && /^\d+$/.test(stepRaw0) ? parseInt(stepRaw0, 10) : null);
        const settable0 = stepSize0 !== null;
        this.adapter.log('info', `[blank-shapes] deterministic match: ${slot.blankName}/${slot.shapeAction}${slot.shapeValue ? '=' + slot.shapeValue : ''} (0 LLM)`);
        const shapeText = text;
        void (async () => {
          this._loadingAnimator().start(slot.index, 'blank-fill');
          let typedAction: 'set' | 'step' | undefined;
          // Undo capture (get-before-set): the OS value BEFORE the set,
          // so `undo _` can restore it. When the prior read fails the
          // set still proceeds — journaled as a non-invertible external
          // effect so the undo report stays honest instead of guessing.
          let undoExtras: UndoEntry[] | undefined;
          const scriptForUndo = (blank as { blankScript?: string }).blankScript;
          const undoScriptPath = scriptForUndo
            ? (scriptForUndo.startsWith('~') ? home + scriptForUndo.slice(1) : scriptForUndo)
            : undefined;
          if (slot.shapeAction === 'set' && slot.shapeValue && /^\d+$/.test(slot.shapeValue) && settable0) {
            const prior = await this.runBlankGetValue(slot.blankName, blank as Record<string, unknown>);
            if (this._lastInputText !== shapeText) { this._loadingAnimator().stop(slot.index, 'blank-fill'); this._pendingScripts.delete(dedupKey); return; }
            await this.runBlankSet(slot.blankName, slot.shapeValue, blank as Record<string, unknown>);
            if (this._lastInputText !== shapeText) { this._loadingAnimator().stop(slot.index, 'blank-fill'); this._pendingScripts.delete(dedupKey); return; }
            typedAction = 'set';
            undoExtras = prior !== null
              ? [{ kind: 'os-set', blankName: slot.blankName, scriptPath: undoScriptPath, prevValue: String(prior), newValue: slot.shapeValue }]
              : [{ kind: 'external', label: `${slot.blankName} set ${slot.shapeValue} (prior value unreadable)` }];
          } else if (slot.shapeAction === 'step' && (slot.shapeValue === 'up' || slot.shapeValue === 'down') && settable0) {
            const current = await this.runBlankGetValue(slot.blankName, blank as Record<string, unknown>);
            if (this._lastInputText !== shapeText) { this._loadingAnimator().stop(slot.index, 'blank-fill'); this._pendingScripts.delete(dedupKey); return; }
            if (current !== null) {
              const next = Math.max(0, Math.min(100, slot.shapeValue === 'up' ? current + stepSize0! : current - stepSize0!));
              await this.runBlankSet(slot.blankName, String(next), blank as Record<string, unknown>);
              if (this._lastInputText !== shapeText) { this._loadingAnimator().stop(slot.index, 'blank-fill'); this._pendingScripts.delete(dedupKey); return; }
              typedAction = 'step';
              undoExtras = [{ kind: 'os-set', blankName: slot.blankName, scriptPath: undoScriptPath, prevValue: String(current), newValue: String(next) }];
            }
          }
          doDispatch(typedAction, undoExtras);
        })();
        continue;
      }

      // Non-shaped slot (no blankShapes match tagged it). Dispatch a plain
      // get. Shaped invocations (get/set/step) were handled + `continue`d
      // above via the deterministic shape path; the old LLM BlankIntent gate
      // was retired — an anchored shape match IS the invocation proof.
      doDispatch();
    }
  }

  /**
   * Dispatch a `set <value>` for a settable blank (shaped typed-SET)
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
   * Read a settable blank's CURRENT numeric value (for shaped typed-STEP,
   * which needs `current ± blankStep`). Dispatches a `get`
   * and parses the first integer out of stdout (handles "54", "54%",
   * etc.). Returns null on any failure / non-numeric output, so the
   * caller can degrade to a plain get. Host-native `blankInvoke` first,
   * shell `get` fallback — mirrors `runBlankSet`.
   */
  private async runBlankGetValue(blankName: string, blank: Record<string, unknown>): Promise<number | null> {
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
        action: 'get',
        args: [],
        env,
        timeoutMs: 4000,
      }) ?? null;
      if (!handle) {
        if (!script || !this.adapter.capabilities.includes('spawn-process')) return null;
        handle = this.adapter.spawnProcess({
          command: 'bash',
          args: [scriptPath, 'get'],
          env,
          timeoutMs: 4000,
        });
      }
      const res = await handle.result;
      if (res.exitCode !== 0 || res.timedOut) return null;
      const m = (res.stdout ?? '').match(/-?\d+/);
      return m ? parseInt(m[0], 10) : null;
    } catch (e) {
      this.adapter.log('debug', `BlankFill: typed-STEP read failed for ${blankName}`, e);
      return null;
    }
  }

  /**
   * Apply a blank's ADDITIVE integration template to its output. The blank
   * exposes how its output reads woven into text via `integration:` (a string
   * with `{value}`); we render the real output through it, adding connective
   * "fluff" AROUND the value. Add-only by construction — it only shapes the
   * value being inserted, never the user's surrounding text. No template (or
   * empty value) → the value passes through unchanged.
   */
  private renderIntegration(blank: Record<string, unknown> | undefined, value: string): string {
    const tpl = blank?.integration as string | undefined;
    if (!tpl || !value || !tpl.includes('{value}')) return value;
    return tpl.replace(/\{value\}/g, value);
  }

  /**
   * Apply an async fill: re-read the host's text via getText, find the
   * matching `_` at the slot's word index, splice stdout in. Push via
   * adapter.pushText (calls onChange), since this runs outside any
   * dispatch.
   */
  /** Attempt an [err] feedback fill; returns true when the slot's `_`
   *  (or its animation frame char) is present in the CURRENT buffer —
   *  i.e. the fill had a target and applyAsyncFill ran its course.
   *  False = the adapter's text state hasn't caught up with the
   *  keystroke that formed the slot (live-CC timing, 2026-07-15) and
   *  the caller may retry once. */
  private tryErrFill(slot: BlankSlot, errFill: string, typedAction?: 'set' | 'step'): boolean {
    const cleaned = this.adapter.getText().replace(/[\u200B\u200C]/g, '');
    const target = splitWords(cleaned)[slot.index];
    const present = !!target
      && (target.word === '_' || (this._loading?.isOurSlotChar(slot.index, target.word) ?? false));
    if (present) this.applyAsyncFill(slot, errFill, typedAction);
    return present;
  }

  private applyAsyncFill(slot: BlankSlot, fillValue: string, typedAction?: 'set' | 'step', undoExtras?: readonly UndoEntry[]): void {
    const currentText = this.adapter.getText();
    const cleaned = currentText.replace(/[\u200B\u200C]/g, '');
    const words = splitWords(cleaned);
    const target = words[slot.index];
    const blank = this.configLoader.blanks.get(slot.blankName) as
      | (Record<string, unknown> & {
          blankClearKeywords?: boolean;
          blankDismissible?: boolean;
          blankSatellite?: boolean;
          blankSatelliteSeparator?: string;
          blankClearOnEdit?: boolean;
          blankScript?: string;
          blankSuffix?: string;
          tip?: string;
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
      this.applySatelliteFill(slot, blank, fillValue, cleaned, target, undoExtras);
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

    // ADDITIVE integration template: when the blank declares `integration:`
    // with a `{value}` slot, wrap the (already-suffixed) output in that
    // connective text — "30%" → "volume is now 30%". The template IS the
    // rendering, so it SUPERSEDES the typed-action "<keyword> <value>"
    // default below. Add-only by construction: it only shapes the inserted
    // value, never the user's surrounding text. The keyword + typed value
    // words are still consumed by the clearEnd override (typedAction path)
    // or the blank's replace flags (get path), so no command prefix survives.
    const hasIntegration = typeof blank?.integration === 'string'
      && (blank.integration as string).includes('{value}');
    // The exact string that fills `{value}` (post-suffix). Captured BEFORE the
    // static render so the LLM weave can splice it into the sentinel token
    // afterwards — the value itself never reaches the weaver.
    const integrationValue = primaryFill;
    // `[err] …` results (sentinel validation refusals, note-blank misses)
    // are FEEDBACK, not output: they must never consume the user's typed
    // command. Fill only the `_` so the user can fix the query/key and
    // re-fire, instead of retyping the whole command. Without this, a
    // recall miss (`note kubectl _`) destroyed the very text the user
    // needed to adjust.
    const isErrResult = primaryFill.startsWith('[err]');
    if (hasIntegration && !isErrResult) {
      primaryFill = this.renderIntegration(blank as Record<string, unknown>, primaryFill);
    } else if (typedAction && !isErrResult) {
      // Typed-SET/STEP final-state render. Mirror config-intent's
      // "<setting> <value>" display: keep the keyword as the label and show
      // the read-back value as its value, so "volume 40 _" → "volume 40%".
      // The value shown is the read-back (post-clamp), not the typed input,
      // so "volume 150 _" lands as "volume 100%". The typed value word(s)
      // between keyword and `_` are consumed by the clearEnd override below.
      primaryFill = `${slot.keyword} ${primaryFill}`;
    }

    // FILL is the only mode. The destructive replace dials (blankReplace /
    // blankConsumeContext / blankConsumeAll) are gone — a blank can only ever
    // FILL the `_` or clear the COMMAND span it owns, never a heuristic span
    // over surrounding prose. The clear span is SHAPE-DERIVED, and we only
    // clear it when the output is SELF-CONTAINED:
    //
    //   - typed set/step ("volume 40 _") — the fill re-includes the keyword
    //     as a label ("volume 40%") or the integration template renders it.
    //   - an integration template is present — the template IS the rendering
    //     ("volume is now 30%"), so the typed keyword must go.
    //   - the shape captured an ARG ("weather oslo _", "nvda _", "define X _")
    //     — the arg was part of the query and the output embeds it, so the
    //     whole "<keyword> <arg>" command span is consumed.
    //
    // A BARE keyword GET with no captured arg and no integration ("brightness
    // _") instead just FILLs the `_`, KEEPING the keyword as the label
    // ("brightness 50%") — clearing it would strand a context-free value.
    // Legacy non-shaped keyword blanks fall through to the gentle
    // keyword-clear path (blankClearKeywords); plain `_` in prose just
    // fills at the cursor.
    const shapeCapturedArg = slot.shapeValue !== undefined && slot.shapeValue.length > 0;
    const clearsCommandSpan = !isErrResult
      && (typedAction !== undefined || hasIntegration || shapeCapturedArg);
    // Shaped slots clear from the start of the matched command SEGMENT
    // (commandStart) — for trailing-keyword shapes the captured arg precedes
    // the keyword, and clearing from keywordStart would strand the arg next
    // to an output that already embeds it.
    const clearStart = clearsCommandSpan ? (slot.commandStart ?? slot.keywordStart) : slot.keywordStart;
    const { clearEnd } = clearsCommandSpan
      ? { clearEnd: slot.index - 1 }
      : (isErrResult ? { clearEnd: undefined } : computeFillRange(blank ?? {}, slot));
    this.adapter.log('info', `BlankFill: substituting "${slot.keyword} _" → "${preview(primaryFill, 60)}" (blank=${slot.blankName}${typedAction ? `, typed-${typedAction}` : ''}${lines.length > 1 ? `, ${lines.length} alt(s)` : ''}${isDismissible ? ', dismissible' : ''})`);
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

    const { newText, newCursor } = clearEnd !== undefined
      ? buildClearKeywordText(cleaned, { ...slot, keywordStart: clearStart }, primaryFill, clearEnd)
      : { newText: cleaned.slice(0, target.start) + primaryFill + cleaned.slice(target.end),
          newCursor: target.start + primaryFill.length };

    const fillStart = newCursor - primaryFill.length;

    // Commit the STATIC fill — splice + cycling/clearOnEdit registration.
    // Factored into a closure so the weave path can run it ONLY on weave
    // failure (so the buffer changes exactly once, never value-then-reflow).
    const commitStatic = (): void => {
      // Populate span for fills with anything cycleable to do: multi-word
      // fill, multiple lines, blankDismissible, or clearOnEdit.
      const newWords = splitWords(newText);
      const startWord = newWords.find(w => w.start === fillStart);
      const kwStartChar = newWords[clearStart]?.start ?? fillStart;
      const wantsClearOnEdit = blank?.blankClearOnEdit === true;
      if (this.spanFillState) {
        const fillWordCount = primaryFill.split(/\s+/).filter(Boolean).length;
        const altsForSpan = isDismissible ? [...lines, '_'] : lines;
        const wantsSpan = fillWordCount > 1 || altsForSpan.length > 1 || wantsClearOnEdit;
        if (startWord && wantsSpan) {
          this.spanFillState.set({
            index: startWord.index,
            alternatives: altsForSpan,
            currentAltIndex: 0,
            spanLength: Math.max(1, fillWordCount),
            tip: blank?.tip,
            clearOnEdit: wantsClearOnEdit,
            pairCharStart: wantsClearOnEdit ? kwStartChar : undefined,
            pairCharEnd: wantsClearOnEdit ? newCursor : undefined,
          }, newText);
        } else {
          this.spanFillState.clear();
        }
      }
      // blankSuffix numeric+unit fill (volume, brightness) → attribute the word
      // to its source blank via a DynDef so cycling routes correctly.
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
      this.commitText(newText, newCursor);
      // `[err]` fills are feedback, not changes worth journaling — the
      // command is still in the buffer for the user to fix.
      if (!isErrResult) this.recordUndo(`${slot.blankName} fill`, cleaned, newText, undoExtras);
    };

    // ── LLM contextual weave (optional, opt-in, off by default) ──────────
    // When `integration-weave-mode: on` AND this blank declares
    // `integration-weave: true`, we DON'T commit the static fill. Instead we
    // keep the loading animation running, WAIT for one blanks-bucket LLM call
    // that weaves the exemplar into the prior prose, and commit ONCE: the woven
    // text on success, the static fill on failure/timeout. One buffer change,
    // never value-then-reflow. Privacy/integrity: the real value never reaches
    // the LLM — the weaver gets the exemplar's sentinel token and we splice the
    // value in here (see blank-weave.ts).
    const weaveExemplar = typeof blank?.integration === 'string' ? blank.integration : '';
    const willWeave = hasIntegration && !!this.weave && blank?.integrationWeave === true
      && this.configLoader.opencuesState.settings.get('integration-weave-mode') === 'on'
      && weaveExemplar.includes('{value}');

    if (!willWeave) {
      commitStatic();
      return;
    }

    const weaver = this.weave!;
    const priorContext = newText.slice(0, fillStart);
    // The script-get phase stopped the loader before applyAsyncFill ran; restart
    // it (same slot/owner, same tick → no flicker) so the wait stays animated.
    this._loadingAnimator().start(slot.index, 'blank-fill');
    // Timeout is configurable via `integration-weave-timeout-ms` (default 6s),
    // so a hung provider can't leave the `_` spinning — and tests can shorten it.
    const weaveTimeoutMs = parseInt(this.configLoader.opencuesState.settings.get('integration-weave-timeout-ms') ?? '', 10) || BlankFill.WEAVE_TIMEOUT_MS;
    void (async () => {
      let woven: string | null = null;
      try {
        woven = await Promise.race([
          weaver({ exemplar: weaveExemplar, priorContext }),
          new Promise<null>(resolve => setTimeout(() => resolve(null), weaveTimeoutMs)),
        ]);
      } catch (e) {
        this.adapter.log('info', `BlankFill: weave error (static fallback) — ${(e as Error)?.message ?? e}`);
      }
      this._loadingAnimator().stop(slot.index, 'blank-fill');
      // Staleness: if the user edited during the wait, the slot they were
      // filling is gone — drop, don't clobber (matches the async-fill contract).
      const liveNow = this.adapter.getText().replace(/[​‌]/g, '');
      if (liveNow !== cleaned) {
        this.adapter.log('debug', 'BlankFill: weave fill dropped — buffer changed during the call');
        return;
      }
      if (woven) {
        // Splice the REAL value in for the token (deterministic, local).
        const swapped = woven.split(WEAVE_VALUE_TOKEN).join(integrationValue);
        const finalText = newText.slice(0, fillStart) + swapped + newText.slice(newCursor);
        const finalCursor = Math.min(finalText.length, fillStart + swapped.length);
        // Woven output is contextual prose — NOT a cycleable/clearOnEdit pair,
        // so don't register a span watcher (which would wipe it on the next edit).
        this.spanFillState?.clear();
        this.adapter.log('info', `BlankFill: woven integration → "${preview(swapped, 60)}"`);
        this.commitText(finalText, finalCursor);
        this.recordUndo(`${slot.blankName} fill`, cleaned, finalText, undoExtras);
        this.adapter.emitEvent?.('blank.woven', { blankName: String(blank?.name ?? ''), output: swapped });
      } else {
        // Weave failed / ceded / timed out — land the static fill (one change).
        commitStatic();
      }
    })();
  }

  /** Commit text via the host's preferred path (pushText when available). */
  private commitText(text: string, cursor: number): void {
    if (this.adapter.pushText) this.adapter.pushText(text, cursor);
    else { this.adapter.setText(text); this.adapter.setCursorOffset(cursor); this.adapter.forceRender(); }
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
      blankSatellite?: boolean;
      blankSatelliteSeparator?: string;
      blankClearOnEdit?: boolean;
      blankScript?: string;
    },
    fillValue: string,
    cleaned: string,
    target: { start: number; end: number; word: string; index: number },
    undoExtras?: readonly UndoEntry[],
  ): void {
    const tabIdx = fillValue.indexOf('\t');
    const selectorRaw = fillValue.slice(0, tabIdx).trim();
    const satelliteRaw = fillValue.slice(tabIdx + 1).split('\n')[0].trim();
    if (!selectorRaw || !satelliteRaw) return;
    const sep = blank.blankSatelliteSeparator || ' ';
    const pair = `${selectorRaw}${sep}${satelliteRaw}`;
    const { clearEnd } = computeFillRange(blank, slot);
    const { newText, newCursor } = clearEnd !== undefined
      ? buildClearKeywordText(cleaned, slot, pair, clearEnd)
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
    this.recordUndo(`${slot.blankName} fill`, cleaned, newText, undoExtras);
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
          blankClearKeywords?: boolean;
          blankDismissible?: boolean;
          tip?: string;
        })
      | undefined;
    if (!blank) return false;
    if (this.dismissedBlanks?.has(slot.index)) return false;
    const stepValues = blank.stepValues;
    if (!Array.isArray(stepValues) || stepValues.length === 0) return false;
    const fillValue = stepValues[0];

    // List blanks (stepValues) FILL the `_` and, at most, clear their own
    // keyword via the gentle keyword-clear path. No replace modes, no
    // wipe-all — a list blank can never wipe surrounding prose.
    const { clearEnd } = computeFillRange(blank, slot);

    const { newText, newCursor } = clearEnd !== undefined
      ? buildClearKeywordText(insertedText, slot, fillValue, clearEnd)
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
          tip: blank.tip,
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
  private matchKeyword(words: readonly string[], blankIdx: number, lineOf?: readonly number[]): BlankSlot | null {
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
    // Window. The keyword window is LINE-SCOPED for every blank via the
    // SHARED `keywordInWindow` predicate — identical to the resolver's
    // BlankSource claim + the FluidBlank/Transform/ConfigIntent cede checks,
    // so the five sites can never disagree on who owns the `_` (the June
    // 2026 race). A keyword claims when it's on the same line as the `_`.
    // Precise routing is the job of `blankShapes`; shaped blanks bypass this
    // window (they're shape-gated downstream).
    for (let j = blankIdx - 1; j >= 0; j -= 1) {
      for (const [name, blank] of this.configLoader.blanks.entries()) {
        const blankKeywords = (blank as { blankKeywords?: readonly string[] }).blankKeywords;
        if (!blankKeywords || blankKeywords.length === 0) continue;
        if (!supportsCycling && isBlankConfigCycleable(blank as Parameters<typeof isBlankConfigCycleable>[0])) continue;
        // The keyword's last word is at `j`; claims iff on the same line as `_`.
        if (!keywordInWindow(j, blankIdx, { lineOf })) continue;
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


/**
 * Derive the `clearEnd` the splice will use, given a blank's flags.
 *
 *   - blankClearKeywords: clearEnd = slot.keywordEnd (drop just the
 *     keyword span).
 *   - otherwise: undefined (only the `_` is replaced).
 *
 * This is the legacy keyword-blank path only. Shaped invocations derive
 * their command-span clear directly (clearEnd = slot.index - 1) at the
 * call site, so they never pass through here.
 */
export function computeFillRange(
  blank: {
    blankClearKeywords?: boolean;
  },
  slot: { index: number; keyword: string; keywordEnd: number },
): { clearEnd: number | undefined } {
  const clearEnd: number | undefined = blank.blankClearKeywords === true ? slot.keywordEnd : undefined;
  return { clearEnd };
}

/**
 * Char-position splice that handles keyword clearing and shape-derived
 * command-span clearing while preserving surrounding whitespace structure
 * (newlines, paragraph breaks, indentation, bullet markers). v1 used a
 * word-split + word-join approach which collapsed all whitespace runs to
 * single spaces — that destroyed bullet/paragraph layouts whenever
 * `config _` (or any blank with blankClearKeywords) fired inside formatted
 * prose. Char-position splice fixes it.
 *
 *   - The range [keywordStart..clearEnd] (word indices) is dropped
 *     (default clearEnd = keywordEnd → clears just the keyword span).
 *     When clearEnd = slot.index - 1 (shaped get/set/step), the words
 *     between keyword and blank are also dropped — the whole command span.
 *   - The slot.index entry (the `_` token) is replaced with `fillValue`.
 *
 * Whitespace handling:
 *   - When the cleared range is contiguous with the blank (shaped-clear
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
    newText = cleaned.slice(0, kwStart) + fillValue + cleaned.slice(blankEnd);
    cursor = kwStart + fillValue.length;
  } else {
    // Drop keyword + one trailing horizontal whitespace char so we don't
    // leave a double-space when the kept text follows. Newlines NEVER
    // get consumed — formatted prose stays intact.
    let kwSkipEnd = kwEnd;
    const trailing = cleaned[kwSkipEnd];
    if (trailing === ' ' || trailing === '\t') kwSkipEnd += 1;
    const middle = cleaned.slice(kwSkipEnd, blankStart);
    const prefix = cleaned.slice(0, kwStart) + middle;
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
