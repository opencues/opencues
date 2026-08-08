/**
 * Cue dismissals — the user's answer to a cue they do not want.
 *
 * Two grains, because one is not enough. Silencing tonight's nag must not
 * retire the thing being nagged about, or the only safe response to a bad cue
 * is to turn the whole feature off:
 *
 *   mute   — this cue stops flagging for a while. Held in memory by the
 *            runtime (`state/cue-dismissals.ts`), gone when the host exits.
 *   forget — this cue never comes back. That is what lives in this file's
 *            format, on disk, and what `opencues dismissals` shows you.
 *
 * ⚠ WHY THE KEY IS THE TEXT, NOT AN ID. A session-contradiction flag cites a
 * `commitmentId` (`c1`, `c2`, …), and those look like identities but are not:
 * `buildSessionCommitmentsSnapshot` assigns them positionally on EVERY write,
 * and `mergeSessionCommitments` emits fresh entries first — so one new decision
 * renumbers the whole watchlist, and the same decision carries different ids in
 * two different watchlists (verified on real snapshots: "the shader border width
 * is set to 8px" is c1 in one and c5 in another). Keying a dismissal on an id
 * would silence whichever cue happens to land in that slot next tick — worse
 * than not working, because it would look like it worked.
 *
 * So the key is the normalized TEXT, using the same normalization the watchlist
 * merge already uses for dedup and supersession. That is the system's existing
 * notion of "the same claim", and it survives renumbering, re-resolution and a
 * new session. Its one limit: a REPHRASED restatement normalizes differently
 * and reads as a new cue. Forget therefore covers exact restatements; mute
 * covers the here and now.
 *
 * Pure — no filesystem, no `process`. The CLI owns writes; the runtime reads.
 */

/** One forgotten cue. `label` is what the user saw, kept for the CLI list. */
export interface DismissalRecord {
  /** Normalized text — the identity. See the note above on why not an id. */
  readonly key: string;
  /** The advisory as it was shown, verbatim (emoji stripped). For display. */
  readonly label: string;
  /** Which engine raised it: `contradiction`, `calendar`, `sentence-cue`, … */
  readonly source: string;
  /** ISO string — when the user dismissed it. */
  readonly dismissedAt: string;
}

/** The on-disk shape of `<cues>/dismissals.json`. */
export interface DismissalsFile {
  readonly dismissed: readonly DismissalRecord[];
}

/** Leading note emojis a cueTip may carry — stripped so the key is the words,
 *  not the decoration (the same tip with a different emoji is the same cue). */
const NOTE_EMOJI = /^(?:⚠️|⚠|🧢|❓|📅|📖|🔊|🔆)\s*/u;

/**
 * The identity of a cue, for dismissal. Lowercase, strip punctuation, collapse
 * whitespace — deliberately identical to `normalizeCommitmentStatement`, so a
 * dismissal and the watchlist agree on what "the same claim" means.
 */
export function dismissalKey(text: string): string {
  return (text || '')
    .replace(NOTE_EMOJI, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The advisory text with its leading emoji removed — what the CLI lists. */
export function dismissalLabel(text: string): string {
  return (text || '').replace(NOTE_EMOJI, '').trim();
}

/** Tolerant parse of the dismissals file. A malformed or partial file yields
 *  the records that ARE well-formed, never a throw — a bad file must not take
 *  a host down, and must not silently un-forget everything either. */
export function parseDismissals(raw: string): DismissalRecord[] {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(obj)
    ? obj                                                   // legacy bare array
    : (obj && typeof obj === 'object' && Array.isArray((obj as DismissalsFile).dismissed))
      ? (obj as DismissalsFile).dismissed
      : [];
  const out: DismissalRecord[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Partial<DismissalRecord>;
    const key = typeof rec.key === 'string' && rec.key.trim()
      ? rec.key.trim()
      : (typeof rec.label === 'string' ? dismissalKey(rec.label) : '');
    if (!key) continue;
    out.push({
      key,
      label: typeof rec.label === 'string' ? rec.label : key,
      source: typeof rec.source === 'string' && rec.source.trim() ? rec.source.trim() : 'cue',
      dismissedAt: typeof rec.dismissedAt === 'string' ? rec.dismissedAt : '',
    });
  }
  return out;
}

/** Serialize for disk. Stable field order + trailing newline so a hand edit or
 *  a `git diff` of the file reads cleanly. */
export function serializeDismissals(records: readonly DismissalRecord[]): string {
  const file: DismissalsFile = {
    dismissed: records.map((r) => ({
      key: r.key, label: r.label, source: r.source, dismissedAt: r.dismissedAt,
    })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Add a record, replacing any existing one with the same key (re-dismissing
 *  refreshes the timestamp rather than duplicating the row). */
export function addDismissal(
  records: readonly DismissalRecord[],
  rec: DismissalRecord,
): DismissalRecord[] {
  return [...records.filter((r) => r.key !== rec.key), rec];
}

/** Remove a record by key — the CLI's restore. Returns the new list; absent
 *  key is a no-op, so `restore` is safe to run twice. */
export function removeDismissal(
  records: readonly DismissalRecord[],
  key: string,
): DismissalRecord[] {
  return records.filter((r) => r.key !== key);
}

/** Key set for the runtime's fast per-note check. */
export function dismissedKeySet(records: readonly DismissalRecord[]): Set<string> {
  return new Set(records.map((r) => r.key));
}
