/**
 * Typed-sentinel language — the parameterized / nested / field-access
 * sentinel grammar, gated behind `sentinel-language: typed` (default
 * `bare`, which keeps every existing user byte-for-byte on the flat
 * `[TOKEN]` path in `identity-context.ts:postProcessContext`).
 *
 * Bench evidence for this grammar lives in
 * `tests/benchmarks/typed-sentinel-language/FINDINGS.md` (parameterized
 * +14pp cross-provider, param-fill +47pp, 0 fabrication on bracket
 * languages, nested composition 100% through depth 3). Design rationale +
 * the resolved open decisions: `docs/architecture/typed-sentinel-language.md`.
 *
 * This module is PURE — no I/O, no LLM, no runtime deps. It exposes three
 * things:
 *   - renderTypedCatalog  — the catalog block shipped to the LLM
 *   - parseTypedSentinels — recursive bracket parser (proven in the bench
 *                           probes; lifted verbatim in spirit)
 *   - resolveTypedSentinels — innermost-first resolution with the
 *                           VALIDATE-AND-DEGRADE contract from decision #1
 *                           (a bad accessor drops to the base value; an
 *                           unknown id strips or is preserved; a malformed
 *                           nest never throws)
 *
 * The grammar (what the LLM may emit, what this resolves):
 *
 *   scalar            [WORK CITY]
 *   parameterized fn  [STOCK PRICE(ticker=NVDA)]
 *   nested (compose)  [WEATHER TEMP(city=[WORK CITY])]
 *   field access      [STOCK(ticker=NVDA): price]   (return-selector)
 *                     [STOCK(ticker=NVDA).price]    (dotted)
 *
 * Resolution is innermost-first: nested args resolve to scalars before the
 * outer call runs. The runtime supplies the two resolution callbacks
 * (`scalarLookup`, `callFn`) so this module never needs to know HOW a value
 * is fetched — only how to walk the tree.
 */

// ────────────────────────────────────────────────────────────────────
// Catalog model + renderer
// ────────────────────────────────────────────────────────────────────

export interface TypedCatalogParam {
  readonly name: string;
  /** Type annotation, e.g. 'string' | 'number'. */
  readonly type: string;
}

export interface TypedCatalogEntry {
  /** Display name inside the brackets, e.g. `STOCK PRICE`, `WORK CITY`. */
  readonly displayName: string;
  /** `scalar` = no args (identity field / aggregate); `fn` = takes params. */
  readonly kind: 'scalar' | 'fn';
  /** Return-type annotation: `string` | `number` | `array<string>` |
   *  `{temp: number, conditions: string}` | `array<{...}>`. */
  readonly returns: string;
  /** Parameter signature (fns only). */
  readonly params?: ReadonlyArray<TypedCatalogParam>;
  /** Human-readable description for the catalog line. */
  readonly description: string;
  /** Optional `(covers: ...)` synonym hint (prose-binding aid). */
  readonly covers?: string;
}

/** Render a single catalog line in the bench-winning parameterized shape:
 *    `- [STOCK PRICE(ticker: string): number] — current price (covers: ...)` */
export function renderTypedCatalogLine(e: TypedCatalogEntry): string {
  const sig = e.kind === 'fn' && e.params && e.params.length
    ? `(${e.params.map(p => `${p.name}: ${p.type}`).join(', ')})`
    : '';
  const base = `- [${e.displayName}${sig}: ${e.returns}] — ${e.description}`;
  return e.covers ? `${base} (covers: ${e.covers})` : base;
}

/**
 * Render the full typed catalog block (header + lines + the nesting +
 * accessor usage instruction). `header` and `rules` are supplied by the
 * caller (identity-context / blank-context keep their own framing); this
 * only owns the typed-shape line rendering + the composition instruction
 * that the bench found necessary for nested composition to fire.
 */
export function renderTypedCatalog(
  header: string,
  entries: ReadonlyArray<TypedCatalogEntry>,
  rules: string,
): string {
  if (entries.length === 0) return '';
  const lines = entries.map(renderTypedCatalogLine).join('\n');
  const usage = `USE PATTERN: emit [NAME] for scalars (no args), [NAME(arg=value)] for functions. A function argument may itself be ANOTHER token when that is how the user's intent maps to the data — the runtime resolves the INNERMOST token first and feeds its value outward (e.g. [WEATHER TEMP(city=[WORK CITY])]). To pick one field of a struct return, append it: [STOCK(ticker=NVDA): price]. Never invent a function or field that is not listed.`;
  return `\n\n${header}\n\n${usage}\n\n${lines}\n\n${rules}`;
}

// ────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────

export interface TypedToken {
  /** Display name as written by the LLM (e.g. `STOCK PRICE`). */
  readonly name: string;
  /** Args: name → literal string OR a nested token. Empty for scalars. */
  readonly args: Record<string, string | TypedToken>;
  /** Field accessor (struct field / array op), without the leading `.`/`:`.
   *  Undefined when none was written. */
  readonly accessor?: string;
  /** The raw inner text (between the outer brackets), for diagnostics. */
  readonly raw: string;
}

export interface ParsedSpan {
  /** Index of the opening `[` in the source. */
  readonly start: number;
  /** Index of the closing `]` in the source. */
  readonly end: number;
  /** The full matched substring `[...]`. */
  readonly text: string;
  readonly token: TypedToken;
}

/** Every TOP-LEVEL `[...]` span, tolerant of nested `[...]` inside args. */
function topLevelSpans(s: string): Array<{ start: number; end: number; inner: string }> {
  const out: Array<{ start: number; end: number; inner: string }> = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push({ start, end: i, inner: s.slice(start + 1, i) });
          start = -1;
        }
      }
      // stray ']' at depth 0 — ignore
    }
  }
  return out;
}

/** Split `a=1, b=[X], c="x,y"` on TOP-LEVEL commas (depth-aware, quote-aware). */
function splitTopLevelArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let q: string | null = null;
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Parse one bracket's inner text into a TypedToken. */
export function parseTypedToken(inner: string): TypedToken {
  let name: string;
  let argBody = '';
  let tail = ''; // text after the `)` (an accessor like `: price` / `.price`)

  const lp = inner.indexOf('(');
  if (lp < 0) {
    // No parens: either a bare scalar `WORK CITY`, a typed scalar
    // `EMAIL: string`, or a dotted accessor `STOCK.price`.
    name = inner.trim();
  } else {
    name = inner.slice(0, lp).trim();
    // find the matching ')'
    let d = 1;
    let j = lp + 1;
    let q: string | null = null;
    for (; j < inner.length; j++) {
      const ch = inner[j]!;
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '(') d++;
      else if (ch === ')') { d--; if (d === 0) break; }
    }
    argBody = inner.slice(lp + 1, j);
    tail = inner.slice(j + 1);
  }

  // Accessor: a trailing `: field` or `.field`. For the no-paren case it
  // rides on `name` (e.g. `STOCK.price`); for the paren case it's in `tail`.
  let accessor: string | undefined;
  if (lp < 0) {
    // dotted accessor on a scalar name — but the name itself may contain
    // spaces (`STOCK PRICE`). Only split on a `.` (dotted), NOT spaces.
    const dot = name.indexOf('.');
    if (dot >= 0) {
      accessor = name.slice(dot + 1).trim() || undefined;
      name = name.slice(0, dot).trim();
    }
    // strip a `: type` return annotation the LLM may echo (`EMAIL: string`)
    const colon = name.indexOf(':');
    if (colon >= 0) name = name.slice(0, colon).trim();
  } else {
    const t = tail.trim();
    if (t.startsWith(':') || t.startsWith('.')) {
      accessor = t.slice(1).trim() || undefined;
    }
  }

  const args: Record<string, string | TypedToken> = {};
  if (argBody.trim()) {
    for (const part of splitTopLevelArgs(argBody)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue; // positional / malformed arg — skip (degrade)
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        args[k] = parseTypedToken(v.slice(1, -1));
      } else {
        args[k] = v.replace(/^["']|["']$/g, '');
      }
    }
  }

  return { name, args, accessor, raw: inner };
}

/** Parse every top-level typed sentinel in a string. */
export function parseTypedSentinels(text: string): ParsedSpan[] {
  return topLevelSpans(text).map(s => ({
    start: s.start,
    end: s.end,
    text: text.slice(s.start, s.end + 1),
    token: parseTypedToken(s.inner),
  }));
}

// ────────────────────────────────────────────────────────────────────
// Resolver — innermost-first, validate-and-degrade
// ────────────────────────────────────────────────────────────────────

export interface ResolveTypedOptions {
  /** Resolve a scalar (a bracket display name like `WORK CITY`) to its
   *  value, or undefined if unknown. */
  readonly scalarLookup: (displayName: string) => string | undefined;
  /** Resolve a parameterized fn call (args already resolved to literal
   *  strings) to its value, or undefined if it can't. Optional: when
   *  omitted, every fn call degrades. */
  readonly callFn?: (name: string, args: Record<string, string>) => string | undefined;
  /** Apply a field accessor to a resolved value (struct field / array op),
   *  or undefined if the accessor is invalid. Optional: when omitted, an
   *  accessor is dropped and the base value is used (resolve-rest). */
  readonly applyAccessor?: (value: string, accessor: string) => string | undefined;
  /** The user's pre-LLM buffer; an exact bracket substring found here is
   *  user-typed and preserved verbatim (mirrors postProcessContext). */
  readonly originalBody?: string;
  /** Keep an unresolved token as its raw text instead of stripping it.
   *  TransformBlank passes true (LLM placeholders for non-user entities
   *  survive); FluidBlank passes false (catalog declared exhaustive). */
  readonly preserveUnknown?: boolean;
}

export interface TypedResolveReport {
  readonly resolved: Array<{ raw: string; value: string }>;
  readonly degraded: Array<{ raw: string; reason: string }>;
  readonly preserved: string[];
  readonly badAccessors: Array<{ raw: string; accessor: string }>;
}

export interface TypedResolveResult {
  readonly output: string;
  readonly report: TypedResolveReport;
}

// ── Runtime adapters: bridge the engine's callbacks to OpenCues' actual
//    data model (a flat `token → value` catalog of identity scalars +
//    pre-fetched blank-context instances). Kept here (pure + testable)
//    rather than in the source so the bridging rules have unit coverage. ──

/** Canonicalise a bracket token for tolerant matching (case + space/
 *  underscore-insensitive), mirroring identity-context's postProcessContext. */
function canonToken(tok: string): string {
  return tok.replace(/^\[|\]$/g, '').toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A `scalarLookup` backed by the merged `token → value` catalog: exact
 *  `[NAME]` match first, then tolerant canonical match (so `[FIRST_NAME]`
 *  and `[first name]` both resolve). */
export function catalogScalarLookup(
  catalog: ReadonlyMap<string, string>,
): (displayName: string) => string | undefined {
  const idx = new Map<string, string>();
  for (const [k, v] of catalog) idx.set(canonToken(k), v);
  return (displayName) => {
    const exact = catalog.get(`[${displayName}]`);
    if (exact !== undefined) return exact;
    return idx.get(canonToken(`[${displayName}]`));
  };
}

/** A best-effort `callFn` that bridges a parameterized call to a
 *  pre-fetched blank-context INSTANCE token. `STOCK PRICE(ticker=NVDA)`
 *  → tries `[STOCK NVDA]` and `[STOCK PRICE NVDA]`. Single-arg only —
 *  multi-arg fns (CONVERT) have no pre-fetched instance to map to, so they
 *  degrade. Returns undefined when no instance exists (→ graceful degrade). */
export function instanceTokenFnBridge(
  scalarLookup: (displayName: string) => string | undefined,
): (name: string, args: Record<string, string>) => string | undefined {
  return (name, args) => {
    const vals = Object.values(args);
    if (vals.length !== 1) return undefined;
    const slot = vals[0]!;
    const firstWord = name.split(/\s+/)[0]!;
    for (const cand of [`${firstWord} ${slot}`, `${name} ${slot}`]) {
      const hit = scalarLookup(cand);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
}

/** An `applyAccessor` for struct-return values stored as JSON. A non-JSON
 *  value or a missing field returns undefined (→ resolve-rest degrade). */
export function jsonFieldAccessor(value: string, field: string): string | undefined {
  try {
    const obj = JSON.parse(value) as Record<string, unknown> | null;
    const f = obj && typeof obj === 'object' ? obj[field] : undefined;
    return f === undefined || f === null ? undefined : String(f);
  } catch { return undefined; }
}

// ── Phase 4: on-demand parameterized resolution (PURE pre-pass) ──────────
// The catalog renders a param-safe blank as `[STOCK(ticker: string): number]`
// (fn name = the bare instance-token prefix). The LLM emits `[STOCK(ticker=
// NVDA)]`. This pure pass extracts the (blankName, arg, instanceToken) tuples
// the RUNTIME should fetch; the runtime awaits its capability-gated blankFetch
// for each, merges `instanceToken → value` into the catalog, then runs the
// normal sync resolver (whose bridge finds the freshly-fetched instance). All
// async I/O + the capability enforcement stay in the runtime; this stays pure.

/** Registry of param-safe fns, keyed (canonically) by the fn display-name
 *  the LLM emits === the bare instance-token prefix. */
export interface ParamSafeFn {
  /** Runtime blank to call get(arg) on (e.g. `stocks`). */
  readonly blankName: string;
  /** Bare instance-token prefix the fetched value is keyed under
   *  (e.g. `STOCK` → instance token `[STOCK NVDA]`). */
  readonly tokenPrefix: string;
}

export interface ParamSafeFetch {
  readonly blankName: string;
  readonly arg: string;
  /** The bare instance token to populate in the catalog once fetched. */
  readonly instanceToken: string;
}

/** Canonicalise a fn/display name for registry matching (case + space-insensitive). */
function canonName(name: string): string {
  return name.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Scan the LLM output for top-level param-safe fn-calls and return the
 * fetches the runtime should perform. Only fn-calls whose name matches a
 * registered ParamSafeFn are collected — the `paramSafe` registry IS the
 * capability gate (built only from `param-safe: true` blanks). A call's single
 * argument is resolved as a literal or a nested SCALAR (via scalarLookup);
 * nested fn-args are skipped (no recursive fetch in v1). Deduped per
 * (blank, arg). Pure + total.
 */
export function collectParamSafeFetches(
  text: string,
  paramSafe: ReadonlyMap<string, ParamSafeFn>,
  scalarLookup: (displayName: string) => string | undefined,
): ParamSafeFetch[] {
  if (paramSafe.size === 0) return [];
  const out: ParamSafeFetch[] = [];
  const seen = new Set<string>();
  for (const span of parseTypedSentinels(text)) {
    const tok = span.token;
    const argNames = Object.keys(tok.args);
    if (argNames.length === 0) continue; // scalar, not a fn-call
    const fn = paramSafe.get(canonName(tok.name));
    if (!fn) continue; // not a param-safe fn → capability gate denies the fetch
    const v = tok.args[argNames[0]!]!; // param-safe blanks take one slot arg
    let arg: string | undefined;
    if (typeof v === 'string') arg = v;
    else if (Object.keys(v.args).length === 0) arg = scalarLookup(v.name); // nested scalar
    // (nested fn arg → skip: no recursive on-demand fetch in v1)
    if (arg === undefined || arg.trim() === '') continue;
    arg = arg.trim();
    const key = `${fn.blankName} ${arg.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ blankName: fn.blankName, arg, instanceToken: `[${fn.tokenPrefix} ${arg}]` });
  }
  return out;
}

const UNRESOLVED = Symbol('unresolved');

/** Resolve a single token tree to a string, or UNRESOLVED if it can't.
 *  Mutates `report` for diagnostics. Never throws. */
function resolveNode(
  token: TypedToken,
  opts: ResolveTypedOptions,
  report: TypedResolveReport,
): string | typeof UNRESOLVED {
  const argNames = Object.keys(token.args);
  let base: string | undefined;

  if (argNames.length === 0) {
    // Scalar (possibly with an accessor): look up by display name.
    base = opts.scalarLookup(token.name);
    if (base === undefined) return UNRESOLVED;
  } else {
    // Parameterized fn: resolve each arg first (innermost-first).
    const resolvedArgs: Record<string, string> = {};
    for (const k of argNames) {
      const v = token.args[k]!;
      if (typeof v === 'string') {
        resolvedArgs[k] = v;
      } else {
        const inner = resolveNode(v, opts, report);
        if (inner === UNRESOLVED) return UNRESOLVED; // a nested arg failed → whole call fails
        resolvedArgs[k] = inner;
      }
    }
    if (!opts.callFn) return UNRESOLVED;
    base = opts.callFn(token.name, resolvedArgs);
    if (base === undefined) return UNRESOLVED;
  }

  // Apply accessor (validate-and-degrade: bad accessor → base value).
  if (token.accessor) {
    const applied = opts.applyAccessor?.(base, token.accessor);
    if (applied === undefined) {
      report.badAccessors.push({ raw: `[${token.raw}]`, accessor: token.accessor });
      return base; // resolve-rest (decision #1)
    }
    return applied;
  }
  return base;
}

/**
 * Resolve every typed sentinel in `text`. Pure, total (never throws).
 * Unmatched / malformed brackets are left as-is. Innermost-first; bad
 * accessors degrade to the base value; unknown ids strip or preserve per
 * `preserveUnknown`.
 */
export function resolveTypedSentinels(
  text: string,
  opts: ResolveTypedOptions,
): TypedResolveResult {
  const report: TypedResolveReport = { resolved: [], degraded: [], preserved: [], badAccessors: [] };
  const spans = parseTypedSentinels(text);
  if (spans.length === 0) return { output: text, report };

  // Rebuild the string, replacing each top-level span. Walk right-to-left
  // so earlier indices stay valid.
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    let replacement: string;

    // CANDIDATE GUARD (buffer-safety): only treat a span as a sentinel if
    // it actually looks like one — an uppercase-leading token name (the same
    // shape bare's `/\[[A-Z][A-Z0-9 _-]*\]/` matches) OR a parameterized
    // call (has args). This leaves markdown links `[docs](url)`, citations
    // `[1]`, code `arr[0]`, checkboxes `[ ]`, and lowercase placeholders
    // `[your name]` untouched — exactly as the bare post-processor does.
    // Without this, the wider `[...]` grammar would strip them and corrupt
    // the buffer. A user-typed bracket is also preserved below via
    // originalBody, but that only covers text the user typed, not
    // LLM-generated markdown — this guard covers both.
    const nameLooksLikeToken = /^[A-Z][A-Z0-9 _-]*$/.test(span.token.name.trim());
    const isCandidate = nameLooksLikeToken || Object.keys(span.token.args).length > 0;
    if (!isCandidate) continue; // leave the span verbatim

    if (opts.originalBody && opts.originalBody.includes(span.text)) {
      report.preserved.push(span.text);
      replacement = span.text; // user-typed — untouched
    } else {
      const r = resolveNode(span.token, opts, report);
      if (r === UNRESOLVED) {
        report.degraded.push({ raw: span.text, reason: 'unresolved id/args' });
        replacement = opts.preserveUnknown ? span.text : '';
      } else {
        report.resolved.push({ raw: span.text, value: r });
        replacement = r;
      }
    }
    out = out.slice(0, span.start) + replacement + out.slice(span.end + 1);
  }
  return { output: out, report };
}
