// Pure plaintext ↔ Notes-body-HTML helpers for the Apple Notes band.
//
// Platform facts these encode (measured — see
// integrations/apple-notes/NOTES-PLATFORM.md):
//   - body is one `<div>…</div>` per line joined with `\n`;
//     an empty line is `<div><br></div>`.
//   - Notes re-serializes entities WITHOUT trailing semicolons on
//     read-back (`<` → `&lt`, `&` → `&amp`, `"` → `&quot`), but ACCEPTS
//     standard semicolon entities on write. So: unescape must handle
//     both forms; escape emits the standard form.
//   - `plaintext` corresponds line-for-line with the div sequence and
//     ends with a trailing `\n`.

/** Escape a plain line for writing into a Notes body div. */
export function escapeNotesHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Unescape Notes body text, tolerating Notes' semicolon-less entity
 * serialization alongside the standard forms. `&amp`/`&amp;` resolve
 * last so `&amplt` can't double-decode.
 */
export function unescapeNotesEntities(s: string): string {
  return s
    .replace(/&lt;?/g, '<')
    .replace(/&gt;?/g, '>')
    .replace(/&quot;?/g, '"')
    .replace(/&apos;?/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;?/g, ' ')
    .replace(/&amp;?/g, '&');
}

/** Normalize a plaintext read from Notes for use as the runtime buffer. */
export function normalizePlaintext(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** True when writing this body back would risk destroying rich content. */
export function bodyLooksAttachmentBearing(bodyHtml: string): boolean {
  return /<img[\s>]|<object[\s>]|<attachment|data:|<video[\s>]|<audio[\s>]/i.test(bodyHtml);
}

interface BodyLine {
  /** The whole `<div>…</div>` fragment, exactly as it appears in body. */
  raw: string;
  /** Offset of the fragment within the body string. */
  start: number;
  /** Plain text of the line (tags stripped, entities unescaped). */
  text: string;
}

const DIV_RE = /<div[^>]*>([\s\S]*?)<\/div>/g;

/** Split a Notes body into its line fragments. */
export function splitBodyLines(bodyHtml: string): BodyLine[] {
  const lines: BodyLine[] = [];
  let m: RegExpExecArray | null;
  DIV_RE.lastIndex = 0;
  while ((m = DIV_RE.exec(bodyHtml)) !== null) {
    const inner = m[1];
    const text = inner === '<br>' || inner === '<br/>' || inner === '<br />'
      ? ''
      : unescapeNotesEntities(inner.replace(/<[^>]+>/g, ''));
    lines.push({ raw: m[0], start: m.index, text });
  }
  return lines;
}

/**
 * Replace the single line whose plain text equals `oldLinePlain` with a
 * freshly-escaped div containing `newLinePlain`.
 *
 * Returns the new body, or `null` when zero or more than one line
 * matches — the caller must then ABORT the fill. The failure bias is
 * deliberate: "nothing happened" is recoverable, a wrong splice into
 * someone's notes is not. Never fall back to rebuilding the whole body
 * from plaintext; that destroys formatting on every other line.
 */
export function spliceLineIntoBody(
  bodyHtml: string,
  oldLinePlain: string,
  newLinePlain: string,
): string | null {
  return spliceLinesIntoBody(bodyHtml, [oldLinePlain], [newLinePlain]);
}

/**
 * Replace a CONSECUTIVE run of lines whose plain texts equal
 * `oldLinesPlain` with freshly-escaped divs for `newLinesPlain`.
 * Same exactly-one-match abort contract as `spliceLineIntoBody`;
 * the run must appear exactly once in the body. Line counts may
 * differ (multi-line answers replacing a single cue line).
 *
 * `expectedStart` (0-based line index of the region, from the caller's
 * line diff) disambiguates MULTIPLE content matches: plaintext lines
 * map 1:1 onto the body's `<div>` sequence (NOTES-PLATFORM.md), so
 * when the identical cue line appears more than once (live failure
 * 2026-07-08: a note holding several "Draft an email _" attempts made
 * every fill abort) the match at the diffed index is provably the
 * right one. Content is still verified at that index and every write
 * remains CAS-guarded — ambiguity WITHOUT a matching index still
 * aborts.
 */
export function spliceLinesIntoBody(
  bodyHtml: string,
  oldLinesPlain: readonly string[],
  newLinesPlain: readonly string[],
  expectedStart?: number,
): string | null {
  // Phantom-trailing-line normalization: Notes plaintext ends with a
  // terminal `\n`, so a split produces one final '' element that has NO
  // corresponding `<div>` in the body. A diff whose region reaches the
  // end of the note carries that phantom on BOTH sides — drop one
  // trailing '' from each (a REAL empty last line still has its
  // `<div><br></div>` plus the phantom, so exactly one drop is right).
  // Live failure this fixes: a whole-note TransformBlank rewrite
  // aborted with "could not locate a unique splice region".
  let oldL = oldLinesPlain;
  let newL = newLinesPlain;
  if (oldL.length > 0 && oldL[oldL.length - 1] === '' &&
      newL.length > 0 && newL[newL.length - 1] === '') {
    oldL = oldL.slice(0, -1);
    newL = newL.slice(0, -1);
  }
  return spliceExactLines(bodyHtml, oldL, newL, expectedStart);
}

function spliceExactLines(
  bodyHtml: string,
  oldLinesPlain: readonly string[],
  newLinesPlain: readonly string[],
  expectedStart?: number,
): string | null {
  if (oldLinesPlain.length === 0) return null;
  const lines = splitBodyLines(bodyHtml);
  const starts: number[] = [];
  for (let i = 0; i + oldLinesPlain.length <= lines.length; i++) {
    let all = true;
    for (let j = 0; j < oldLinesPlain.length; j++) {
      if (lines[i + j].text !== oldLinesPlain[j]) { all = false; break; }
    }
    if (all) starts.push(i);
  }
  let regionStart: number;
  if (starts.length === 1) {
    regionStart = starts[0];
  } else if (starts.length > 1 && expectedStart !== undefined && starts.includes(expectedStart)) {
    regionStart = expectedStart;
  } else {
    return null;
  }
  const first = lines[regionStart];
  const last = lines[regionStart + oldLinesPlain.length - 1];
  // Text-unchanged lines at the region's edges keep their ORIGINAL raw
  // fragments. diffLines widens pure insertions/deletions with an
  // anchor line whose text didn't change — re-escaping it as a plain
  // `<div>` would strip any styling (heading, bold) the user had there.
  const oldN = oldLinesPlain.length;
  const newN = newLinesPlain.length;
  let pre = 0;
  while (pre < Math.min(oldN, newN) && oldLinesPlain[pre] === newLinesPlain[pre]) pre++;
  let suf = 0;
  while (
    suf < Math.min(oldN, newN) - pre &&
    oldLinesPlain[oldN - 1 - suf] === newLinesPlain[newN - 1 - suf]
  ) suf++;
  const replacement = newLinesPlain
    .map((l, j) => {
      if (j < pre) return lines[regionStart + j].raw;
      if (j >= newN - suf) return lines[regionStart + oldN - (newN - j)].raw;
      return l === '' ? '<div><br></div>' : `<div>${escapeNotesHtml(l)}</div>`;
    })
    .join('\n');
  return (
    bodyHtml.slice(0, first.start) +
    replacement +
    bodyHtml.slice(last.start + last.raw.length)
  );
}
