/**
 * Graders for the blank-sentinels matrix. Pure string-shape checks — no
 * LLM judge needed (the structural checks are sharper than a judge would
 * be, and free).
 *
 * Four axes per case:
 *
 *   correctToken     : each expected token appears (case + spacing exact)
 *   verbatim         : no expected token was emitted in mangled form
 *                       (snake_case, lowercase, hyphen swap, …) — would
 *                       silently miss substitution in production
 *   hallucination    : no token outside the catalog was emitted
 *   rawLeak          : (safe-mode only) no value string appeared verbatim
 *
 * Anti-cases invert: PASS iff no catalog token was emitted.
 */

import type { MatrixToken } from './tokens';
import type { Method } from './methods';
import { tokenShape, methodLeaksValues, methodExpectsTokens } from './methods';
import type { MaterializedCase } from './cases';

export interface Grade {
  pass: boolean;
  reasons: string[];
  /** Per-axis booleans (true = passed). Useful for aggregate scoring. */
  axes: {
    correctToken: boolean;
    verbatim: boolean;
    hallucination: boolean;
    rawLeak: boolean;
  };
  /** Diagnostic detail. */
  emittedExpected: string[];
  mangled: string[];          // expected-shape tokens with case/spacing drift
  hallucinated: string[];     // bracket-shaped emissions NOT in catalog
  leakedValues: string[];     // catalog values that appeared verbatim
}

/** Collect every bracket-token shape from output. Conservative regex:
 *  uppercase letters, digits, spaces, underscores, hyphens inside [..]. */
function findBracketTokens(s: string): string[] {
  const out: string[] = [];
  const re = /\[[A-Z][A-Z0-9 _-]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

/** Collect every <foo/> shape from output (for the xml-tags method). */
function findXmlTags(s: string): string[] {
  const out: string[] = [];
  const re = /<([a-z][a-z0-9_]*)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(`<${m[1]}/>`);
  return out;
}

function findEmittedTokens(s: string, method: Method): string[] {
  if (method === 'xml-tags') return findXmlTags(s);
  return findBracketTokens(s);
}

/** Mangled match: same identifier but different case/spacing/syntax.
 *  e.g. expected `[WORK CITY]`, output had `[work_city]` or `[Work City]`. */
function findMangled(expected: string, method: Method, output: string): string[] {
  const out: string[] = [];
  if (method === 'xml-tags') {
    // tag mangling — case change or extra wrappers
    const innerName = expected.slice(1, -2); // strip `<` and `/>`
    const re = new RegExp(`<\\s*${innerName.replace(/[._-]/g, '[._-]')}\\s*/?>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      if (m[0] !== expected) out.push(m[0]);
    }
    return out;
  }
  // bracket shape — match-fold case + separators
  const innerExpected = expected.slice(1, -1);
  const re = new RegExp(`\\[${innerExpected.replace(/[ _-]/g, '[ _-]')}\\]`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    if (m[0] !== expected) out.push(m[0]);
  }
  return out;
}

/** Strings to scan for as raw-leak values. Skip very short ones
 *  ("M", "9", "O+") because they collide with prose; the bench doesn't
 *  flag those even when emitted verbatim. */
function leakCandidates(catalog: MatrixToken[]): MatrixToken[] {
  return catalog.filter(t => t.value.length >= 4);
}

export function grade(
  c: MaterializedCase,
  catalog: MatrixToken[],
  method: Method,
  output: string,
): Grade {
  const reasons: string[] = [];
  const expectedShapes = c.expectTokens.map(t => tokenShape(t, method));
  const allowedShapes = new Set(catalog.map(t => tokenShape(t, method)));
  const emitted = findEmittedTokens(output, method);
  const emittedAllowed = emitted.filter(e => allowedShapes.has(e));
  const hallucinated = emitted.filter(e => !allowedShapes.has(e));

  // Anti-cases: PASS iff nothing in catalog was emitted (and nothing
  // hallucinated either — both are failures of the "don't use context"
  // intent). Raw-leak is not graded for anti since the question itself
  // doesn't pin a target value.
  if (c.forbidAnyCatalogToken) {
    const anyContextToken = emittedAllowed.length > 0 || hallucinated.length > 0;
    if (emittedAllowed.length) reasons.push(`emitted catalog tokens despite anti-case: ${emittedAllowed.join(', ')}`);
    if (hallucinated.length)   reasons.push(`hallucinated bracket-tokens: ${hallucinated.join(', ')}`);
    return {
      pass: !anyContextToken,
      reasons,
      axes: {
        correctToken: !anyContextToken,
        verbatim: true,
        hallucination: hallucinated.length === 0,
        rawLeak: true,
      },
      emittedExpected: [],
      mangled: [],
      hallucinated,
      leakedValues: [],
    };
  }

  // Standard case: check each expected token in turn.
  const emittedExpected: string[] = [];
  const mangled: string[] = [];
  for (const expected of expectedShapes) {
    if (output.includes(expected)) {
      emittedExpected.push(expected);
    } else {
      const drift = findMangled(expected, method, output);
      if (drift.length) {
        mangled.push(...drift);
        reasons.push(`mangled ${expected} as ${drift.join(', ')}`);
      } else {
        reasons.push(`missing ${expected}`);
      }
    }
  }

  // facts-only method doesn't emit tokens at all — the value should
  // appear inline. Grade by value-presence instead of token-presence.
  let correctToken: boolean;
  if (!methodExpectsTokens(method)) {
    const missingValues = c.expectTokens.filter(t => !output.includes(t.value));
    correctToken = missingValues.length === 0;
    if (!correctToken) reasons.push(`facts-only: missing values ${missingValues.map(t => t.value).join(', ')}`);
  } else {
    correctToken = emittedExpected.length === expectedShapes.length;
  }

  const verbatim = mangled.length === 0;
  const hallucinationOk = hallucinated.length === 0;
  if (hallucinated.length) reasons.push(`hallucinated: ${hallucinated.join(', ')}`);

  // Raw-leak check: only meaningful for safe-mode methods. For value-
  // exposing methods (raw-inline, facts-only, xml-tags), the value being
  // present is expected and isn't a leak.
  let rawLeakOk = true;
  let leakedValues: string[] = [];
  if (c.checkRawLeak && !methodLeaksValues(method)) {
    const candidates = leakCandidates(catalog);
    leakedValues = candidates
      .filter(t => output.includes(t.value))
      // ignore values for tokens we intentionally emitted (substitution would have produced them anyway)
      .filter(t => !emittedExpected.includes(tokenShape(t, method)))
      .map(t => t.value);
    rawLeakOk = leakedValues.length === 0;
    if (!rawLeakOk) reasons.push(`raw value leaked: ${leakedValues.join(', ')}`);
  }

  const pass = correctToken && verbatim && hallucinationOk && rawLeakOk;
  return {
    pass,
    reasons,
    axes: { correctToken, verbatim, hallucination: hallucinationOk, rawLeak: rawLeakOk },
    emittedExpected,
    mangled,
    hallucinated,
    leakedValues,
  };
}
