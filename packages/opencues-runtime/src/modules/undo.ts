/**
 * UndoApplier — executes `undo _` / `redo _` against the UndoJournal.
 * Constructed by the Resolver when it's handed a journal; invoked from
 * the resolver's ACTION branch with the live buffer text (command span
 * already spliced out).
 *
 * Policy (docs/architecture/undo.md):
 *
 * - EXACT-MATCH-OR-REFUSE everywhere. A buffer slice relocates only on
 *   a unique match; a scalar reverts only if its current value is still
 *   what this transaction wrote; an OS value reverts only after a
 *   verify `get` matches. Anything else is a SKIPPED entry with a
 *   reason — never a guess, never a clobber.
 * - NEVER throws; every failure mode is a report entry.
 * - Partial failure is reported, never masked: entries that apply,
 *   apply; entries that can't, land in `report.skipped`.
 * - Consumed transactions pop regardless of skips — a dead transaction
 *   must not wedge the stack so `undo _` re-hits it forever.
 * - Runs inside `journal.runApply()`, so the inversions' own side
 *   effects are never re-journaled.
 */

import type { HostAdapter } from '../adapter';
import type { ConfigLoader } from './config-loader';
import {
  UndoJournal,
  type UndoApplyReport,
  type UndoEntry,
  type UndoSkipReason,
} from '../state/undo-journal';
import { invokeOrSpawnBlank } from '../util/blank-invoke';
import { applyScalarAndPersist } from '../util/apply-scalar';
import { findFeature } from '@opencues/core';

type EntryOutcome =
  | { applied: true; text: string }
  | { applied: false; reason: UndoSkipReason; detail?: string };

export class UndoApplier {
  constructor(
    private adapter: HostAdapter,
    private configLoader: ConfigLoader,
    private journal: UndoJournal,
  ) {}

  /**
   * Apply `count` transactions (clamped to depth) against `workingText`,
   * executing side-effect inversions as it goes. Returns the final text
   * + report; the CALLER does the single buffer commit.
   */
  async apply(action: 'undo' | 'redo', count: number, workingText: string): Promise<{ text: string; report: UndoApplyReport }> {
    return this.journal.runApply(async () => {
      const txs = action === 'undo' ? this.journal.peekUndo(count) : this.journal.peekRedo(count);
      let text = workingText;
      let appliedTransactions = 0;
      let appliedEntries = 0;
      const skipped: Array<{ label: string; reason: UndoSkipReason; detail?: string }> = [];

      for (const tx of txs) {
        // Undo walks a transaction's entries in reverse-record order;
        // redo replays them forward.
        const entries = action === 'undo' ? [...tx.entries].reverse() : [...tx.entries];
        let anyApplied = false;
        for (const entry of entries) {
          const outcome = await this.applyEntry(action, entry, text);
          if (outcome.applied) {
            text = outcome.text;
            anyApplied = true;
            appliedEntries++;
          } else {
            skipped.push({ label: tx.label, reason: outcome.reason, detail: outcome.detail });
          }
        }
        if (anyApplied) appliedTransactions++;
        // Pop regardless of skips — the transaction is consumed either
        // way; leaving a dead one on the stack would wedge `undo _`.
        if (action === 'undo') this.journal.confirmUndo(tx);
        else this.journal.confirmRedo(tx);
      }

      const report: UndoApplyReport = {
        action,
        requested: txs.length,
        appliedTransactions,
        appliedEntries,
        skipped,
        at: Date.now(),
      };
      this.journal.noteApplyReport(report);
      return { text, report };
    });
  }

  private async applyEntry(action: 'undo' | 'redo', entry: UndoEntry, text: string): Promise<EntryOutcome> {
    switch (entry.kind) {
      case 'buffer-splice': {
        if (entry.bufferEpoch !== this.journal.currentEpoch) {
          return { applied: false, reason: 'stale-epoch', detail: 'text from a previous message' };
        }
        const anchor = action === 'undo' ? entry.afterSlice : entry.beforeSlice;
        const replacement = action === 'undo' ? entry.beforeSlice : entry.afterSlice;
        if (anchor === '') {
          // Empty anchor = the recorded change replaced everything with
          // nothing; it re-applies only onto an (effectively) empty buffer.
          if (text.trim() === '') return { applied: true, text: replacement };
          return { applied: false, reason: 'not-found' };
        }
        const i = text.indexOf(anchor);
        if (i < 0) return { applied: false, reason: 'not-found' };
        if (text.indexOf(anchor, i + 1) >= 0) return { applied: false, reason: 'ambiguous' };
        return { applied: true, text: text.slice(0, i) + replacement + text.slice(i + anchor.length) };
      }

      case 'scalar-write': {
        const registryDefault = findFeature(entry.key)?.values[0]?.id;
        const current = this.configLoader.opencuesState.settings.get(entry.key);
        // Drift guard: the scalar must still hold what THIS transaction
        // wrote (undo) / what it overwrote (redo). An absent expected
        // value is equivalent to the registry default — the file may
        // legitimately have gained the explicit default line since.
        const expectedRaw = action === 'undo' ? entry.newValue : entry.prevValue;
        const expected = expectedRaw ?? registryDefault;
        if (current !== expected && (current ?? registryDefault) !== expected) {
          return { applied: false, reason: 'value-drifted', detail: `${entry.key} is now '${current ?? '(absent)'}'` };
        }
        const target = (action === 'undo' ? entry.prevValue : entry.newValue) ?? registryDefault;
        if (target === undefined) {
          return { applied: false, reason: 'no-prior-value', detail: `${entry.key} had no value before the change and no registry default` };
        }
        await applyScalarAndPersist(this.adapter, this.configLoader, entry.key, target);
        return { applied: true, text };
      }

      case 'os-set': {
        // Verify-then-set: read the current OS value; if it isn't what
        // this transaction left it at, someone else changed it since —
        // restoring "our" prior value would clobber theirs.
        const getHandle = invokeOrSpawnBlank(this.adapter, entry.blankName, 'get', [], entry.scriptPath, { timeoutMs: 4000 });
        if (!getHandle) return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} get: no invocation path` };
        let currentRaw: string;
        try {
          const res = await getHandle.result;
          if (res.exitCode !== 0 || res.timedOut) return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} get exited ${res.exitCode}${res.timedOut ? ' (timeout)' : ''}` };
          const m = (res.stdout ?? '').match(/-?\d+(?:\.\d+)?/);
          if (!m) return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} get returned no number` };
          currentRaw = m[0];
        } catch (e) {
          return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} get: ${(e as Error).message}` };
        }
        const expected = action === 'undo' ? entry.newValue : entry.prevValue;
        if (Number(currentRaw) !== Number(expected)) {
          return { applied: false, reason: 'value-drifted', detail: `${entry.blankName} is now ${currentRaw}, not ${expected}` };
        }
        const target = action === 'undo' ? entry.prevValue : entry.newValue;
        const setHandle = invokeOrSpawnBlank(this.adapter, entry.blankName, 'set', [target], entry.scriptPath, { timeoutMs: 4000 });
        if (!setHandle) return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} set: no invocation path` };
        try {
          const res = await setHandle.result;
          if (res.exitCode !== 0 || res.timedOut) return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} set exited ${res.exitCode}${res.timedOut ? ' (timeout)' : ''}` };
        } catch (e) {
          return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} set: ${(e as Error).message}` };
        }
        return { applied: true, text };
      }

      case 'file-write': {
        // Replay the recorded inverse (undo) / forward (redo) op through
        // the blank itself — i.e. back through validateSentinelWrite /
        // validateNoteWrite. `[err]` output = the blank refused; report
        // its own message.
        const op = action === 'undo' ? entry.inverseOp : entry.forwardOp;
        const handle = invokeOrSpawnBlank(this.adapter, entry.blankName, 'get', [op.keyword, ...op.args], undefined, { timeoutMs: 8000 });
        if (!handle) return { applied: false, reason: 'exec-failed', detail: `${entry.blankName}: no invocation path` };
        try {
          const res = await handle.result;
          if (res.exitCode !== 0 || res.timedOut) return { applied: false, reason: 'exec-failed', detail: `${entry.blankName} exited ${res.exitCode}${res.timedOut ? ' (timeout)' : ''}` };
          const out = (res.stdout ?? '').trim();
          if (out.startsWith('[err]')) return { applied: false, reason: 'exec-failed', detail: out };
        } catch (e) {
          return { applied: false, reason: 'exec-failed', detail: `${entry.blankName}: ${(e as Error).message}` };
        }
        return { applied: true, text };
      }

      case 'external':
        // Tier 4 — by construction not reversible; always reported.
        return { applied: false, reason: 'external', detail: entry.label };
    }
  }
}
