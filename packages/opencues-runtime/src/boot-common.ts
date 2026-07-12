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
import { buildBlankWeaver, type BlankWeaver } from './modules/blank-weave';
import type { HttpAdapterShape } from '@opencues/core';
import { StocksBlank } from './blanks/stocks';
import { WeatherBlank } from './blanks/weather';
import { CryptoBlank } from './blanks/crypto';

/**
 * Audited built-in fetch classes that may be `ai-callable` (LLM-arg-callable) by
 * CODE IDENTITY. Each has been reviewed for arg safety: it validates/encodes
 * its argument before any URL/query (`StocksBlank` → `[A-Z0-9.]`, `WeatherBlank`
 * → encodeURIComponent, `CryptoBlank` → `[a-z0-9-]`) and returns a bounded
 * codomain. A blank is ai-callable iff it is `instanceof` one of these OR the
 * USER explicitly trusted it via `ai-callable-allow` — a pack can never
 * self-grant by shipping the frontmatter flag. To add a class here, audit its
 * `get(arg)` arg handling first.
 */
const AUDITED_AI_CALLABLE_CLASSES = [StocksBlank, WeatherBlank, CryptoBlank] as const;

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

/**
 * AgentRewrite `identityDehydration` thunk body (buffer-dehydration
 * feature). Returns the IDENTITY.md token→value catalog when
 * `identity-context-mode: safe` and the catalog is non-empty; null
 * otherwise (`off` = feature disabled, `raw` = values are permitted to
 * ship, empty catalog = nothing to scrub). Callers wrap it in an arrow
 * (`identityDehydration: () => identityDehydrationFor(configLoader)`)
 * so IDENTITY.md / mode edits hot-reload per tick — the same pattern
 * as `buildAgentLLMResolver`. The catalog Map identity doubles as the
 * dehydrator-compile cache key (fresh Map per ConfigLoader reload).
 * See docs/architecture/hydration-dehydration.md.
 */
export function identityDehydrationFor(
  configLoader: ConfigLoader,
): { catalog: ReadonlyMap<string, string> } | null {
  if (configLoader.opencuesState.identityContextMode !== 'safe') return null;
  const catalog = configLoader.identity?.catalog;
  if (!catalog || catalog.size === 0) return null;
  return { catalog };
}

/**
 * Kata (kata) coach LLM resolver — per-feature scalars win, then the
 * auditors bucket (the coach is a background prose-reading concern, same
 * trust class as agent-rewrite), then global. Precedence:
 *   kata-llm-provider/-model/-endpoint > auditors-llm-* > llm-*.
 * Re-resolved per tick so OPENCUES.md edits hot-reload.
 */
export function buildKataLLMResolver(
  configLoader: ConfigLoader,
  apiKeys: Readonly<Record<string, string | undefined>>,
): ResolvedAgentLLM | null {
  let core: { resolveLLM?: (opts: unknown) => unknown } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    core = require('@opencues/core');
  } catch { return null; }
  if (!core?.resolveLLM) return null;
  const s = configLoader.opencuesState.settings;
  const auditorsBucket = configLoader.opencuesState.auditorsLlmProvider;
  const auditorsBucketProvider = auditorsBucket === 'inherit' ? undefined : auditorsBucket;
  const auditorsBucketModel = auditorsBucketProvider ? s.get('auditors-llm-model') : undefined;
  const auditorsBucketEndpoint = auditorsBucketProvider ? s.get('auditors-llm-endpoint') : undefined;
  const out = core.resolveLLM({
    featureProvider: s.get('kata-llm-provider'),
    featureModel: s.get('kata-llm-model'),
    endpointOverride: s.get('kata-llm-endpoint') ?? auditorsBucketEndpoint ?? s.get('llm-endpoint'),
    globalProvider: auditorsBucketProvider ?? s.get('llm-provider'),
    globalModel: auditorsBucketProvider ? (auditorsBucketModel ?? undefined) : s.get('llm-model'),
    apiKeys,
  }) as ResolvedAgentLLM | null;
  if (!out) return null;
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
  /** Optional HTTP adapter for the `integration-weave` LLM call. Chrome
   *  passes its fetch-based `host.httpAdapter`; native hosts omit it and the
   *  weaver lazily falls back to NodeHttpAdapter. When the feature is off
   *  (default) this is never consulted. */
  readonly httpAdapter?: HttpAdapterShape;
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

/** Max length of an LLM-provided `ai-callable` fetch argument. A single
 *  data-lookup value (ticker / crypto id / city name) is short; anything
 *  longer is abuse, not a lookup. */
export const AI_CALLABLE_ARG_MAX = 200;

/**
 * Defense-in-depth shape floor for an LLM-provided `ai-callable` fetch argument.
 * Returns false (→ the runtime refuses the fetch) when the arg is empty, over
 * `AI_CALLABLE_ARG_MAX`, contains a control char / CRLF / null, or contains a
 * URL-structure / injection char (`& ? # / \ @ % < > " ` { } | ^`). It does NOT
 * replace each blank's own arg validation/encoding — it bounds the blast radius
 * of a custom `ai-callable` blank that forgets to encode. Legitimate values
 * (letters, digits, spaces, accents, `.`/`-`/`'`/`,`) pass.
 */
export function aiCallableArgWithinFloor(arg: string): boolean {
  if (arg.length === 0 || arg.length > AI_CALLABLE_ARG_MAX) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(arg)) return false; // control / CRLF / null
  if (/[&?#/\\@%<>"`{}|^]/.test(arg)) return false;    // URL-structure / injection
  return true;
}

/**
 * Phase 4 — capability-gated on-demand blank-fetch provider for the
 * typed-sentinel parameterized tier. Returns `{ getAiCallableFns, blankFetch }`:
 *
 *   - getAiCallableFns(): the LIVE registry (canonical token-prefix →
 *     {blankName, tokenPrefix}) of blanks with `ai-callable: true` AND no
 *     `blankScript` AND a runtime impl on this host AND `blank-context-mode`
 *     on. This registry IS the capability gate — core only fetches fn-calls
 *     present here. Rebuilt per call so a ai-callable flip hot-reloads.
 *   - blankFetch(blankName, arg): calls the blank's `get(arg)` with an
 *     LLM-PROVIDED argument. RE-ENFORCES the capability on EVERY call
 *     (defense in depth — never trust the caller), so a script blank can
 *     never be invoked here even if the registry were somehow tampered with.
 *
 * Returns undefined when no blanks are wired, so the whole path is a
 * structural no-op until a blank opts into `ai-callable`.
 */
export function buildBlankFetchProvider(
  configLoader: ConfigLoader,
  blanks: ReadonlyMap<string, import('./blanks/types').Blank> | undefined,
  log: (level: LogLevel, msg: string) => void,
): {
  getAiCallableFns: () => ReadonlyMap<string, { blankName: string; tokenPrefix: string }>;
  getRenderedBlock: () => string;
  blankFetch: (blankName: string, arg: string) => Promise<string | undefined>;
} | undefined {
  if (!blanks || blanks.size === 0) return undefined;
  let core: { deriveBlankContextToken?: (n: string, s: string) => string } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    core = require('@opencues/core');
  } catch { return undefined; }
  if (!core?.deriveBlankContextToken) return undefined;

  // Authorised for LLM-arg invocation RIGHT NOW? Reads live config so a flip
  // (or removal) of ai-callable / the trust list hot-reloads, and re-checks the
  // script-blank ban + the capability gate on EVERY call.
  const isAiCallable = (blankName: string): boolean => {
    const cfg = configLoader.mergedBlanksConfig?.blanks?.[blankName];
    // Necessary preconditions: opted in + not a script blank (LLM-arg → shell).
    if (!cfg || cfg.aiCallable !== true || cfg.blankScript) return false;
    // CAPABILITY GATE — `ai-callable: true` alone is NOT sufficient (a pack can
    // ship it; installing ≠ enabling). Honour it only when EITHER:
    //   (a) the blank is one of the audited built-in fetch classes (trusted by
    //       CODE IDENTITY — `instanceof`, spoof-proof: a pack's `impl: ./x.js`
    //       can never be an instance of a core class), OR
    //   (b) the USER explicitly trusted this name via `ai-callable-allow` in
    //       OPENCUES.md (which a pack can't write).
    const inst = blanks.get(blankName);
    if (inst && AUDITED_AI_CALLABLE_CLASSES.some(C => inst instanceof C)) return true;
    return configLoader.opencuesState.aiCallableAllow.includes(blankName);
  };
  const prefixOf = (blankName: string): string =>
    core!.deriveBlankContextToken!(blankName, 'X').slice(1).split(' ')[0]!; // "[STOCK X]" → "STOCK"
  const canon = (s: string): string => s.toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  const getAiCallableFns = (): ReadonlyMap<string, { blankName: string; tokenPrefix: string }> => {
    const reg = new Map<string, { blankName: string; tokenPrefix: string }>();
    if (configLoader.opencuesState.blankContextMode === 'off') return reg; // blank-data opt-in
    const merged = configLoader.mergedBlanksConfig?.blanks ?? {};
    for (const name of Object.keys(merged)) {
      if (!isAiCallable(name) || !blanks.has(name)) continue;
      const prefix = prefixOf(name);
      reg.set(canon(prefix), { blankName: name, tokenPrefix: prefix });
    }
    return reg;
  };

  const blankFetch = async (blankName: string, arg: string): Promise<string | undefined> => {
    // SECURITY chokepoint — re-verify the capability on every call. A blank
    // that isn't ai-callable, or is a script blank, is NEVER invoked here.
    if (!isAiCallable(blankName)) {
      log('warn', `[ai-callable] refused on-demand fetch "${blankName}" — not ai-callable or is a script blank`);
      return undefined;
    }
    // DEFENSE-IN-DEPTH arg floor. The PRIMARY defense is each blank
    // validating/encoding its own arg (StocksBlank → `[A-Z0-9.]`, WeatherBlank
    // → encodeURIComponent). But `ai-callable` is open to ANY non-script `impl:`
    // blank a user opts into — including their own JS — and a blank that
    // forgets to encode would interpolate this LLM-chosen string straight into
    // a URL. So bound it here too: reject control chars / CRLF / null (never
    // legitimate; header- & null-injection vectors), the URL-structure chars
    // that have no place in a single data-lookup value (`& ? # / \ @ % < > " ` { } | ^`),
    // and anything over ARG_MAX. Legitimate args (tickers, crypto ids, city
    // names with spaces/accents/`.`/`-`/`'`) pass untouched. Authors MUST still
    // treat the arg as hostile — this is belt-and-suspenders, not a substitute.
    if (!aiCallableArgWithinFloor(arg)) {
      log('warn', `[ai-callable] refused on-demand fetch "${blankName}" — argument failed the shape floor (control/URL char or length cap)`);
      return undefined;
    }
    const blank = blanks.get(blankName);
    if (!blank) return undefined;
    try {
      // Blanks disagree on where the arg lives: StocksBlank/CryptoBlank read
      // the first param (keyword); WeatherBlank ignores it and reads the
      // SECOND param (context) — so pass the LLM arg in BOTH positions to
      // satisfy every get() convention.
      const v = await blank.get(arg, [arg]);
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    } catch (e) {
      log('warn', `[ai-callable] fetch "${blankName}(${arg})" failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  // Render the ai-callable FUNCTIONS block for the typed catalog so the LLM
  // emits `[STOCK(ticker=NVDA)]` calls. Built from each blank's signature/
  // returns/description (live config). Empty when no ai-callable blank applies.
  const getRenderedBlock = (): string => {
    const reg = getAiCallableFns();
    if (reg.size === 0) return '';
    const merged = configLoader.mergedBlanksConfig?.blanks ?? {};
    const lines: string[] = [];
    for (const { blankName, tokenPrefix } of reg.values()) {
      const cfg = merged[blankName];
      const sig = cfg?.signature ?? '(arg: string)';
      const ret = cfg?.returns ?? 'string';
      const desc = cfg?.tip ?? `live ${blankName} value for the argument`;
      lines.push(`- [${tokenPrefix}${sig}: ${ret}] — ${desc}`);
    }
    // Two clauses here are load-bearing (issue #279): the "IN ADDITION to
    // the catalog tokens above" opener AND the trailing catalog-guard
    // examples ("i work at _" → [COMPANY]). Without them gpt-oss-120b
    // treats this block as REPLACING the identity/blank-context catalogs
    // above it — identity lookups like `i work at _` flip from
    // `ANSWER: [COMPANY]` to `SPAN: NONE` the moment any ai-callable blank
    // is registered (i.e. on every real host, which is why the bench — no
    // fn block — kept passing while agentic scenario 54 failed on every
    // host). The decision is knife-edge sensitive (even fn-line ORDER
    // flipped it with the opener alone), so both nudges ship together;
    // the concrete examples are what hold it robust. No-catalog safety:
    // with no USER CONTEXT block present the model does NOT hallucinate
    // the example tokens (verified — emits generic prose instead), and a
    // token for an unlisted field is stripped by the post-processor
    // (agentic scenario 56). Repro'd + fixed deterministically (temp=0,
    // seed=42); fn-call emission verified unregressed at the old baseline
    // (9/10) via tests/benchmarks/typed-sentinel-language/livefn-bench.ts,
    // whose LIVE_FUNCTIONS mirror must be kept in sync with this string.
    return `\n\nLIVE FUNCTIONS — IN ADDITION to the catalog tokens above (all catalog rules still apply), these fetch live data for ANY argument, not only the values pre-listed above. When the content names an entity one of these can fetch (a stock ticker, a city's weather, …), emit the function CALL with that entity as the argument; the runtime fetches the live value and substitutes it.\nThis OVERRIDES the "write a natural placeholder" rule for any entity a function covers: prefer the CALL [STOCK(ticker=AMZN)] over a generic placeholder like [Amazon Stock Price] or [Today's Price]. Use the ticker symbol / city / id as the argument; if the prose names a company, use its ticker (Amazon→AMZN, Netflix→NFLX, Reddit→RDDT).\n${lines.join('\n')}\nExamples: "Amazon's share price" → [STOCK(ticker=AMZN)] · "weather in Berlin" → [WEATHER(city=Berlin)] · "solana's price" → [CRYPTO(symbol=SOL)] · queries about the USER's own data still take the catalog token above: "i work at _" → [COMPANY] · "my email _" → [EMAIL].`;
  };

  return { getAiCallableFns, getRenderedBlock, blankFetch };
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
  _err?: Error,
  ctx?: { provider?: string; model?: string; endpoint?: string },
): string {
  // Local `ollama` fails in ways the cloud-centric hints below don't
  // cover: the server may not be installed/running, or the model may not
  // be pulled. The generic "check connectivity" / "make llm-model a valid
  // pair" text is useless there — tell the user the actual fix (`ollama
  // serve` / `ollama pull <model>`). Guarded by provider id so it only
  // fires for the local provider.
  if (ctx?.provider === 'ollama') {
    const model = ctx.model && ctx.model.length > 0 ? ctx.model : 'the model';
    switch (reason) {
      case 'model-not-found':
        return `[OpenCues: Ollama model '${model}' is not installed — run \`ollama pull ${ctx.model ?? '<model>'}\` (see your pulled models with \`ollama list\`)]`;
      case 'network':
      case 'endpoint-not-found':
        return '[OpenCues: Ollama is not reachable — install it from ollama.com and start it with `ollama serve` (then `ollama pull` a model). Check `llm-endpoint:` if you run Ollama on a non-default host/port.]';
      // invalid-api-key / rate-limit / insufficient-credits don't apply to
      // a local server — fall through to the generic text below.
    }
  }
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

  // OUTBOUND PII FLOOR (buffer-dehydration, defense-in-depth): register
  // the dispatchChat-level guard. Per-source dehydration is the primary
  // mechanism; this floor scrubs any residual catalog value a future /
  // missed source ships, with a loud warning. Thunk re-reads config per
  // dispatch so mode flips + IDENTITY.md edits hot-reload. Lazy-require
  // keeps parity with buildAgentLLMResolver's no-hard-core-dep stance.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('@opencues/core') as {
      setOutboundDehydrationGuard?: (g: (() => unknown) | null) => void;
      getDehydrator?: (c: ReadonlyMap<string, string>) => unknown;
    };
    core.setOutboundDehydrationGuard?.(() => {
      const id = identityDehydrationFor(configLoader);
      return id && core.getDehydrator ? core.getDehydrator(id.catalog) : null;
    });
  } catch { /* bare boots without core keep the unguarded (pre-feature) behaviour */ }

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
  // Optional integration-weave LLM (blanks bucket). Built only when the host
  // exposed an API-key bag; the weaver itself no-ops to static when the
  // feature is off, no key resolves, or the http adapter is unavailable.
  const blankWeaver: BlankWeaver | null = getApiKeys
    ? buildBlankWeaver(configLoader, getApiKeys, opts.httpAdapter, (lvl, msg) => log(lvl, msg))
    : null;
  const blankFill = new BlankFill(
    adapter, configLoader, spanFillState, dismissedBlanks, selectorSatelliteState, dynDefs, blankLoading,
    blankWeaver,
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
