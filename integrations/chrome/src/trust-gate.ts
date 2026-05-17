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
// Defense: each trusted `_` introduction (keydown of `_`, paste/drop
// with `_` in data) adds a TIMESTAMPED credit. Each accepted user-
// classified text-change consumes (new − last accepted) underscores
// worth of credits. Three layers of stale-credit defence:
//
//   1. Credits expire after CREDIT_TTL_MS (500ms). A page that
//      preventDefault's the keydown gets at most that window before
//      the credit is dropped — too short for a script to react to
//      the user's keystroke and inject.
//   2. resetCredits() is wired to focusin/focusout in content.ts —
//      credit earned in field A doesn't fund an injection in field B.
//   3. Runtime writes (source='runtime') bypass and reset the baseline.

const CREDIT_TTL_MS = 500;

export interface TrustGate {
  /** Called when the user does something that trustedly inserts N underscores. */
  noteUnderscoreInsertion(count: number): void;
  /** Returns true if the change should be forwarded to the runtime; false to drop.
   *  Consumes credits or resets baseline as appropriate. */
  checkAndConsume(text: string, isRuntimeWrite: boolean): boolean;
  /** Wipe pending credits without touching the baseline count.
   *  Wired to focusin/focusout so a credit earned in field A can't
   *  fund an injection in field B. */
  resetCredits(): void;
  /** Exposed for tests. Resets the gate's internal counters AND baseline. */
  reset(): void;
  /** Exposed for tests / diagnostics. Read-only snapshot of internal state. */
  inspect(): { credits: number; lastAcceptedCount: number };
}

interface Credit { addedAt: number }

export function createTrustGate(): TrustGate {
  let credits: Credit[] = [];
  let lastAcceptedCount = 0;

  function pruneStale(now: number): void {
    if (credits.length === 0) return;
    const cutoff = now - CREDIT_TTL_MS;
    // Credits are appended in chronological order, so we can stop
    // scanning at the first non-stale entry. Simple filter is fine
    // for the expected size (≤handful of credits in flight).
    credits = credits.filter(c => c.addedAt >= cutoff);
  }

  return {
    noteUnderscoreInsertion(count: number): void {
      if (count <= 0) return;
      const now = Date.now();
      for (let i = 0; i < count; i++) credits.push({ addedAt: now });
    },
    checkAndConsume(text: string, isRuntimeWrite: boolean): boolean {
      pruneStale(Date.now());
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
        if (credits.length < delta) return false;
        // Consume the OLDEST credits first — keeps the freshest ones
        // available for closely-spaced legitimate keystrokes.
        credits.splice(0, delta);
      }
      lastAcceptedCount = newCount;
      return true;
    },
    resetCredits(): void {
      credits = [];
    },
    reset(): void {
      credits = [];
      lastAcceptedCount = 0;
    },
    inspect(): { credits: number; lastAcceptedCount: number } {
      // Re-prune on inspect so callers (and tests) see the live count
      // rather than a snapshot that includes already-stale entries.
      pruneStale(Date.now());
      return { credits: credits.length, lastAcceptedCount };
    },
  };
}

function countUnderscores(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '_') n++;
  return n;
}
