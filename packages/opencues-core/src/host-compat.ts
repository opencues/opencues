/**
 * Host-compat: which OpenCues integrations a cue or blank runs on.
 *
 * The OpenStandard supports multiple host integrations — claude-code,
 * opencode, gemini-cli, chrome — that share the same .md config format.
 * Most entries work on ALL hosts; the few that don't declare it explicitly
 * via frontmatter.
 *
 * Default: every cue / blank advertises as compatible with every host. The
 * runtime will attempt to invoke it; if the host genuinely can't fulfil the
 * call (e.g. chrome without chrome-host trying to spawn a `.sh` script),
 * the failure surfaces at runtime (exit 127 / "spawnProcess not supported")
 * rather than being hidden behind a misleading "incompatible host" marker.
 *
 * Historical note: this used to auto-exclude chrome for entries with
 * `script: ./X.sh` / `.py` / `.exe` / etc., on the assumption that chrome
 * could never run subprocesses. With chrome-host (May 2026 native-messaging
 * bridge) chrome CAN run POSIX scripts via the host process, so the
 * heuristic became actively wrong. We removed the auto-exclusion in favour
 * of explicit `on-host:` / `not-on-host:` overrides.
 *
 * Override rules:
 *
 *   on-host: [claude-code, opencode]    → allow-list (everything else excluded)
 *   not-on-host: [chrome]               → deny-list (filtered out)
 *   both                                → on-host allow AND not-on-host deny
 *
 * Conflicts (e.g. on-host: [chrome] AND not-on-host: [chrome]) are reported
 * as warnings by `opencues validate`; the runtime treats not-on-host as
 * authoritative (deny wins).
 */

/** Every integration host. Keep alphabetical for stable equality checks. */
export const HOSTS = ['chrome', 'claude-code', 'dsh', 'gemini-cli', 'opencode', 'shell', 'windows'] as const;
export type Host = typeof HOSTS[number];

/** Hosts that can spawn subprocesses + access the filesystem WITHOUT an
 *  auxiliary helper. Chrome can also spawn subprocesses, but only when
 *  chrome-host (the native-messaging bridge) is installed — so chrome's
 *  capability is runtime-detected, not a static property. */
export const NATIVE_HOSTS: readonly Host[] = ['claude-code', 'gemini-cli', 'opencode', 'shell', 'windows'];

/**
 * Hosts that run inside a web page.
 *
 * Distinct from "not native": what these share is a DOM, a browser's own
 * keybindings, and page-derived colours — not merely the absence of a
 * subprocess. Several behaviours are browser-motivated and were written as
 * `hostName === 'chrome'` while chrome was the only browser host: the
 * ctrl-alt keymap (because ctrl-shift+arrow is the browser's own
 * extend-selection-by-word), and `dim-mix` (because the dim colour is mixed
 * toward a *page* background). Those are properties of being in a browser,
 * so a second browser host must inherit them by construction rather than by
 * happening to call itself `chrome`.
 *
 * Ask `isBrowserHost()`; a bare `=== 'chrome'` in new code is almost always
 * this question asked wrongly.
 */
export const BROWSER_HOSTS: readonly Host[] = ['chrome', 'dsh'];

/** Does this host render inside a web page? See `BROWSER_HOSTS`. */
export function isBrowserHost(hostName: string): boolean {
  return (BROWSER_HOSTS as readonly string[]).includes(hostName);
}

/**
 * The subset of frontmatter fields host-compat resolution looks at. Accepts
 * both monolithic BlankConfig (camelCase) and SingleCueFrontmatter (raw
 * YAML keys) — the latter has `not-on-host` with hyphens.
 */
export interface HostCompatInput {
  /** Explicit allow-list. Camel + hyphenated forms both accepted. */
  readonly onHost?: readonly string[] | string;
  readonly 'on-host'?: readonly string[] | string;
  /** Explicit deny-list. */
  readonly notOnHost?: readonly string[] | string;
  readonly 'not-on-host'?: readonly string[] | string;
}

export interface HostCompatResult {
  /** The hosts this entry will run on, sorted. */
  readonly hosts: readonly Host[];
  /** True if every host is in the allow-list (i.e. universal). */
  readonly all: boolean;
  /** Which mechanism produced this — useful for `opencues list` markers. */
  readonly source: 'auto' | 'on-host' | 'not-on-host';
}

/**
 * Compute which hosts an entry runs on. Pure function — no I/O.
 *
 * Examples:
 *
 *   inferHostCompat({})
 *     → { hosts: [chrome, claude-code, gemini-cli, opencode], all: true, source: 'auto' }
 *
 *   inferHostCompat({ 'on-host': ['chrome'] })
 *     → { hosts: [chrome], all: false, source: 'on-host' }
 *
 *   inferHostCompat({ 'not-on-host': ['chrome'] })
 *     → { hosts: [claude-code, gemini-cli, opencode], all: false, source: 'not-on-host' }
 */
export function inferHostCompat(input: HostCompatInput): HostCompatResult {
  const onHost = normaliseHostList(input.onHost ?? input['on-host']);
  const notOnHost = normaliseHostList(input.notOnHost ?? input['not-on-host']);

  // Start from on-host allow-list when provided; otherwise every host.
  let hosts: Host[];
  let source: HostCompatResult['source'];
  if (onHost.length > 0) {
    hosts = [...onHost];
    source = 'on-host';
  } else {
    hosts = [...HOSTS];
    source = 'auto';
  }

  // not-on-host removes explicit denials.
  if (notOnHost.length > 0) {
    hosts = hosts.filter(h => !notOnHost.includes(h));
    if (source === 'auto') source = 'not-on-host';
  }

  hosts.sort();
  return { hosts, all: hosts.length === HOSTS.length, source };
}

/**
 * Accept hosts as a YAML list, comma-separated string, or single value.
 * Drops empty / whitespace entries; lowercases; filters to known HOSTS.
 * Unknown values are silently dropped (validator surfaces them with a
 * proper error message).
 */
function normaliseHostList(v: readonly string[] | string | undefined): Host[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr
    .map(s => String(s).trim().toLowerCase())
    .filter(s => s.length > 0)
    .filter((s): s is Host => (HOSTS as readonly string[]).includes(s));
}

/** Returns the unknown host names from a raw frontmatter value. Used by the
 *  validator to flag typos. Empty array on success. */
export function unknownHostNames(v: readonly string[] | string | undefined): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const known = new Set<string>(HOSTS);
  return arr
    .map(s => String(s).trim().toLowerCase())
    .filter(s => s.length > 0)
    .filter(s => !known.has(s));
}

/** Format the host list for human display: "all" or "claude-code, gemini-cli, opencode". */
export function formatHostList(hosts: readonly Host[]): string {
  if (hosts.length === HOSTS.length) return 'all';
  return [...hosts].sort().join(', ');
}

// ─── Site-compat ─────────────────────────────────────────────────────────
//
// `on-site` / `not-on-site` is the strictly-broader version of on-host.
// An entry can be a platform name, a hostname, a wildcard hostname, or
// a hostname with a path prefix. Lets a cue/blank/auditor scope itself
// to "only on reddit.com" or "only the /r/claudeai subreddit", while
// still allowing platform-only scopes (just like on-host).

/**
 * Common aliases accepted alongside canonical host names. Maps
 * alias → canonical Host. The canonical names themselves
 * ('claude-code', 'opencode', 'chrome', 'gemini-cli') are NOT in
 * this map — use `resolveHost()` to handle both in one call.
 *
 * Single source of truth for every CLI subcommand that accepts a
 * host argument (install, run, sync, uninstall, update). Adding an
 * alias = one entry here.
 */
export const HOST_ALIASES: Readonly<Record<string, Host>> = {
  'cc': 'claude-code',
  'claudecode': 'claude-code',
  'claude': 'claude-code',
  'oc': 'opencode',
  'gemini': 'gemini-cli',
  'geminicli': 'gemini-cli',
  'terminal': 'shell',   // back-compat: 'terminal' was the canonical name before May 2026
  'term': 'shell',
  'oc-shell': 'shell',
  'oc-edit': 'shell',
  'win': 'windows',
  'oc-windows': 'windows',
  'deepseek': 'dsh',
  'deepseek-harness': 'dsh',
};

/**
 * Resolve a user-supplied host string (canonical name or alias)
 * to its canonical Host. Returns null when the input doesn't match
 * any known host. CLI subcommands should call this rather than
 * maintaining their own alias map.
 *
 * @example
 *   resolveHost('cc')          // 'claude-code'
 *   resolveHost('claude-code') // 'claude-code'
 *   resolveHost('vscode')      // null
 */
export function resolveHost(input: string | null | undefined): Host | null {
  if (!input) return null;
  const key = input.toLowerCase();
  if ((HOSTS as readonly string[]).includes(key)) return key as Host;
  return HOST_ALIASES[key] ?? null;
}

/**
 * The known field-kind vocabulary for `on-field:` / `not-on-field:` scoping.
 * A host declares the focused field's shape (see `AmbientContext.singleLine`);
 * the runtime maps it to one of these tokens for cue/blank scoping.
 */
export const FIELD_KINDS = ['single-line', 'multi-line'] as const;
export type FieldKind = typeof FIELD_KINDS[number];

/** Derive the field-kind token from the ambient field declaration, or null
 *  when the host declared nothing (kind unknown). */
export function fieldKindOf(ambient: { singleLine?: boolean } | undefined): FieldKind | null {
  if (ambient?.singleLine === true) return 'single-line';
  if (ambient?.singleLine === false) return 'multi-line';
  return null;
}

/**
 * The privacy-safe SHAPE subset of an AmbientContext: the on-machine
 * structural booleans (`singleLine` / `disposable`) that drive field-kind
 * routing (`on-field:` scoping) and the field-declared WIPE gate. These
 * NEVER reach an LLM — unlike the text metadata (label / placeholder /
 * pageTitle / app), which DOES go on the wire and is therefore gated by
 * `ambient-context-mode`.
 *
 * The resolver forwards THIS subset unconditionally — field-kind scoping is
 * structural routing, the same category as on-host / on-site, not a privacy
 * opt-in — and forwards the FULL ambient only when `ambient-context-mode:
 * on`. This is a WHITELIST: even a misbehaving host that stuffs PII into
 * `label` has it dropped here before any source sees it, so the "no field
 * metadata to the LLM when the mode is off" invariant is preserved BY
 * CONSTRUCTION — strictly stronger than the old "don't consult the host at
 * all" stance (a blacklist that broke field-shape awareness as collateral).
 *
 * Returns undefined when the host declared no shape at all (both booleans
 * absent — e.g. a native host with no DOM, or a sensitive field the host
 * refused to describe), so downstream `kind unknown` handling is unchanged.
 */
export function structuralAmbientOnly(
  ambient: { singleLine?: boolean; disposable?: boolean; [k: string]: unknown } | undefined,
): { singleLine?: boolean; disposable?: boolean } | undefined {
  if (!ambient) return undefined;
  const out: { singleLine?: boolean; disposable?: boolean } = {};
  if (ambient.singleLine !== undefined) out.singleLine = ambient.singleLine;
  if (ambient.disposable !== undefined) out.disposable = ambient.disposable;
  return out.singleLine !== undefined || out.disposable !== undefined ? out : undefined;
}

/**
 * True when the entry's `on-field:` / `not-on-field:` frontmatter permits the
 * CURRENT field. Pure function; evaluated PER-RESOLVE (the field kind changes
 * every focus), unlike `on-host` (evaluated once at load). Mirrors the
 * on-site / not-on-site semantics:
 *
 *   No on-field, no not-on-field           → always true.
 *   not-on-field matches the known kind    → false (excluded here).
 *   on-field present                       → the known kind must match one.
 *
 * Graceful default: when the host declares NO field shape (kind unknown),
 * `not-on-field` never excludes (we can't prove the field is that kind), and
 * `on-field` never matches (an allow-list is opt-in to a known kind). So a cue
 * with no field frontmatter, or a host that reports no field shape, behaves
 * exactly as before this feature.
 */
export function inferFieldCompat(
  input: { onField?: readonly string[]; notOnField?: readonly string[] },
  ambient: { singleLine?: boolean } | undefined,
): boolean {
  const kind = fieldKindOf(ambient);
  const allow = (input.onField ?? []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const deny = (input.notOnField ?? []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  if (kind && deny.includes(kind)) return false;      // deny wins, only on a known matching kind
  if (allow.length === 0) return true;
  return kind !== null && allow.includes(kind);        // allow-list: needs a known matching kind
}

/** Site-compat evaluation context. */
export interface SiteCompatContext {
  /** Canonical host name: 'chrome' | 'claude-code' | 'opencode' | 'gemini-cli'. */
  readonly hostName: Host | null;
  /** Current hostname (browser only — `location.hostname`). Null on native hosts. */
  readonly hostname: string | null;
  /** Current path (browser only — `location.pathname`). Null on native hosts. */
  readonly path: string | null;
}

/**
 * True when the entry's on-site/not-on-site frontmatter passes the
 * current scope. Pure function.
 *
 *   No on-site, no not-on-site             → always true.
 *   on-site present                        → at least one entry must match.
 *   not-on-site present                    → no entry may match.
 *   both present                           → on-site allow AND not-on-site deny.
 *
 * Matching rules per entry:
 *   - 'chrome' / 'claude-code' / 'cc' / 'opencode' / 'oc' / 'gemini-cli' / 'gemini'
 *     → matches ctx.hostName (with HOST_ALIASES).
 *   - 'reddit.com'                  → matches when ctx.hostname === 'reddit.com'.
 *   - '*.reddit.com'                → matches subdomains AND the bare domain.
 *   - 'reddit.com/r/claudeai'       → matches hostname + path.startsWith('/r/claudeai').
 *
 * Native hosts (hostname/path null): hostname-based entries don't
 * match. Only platform-name entries do.
 */
export function inferSiteCompat(
  input: { onSite?: readonly string[]; notOnSite?: readonly string[] },
  ctx: SiteCompatContext,
): boolean {
  const allow = (input.onSite ?? []).map(s => String(s).trim()).filter(Boolean);
  const deny = (input.notOnSite ?? []).map(s => String(s).trim()).filter(Boolean);

  if (deny.some(e => matchSiteEntry(e, ctx))) return false;
  if (allow.length === 0) return true;
  return allow.some(e => matchSiteEntry(e, ctx));
}

/** Test one entry against the current scope. */
function matchSiteEntry(entry: string, ctx: SiteCompatContext): boolean {
  const e = entry.toLowerCase();

  // Hostname + path-prefix form.
  if (e.includes('/')) {
    const slashIdx = e.indexOf('/');
    const hostPart = e.slice(0, slashIdx);
    const pathPrefix = e.slice(slashIdx); // includes leading slash
    if (!ctx.hostname || !ctx.path) return false;
    if (!matchHostname(hostPart, ctx.hostname)) return false;
    return ctx.path.toLowerCase().startsWith(pathPrefix);
  }

  // Platform name (with alias resolution).
  const aliased = HOST_ALIASES[e];
  if (aliased) return ctx.hostName === aliased;
  if ((HOSTS as readonly string[]).includes(e)) return ctx.hostName === (e as Host);

  // Treat as hostname pattern.
  if (!ctx.hostname) return false;
  return matchHostname(e, ctx.hostname);
}

/** Hostname match: exact or `*.suffix` (matches suffix + subdomains). */
function matchHostname(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return p === h;
}
