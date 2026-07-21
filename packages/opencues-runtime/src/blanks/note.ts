// NoteBlank — user-curated collection blank over ~/.cues/NOTES.md
// (PROTOTYPE — issue #210: searchable, reusable snippets/commands).
//
// Triggered by (keyword-synthesized shapes on `note`):
//   note add <text> _        → append an entry
//   note <query> _           → recall: best match fills, rest cycle
//   note delete <query> _    → remove (refuses on ambiguous match)
//   note _                   → list recent entries (cycleable)
//
// Follows the sentinel pattern: keyword-bound only (no LLM routing),
// injected readFile/writeFile IO, and a single validation chokepoint
// (`validateNoteWrite`) in front of every write. Search is fully
// LOCAL and deterministic — stored entries never reach an LLM
// provider.
//
// Storage format (~/.cues/NOTES.md): one `- ` bullet line per entry.
// Writes are line surgery (append one bullet / remove one bullet) so
// the user's own headers, comments, and spacing are never rewritten —
// the file stays fully hand-editable. An optional
// `label: ` prefix (first `: ` within the first 64 chars) makes an
// entry addressable by name; recall fills the BODY only, so a
// recalled command lands ready to run/tweak.
//
// UNLIKE sentinel, results are NOT clearOnEdit: the whole point of
// recall is tweaking the recalled text in place — an edit inside the
// fill must never wipe it.

import type { Blank } from './types';
import type { BlankWriteInverse } from '../adapter';

export interface NoteBlankOptions {
  /** Read NOTES.md content. Returns null when missing. */
  readonly readFile: () => Promise<string | null>;
  /** Write NOTES.md (atomic replace). */
  readonly writeFile: (content: string) => Promise<void>;
  /** Override default caps. Used by tests + future per-host policy. */
  readonly caps?: NoteCaps;
}

export interface NoteCaps {
  /** Maximum number of entries the file may hold. */
  readonly maxEntries: number;
  /** Maximum characters per entry. */
  readonly maxEntryChars: number;
}

export const DEFAULT_NOTE_CAPS: NoteCaps = { maxEntries: 256, maxEntryChars: 1024 };

/** One parsed entry. `label` is null when the entry has no `label: ` prefix. */
export interface NoteEntry {
  readonly text: string;
  readonly label: string | null;
  readonly body: string;
  /** Line number of the `- ` bullet in the file (set by parseNotesMd). */
  readonly line?: number;
}

const MAX_LABEL_CHARS = 64;

/** Split an entry into optional label + body on the first `: `. */
export function parseEntry(text: string): NoteEntry {
  const idx = text.indexOf(': ');
  if (idx > 0 && idx <= MAX_LABEL_CHARS) {
    return { text, label: text.slice(0, idx), body: text.slice(idx + 2) };
  }
  return { text, label: null, body: text };
}

export interface ParsedNotesFile {
  /** Raw file content (null/empty file normalises to ''). */
  readonly content: string;
  readonly entries: readonly NoteEntry[];
}

export function parseNotesMd(content: string): ParsedNotesFile {
  const lines = content.split('\n');
  const entries: NoteEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('- ')) {
      const text = lines[i].slice(2).trim();
      if (text.length > 0) entries.push({ ...parseEntry(text), line: i });
    }
  }
  return { content, entries };
}

// Writes are LINE SURGERY, not a re-serialise: the user's own headers,
// comments between bullets, and spacing are never the runtime's to
// rewrite. (The first prototype re-emitted header+bullets and silently
// ate a hand-written comment sitting between two entries — found by
// the dumb-user gauntlet.)

/** Append a bullet, bootstrapping the default header for a new file. */
export function appendNoteLine(content: string, text: string): string {
  if (content.trim().length === 0) return `# Notes\n\n- ${text}\n`;
  return content.replace(/\n*$/, '\n') + `- ${text}\n`;
}

/** Remove exactly one bullet line; everything else stays byte-identical. */
export function removeNoteLine(content: string, line: number): string {
  const lines = content.split('\n');
  if (line < 0 || line >= lines.length) return content;
  lines.splice(line, 1);
  return lines.join('\n');
}

export type NoteWriteOp =
  | { readonly op: 'add'; readonly text: string }
  | { readonly op: 'remove'; readonly index: number };

export type NoteWriteResult =
  | { readonly ok: true; readonly action: 'write' | 'noop'; readonly entries: readonly NoteEntry[] }
  | { readonly ok: false; readonly detail: string };

// C0/C1 control chars (minus \t which whitespace-splitting already ate).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/**
 * The single write chokepoint — every mutation of the entry list goes
 * through here before `writeFile` is called (mirrors
 * `validateSentinelWrite`). Enforces entry shape, per-entry length,
 * capacity, and duplicate idempotency.
 */
export function validateNoteWrite(
  entries: readonly NoteEntry[],
  op: NoteWriteOp,
  caps: NoteCaps = DEFAULT_NOTE_CAPS,
): NoteWriteResult {
  if (op.op === 'remove') {
    if (op.index < 0 || op.index >= entries.length) {
      return { ok: false, detail: `no note at position ${op.index}` };
    }
    return { ok: true, action: 'write', entries: entries.filter((_, i) => i !== op.index) };
  }
  const text = op.text.trim();
  if (text.length === 0) {
    return { ok: false, detail: 'note add: usage is `note add <text> _`' };
  }
  if (CONTROL_CHARS.test(text)) {
    return { ok: false, detail: 'note contains forbidden control characters' };
  }
  if (text.length > caps.maxEntryChars) {
    return { ok: false, detail: `note is too long (${text.length} chars, max ${caps.maxEntryChars})` };
  }
  if (entries.some(e => e.text === text)) {
    return { ok: true, action: 'noop', entries };
  }
  if (entries.length >= caps.maxEntries) {
    return { ok: false, detail: `NOTES.md is full — ${entries.length}/${caps.maxEntries} notes. Delete unused ones (note delete <query> _)` };
  }
  return { ok: true, action: 'write', entries: [...entries, parseEntry(text)] };
}

interface RankedMatch {
  readonly entry: NoteEntry;
  /** Index in the file (higher = newer). */
  readonly index: number;
  readonly rank: number;
}

/**
 * Deterministic local search. Every whitespace token of the query must
 * appear (case-insensitive substring) somewhere in the entry. Rank:
 * label-prefix (3) > all-tokens-in-label (2) > all-tokens-anywhere (1),
 * newest first within a rank.
 */
export function searchNotes(entries: readonly NoteEntry[], query: string): RankedMatch[] {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const out: RankedMatch[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const full = e.text.toLowerCase();
    if (!tokens.every(t => full.includes(t))) continue;
    const label = (e.label ?? '').toLowerCase();
    let rank = 1;
    if (label && tokens.every(t => label.includes(t))) rank = 2;
    if (label.startsWith(q)) rank = 3;
    out.push({ entry: e, index: i, rank });
  }
  out.sort((a, b) => (b.rank - a.rank) || (b.index - a.index));
  return out;
}

/** How many recent entries a bare `note _` lists. */
const RECENT_LIST_SIZE = 5;

export class NoteBlank implements Blank {
  readonly name = 'note';
  readonly readOnly = false;
  private readonly _read: () => Promise<string | null>;
  private readonly _write: (content: string) => Promise<void>;
  private readonly _caps: NoteCaps;
  /** One-shot inverse of the last successful write — undo-journal feed
   *  (drained by createBlankInvoke via consumeLastWriteInverse). */
  private _lastWriteInverse: BlankWriteInverse | null = null;

  constructor(opts: NoteBlankOptions) {
    this._read = opts.readFile;
    this._write = opts.writeFile;
    this._caps = opts.caps ?? DEFAULT_NOTE_CAPS;
  }

  consumeLastWriteInverse(): BlankWriteInverse | null {
    const inv = this._lastWriteInverse;
    this._lastWriteInverse = null;
    return inv;
  }

  /**
   * Dispatch — `keyword` is "note"; `context` is everything between
   * the keyword and `_`. The first context word selects the verb
   * (add / delete / remove); anything else is a recall query.
   *
   * The return string is what the runtime substitutes for `_`.
   * Multi-line returns become the cycling list (line 0 fills first).
   * `[err] …` returns are visible but inert.
   */
  async get(keyword?: string, context?: readonly string[]): Promise<string> {
    const args = (context ?? []).filter(w => w.length > 0);
    const file = parseNotesMd((await this._read()) ?? '');
    const verb = (args[0] ?? '').toLowerCase();

    if (verb === 'add') return this.doAdd(file, args.slice(1).join(' '));
    if (verb === 'delete' || verb === 'remove') return this.doDelete(file, args.slice(1).join(' '));
    if (args.length === 0) return this.doList(file);
    return this.doRecall(file, args.join(' '));
  }

  private async doAdd(file: ParsedNotesFile, text: string): Promise<string> {
    const r = validateNoteWrite(file.entries, { op: 'add', text }, this._caps);
    if (!r.ok) return formatError(r.detail);
    if (r.action === 'write') {
      await this._write(appendNoteLine(file.content, text.trim()));
      // Inverse: delete by the full saved text. If another note makes
      // that query ambiguous at undo time, doDelete refuses with [err]
      // and the applier reports the skip — never guesses.
      const textWords = text.trim().split(/\s+/).filter(Boolean);
      this._lastWriteInverse = {
        file: 'NOTES.md',
        blankName: this.name,
        inverseOp: { keyword: 'note', args: ['delete', ...textWords] },
        forwardOp: { keyword: 'note', args: ['add', ...textWords] },
      };
    }
    const saved = parseEntry(text.trim());
    const name = saved.label ?? preview(saved.body, 40);
    const n = r.entries.length;
    return r.action === 'noop'
      ? `[note already saved: ${name}]`
      : `[note saved: ${name} · ${n} note${n === 1 ? '' : 's'}]`;
  }

  private async doDelete(file: ParsedNotesFile, query: string): Promise<string> {
    if (query.trim().length === 0) return formatError('note delete: usage is `note delete <query> _`');
    const matches = searchNotes(file.entries, query);
    if (matches.length === 0) return formatError(`no note matches "${query}"`);
    if (matches.length > 1) {
      return formatError(`${matches.length} notes match "${query}" — be more specific (preview them with \`note ${query} _\`)`);
    }
    const m = matches[0];
    const r = validateNoteWrite(file.entries, { op: 'remove', index: m.index }, this._caps);
    if (!r.ok) return formatError(r.detail);
    await this._write(removeNoteLine(file.content, m.entry.line ?? -1));
    // Inverse: re-add the deleted entry's full text (label included).
    const entryWords = m.entry.text.split(/\s+/).filter(Boolean);
    this._lastWriteInverse = {
      file: 'NOTES.md',
      blankName: this.name,
      inverseOp: { keyword: 'note', args: ['add', ...entryWords] },
      forwardOp: { keyword: 'note', args: ['delete', ...entryWords] },
    };
    return `[deleted: ${m.entry.label ?? preview(m.entry.body, 40)}]`;
  }

  /** Recall fills the BODY (label stripped) so commands land ready to use. */
  private doRecall(file: ParsedNotesFile, query: string): string {
    const matches = searchNotes(file.entries, query);
    if (matches.length === 0) {
      // Tailor the nudge: "save one" is wrong advice when notes exist
      // (the dumb-user `note list _` guess hit this) — point at
      // browsing / loosening the query instead.
      const n = file.entries.length;
      return n === 0
        ? formatError(`no note matches "${query}" — save one with \`note add <text> _\``)
        : formatError(`no note matches "${query}" — ${n} note${n === 1 ? '' : 's'} saved; try fewer words or browse with \`note _\``);
    }
    return matches.map(m => m.entry.body).join('\n');
  }

  /** Bare `note _` — browse recent entries (labels kept for identification). */
  private doList(file: ParsedNotesFile): string {
    if (file.entries.length === 0) {
      return formatError('no notes yet — save one with `note add <text> _`');
    }
    return [...file.entries].reverse().slice(0, RECENT_LIST_SIZE).map(e => e.text).join('\n');
  }
}

function preview(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + '…';
}

function formatError(detail: string): string {
  // `[err] ...` prefix keeps the result visible but inert (no cycling
  // state registered) — same convention as SentinelBlank.
  return `[err] ${detail}`;
}
