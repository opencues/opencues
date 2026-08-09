/**
 * Cue dismissal state — the runtime half of "I do not want this cue".
 *
 * Module-level, exactly like the hint-dismissal state next door in
 * `dyn-defs.ts`: the paint site (DimRender), the gesture site (Cycling) and the
 * boot ingest all need the same answer, and threading a store through every
 * host band's module wiring would buy nothing.
 *
 * Two grains (see `@opencues/core/dismissals` for why the key is text):
 *
 *   MUTE   — `_` once on an advisory note. In memory, TTL'd, per host process.
 *            Silences THIS cue for a while; the claim behind it is untouched.
 *   FORGET — `_` twice. Handed to a sink that writes `<cues>/dismissals.json`,
 *            and read back by the ingest, so it outlives the process and shows
 *            up in `opencues dismissals`.
 *
 * Nothing here reaches the filesystem. Boot registers a sink; without one
 * (chrome, tests) forget degrades to a long mute, which is the honest failure:
 * the gesture still does something, it just cannot promise "never again".
 */

import { dismissalKey, dismissalLabel, type DismissalRecord } from '@opencues/core';

/** The shape both DimRender and Cycling hold: enough of a def to decide
 *  whether it is a dismissable advisory, without importing WordDef. */
interface AdvisoryLike {
  readonly cueTip?: string;
  readonly blankName?: string;
  readonly alternatives: readonly string[];
}

/**
 * What this def would dismiss, or null if it is not dismissable.
 *
 * Dismissable means a PURE ADVISORY: it carries a `cueTip` and has nothing to
 * cycle to (a calendar clash, a contradiction whose verdict is advice rather
 * than a fix). Those are exactly the notes where `_` is otherwise dead — a
 * cycleable cue already uses `_` to walk its alternatives, and reaching the
 * reconciled rewrite IS the answer there, so v1 does not overload it.
 */
export function dismissalTargetOf(
  def: AdvisoryLike,
): { key: string; label: string; source: string } | null {
  if (!def.cueTip) return null;
  if (def.alternatives.length > 1) return null;   // cycleable — `_` means cycle
  const key = dismissalKey(def.cueTip);
  if (!key) return null;
  return { key, label: dismissalLabel(def.cueTip), source: def.blankName || 'cue' };
}

/** How long a single `_` silences a cue. A session's worth of quiet without
 *  being permanent — long enough that the nag does not return mid-task, short
 *  enough that a claim you still care about comes back on its own. */
export const MUTE_MS = 30 * 60 * 1000;

/**
 * How long the note stays up after the first press, offering the second one.
 *
 * ⚠ This window is the whole reason `forget` is reachable. Without it the first
 * press silences the cue, the note stops painting, and there is nothing left on
 * screen to press `_` on a second time — the grain would be unreachable through
 * the UI, which is exactly the state the first cut of this shipped in.
 *
 * So it is a GRACE window, not a double-click timer: long enough to read a new
 * hint and act on it, not a reflex test. During it the note keeps painting and
 * its hint changes to say what a second press does.
 */
export const FORGET_GRACE_MS = 3_000;

/** key → epoch ms at which the mute lapses. */
const _muted = new Map<string, number>();
/** Keys forgotten on disk, hydrated by the ingest. */
let _forgotten: ReadonlySet<string> = new Set();
/** key → epoch ms of the last mute press, for double-press detection. */
const _lastPress = new Map<string, number>();

type DismissalSink = (rec: DismissalRecord) => void;
let _sink: DismissalSink | null = null;

/** Boot registers the writer that persists a forget. One sink; last wins. */
export function registerDismissalSink(sink: DismissalSink | null): void {
  _sink = sink;
}

/** The ingest hands over what is currently forgotten on disk. Replaces the set
 *  wholesale, so a restore via the CLI takes effect on the next poll — that is
 *  what makes `opencues dismissals` a live undo rather than a restart. */
export function setForgottenKeys(keys: Iterable<string>): void {
  _forgotten = new Set(keys);
}

/** True when this cue should not be shown at all: forgotten, or muted and the
 *  mute has not lapsed. Lapsed mutes are dropped as they are found. */
export function isCueDismissed(key: string, now: number = Date.now()): boolean {
  if (!key) return false;
  if (_forgotten.has(key)) return true;
  const until = _muted.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  _muted.delete(key);
  return false;
}

/** Whether the cue is currently muted (as opposed to forgotten) — the CLI and
 *  doctor distinguish the two, and only one of them is durable. */
export function muteRemainingMs(key: string, now: number = Date.now()): number {
  const until = _muted.get(key);
  return until !== undefined && until > now ? until - now : 0;
}

/**
 * Milliseconds left of the offer-to-forget window, 0 outside it.
 *
 * DimRender keeps painting a note while this is positive (with a hint saying
 * what a second press does) and Cycling keeps claiming `_` for it. Both stop
 * the moment it lapses, so a muted cue goes quiet and `_` returns to its
 * ordinary meaning — no key silently swallowed over an invisible note.
 */
export function forgetOfferRemainingMs(key: string, now: number = Date.now()): number {
  if (!key || _forgotten.has(key)) return 0;      // already forgotten — nothing to offer
  const last = _lastPress.get(key);
  if (last === undefined) return 0;
  const left = last + FORGET_GRACE_MS - now;
  return left > 0 ? left : 0;
}

/**
 * Record a dismissal press. The FIRST press mutes and opens the offer window;
 * a SECOND press within `FORGET_GRACE_MS` upgrades it to a forget. Returns
 * which grain was applied, so the caller can log it.
 *
 * The double-press is deliberately keyed per cue, not global: pressing `_` on
 * two different advisories in quick succession mutes both rather than forgetting
 * the second, which is the mistake a global timer would make.
 */
export function pressDismiss(
  args: { key: string; label: string; source: string },
  now: number = Date.now(),
): 'mute' | 'forget' {
  const { key, label, source } = args;
  if (!key) return 'mute';
  const last = _lastPress.get(key) ?? 0;
  const grain: 'mute' | 'forget' = last > 0 && now - last <= FORGET_GRACE_MS ? 'forget' : 'mute';
  _lastPress.set(key, now);

  if (grain === 'forget') {
    const rec: DismissalRecord = {
      key, label, source,
      dismissedAt: new Date(now).toISOString(),
    };
    if (_sink) {
      // Reflect it locally too: the sink writes and the ingest polls, so
      // without this the cue would flash back for a few seconds.
      _forgotten = new Set([..._forgotten, key]);
      _muted.delete(key);
      try { _sink(rec); } catch { /* a failed write must not eat the keystroke */ }
    } else {
      // No writer (chrome, tests): a long mute, NOT a local forget. Claiming
      // permanence we cannot persist would be a lie the next restart exposes.
      _muted.set(key, now + 24 * 60 * 60 * 1000);
    }
    return 'forget';
  }

  _muted.set(key, now + MUTE_MS);
  return 'mute';
}

/** Test hook — clear every grain and the sink. */
export function _resetCueDismissalsForTests(): void {
  _muted.clear();
  _lastPress.clear();
  _forgotten = new Set();
  _sink = null;
}
