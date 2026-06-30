// Shared host-bootstrap helpers — keeps the per-host adapter boot.ts files
// from drifting on state-class wiring or universal-module subscription
// order. Each adapter band still owns:
//   - the HostAdapter implementation (DOM vs node:* vs OpenTUI)
//   - the bindings → adapter construction
//   - the per-host log function + isDebugEnabled gating
//   - any conditional optional modules whose construction shape differs
//     between hosts (Statusline file path vs in-process hook, TTS script
//     vs speakFn, Resolver httpAdapter override, etc.)
//
// Everything below is identical across hosts and lives here once. If you
// add a new universal state class or a module that always wires the same
// way regardless of host, put it here so both adapters pick it up at the
// same time.
//
// Tested via the existing Navigation/DimRender/Cycling/BlankFill module
// suites that already exercise the wiring against MockAdapter — adding a
// boot-common-specific test would mostly duplicate them.

import type { HostAdapter, LogLevel } from './adapter';
import type { ResolvedAgentLLM } from './modules/agent-rewrite';

/* ─── Direct-launch drift advisory ───────────────────────────────────────
 *
 * `opencues run <host>` calls a CLI-side srcHash check + auto-rebuild
 * before spawning the host (see PR #42). Direct launches —
 * `claude-cues` typed straight from bash, `oc-shell` aliased to a
 * key, anything that bypasses `opencues run` — never hit that path.
 *
 * `checkRuntimeDrift` closes the gap from the runtime side. The
 * runtime knows its own bundled version (from its package.json) and
 * reads the marker the installer wrote at install time. If the
 * marker records a `repoRoot` AND the repo's current runtime
 * package.json version is HIGHER than the running runtime's version,
 * we warn the user once at boot — they have unpulled-bundle drift.
 *
 * Limits:
 *   - Doesn't compute srcHash (would walk 200+ files at boot — too
 *     expensive). Catches "version was bumped in source but bundle
 *     wasn't re-installed". Doesn't catch "source changed without a
 *     version bump" — that's exclusively the CLI's srcHash check
 *     fires via `opencues run`. Direct-launch users see drift only
 *     when versions were bumped.
 *   - Silently skips when (a) no marker file found, (b) marker has
 *     no repoRoot, (c) repoRoot doesn't exist on disk (npm-published
 *     install with no clone), (d) `host.readFile` is unavailable
 *     (chrome — no node fs). Designed for fail-open: never blocks a
 *     legitimate launch.
 *   - Marker discovery is a fixed list of relative paths off the
 *     runtime's own location. Hosts that install the marker
 *     elsewhere need a candidate entry added.
 *
 * Output: one `[opencues] WARN: bundled runtime <X> < source <Y> —
 * run \`opencues update <host>\` to pick up changes.` line via
 * `adapter.log('warn', ...)`. Same channel every other boot log uses.
 */
export async function checkRuntimeDrift(
  adapter: HostAdapter,
  options: { runtimeVersion?: string } = {},
): Promise<void> {
  try {
    // Node-only path — chrome has no `fs` / `path`. The dynamic require
    // throws under the chrome stub; we catch and silent-skip.
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;

    // Find this runtime's bundled package.json so we know our own
    // version. We're running from `<install root>/node_modules/@opencues/runtime/dist/...`.
    // The package.json sits two levels up from dist/ (dist/src/* → dist/* → package.json).
    // Multiple candidate depths cover both the dist/src/ layout and
    // dist/ flat layout some bundlers produce.
    const runtimeBundlePkg = locatePackageJson(fs, path, __dirname);
    if (!runtimeBundlePkg) return;
    const bundlePkg = safeReadJson(fs, runtimeBundlePkg);
    const bundledVersion: string | null = options.runtimeVersion
      ?? (bundlePkg && typeof bundlePkg.version === 'string' ? bundlePkg.version : null);
    if (!bundledVersion) return;

    // Marker candidates — derived from where each host installs.
    // host.cwd is the user's working dir, NOT the install root, so we
    // walk up from the runtime's dist location to find the install
    // root (3 levels: dist/src/<file> → dist/src → dist → @opencues/runtime → @opencues → node_modules → <fork>).
    // Then probe each host's marker dir.
    const installRoot = findInstallRoot(fs, path, runtimeBundlePkg);
    if (!installRoot) return;
    const markerCandidates = [
      path.join(installRoot, '.cues', 'version.json'),       // CC
      path.join(installRoot, '.opencues', 'version.json'),   // OC / gemini
      path.join(installRoot, 'node_modules', '@opencues', 'version.json'), // shell self-owned
    ];
    let marker: Record<string, unknown> | null = null;
    for (const c of markerCandidates) {
      const parsed = safeReadJson(fs, c);
      if (parsed && typeof parsed === 'object') {
        marker = parsed;
        break;
      }
    }
    const repoRoot = marker && typeof marker.repoRoot === 'string' ? marker.repoRoot : null;
    if (!repoRoot) return;

    // Compare bundled runtime version against the source's current
    // runtime version. If source moved ahead, warn.
    const sourceRuntimePkg = path.join(repoRoot, 'packages', 'opencues-runtime', 'package.json');
    const sourcePkg = safeReadJson(fs, sourceRuntimePkg);
    const sourceVersion = sourcePkg && typeof sourcePkg.version === 'string' ? sourcePkg.version : null;
    if (!sourceVersion) return;
    if (sourceVersion === bundledVersion) return; // fresh
    if (!isHigherVersion(sourceVersion, bundledVersion)) return; // source is OLDER (rollback) — don't nag

    adapter.log(
      'warn',
      `[opencues] bundled runtime ${bundledVersion} is older than source ${sourceVersion} ` +
      `at ${repoRoot}. Run \`opencues run ${adapter.hostName}\` (auto-rebuilds) or ` +
      `\`opencues update ${adapter.hostName}\` to refresh the bundle. ` +
      `Pass \`--no-rebuild-check\` to suppress this if intended.`,
    );
  } catch {
    // Any failure (chrome stub, missing fs, parse error, permissions)
    // → silent skip. Drift advisory is never load-bearing.
  }
}

function safeReadJson(
  fs: typeof import('node:fs'),
  p: string,
): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function locatePackageJson(
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  startDir: string,
): string | null {
  // Walk up from startDir looking for a package.json whose name is
  // @opencues/runtime. Caps at 6 levels — runtime dist depth is
  // usually 2-4.
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    const parsed = safeReadJson(fs, candidate);
    if (parsed && parsed.name === '@opencues/runtime') return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findInstallRoot(
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  runtimePkgPath: string,
): string | null {
  // runtimePkgPath is `<install root>/node_modules/@opencues/runtime/package.json`
  // for fork-style installs. Walk up to the directory CONTAINING node_modules.
  const runtimeDir = path.dirname(runtimePkgPath); // /node_modules/@opencues/runtime
  const opencuesDir = path.dirname(runtimeDir);    // /node_modules/@opencues
  const nodeModulesDir = path.dirname(opencuesDir); // /node_modules
  if (path.basename(nodeModulesDir) !== 'node_modules') return null;
  return path.dirname(nodeModulesDir);
}

function isHigherVersion(a: string, b: string): boolean {
  // Simple semver compare — works for our 0.x.y range. Returns true
  // iff a > b. Falls back to string compare on parse failure.
  const ax = a.split('.').map(n => parseInt(n, 10));
  const bx = b.split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const av = ax[i] ?? 0;
    const bv = bx[i] ?? 0;
    if (Number.isNaN(av) || Number.isNaN(bv)) return a > b;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}


/* ─── Source reclassification helper ─────────────────────────────────────
 *
 * Both bootstraps need the same shape: stash text the runtime wrote,
 * then reclassify subsequent text-change events as source='runtime' if
 * the text matches a recent stash. Multi-shot within a short TTL
 * window — DOM reconciliation pipelines (Lexical, ProseMirror,
 * Gmail's compose) fire MULTIPLE input events per programmatic write,
 * and a single-shot reclassifier only catches the first.
 *
 * Bug history (May 2026): with one-shot matching, the FIRST input
 * event from a TransformBlank substitute was reclassified to
 * 'runtime' and skipped by the Resolver. The SECOND+ echo events (from
 * MutationObserver-triggered re-renders) arrived after the stash was
 * cleared and got tagged 'user'. The Resolver then processed them
 * normally, fired the `_`-pipeline on the runtime's own substituted
 * buffer (which often still contained a `_` the LLM had failed to
 * strip), and produced a runaway loop — one user `_ trigger` → 4+
 * full ConfigIntent+TransformBlank+FluidBlank cycles in 7 seconds
 * observed on chrome.
 *
 * Multi-shot fix: keep a list of recent writes, TTL them out after
 * 250ms (long enough to cover the typical 10-150ms DOM echo window,
 * short enough that a user typing the exact same content moments
 * later isn't misclassified).
 *
 * Hosts call markRuntimeWrite(text) inside their setText/pushText, and
 * reclassify(text, source) inside their notifyOpenCuesTextChange.
 */
export interface SourceReclassifier {
  /** Stash text written by the runtime so subsequent matching input
   *  events flip source to 'runtime' (within the TTL window). Hosts
   *  whose write path normalises whitespace (chrome's execCommand)
   *  should call this AFTER the write with the actual post-DOM text. */
  markRuntimeWrite(text: string): void;
  /** Returns 'runtime' when the incoming text matches a recent marked
   *  runtime write (within RUNTIME_WRITE_TTL_MS), otherwise the
   *  proposed source. */
  reclassify(text: string, proposedSource: 'user' | 'runtime'): 'user' | 'runtime';
}

/** Time window in which subsequent matching input events are still
 *  reclassified to 'runtime'. 250ms covers the typical DOM-echo
 *  window (50-200ms on Gmail/Lexical/PM) with margin, while staying
 *  well under any realistic gap between a runtime substitute and a
 *  user typing the identical text manually. */
export const RUNTIME_WRITE_TTL_MS = 250;

export function createSourceReclassifier(now: () => number = Date.now): SourceReclassifier {
  const recent: Array<{ text: string; addedAt: number }> = [];

  function pruneStale(t: number): void {
    const cutoff = t - RUNTIME_WRITE_TTL_MS;
    while (recent.length > 0 && recent[0].addedAt < cutoff) recent.shift();
  }

  return {
    markRuntimeWrite(text: string): void {
      const t = now();
      pruneStale(t);
      recent.push({ text, addedAt: t });
    },
    reclassify(text: string, proposedSource: 'user' | 'runtime'): 'user' | 'runtime' {
      const t = now();
      pruneStale(t);
      // Multi-shot match WITHOUT consumption — a single runtime write
      // can produce multiple DOM-echo input events (Gmail compose
      // fires 2-4; ProseMirror's reconciler can fire more). All of
      // them carry the same text; all of them need to reclassify to
      // 'runtime' so the Resolver skips the entire batch. Consuming
      // on first match leaves the remaining echoes mislabeled as
      // 'user', which was the May 2026 runaway-loop bug. Stale
      // entries age out via pruneStale's TTL.
      if (recent.some(w => w.text === text)) return 'runtime';
      return proposedSource;
    },
  };
}

/* ─── Log factory ────────────────────────────────────────────────────────
 *
 * Both bootstraps build a log function that:
 *  - gates 'debug' through `isDebugEnabled` (reads OPENCUES.md
 *    debug-mode lazily so a popup/file edit can toggle it without
 *    restart),
 *  - delegates everything else to a host-supplied sink (console on
 *    chrome, fs.appendFileSync on opencode).
 *
 * This factory just composes those two pieces.
 */
export interface LogFactoryOptions {
  /** Host-supplied sink. Errors thrown by the sink are swallowed so
   *  flaky logging can't crash the runtime. */
  readonly sink: (level: LogLevel, msg: string, data?: unknown) => void;
  /** Lazy debug gate. Re-evaluated on every log call so OPENCUES.md
   *  hot-reloads pick up new debug-mode without restart. */
  readonly isDebugEnabled?: () => boolean;
}

export function createLogFunction(
  opts: LogFactoryOptions,
): (level: LogLevel, msg: string, data?: unknown) => void {
  const { sink, isDebugEnabled } = opts;
  return (level, msg, data) => {
    // No gate supplied = all levels pass through (caller opted out of
    // gating). When supplied, debug is dropped unless the gate returns
    // true. Re-evaluated per call so OPENCUES.md hot-reloads pick up
    // a flipped debug-mode without restart.
    if (level === 'debug' && isDebugEnabled !== undefined && !isDebugEnabled()) return;
    try { sink(level, msg, data); } catch { /* swallow */ }
  };
}
import { ConfigLoader } from './modules/config-loader';
import { BlankContextCache } from './modules/blank-context-cache';

/**
 * Build the AgentRewrite `resolveLLM` thunk for boot files. Reads the
 * current `agent-provider:` / `agent-model:` / `agent-endpoint:`
 * OPENCUES.md frontmatter (with falls-through to global `llm-provider:`
 * / `llm-model:` / `llm-endpoint:`), looks up the right ProviderAdapter
 * from @opencues/core, and returns the resolved tuple. Returns null
 * when no key is available for the resolved provider, OR when
 * @opencues/core can't be require()'d (rare — usually a packaging
 * misstep). The runtime falls back to its built-in Groq-shaped path
 * in that case.
 *
 * Re-resolves on every tick (callers wrap this in an arrow), so
 * OPENCUES.md hot-reload propagates without an integration restart.
 */
export function buildAgentLLMResolver(
  configLoader: ConfigLoader,
  apiKeys: Readonly<Record<string, string | undefined>>,
): ResolvedAgentLLM | null {
  let core: { resolveLLM?: (opts: unknown) => unknown } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    core = require('@opencues/core');
  } catch {
    return null;
  }
  if (!core?.resolveLLM) return null;
  const s = configLoader.opencuesState.settings;
  // Auditors bucket override sits BETWEEN per-feature (agent-provider /
  // agent-model) and the global llm-provider tier. `inherit` collapses
  // to undefined so the bucket disappears and global takes over —
  // mirrors the cues/blanks bucket collapse in build-sources.ts.
  const auditorsBucket = configLoader.opencuesState.auditorsLlmProvider;
  const auditorsBucketProvider = auditorsBucket === 'inherit' ? undefined : auditorsBucket;
  const auditorsBucketModel = auditorsBucketProvider ? s.get('auditors-llm-model') : undefined;
  const auditorsBucketEndpoint = auditorsBucketProvider ? s.get('auditors-llm-endpoint') : undefined;
  const out = core.resolveLLM({
    featureProvider: s.get('agent-provider'),
    featureModel: s.get('agent-model'),
    endpointOverride: s.get('agent-endpoint') ?? auditorsBucketEndpoint ?? s.get('llm-endpoint'),
    // Bucket-then-global precedence. When the user pins
    // `auditors-llm-provider: cerebras` it wins over the global
    // `llm-provider`; per-feature `agent-provider:` still wins above
    // both.
    globalProvider: auditorsBucketProvider ?? s.get('llm-provider'),
    globalModel: auditorsBucketProvider
      ? (auditorsBucketModel ?? undefined)
      : s.get('llm-model'),
    apiKeys,
  }) as ResolvedAgentLLM | null;
  if (!out) return null;
  // Thread the `max-thinking` toggle (default on) onto the resolved
  // tuple so AgentRewrite's dispatch honours the same per-model
  // reasoning-budget resolution as the cue/blank sources. `agent-rewrite`
  // reads the auditors bucket; `off` drops its reasoning-capable models
  // to their reduced level. See @opencues/core/model-thinking.ts.
  return { ...out, maxThinking: (s.get('max-thinking') ?? 'on') !== 'off' };
}

import { Navigation } from './modules/navigation';
import { DimRender } from './modules/dim-render';
import { Cycling } from './modules/cycling';
import { BlankFill } from './modules/blank-fill';
import { BlankLoadingAnimator, parseCustomFrames, parseRgbColors, parseAnsiColors, parseFrameIntervalMs, DEFAULT_RGB_PALETTE, DEFAULT_ANSI_PALETTE } from './modules/blank-loading';
import { MarkdownRender } from './modules/markdown-render';
import { HighlightState } from './state/highlight-state';
import { DynDefs } from './state/dyn-defs';
import { SpanFillState } from './state/span-fill';
import { DismissedBlanks } from './state/dismissed-blanks';
import { SelectorSatelliteState } from './state/selector-satellite';
import { AgentTaskState } from './state/agent-task';

/** State + ConfigLoader the optional modules (Statusline / TTS / Resolver
 *  / CursorStateExport) and the host's BootResult need access to. */
export interface SharedRuntime {
  readonly configLoader: ConfigLoader;
  readonly hlState: HighlightState;
  readonly dynDefs: DynDefs;
  readonly spanFillState: SpanFillState;
  readonly dismissedBlanks: DismissedBlanks;
  readonly selectorSatelliteState: SelectorSatelliteState;
  readonly agentTaskState: AgentTaskState;
  /** Shared loading-glyph animator for in-flight `_` slots. Passed to
   *  BlankFill (keyword-bound slots) and to Resolver (Fluid/Transform
   *  slots) so both code paths share state and don't race. */
  readonly blankLoading: BlankLoadingAnimator;
  /** Markdown overlay renderer — parses **bold** / *italic* / `code`
   *  etc. on LLM-substitution events and emits per-range directives
   *  the host's render pipeline picks up. */
  readonly markdownRender: MarkdownRender;
  /** Keyword-bound `_` slot detector. Adapters thread this into the
   *  Resolver's `keywordBoundSlotIndices` option so the blank-as-context
   *  catalog fetch is skipped when every `_` is already claimed by
   *  BlankFill — saves ~5 sequential script/network calls per resolve
   *  on inputs like `volume _` / `weather _` / `nvidia _`. */
  readonly blankFill: BlankFill;
}

export interface BuildSharedRuntimeOptions {
  /** Same log function the host uses. Errors from ConfigLoader.load
   *  + BlankFill.subscribe wiring flow through it. */
  readonly log: (level: LogLevel, msg: string, data?: unknown) => void;
  /** Search paths for `.cues/` config dirs, in priority order
   *  (project first, user second). Falls back to `[adapter.cwd]` when
   *  unset for backwards compat. See ConfigLoaderOptions. */
  readonly configSearchPaths?: readonly string[];
  /** Path to `OPENCUES.md` (user-level runtime config, frontmatter
   *  format). When unset, settings stay at runtime defaults. */
  readonly settingsFile?: string;
  /** Resolves the API-key bag the host gathered at boot. Threaded into
   *  Cycling so the satellite-cycle path can skip llm-provider values
   *  whose env key isn't set — prevents committing a broken
   *  (provider, no-key) pair to OPENCUES.md via Ctrl+Alt+Up.
   *  Omit to disable filtering (back-compat default; the cycling menu
   *  then matches its pre-June-2026 behaviour of cycling blindly). */
  readonly getApiKeys?: () => Readonly<Record<string, string | undefined>>;
  /** Optional probe for `transport: 'cli'` providers
   *  (claude-code-cli, openai-subscription) — true iff the CLI binary
   *  is on PATH. Hosts that don't shell out (chrome) leave undefined,
   *  in which case CLI providers are conservatively dropped from the
   *  cycling menu. */
  readonly isCliProviderAvailable?: (providerId: string) => boolean;
}

/**
 * Native-host error formatter shared by CC / OC / gemini-cli / terminal
 * — chrome supplies its own (popup-specific phrasing). The messages
 * mention `~/.cues/.env` + shell env because that's where native hosts
 * read keys + scalars from. Returns the in-buffer text the runtime
 * substitutes for the failed `_`.
 *
 * Wired by each non-chrome boot via `ResolverOptions.formatLLMErrorAsSubstitute`.
 * Resolver hands every classified user-actionable HTTP failure
 * (401/403/404/429/400/network) through this function; LLM-internal
 * errors (no-span, malformed JSON, 5xx) stay silent unconditionally.
 */
/**
 * Build a `blankContextProvider` closure for the Resolver constructor.
 *
 * The resolver invokes this on every resolve when
 * `blank-context-mode !== 'off'`. We plan slots for every blank with
 * `as-context: safe|raw` in its frontmatter, then snapshot via the
 * BlankContextCache (lazy TTL refresh on prompt-build, fail-soft `[STALE]`
 * on fetch error). Returns `undefined` when no host blanks are wired
 * (chrome host-process path) or the user hasn't opted in any blanks.
 *
 * See docs/features/blank-as-context.md.
 */
/**
 * Closure returned by `buildBlankContextProvider`. Carries an optional
 * `.stop()` hook so tests + future explicit-teardown callers can cancel
 * the background pre-warm timer. Production callers don't need to wire
 * it — the timer is `.unref()`'d, so it doesn't block process exit.
 */
export type BlankContextProvider = ((() => Promise<
  | { fields: ReadonlyArray<{ token: string; description: string; value: string }>;
      catalog: ReadonlyMap<string, string>;
      mode: 'safe' | 'raw' }
  | undefined
>)) & { stop?: () => void };

export function buildBlankContextProvider(
  configLoader: ConfigLoader,
  blanks: ReadonlyMap<string, import('./blanks/types').Blank> | undefined,
  log: (level: LogLevel, msg: string) => void,
): BlankContextProvider | undefined {
  if (!blanks || blanks.size === 0) return undefined;
  // Dynamic require — opencues-core may not be loadable in every host
  // build (chrome bundle was a notable case until June 2026). Skip the
  // wire-up gracefully when it isn't.
  let core: {
    planBlankContextSlots?: (cfg: unknown, identity: unknown) => { slots: ReadonlyArray<{ blankName: string; slot: string; token: string; description: string }>; warnings: ReadonlyArray<string> };
  } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    core = require('@opencues/core');
  } catch {
    return undefined;
  }
  if (!core?.planBlankContextSlots) return undefined;
  const cache = new BlankContextCache();

  const runProvider = async () => {
    const mode = configLoader.opencuesState.blankContextMode;
    if (mode === 'off') return undefined;
    const identity = configLoader.identity;
    // Plan slots across every shipped blank with as-context opt-in.
    const merged = configLoader.mergedBlanksConfig?.blanks ?? {};
    const allPlans: Array<{ blankName: string; slot: string; token: string; description: string }> = [];
    const ttls = new Map<string, number>();
    for (const [name, blankCfg] of Object.entries(merged)) {
      if (!blankCfg.asContext || blankCfg.asContext === 'off') continue;
      const result = core!.planBlankContextSlots!(blankCfg, identity);
      allPlans.push(...result.slots);
      for (const w of result.warnings) log('warn', `blank-context: ${w}`);
      ttls.set(name, (blankCfg.contextTtl ?? 60) * 1000);
    }
    if (allPlans.length === 0) return undefined;
    const snap = await cache.snapshot(allPlans, blanks, ttls);
    return { fields: snap.fields, catalog: snap.catalog, mode };
  };

  // Pre-warm timer — self-rescheduling so the interval (read from
  // `blank-context-prewarm-ms`) hot-reloads without a host restart.
  //
  // Why this exists: pre-#131, the first `_` after launch always paid
  // the full HTTP fan-out (~200-300ms for stocks+weather+crypto+HN even
  // with the parallelised Promise.all). #131 brought it down to ~210ms.
  // The pre-warm timer reduces that to ~0ms on the FIRST user call:
  // it fires runProvider in the background every interval, populating
  // the cache; user-triggered calls then find every entry within TTL
  // and skip every HTTP round-trip.
  //
  // Quality risk: zero. The timer runs the SAME runProvider code path
  // the user-triggered call uses; snapshot CONTENT is identical, only
  // timing differs. A swallowed error in the timer (network blip) just
  // means the next user call falls back to lazy refresh — exactly the
  // pre-#131 behaviour.
  let timerHandle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (configLoader.opencuesState.blankContextMode !== 'off') {
        await runProvider();
      }
    } catch {
      // Timer is a backstop. Errors here are silently absorbed; the
      // user-triggered call will retry on its own.
    }
    if (stopped) return;
    const next = readPrewarmIntervalMs(configLoader);
    // When `off`, recheck every 5s so re-enabling via OPENCUES.md edit
    // brings the timer back without a host restart.
    const delay = next > 0 ? next : 5_000;
    timerHandle = setTimeout(() => { void tick(); }, delay);
    // Don't pin the Node event loop alive in tests / short-lived hosts.
    (timerHandle as { unref?: () => void }).unref?.();
  };
  // Fire once immediately so the FIRST user `_` after launch hits warm
  // cache. Fire-and-forget — runProvider has its own try/catch above.
  void tick();

  const provider = runProvider as BlankContextProvider;
  provider.stop = () => {
    stopped = true;
    if (timerHandle) clearTimeout(timerHandle);
  };
  return provider;
}

/** Read the `blank-context-prewarm-ms` setting. Returns 0 when
 *  disabled (`off`), a positive number of milliseconds otherwise.
 *  Misparses + sub-1s values fall back to the 35s default. */
function readPrewarmIntervalMs(configLoader: ConfigLoader): number {
  const raw = configLoader.opencuesState.settings.get('blank-context-prewarm-ms');
  if (!raw) return 35_000;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'off' || trimmed === '0') return 0;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1000) return 35_000;
  return n;
}

export function nativeHostFormatLLMError(
  reason: 'invalid-api-key' | 'network' | 'rate-limit' | 'endpoint-not-found' | 'model-not-found' | 'insufficient-credits' | 'bad-request',
): string {
  // Provider's own JSON error deliberately NOT inlined — it can be
  // ugly, leak details, or vary wildly across providers. The reason
  // class + actionable hint is enough.
  switch (reason) {
    case 'invalid-api-key':    return '[OpenCues: API key rejected (401/403) — re-export the provider\'s API key in your shell env (or ~/.cues/.env)]';
    case 'endpoint-not-found': return '[OpenCues: provider endpoint returned 404 — check `llm-endpoint:` in ~/.cues/OPENCUES.md]';
    case 'model-not-found':    return '[OpenCues: model not available for the chosen provider — make `llm-model:` and `llm-provider:` in ~/.cues/OPENCUES.md a valid pair (Cerebras serves `gpt-oss-120b`; Groq/OpenRouter serve `openai/gpt-oss-120b`)]';
    case 'insufficient-credits': return '[OpenCues: provider rejected the request — out of credits / quota. Top up the account, or switch `llm-provider:` in ~/.cues/OPENCUES.md to a provider whose key has credit.]';
    case 'rate-limit':         return '[OpenCues: provider rate-limit hit (429) — wait a moment or switch `llm-provider:` in OPENCUES.md]';
    case 'network':            return '[OpenCues: network error — provider unreachable. Check connectivity, then retry.]';
    case 'bad-request':        return '[OpenCues: provider returned 400 (bad request) — check the llm-model: you set in OPENCUES.md matches the chosen provider]';
  }
}

/**
 * Native-host no-key fallback message — wired by CC / OC / gemini-cli
 * / terminal boots via `ResolverOptions.missingKeyFallbackMessage`. Used
 * when the user types `_` AND no LLM source could be wired (zero keys).
 * Chrome supplies its own (popup-specific phrasing).
 */
export const NATIVE_HOST_MISSING_KEY_MESSAGE =
  '[OpenCues: no API key — set CEREBRAS_API_KEY (or another provider\'s key) in ~/.cues/.env or your shell env]';

/**
 * Construct ConfigLoader, every state class, and subscribe the universal
 * modules (Navigation, DimRender, Cycling, BlankFill). Hosts call this
 * after building the adapter — the returned SharedRuntime is then handed
 * to optional modules they wire conditionally (Statusline / TTS / etc.).
 *
 * Module subscription order matches the original per-host boot.ts files —
 * any reordering should happen here so both bands change together.
 */
export function buildSharedRuntime(
  adapter: HostAdapter,
  opts: BuildSharedRuntimeOptions,
): SharedRuntime {
  const { log, configSearchPaths, settingsFile, getApiKeys, isCliProviderAvailable } = opts;

  // Fire-and-forget direct-launch drift advisory. Runs once per boot,
  // catches users who launched the host directly (bypassing
  // `opencues run`'s CLI-side srcHash check). Silent skip when no
  // marker / no repo / chrome / any error. See `checkRuntimeDrift`
  // for the limits.
  void checkRuntimeDrift(adapter);

  // ConfigLoader first — every other module depends on it. load() runs
  // async; modules tolerate the empty pre-load window.
  const configLoader = new ConfigLoader(adapter, { configSearchPaths, settingsFile });
  configLoader.subscribe();
  configLoader.load().catch(err => log('error', 'ConfigLoader.load failed', err));

  // State classes. Order is dependency-irrelevant but matches the
  // historical declaration order in both per-host boot.ts files.
  const hlState = new HighlightState();
  const dynDefs = new DynDefs();
  const spanFillState = new SpanFillState();
  const dismissedBlanks = new DismissedBlanks();
  const selectorSatelliteState = new SelectorSatelliteState();
  const agentTaskState = new AgentTaskState();

  // Universal modules — wired identically on every host.
  const navigation = new Navigation(
    adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState,
  );
  navigation.subscribe();

  const dimRender = new DimRender(
    adapter, hlState, dynDefs, configLoader, spanFillState, selectorSatelliteState,
  );
  dimRender.subscribe();

  const cycling = new Cycling(
    adapter, hlState, dynDefs, configLoader,
    spanFillState, dismissedBlanks, selectorSatelliteState,
    getApiKeys, isCliProviderAvailable,
  );
  cycling.subscribe();

  // Shared loading-animation owner. Used by both BlankFill (keyword-
  // bound slots like `volume _`) and the Resolver (TransformBlank +
  // FluidBlank slots like `make this shorter _` and `capital of france _`).
  // One instance keeps the animation timer + state coherent — without
  // it BlankFill and Resolver would each spin their own and race on
  // shared slots.
  const blankLoading = new BlankLoadingAnimator({
    adapter,
    mode: () => {
      const raw = configLoader.opencuesState.settings.get('blank-loading-animation');
      if (raw === 'off' || raw === 'braille-rotate' || raw === 'flipper' || raw === 'custom') return raw;
      return 'bounce';
    },
    customFrames: () => parseCustomFrames(
      configLoader.opencuesState.settings.get('blank-loading-frames'),
    ),
    rgbColors: () => parseRgbColors(
      configLoader.opencuesState.settings.get('blank-loading-colors-rgb'),
    ) ?? DEFAULT_RGB_PALETTE,
    ansiColors: () => parseAnsiColors(
      configLoader.opencuesState.settings.get('blank-loading-colors-ansi'),
    ) ?? DEFAULT_ANSI_PALETTE,
    frameIntervalMs: () => parseFrameIntervalMs(
      configLoader.opencuesState.settings.get('blank-loading-interval-ms'),
    ),
    log: msg => log('debug', msg),
  });

  // Register the animator as a render handler so its per-frame colours
  // flow through the existing RenderDirectives pipeline. The host picks
  // ansi vs rgb by capability (`render-rgb-color` advertises full
  // colour support — chrome only at the moment). Without that
  // capability, default to ANSI which works for every terminal host.
  const wantsRgb = adapter.capabilities.includes('render-rgb-color');
  adapter.onRender((ctx) => {
    const ranges = blankLoading.getActiveColoredRanges(ctx.text, wantsRgb ? 'rgb' : 'ansi');
    if (ranges.length === 0) return null;
    return {
      coloredRanges: ranges.map(r => ({
        start: r.start,
        end: r.end,
        ...(wantsRgb ? { rgb: r.color } : { ansi: r.color }),
      })),
    };
  });

  // BlankFill subscribes only after ConfigLoader.load resolves so its
  // initial scan sees the populated blanksByWord map. Same pattern
  // both hosts had inline. Routing is deterministic (blankShapes) — the
  // old LLM BlankIntent gate was retired.
  const blankFill = new BlankFill(
    adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs, blankLoading,
  );
  configLoader.load()
    .then(() => blankFill.subscribe())
    .catch(err => log('error', 'BlankFill: deferred subscribe failed', err));

  // MarkdownRender — receives `markdown.styled` events from substituting
  // modules and exposes the per-style ranges as RenderDirectives. The
  // strip happens in markdown-substitute.ts at write time; MarkdownRender
  // is purely a directive-emitter.
  const markdownRender = new MarkdownRender(adapter);
  markdownRender.subscribe();

  return {
    configLoader,
    hlState,
    dynDefs,
    spanFillState,
    dismissedBlanks,
    selectorSatelliteState,
    agentTaskState,
    blankLoading,
    markdownRender,
    blankFill,
  };
}

/* ─── Per-buffer state reset ─────────────────────────────────────────────
 *
 * Wipe the state objects whose contents are bound to specific character
 * offsets / word indices in the live buffer. Callers fire this whenever
 * an external mutation has invalidated those offsets:
 *
 *   - Chrome content script — focus change between fields (each field
 *     is its own buffer with its own word indices), AND buffer-replacing
 *     input events (undo / redo / paste / IME commit / native autocomplete).
 *   - Native hosts — TBD per host. Terminal undo, paste, and any host-
 *     UI write that bypasses the runtime's setText pipeline qualify.
 *
 * What gets cleared:
 *   dynDefs                — leftover word-position entries either render
 *                            phantom highlights or block legit substitutions
 *                            (the May 2026 "first `_` doesn't work" bug).
 *   hlState                — stale highlight pointer renders the wrong
 *                            word as "current" until the user moves caret.
 *   spanFillState          — in-flight span-fill from the prior buffer
 *                            state would splice into the new text at the
 *                            same character range.
 *   selectorSatelliteState — mid-cycle on a settings selector would resume
 *                            against the wrong buffer (wrong-buffer settings
 *                            writes).
 *
 * Deliberately NOT cleared (session-scoped, not buffer-scoped):
 *   agentTaskState  — armed `agentically X _` task survives so users can
 *                     leave a draft, tab away, return without re-arming.
 *   dismissedBlanks — dismissing `weather _` once stays dismissed for the
 *                     session; undo shouldn't resurrect the suggestion.
 *
 * Resolver re-runs on the next keystroke debounce — the user sees a clean
 * buffer briefly, then cues repopulate. Acceptable UX cost vs. the silent
 * desync that partial reconciliation would produce.
 *
 * Idempotent — safe to call repeatedly (focus-change spam, input-event
 * bursts during paste or IME composition).
 *
 * Signature takes a minimal structural type, not `SharedRuntime`, so the
 * CC v2.1 boot (which builds its state classes inline rather than via
 * `buildSharedRuntime`) can pass the same locals it already has — every
 * band stays in lockstep on the wipe set without forcing CC to also
 * adopt SharedRuntime.
 */
export function resetSharedBufferState(state: {
  readonly dynDefs: Pick<DynDefs, 'clear'>;
  readonly hlState: Pick<HighlightState, 'deactivate'>;
  readonly spanFillState: Pick<SpanFillState, 'clear'>;
  readonly selectorSatelliteState: Pick<SelectorSatelliteState, 'clear'>;
  /** Optional: deeper module + source state that survives a basic
   *  buffer-state wipe. Keep-alive hosts crossing session boundaries
   *  and off-process bridge drivers calling `reset` mid-session both
   *  need these cleared too — otherwise dismissed-blank flags, primed
   *  caches, in-flight resolver controllers leak across what should
   *  be independent sessions. Hosts that don't thread these in stay
   *  buffer-state-only (back-compat). */
  readonly dismissedBlanks?: Pick<DismissedBlanks, 'clear'>;
  readonly agentTaskState?: Pick<AgentTaskState, 'stop'>;
  readonly blankFill?: { resetState(): void };
  readonly markdownRender?: { resetState(): void };
  /** Optional: Resolver + AgentRewrite reset hooks. The Resolver
   *  isn't part of SharedRuntime (constructed per adapter band) but
   *  the adapter exposes its resetState via this same path so the
   *  reset surface stays one-shot for callers. */
  readonly resolver?: { resetState(): void };
  readonly agentRewrite?: { resetState(): void };
}): void {
  state.dynDefs.clear();
  state.hlState.deactivate();
  state.spanFillState.clear();
  state.selectorSatelliteState.clear();
  // Optional-module clears are defensive: `typeof === 'function'`
  // tolerates callers that pass a SharedRuntime-shaped object with
  // stub fields (existing back-compat tests do this), as well as
  // earlier-vintage runtimes whose module classes pre-date the
  // resetState method.
  if (typeof state.dismissedBlanks?.clear === 'function') state.dismissedBlanks.clear();
  if (typeof state.agentTaskState?.stop === 'function') state.agentTaskState.stop();
  if (typeof state.blankFill?.resetState === 'function') state.blankFill.resetState();
  if (typeof state.markdownRender?.resetState === 'function') state.markdownRender.resetState();
  if (typeof state.resolver?.resetState === 'function') state.resolver.resetState();
  if (typeof state.agentRewrite?.resetState === 'function') state.agentRewrite.resetState();
}
