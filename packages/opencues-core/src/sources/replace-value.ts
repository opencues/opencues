/**
 * The replace VALUE from the fused rewrite, once a decision leg has named
 * the target and the command (docs/architecture/transform-blank.md
 * § Replace-parse). Pure string work on inputs the runtime holds; no model.
 */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const isFiller = (s: string): boolean => /^[\s\p{P}\p{S}]*$/u.test(s);

/**
 * The value from the fused rewrite. Removes the command from the input,
 * finds the one target occurrence, and takes the longest common prefix and
 * suffix of that base and the rewrite: the changed region must sit on the
 * target, overhanging it by punctuation or whitespace at most. Returns the
 * (possibly punctuation-widened) target and its replacement, or null when
 * the rewrite changed anything else — the merge path then owns the edit.
 */
export function deriveReplaceValue(text: string, command: string, target: string, rewrite: string): { target: string; value: string } | null {
  const ci = text.indexOf(command);
  if (ci < 0) return null;
  const base = norm(text.slice(0, ci) + ' ' + text.slice(ci + command.length));
  const out = norm(rewrite);
  if (!base || !out || base === out) return null;
  // the one occurrence of the target outside the command (the command is gone from base)
  const first = base.indexOf(target);
  if (first < 0 || base.indexOf(target, first + 1) >= 0) return null;
  const tStart = first, tEnd = first + target.length;
  let p = 0;
  while (p < base.length && p < out.length && base[p] === out[p]) p++;
  let s = 0;
  while (s < base.length - p && s < out.length - p && base[base.length - 1 - s] === out[out.length - 1 - s]) s++;
  const cStart = Math.min(p, tStart), cEnd = Math.max(base.length - s, tEnd);
  // the changed region may overhang the target only by filler
  if (!isFiller(base.slice(cStart, tStart)) || !isFiller(base.slice(tEnd, cEnd))) return null;
  const vEnd = out.length - (base.length - cEnd);
  if (vEnd < cStart) return null;
  const widened = base.slice(cStart, cEnd);
  const value = out.slice(cStart, vEnd);
  if (!value.trim() || value === widened) return null;
  // the widened target must still be a verbatim substring of the live text
  if (!text.includes(widened)) return null;
  return { target: widened, value };
}
