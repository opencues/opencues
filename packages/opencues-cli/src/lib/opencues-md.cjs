// lib/opencues-md.cjs — read/write single scalars in ~/.cues/OPENCUES.md
// frontmatter. Shared by every command that customizes settings (`config`
// today; future scalar-writers should reuse this rather than hand-rolling a
// regex). Horizontal-whitespace-only after the colon — a bare `\s*` would
// cross the newline of an empty value and swallow the next line (the bug that
// bit the ai-callable allow-list parser).

'use strict';

const fs = require('node:fs');

/** The first frontmatter block (between the first two `---` fences), or the
 *  whole string if there are no fences. Scalars only live in frontmatter, so
 *  this keeps body prose (`key: value` inside a sentence) out of the parse. */
function frontmatter(md) {
  if (!md) return '';
  const fences = [...md.matchAll(/^---\s*$/gm)];
  if (fences.length >= 2) return md.slice(fences[0].index, fences[1].index);
  return md;
}

/** Parse every `key: value` scalar line into a Map (first occurrence wins). */
function readScalars(md) {
  const out = new Map();
  const fm = frontmatter(md);
  const re = /^[ \t]*([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/gm;
  let m;
  while ((m = re.exec(fm))) {
    if (!out.has(m[1])) out.set(m[1], m[2].trim());
  }
  return out;
}

/** Read one scalar's value, or null if absent. */
function readScalar(md, scalar) {
  if (!md) return null;
  const m = frontmatter(md).match(new RegExp(`^[ \\t]*${scalar}[ \\t]*:[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Upsert `scalar: value` into OPENCUES.md frontmatter. Replaces the line in
 * place if present, else inserts before the closing frontmatter fence (the
 * second `---`), else appends. Returns true on write, false if the file is
 * unreadable.
 */
function writeScalar(filePath, scalar, value) {
  let md;
  try { md = fs.readFileSync(filePath, 'utf8'); } catch { return false; }
  const line = `${scalar}: ${value}`;
  const re = new RegExp(`^[ \\t]*${scalar}[ \\t]*:.*$`, 'm');
  if (re.test(md)) {
    md = md.replace(re, line);
  } else {
    const fences = [...md.matchAll(/^---\s*$/gm)];
    if (fences.length >= 2) {
      const at = fences[1].index;
      md = md.slice(0, at) + line + '\n' + md.slice(at);
    } else {
      md = md.replace(/\n?$/, `\n${line}\n`); // no frontmatter — append (degrade)
    }
  }
  fs.writeFileSync(filePath, md);
  return true;
}

module.exports = { readScalars, readScalar, writeScalar };
