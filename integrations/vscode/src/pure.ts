// Pure helpers for the OpenCues VS Code extension — no `vscode` module
// import so these stay unit-testable under plain vitest (the `vscode`
// module only exists inside a real extension host).

export interface CharRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Sort + merge overlapping/adjacent ranges. Decorations paint patchy
 * when a cue-word range sits inside a span range (the CC
 * applyDirectives merge lesson — PLAN.md Q11): coalesce before every
 * setDecorations call.
 */
export function coalesceRanges(ranges: readonly CharRange[]): CharRange[] {
  if (ranges.length <= 1) return [...ranges];
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

export interface RangeEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Minimal single-range edit turning oldText into newText (common
 * prefix/suffix trim). One range edit inside one `TextEditor.edit`
 * callback = one undo entry, cursor + decorations survive (PLAN.md
 * D12; chrome's one-history-entry lesson). Returns null when equal.
 */
export function computeSingleRangeEdit(oldText: string, newText: string): RangeEdit | null {
  if (oldText === newText) return null;
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix++;
  return {
    start: prefix,
    end: oldText.length - suffix,
    text: newText.slice(prefix, newText.length - suffix),
  };
}

/** A single edit at/above this many chars (insert or delete) is treated
 *  as an external mutation (paste, Copilot accept, file reload) rather
 *  than typing. Deliberately above any plausible single keystroke /
 *  word-completion insert. */
export const EXTERNAL_MUTATION_CHAR_THRESHOLD = 24;

export interface ContentChangeShape {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly textLength: number;
}

/**
 * Heuristic external-mutation detector (PLAN.md Q14). VS Code's
 * onDidChangeTextDocument doesn't say WHO edited; formatters, Copilot
 * accepts, snippet expansions, and file reloads look like user edits.
 * Runtime writes never reach this — the source reclassifier tags them
 * 'runtime' first. Undo/redo never reaches this either —
 * TextDocumentChangeEvent.reason is authoritative and handled upstream.
 *
 * - Multi-range edits: formatters and multi-cursor typing. External.
 *   (Multi-cursor suspends OpenCues anyway — Q15.)
 * - One large insert or delete: paste / accepted completion / cut.
 */
export function looksLikeExternalMutation(changes: readonly ContentChangeShape[]): boolean {
  if (changes.length === 0) return false;
  if (changes.length > 1) return true;
  const c = changes[0];
  return Math.max(c.textLength, c.rangeLength) >= EXTERNAL_MUTATION_CHAR_THRESHOLD;
}

/**
 * D14 word gate: word-cue / sentence-cue analysis only under the
 * configured document word count. 0 disables the gate. Cheap by
 * construction (REPAIR.md #9 — runs inside the resolver build key):
 * a bounded scan that stops counting at maxWords + 1.
 */
export function underWordGate(text: string, maxWords: number): boolean {
  if (maxWords <= 0) return true;
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ws = text.charCodeAt(i) <= 32;
    if (!ws && !inWord) {
      inWord = true;
      count++;
      if (count > maxWords) return false;
    } else if (ws) {
      inWord = false;
    }
  }
  return true;
}

/**
 * Tolerant KEY=VALUE parser for ~/.cues/.env (the `opencues set-key`
 * output). Accepts `export KEY=...`, quoted values, comments, blanks.
 * Process env always wins over file values (merge at the call site).
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) out[m[1]] = value;
  }
  return out;
}
