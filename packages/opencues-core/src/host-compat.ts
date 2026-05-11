/**
 * Host-compat: which OpenCues integrations a cue or blank runs on.
 *
 * The OpenStandard supports multiple host integrations — claude-code,
 * opencode, gemini-cli, chrome — that share the same .md config format but
 * have different runtime capabilities. The most consequential split is:
 *
 *   - Native hosts (claude-code, opencode, gemini-cli) can spawn subprocesses
 *     and read arbitrary filesystem paths. Shell-script-backed blanks
 *     (volume.sh, brightness.sh, …) only run here.
 *
 *   - Chrome can't spawn subprocesses or read arbitrary paths from a
 *     content-script context. Only LLM cues + runtime-class blanks
 *     (HackerNews, Stocks, Weather, …) work in chrome.
 *
 * Rather than make every cue author declare compatibility manually, we
 * INFER it from `script:` / `blankScript:` extension. Authors can override
 * with explicit `not-on-host:` / `on-host:` frontmatter when the auto-
 * detection is wrong.
 *
 * Auto-detection rules:
 *
 *   script: ./X.sh             → not chrome  (subprocess)
 *   script: ./X.ps1            → not chrome  (subprocess)
 *   script: ./X.exe            → not chrome  (subprocess)
 *   script: ./X.bat            → not chrome  (subprocess)
 *   script: ./X.cmd            → not chrome  (subprocess)
 *   script: ./X.py             → not chrome  (subprocess)
 *   script: ./X.rb             → not chrome  (subprocess)
 *   blankScript: <same exts>   → not chrome
 *   no script: field           → all hosts   (LLM-only or runtime-class blank)
 *
 * Override rules (applied AFTER auto-detect):
 *
 *   on-host: [chrome]          → use as allow-list (everything else excluded)
 *   not-on-host: [chrome]      → remove chrome from the allow-list
 *
 * Conflicts (e.g. on-host: [chrome] AND not-on-host: [chrome]) are reported
 * as warnings by `opencues validate`; the runtime treats not-on-host as
 * authoritative (deny wins).
 */

/** Every integration host. Keep alphabetical for stable equality checks. */
export const HOSTS = ['chrome', 'claude-code', 'gemini-cli', 'opencode'] as const;
export type Host = typeof HOSTS[number];

/** Native hosts can spawn subprocesses + access the filesystem. */
export const NATIVE_HOSTS: readonly Host[] = ['claude-code', 'gemini-cli', 'opencode'];

/** Script extensions that imply subprocess execution → not chrome. */
const SUBPROCESS_EXTS = ['.sh', '.bash', '.ps1', '.bat', '.cmd', '.exe', '.py', '.rb', '.pl'];

/**
 * The subset of frontmatter fields host-compat inference looks at.
 * Accepts both monolithic BlankConfig (camelCase) and SingleCueFrontmatter
 * (raw YAML keys) — the latter has `not-on-host` with hyphens.
 */
export interface HostCompatInput {
  /** Path to a script — extension is what matters. */
  readonly script?: string;
  /** Same as script but for blank mode. */
  readonly blankScript?: string;
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
  readonly source: 'auto' | 'on-host' | 'not-on-host' | 'auto+not-on-host';
}

/**
 * Compute which hosts an entry runs on. Pure function — no I/O.
 *
 * Examples:
 *
 *   inferHostCompat({})
 *     → { hosts: [chrome, claude-code, gemini-cli, opencode], all: true, source: 'auto' }
 *
 *   inferHostCompat({ script: './volume.sh' })
 *     → { hosts: [claude-code, gemini-cli, opencode], all: false, source: 'auto' }
 *
 *   inferHostCompat({ script: './foo.sh', 'not-on-host': ['opencode'] })
 *     → { hosts: [claude-code, gemini-cli], all: false, source: 'auto+not-on-host' }
 *
 *   inferHostCompat({ 'on-host': ['chrome'] })
 *     → { hosts: [chrome], all: false, source: 'on-host' }
 */
export function inferHostCompat(input: HostCompatInput): HostCompatResult {
  const onHost = normaliseHostList(input.onHost ?? input['on-host']);
  const notOnHost = normaliseHostList(input.notOnHost ?? input['not-on-host']);

  // Stage 1: explicit on-host wins as allow-list.
  let hosts: Host[];
  let source: HostCompatResult['source'];
  if (onHost.length > 0) {
    hosts = [...onHost];
    source = 'on-host';
  } else {
    // Stage 2: auto-detect from script extension.
    const subprocess = hasSubprocessScript(input.script) || hasSubprocessScript(input.blankScript);
    hosts = subprocess ? [...NATIVE_HOSTS] : [...HOSTS];
    source = 'auto';
  }

  // Stage 3: not-on-host removes any explicit denials.
  if (notOnHost.length > 0) {
    hosts = hosts.filter(h => !notOnHost.includes(h));
    source = source === 'on-host' ? 'on-host' : 'auto+not-on-host';
  }

  hosts.sort();
  return { hosts, all: hosts.length === HOSTS.length, source };
}

/** True if a path's extension implies subprocess execution. */
function hasSubprocessScript(p: string | undefined): boolean {
  if (!p) return false;
  const lower = p.toLowerCase().trim();
  return SUBPROCESS_EXTS.some(ext => lower.endsWith(ext));
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

/** Common aliases accepted alongside canonical host names. */
const HOST_ALIASES: Record<string, Host> = {
  'cc': 'claude-code',
  'claudecode': 'claude-code',
  'claude': 'claude-code',
  'oc': 'opencode',
  'gemini': 'gemini-cli',
  'geminicli': 'gemini-cli',
};

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
