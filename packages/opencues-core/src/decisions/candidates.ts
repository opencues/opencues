/**
 * Candidates cut in code — the runtime's half of "selection, not generation".
 *
 * A decision leg never asks the model to EMIT a value; it offers things the
 * runtime already holds and asks which. These helpers cut those things:
 * the window of a long buffer a `_` router judges, a word's edit-1
 * neighbourhood for a spelling correction, the words / 2-grams / command
 * suffixes a replace detector picks from. What a package then ASKS about
 * them is the package's; what is offered is product policy and lives here.
 */

/** the state is the draft around the `_`; longer drafts are windowed to this many chars ending at the `_` line */
export const UNDERSCORE_ROUTE_MAX_CHARS = 6000;

/** Window a long buffer to the part that carries the `_`, so the state stays far under the budget. */
export function underscoreRouteDraft(text: string, maxChars = UNDERSCORE_ROUTE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const us = text.lastIndexOf('_');
  const end = Math.min(text.length, Math.max(us + 1, 0) + Math.floor(maxChars / 4));
  return text.slice(Math.max(0, end - maxChars), end);
}

/** the option limit of a choice, minus the `none` option */
export const SPELLING_MAX_CANDIDATES = 254;

/** A token a spelling leg may flag: letters only, 3+ chars, not an acronym; never code, paths, numbers, identifiers. */
export function spellingEligible(token: string): boolean {
  const w = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (w.length < 3) return false;
  if (!/^\p{L}+$/u.test(w)) return false;
  if (w === w.toUpperCase()) return false;          // acronyms
  return true;
}

/**
 * The edit-1 neighbourhood, ranked: deletions, transpositions and doublings
 * first (the common typo shapes), then vowel insert / replace, then consonant
 * insert / replace, capped so a request stays inside the option limit.
 */
export function edits1(w: string, cap = SPELLING_MAX_CANDIDATES): string[] {
  const tier1 = new Set<string>(), tier2 = new Set<string>(), tier3 = new Set<string>();
  const vowels = 'aeiou', cons = 'yrstlnmcdhgpbfkvw';
  for (let i = 0; i < w.length; i++) {
    tier1.add(w.slice(0, i) + w.slice(i + 1));
    if (i + 1 < w.length) tier1.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
    tier1.add(w.slice(0, i) + w[i] + w.slice(i));
    for (const c of vowels) { tier2.add(w.slice(0, i) + c + w.slice(i)); tier2.add(w.slice(0, i) + c + w.slice(i + 1)); }
    for (const c of cons) { tier3.add(w.slice(0, i) + c + w.slice(i)); tier3.add(w.slice(0, i) + c + w.slice(i + 1)); }
  }
  for (const c of vowels + cons) tier2.add(w + c);
  const out: string[] = []; const seen = new Set<string>([w]);
  for (const t of [tier1, tier2, tier3]) for (const x of t) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out.slice(0, cap);
}

export const REPLACE_MAX_CANDIDATES = 200;
export const REPLACE_MAX_COMMAND_WORDS = 8;

const strip = (s: string): string => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** The replace candidates: targets = words and 2-grams (punctuation-trimmed, deduped), commands = suffix phrases ending at the `_`. */
export function replaceCandidates(input: string): { targets: string[]; commands: string[] } {
  const toks = input.split(/\s+/).filter(Boolean);
  const us = toks.indexOf('_');
  const body = toks.filter((t) => t !== '_');
  const seen = new Set<string>();
  const targets: string[] = [];
  const push = (t: string): void => { const s = strip(t); if (s && !seen.has(s)) { seen.add(s); targets.push(s); } };
  for (const t of body) push(t);
  for (let i = 0; i + 1 < body.length; i++) push(`${body[i]} ${body[i + 1]}`);
  const commands: string[] = [];
  if (us > 0) for (let k = 1; k <= Math.min(REPLACE_MAX_COMMAND_WORDS, us); k++) commands.push(`${toks.slice(us - k, us).join(' ')} _`);
  return { targets: targets.slice(0, REPLACE_MAX_CANDIDATES), commands };
}
