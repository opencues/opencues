// Credit-based underscore gate. Sits between the chrome content script
// and the runtime to stop hostile-page-injected `_` from triggering
// blanks.
//
// Threat model: a page that has any user gesture (a click, etc.) can
// programmatically call `execCommand('insertText', false, 'volume _')`
// on a focused contenteditable. The resulting input event has
// isTrusted=true with no preceding `_` keystroke — a naive timestamp
// gate is defeated by any prior legitimate `_` keystroke.
//
// Defense: credit-based. Each trusted `_` introduction (keydown of '_',
// paste/drop with '_' in data) adds N credits. Each accepted user-
// classified text-change consumes (new − last accepted) underscores
// worth of credits. Changes whose delta exceeds available credits are
// dropped. Runtime writes (source='runtime' after sourceReclassifier
// reclassification) bypass and reset the baseline.

export interface TrustGate {
  /** Called when the user does something that trustedly inserts N underscores. */
  noteUnderscoreInsertion(count: number): void;
  /** Returns true if the change should be forwarded to the runtime; false to drop.
   *  Consumes credits or resets baseline as appropriate. */
  checkAndConsume(text: string, isRuntimeWrite: boolean): boolean;
  /** Exposed for tests. Resets the gate's internal counters. */
  reset(): void;
  /** Exposed for tests / diagnostics. Read-only snapshot of internal state. */
  inspect(): { credits: number; lastAcceptedCount: number };
}

export function createTrustGate(): TrustGate {
  let credits = 0;
  let lastAcceptedCount = 0;

  return {
    noteUnderscoreInsertion(count: number): void {
      if (count > 0) credits += count;
    },
    checkAndConsume(text: string, isRuntimeWrite: boolean): boolean {
      const newCount = countUnderscores(text);
      if (isRuntimeWrite) {
        // Runtime writes are trusted ground truth. They don't consume
        // credits and set the baseline so future user-typed `_` are
        // measured against what the runtime just wrote.
        lastAcceptedCount = newCount;
        return true;
      }
      const delta = newCount - lastAcceptedCount;
      if (delta > 0) {
        if (credits < delta) return false;
        credits -= delta;
      }
      lastAcceptedCount = newCount;
      return true;
    },
    reset(): void {
      credits = 0;
      lastAcceptedCount = 0;
    },
    inspect(): { credits: number; lastAcceptedCount: number } {
      return { credits, lastAcceptedCount };
    },
  };
}

function countUnderscores(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '_') n++;
  return n;
}
