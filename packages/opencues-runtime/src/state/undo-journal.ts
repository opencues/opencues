/**
 * UndoJournal — the session-scoped transaction log behind `undo _` /
 * `redo _`. Records every change the OpenCues runtime itself applies
 * (buffer splices, OPENCUES.md scalar writes, OS-state script-blank
 * sets, IDENTITY.md/NOTES.md writes) so the UndoApplier
 * (`modules/undo.ts`) can revert them on demand.
 *
 * PURE STATE — no adapter, no ConfigLoader, no IO. Recording sites call
 * `record()` / `begin()`; only the applier consumes via
 * `peekUndo`/`confirmUndo` (+ redo mirrors). All side-effect inversion
 * logic lives in the applier.
 *
 * Design invariants (see docs/architecture/undo.md):
 *
 * - SESSION-scoped, like DismissedBlanks/AgentTaskState: the journal
 *   survives buffer resets (submit, focus change). `noteBufferReset()`
 *   bumps an EPOCH instead of wiping — buffer-splice entries from an
 *   older epoch are skipped at apply time ("text from a previous
 *   message") while scalar/os/file entries in the same transaction
 *   still revert. It is deliberately NOT in resetSharedBufferState's
 *   wipe set.
 *
 * - Buffer entries store SLICES (before/after text), never offsets that
 *   would need span-shift plumbing. The applier relocates `afterSlice`
 *   by unique match at apply time (mirrors dyn-defs' deterministic-
 *   relocate) — exact-match-or-refuse, never guess.
 *
 * - `runApply()` sets a reentrancy flag: every `record()` during an
 *   undo/redo application is a no-op, so undo can never journal itself
 *   (redo is served by the two stacks, not by re-recording).
 *
 * - Coalescing: rapid cycling bursts (volume step ×6, satellite value
 *   cycling) pass a `coalesceKey`; a record whose key matches the TOP
 *   undo transaction merges into it — first before-state kept,
 *   after-state overwritten — so one `undo _` reverts the whole burst.
 *
 * - File-write inversions are stored as blank INVOCATIONS (keyword +
 *   args), computed at record time, never raw file bytes — replaying
 *   them goes back through the blank's own validator chokepoint
 *   (validateSentinelWrite / validateNoteWrite) by construction.
 */

/** A blank invocation — `keyword` routes to the registry blank, `args`
 *  are the action words (e.g. ['set', 'city', 'oslo']). */
export interface BlankOp {
  readonly keyword: string;
  readonly args: readonly string[];
}

export type UndoEntry =
  | {
      kind: 'buffer-splice';
      /** Text the span held BEFORE the runtime's change. */
      beforeSlice: string;
      /** Text the span holds AFTER the change (relocation anchor). */
      afterSlice: string;
      /** Epoch the splice was recorded in — stale epochs skip. */
      bufferEpoch: number;
    }
  | {
      kind: 'scalar-write';
      key: string;
      /** undefined = the scalar was absent before the write. */
      prevValue: string | undefined;
      newValue: string;
    }
  | {
      kind: 'os-set';
      blankName: string;
      scriptPath?: string;
      /** Bare value string as the blank's get/set contract speaks it
       *  (e.g. '40' for volume — no suffix). */
      prevValue: string;
      newValue: string;
    }
  | {
      kind: 'file-write';
      file: 'IDENTITY.md' | 'NOTES.md';
      blankName: string;
      /** Replaying this through the blank path reverts the write —
       *  and re-runs the blank's validator by construction. */
      inverseOp: BlankOp;
      /** The original operation, for redo. */
      forwardOp: BlankOp;
    }
  | {
      kind: 'external';
      /** Tier-4 marker: a user-pack blank's fetch/exec side effect the
       *  runtime cannot reverse. Report-only — the applier always
       *  surfaces it as skipped, never attempts anything. */
      label: string;
    };

export interface UndoTransaction {
  /** Human-readable label for reports ("fluid-blank fill", "volume step"). */
  readonly label: string;
  readonly coalesceKey?: string;
  /** Entries in record order; the applier walks them in REVERSE for undo. */
  entries: UndoEntry[];
}

/** Two-phase recording handle — see UndoJournal.begin(). */
export interface PendingTransaction {
  add(entry: UndoEntry): void;
  /** Route the accumulated entries through record() (coalescing,
   *  redo-clear, reentrancy guard all apply). Empty pending = no-op. */
  commit(): void;
  abort(): void;
}

/** Why an entry (or a whole transaction) was skipped during apply. */
export type UndoSkipReason =
  | 'not-found'       // buffer anchor no longer present (user edited it away / stale)
  | 'ambiguous'       // anchor appears more than once — refuse to guess
  | 'stale-epoch'     // buffer entry from a previous message/buffer
  | 'value-drifted'   // scalar/OS value changed since (hand edit, other app)
  | 'no-prior-value'  // scalar had no pre-write value and no registry default
  | 'external'        // Tier-4: user-pack side effect the runtime can't reverse
  | 'exec-failed';    // inversion invocation failed ([err], exit != 0, timeout)

export interface UndoApplyReport {
  readonly action: 'undo' | 'redo';
  /** Post-clamp count actually attempted. */
  readonly requested: number;
  readonly appliedTransactions: number;
  readonly appliedEntries: number;
  readonly skipped: ReadonlyArray<{ readonly label: string; readonly reason: UndoSkipReason; readonly detail?: string }>;
  readonly at: number;
}

export class UndoJournal {
  static readonly MAX_DEPTH = 50;

  private _undo: UndoTransaction[] = [];
  private _redo: UndoTransaction[] = [];
  private _epoch = 0;
  private _applying = false;
  private _lastApplyReport: UndoApplyReport | null = null;

  // ── epoch ──────────────────────────────────────────────────────────

  get currentEpoch(): number {
    return this._epoch;
  }

  /** Called from resetSharedBufferState (buffer/submit boundary).
   *  Bumps the epoch ONLY — stacks survive so scalar/OS/file changes
   *  stay undoable across messages; buffer entries go stale instead. */
  noteBufferReset(): void {
    this._epoch++;
  }

  // ── reentrancy ─────────────────────────────────────────────────────

  get applying(): boolean {
    return this._applying;
  }

  /** Wraps an undo/redo application: record() no-ops for the duration,
   *  so applying an inversion can never journal itself. */
  async runApply<T>(fn: () => Promise<T>): Promise<T> {
    this._applying = true;
    try {
      return await fn();
    } finally {
      this._applying = false;
    }
  }

  // ── recording ──────────────────────────────────────────────────────

  record(tx: { label: string; coalesceKey?: string; entries: UndoEntry[] }): void {
    if (this._applying) return;
    if (tx.entries.length === 0) return;

    // Any fresh change invalidates the redo stack (standard editor
    // semantics — a new timeline branch).
    this._redo = [];

    // Coalesce: same key as the TOP undo transaction → merge in place.
    // First before-state wins, after-state overwritten, so one undo
    // reverts the whole burst back to its origin. FRAME GUARD: the
    // overwrite-merge is only sound when the new entry's before-state
    // is literally the prior entry's after-state (same span frame) —
    // recording sites uphold this by passing exact replaced-range
    // slices, but a frame break (user edit mid-burst, inconsistent
    // tap) must APPEND instead of merge, or undo splices garbage.
    const top = this._undo[this._undo.length - 1];
    if (tx.coalesceKey !== undefined && top?.coalesceKey === tx.coalesceKey) {
      for (const entry of tx.entries) {
        const prior = top.entries.find(e => e.kind === entry.kind && sameIdentity(e, entry));
        if (prior && framesCompose(prior, entry)) {
          overwriteAfterState(prior, entry);
        } else {
          top.entries.push(entry);
        }
      }
      return;
    }

    this._undo.push({ label: tx.label, coalesceKey: tx.coalesceKey, entries: [...tx.entries] });
    if (this._undo.length > UndoJournal.MAX_DEPTH) {
      this._undo.splice(0, this._undo.length - UndoJournal.MAX_DEPTH);
    }
  }

  /**
   * Two-phase recording for sources whose side effects land at emit
   * time while the buffer splice lands later at resolver-apply time
   * (config-intent: applyScalar fires in core's getCues; the pair
   * splice happens in the resolver, and a race-bail may mean it never
   * does — the scalar still changed, so commit() with scalar entries
   * only is legal and correct).
   */
  begin(label: string, coalesceKey?: string): PendingTransaction {
    const entries: UndoEntry[] = [];
    let done = false;
    return {
      add: (entry: UndoEntry) => {
        if (!done) entries.push(entry);
      },
      commit: () => {
        if (done) return;
        done = true;
        this.record({ label, coalesceKey, entries });
      },
      abort: () => {
        done = true;
      },
    };
  }

  // ── consumption (UndoApplier only) ─────────────────────────────────

  get undoDepth(): number {
    return this._undo.length;
  }

  get redoDepth(): number {
    return this._redo.length;
  }

  /** Newest-first, clamped to depth. Does NOT pop — the applier
   *  confirms each transaction individually after applying it. */
  peekUndo(count: number): readonly UndoTransaction[] {
    const n = Math.max(0, Math.min(count, this._undo.length));
    return this._undo.slice(this._undo.length - n).reverse();
  }

  confirmUndo(tx: UndoTransaction): void {
    const idx = this._undo.lastIndexOf(tx);
    if (idx === -1) return;
    this._undo.splice(idx, 1);
    this._redo.push(tx);
  }

  peekRedo(count: number): readonly UndoTransaction[] {
    const n = Math.max(0, Math.min(count, this._redo.length));
    return this._redo.slice(this._redo.length - n).reverse();
  }

  confirmRedo(tx: UndoTransaction): void {
    const idx = this._redo.lastIndexOf(tx);
    if (idx === -1) return;
    this._redo.splice(idx, 1);
    // Straight back onto the undo stack — NOT via record(), which
    // would wipe the redo stack mid-multi-count-redo.
    this._undo.push(tx);
  }

  // ── apply report (statusline feed) ─────────────────────────────────

  noteApplyReport(report: UndoApplyReport): void {
    this._lastApplyReport = report;
  }

  /** The last apply's report if it's newer than `ttlMs`, else null.
   *  Statusline thunks read this so a skip summary shows briefly and
   *  then ages out on its own. */
  recentApplyReport(ttlMs: number): UndoApplyReport | null {
    const r = this._lastApplyReport;
    if (!r) return null;
    return Date.now() - r.at <= ttlMs ? r : null;
  }

  /** Session teardown only — NOT wired into resetSharedBufferState. */
  clear(): void {
    this._undo = [];
    this._redo = [];
    this._lastApplyReport = null;
  }
}

/**
 * Build a buffer-splice entry from the pre/post text of a runtime
 * write. Trims to the changed region (common prefix/suffix), so tap
 * sites never do range bookkeeping — and whole-buffer merges
 * (transform fused, agent-rewrite) shrink to their actual hunk,
 * which maximises relocation robustness when the user types
 * elsewhere afterwards.
 *
 * Pure deletions widen by one char of shared context so `afterSlice`
 * (the relocation anchor) stays non-empty. Returns null when nothing
 * changed.
 */
export function diffSplice(before: string, after: string, epoch: number): UndoEntry | null {
  if (before === after) return null;
  let p = 0;
  const maxP = Math.min(before.length, after.length);
  while (p < maxP && before[p] === after[p]) p++;
  let s = 0;
  const maxS = maxP - p;
  while (s < maxS && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  let bStart = p;
  let bEnd = before.length - s;
  let aStart = p;
  let aEnd = after.length - s;
  if (aStart === aEnd) {
    // Pure deletion — widen so the anchor is non-empty. An entirely
    // empty `after` stays empty: the applier treats an empty anchor as
    // "the working text must itself be empty".
    if (aStart > 0) { aStart--; bStart--; }
    else if (aEnd < after.length) { aEnd++; bEnd++; }
  }
  return {
    kind: 'buffer-splice',
    beforeSlice: before.slice(bStart, bEnd),
    afterSlice: after.slice(aStart, aEnd),
    bufferEpoch: epoch,
  };
}

/**
 * diffSplice for a blank FILL, where `before` still holds the trigger `_`
 * that the fill replaced with a value. A plain diffSplice would record
 * `beforeSlice: '_'`, so undo restores the `_` verbatim — a live trigger
 * that re-fires the fill on the next keystroke (the re-fire loop). This
 * variant records the UNDO direction WITHOUT the trigger: reverting a
 * fill gives back the user's text, not a re-arming `_`.
 *
 * To keep both relocation anchors non-empty AND unique, the changed
 * region is expanded LEFT to include the preceding word (a bare space
 * would be ambiguous for redo). Only a lone-`_` changed region gets this
 * treatment; anything else (a multi-char span, a whole-buffer rewrite)
 * falls back to plain diffSplice, so callers can route every fill through
 * here safely.
 */
export function fillSplice(before: string, after: string, epoch: number): UndoEntry | null {
  if (before === after) return null;
  // A blank fill's `before` is the user's command, ending in the trigger
  // `_` — whether the fill replaced only that `_` (fluid-blank splice) or
  // rephrased the whole line (countries/integration template). Restoring
  // it verbatim re-arms the trigger. Strip the trailing `_` (and its
  // separating whitespace) so undo gives back the command WITHOUT the
  // re-firing `_`; the diff below is against that stripped form.
  const trig = /\s*_\s*$/.exec(before);
  if (!trig) return diffSplice(before, after, epoch); // not a trigger-ending fill
  const strippedBefore = before.slice(0, trig.index);
  if (strippedBefore === after) return null; // fill produced nothing new
  let p = 0;
  const maxP = Math.min(strippedBefore.length, after.length);
  while (p < maxP && strippedBefore[p] === after[p]) p++;
  let s = 0;
  const maxS = maxP - p;
  while (s < maxS && strippedBefore[strippedBefore.length - 1 - s] === after[after.length - 1 - s]) s++;
  let bStart = p, bEnd = strippedBefore.length - s;
  let aStart = p, aEnd = after.length - s;
  // Pure INSERTION (the value has no counterpart in the stripped before):
  // widen LEFT over the preceding word so redo's anchor (beforeSlice) is
  // non-empty. Word-only — NOT its trailing whitespace, which the
  // command-span wipe eats before `redo _` (a `"france "` anchor wouldn't
  // relocate at redo time; `"france"` is whitespace-eating-proof).
  if (bStart === bEnd) {
    let w = bStart;
    while (w > 0 && /\s/.test(strippedBefore[w - 1]!)) w--;
    while (w > 0 && !/\s/.test(strippedBefore[w - 1]!)) w--;
    bStart = w; aStart = w;
  } else if (aStart === aEnd) {
    // Pure deletion — widen so afterSlice (undo's anchor) is non-empty.
    if (aStart > 0) { aStart--; bStart--; }
    else if (aEnd < after.length) { aEnd++; bEnd++; }
  }
  return {
    kind: 'buffer-splice',
    beforeSlice: strippedBefore.slice(bStart, bEnd), // undo restores this — no trigger `_`
    afterSlice: after.slice(aStart, aEnd),           // redo re-applies the value
    bufferEpoch: epoch,
  };
}

/** Two entries describe the same underlying target (for coalescing). */
function sameIdentity(a: UndoEntry, b: UndoEntry): boolean {
  switch (a.kind) {
    case 'buffer-splice':
      return b.kind === 'buffer-splice';
    case 'scalar-write':
      return b.kind === 'scalar-write' && a.key === b.key;
    case 'os-set':
      return b.kind === 'os-set' && a.blankName === b.blankName;
    case 'file-write':
      return false; // file writes never coalesce
    case 'external':
      return false;
  }
}

/** The overwrite-merge composes only when the newer entry starts where
 *  the prior one ended — prior.after === next.before (same frame). */
function framesCompose(prior: UndoEntry, next: UndoEntry): boolean {
  if (prior.kind === 'buffer-splice' && next.kind === 'buffer-splice') {
    return prior.afterSlice === next.beforeSlice;
  }
  if (prior.kind === 'scalar-write' && next.kind === 'scalar-write') {
    return prior.newValue === next.prevValue;
  }
  if (prior.kind === 'os-set' && next.kind === 'os-set') {
    return prior.newValue === next.prevValue;
  }
  return false;
}

/** Merge a newer entry's after-state into a coalesced prior entry,
 *  keeping the prior's before-state (the burst's origin). */
function overwriteAfterState(prior: UndoEntry, next: UndoEntry): void {
  if (prior.kind === 'buffer-splice' && next.kind === 'buffer-splice') {
    prior.afterSlice = next.afterSlice;
    prior.bufferEpoch = next.bufferEpoch;
  } else if (prior.kind === 'scalar-write' && next.kind === 'scalar-write') {
    prior.newValue = next.newValue;
  } else if (prior.kind === 'os-set' && next.kind === 'os-set') {
    prior.newValue = next.newValue;
    if (next.scriptPath !== undefined) prior.scriptPath = next.scriptPath;
  }
}
