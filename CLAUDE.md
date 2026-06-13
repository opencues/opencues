# CLAUDE.md - OpenCues

This document provides context for Claude sessions working on this project.

## Project Overview

**OpenCues** provides LLM-powered word alternatives and `_`-gated blank fill-ins for text editors. The system reduces to two ideas: **Cues** (LLM → user, on plain text) and **Blanks** (user → system, on `_`). See `concept.md` at the repo root.

**Architecture** (two libraries + integrations):
- **`@opencues/core`** — *what alternatives exist*. Pure TypeScript: parsers
  (CUES.md frontmatter + folder CUE.md / BLANK.md), the LLM `Resolver`,
  prompt templates, sources (ConfigSource, BlankSource, etc.),
  HTTP adapter. Given text + config, answers "what should we suggest for
  this word?" Knows nothing about editors, key events, or rendering.
- **`@opencues/runtime`** — *how the user interacts with those alternatives*.
  Host-agnostic: the `HostAdapter` contract, Navigation / Cycling /
  DimRender / BlankFill modules, render-directive ANSI work, state
  classes, and per-host adapter bands (Claude Code v2.1, future browser,
  …). Knows nothing about LLMs. Will depend on `@opencues/core` from the
  BlankFill phase onward — modules will receive a `Resolver` instance.
- **Integrations** — Editor-specific glue. Claude Code's integration is
  the `tweakcc` patch that injects a thin bootstrap into `cli.js`; that
  bootstrap calls `@opencues/runtime`'s `boot()` entry point.

Roughly: `@opencues/core` is the brain, `@opencues/runtime` is the nervous
system, and each integration is a spinal-cord-shaped bridge between the
host and the runtime.


**Current Integrations**:
- **Claude Code** (`integrations/claude-code/`) — patches Claude Code 2.1.x (tested 2.1.110 cli.js + 2.1.150 native binary) via tweakcc 4.0.13+
- **OpenCode** (`integrations/opencode/`) — patches OpenCode 1.4.x; runtime loaded inline
- **Chrome** (`integrations/chrome/`) — MV3 extension; CSS Custom Highlight API for in-page rendering
- **Gemini CLI** (`integrations/gemini-cli/`) — patches Gemini CLI 0.41.x; React/Ink host with a render-kick + ZWS-toggle pull model. See its CLAUDE.md for the React quirks (it's the first React/Ink host so the integration was non-trivial).
- **Shell** (`integrations/shell/`) — standalone Bun + OpenTUI + SolidJS app. User-facing entry point is `oc-shell` (wraps the user's interactive shell in a private tmux session with an Alt+Shift+↑ input box); `oc-edit` is the internal Bun host lazy-spawned inside that session and is not directly user-invokable. **Self-owned host** — no upstream fork to patch. Built on the same OpenTUI primitives as OpenCode, so the adapter band (`adapters/shell/v1/`) is structurally a near-clone of `adapters/oc/v1.14/`. Canonical host name: `shell` (alias `terminal` kept for back-compat in `on-host:` directives).

> Re-org in progress — folders rename to `cc/`, `oc/`, `chrome/` in Stage 4 of
> the repo restructure. See `docs/architecture/repo-structure.md` for the
> target layout + stage tracker.

---

## Claude Installs

Two Claude Code installs exist on this machine. **OpenCues work targets `claude-cues` only — never touch the native install.**

| Command | Location | Version | Purpose |
|---|---|---|---|
| `claude-cues` | `~/claude-code-cues` (local npm) | 2.1.110 (cli.js, pegged) | OpenCues patches applied here — npm cli.js shape |
| `claude-cues-150` | `~/claude-code-cues-150` (local npm) | 2.1.150 (native bun-binary) | OpenCues patches applied here — native-binary shape (post-2.1.113 cutover) |
| `claude-cues-158` | `~/claude-code-cues-158` (local npm) | 2.1.158 (native bun-binary) | OpenCues patches applied here — same v2.1 adapter band as 150 (all 4 seams S1/S2/S3/S7 still hit) |
| `claude-cues-170` | `~/claude-code-cues-170` (local npm) | 2.1.170 (native bun-binary) | OpenCues patches applied here — **latest tested** (June 2026), same v2.1 adapter band; S6 still missing (gone since 2.1.150, statusline polls); S1/S2/S3/S7 all hit; agentic core suite (01/02/03/07/14) green |
| `claude` | `~/.local/bin/claude` (native) | latest | Clean/unpatched — development use |

- Both `claude-cues` and `claude-cues-150` are patched instances. `setup.sh` targets the cli.js fork; the native-binary fork is patched via tweakcc 4.0.13+'s `.bun` ELF section extract/repack.
- `claude` is never patched. Use it for unaffected Claude Code sessions during development.
- Each patched fork is pegged to its declared version — do not upgrade without re-running the [UPGRADING runbook](integrations/claude-code/UPGRADING.md) to verify the five seam anchors (S1/S2/S3 required, S6/S7 optional).

> **Self-healing on `opencues run <host>` (shipped June 2026).** Every
> `opencues run <host>` invocation now reads the fork's `version.json`
> marker (under `<fork>/.cues/` for CC, `<fork>/.opencues/` for OC and
> gemini-cli, `integrations/shell/node_modules/@opencues/` for shell,
> `integrations/chrome/dist/` for chrome) and compares its **`srcHash`**
> field — a SHA-256 over every file under
> `packages/opencues-{core,runtime}/src/**` plus `packages/opencues-core/node-http-adapter.js`
> — against the current source's hash. If different, the launch path
> transparently re-runs the host installer before spawning the host.
> A single info line tells the user what's happening
> (`▸ <host> bundle is stale (source files changed since last install).
> Rebuilding before launch — pass --no-rebuild-check to skip.`).
>
> The hash is load-bearing: it fires on **any source byte change**,
> not just package.json bumps. Developers forgetting to bump
> versions no longer masks drift — that was the structural root
> cause of the May 2026 dual-fork bug and several subsequent
> "stale runtime" reports.
>
> The remaining manual paths:
> - **Users who type `claude-cues` / `oc-shell` directly** bypass
>   `opencues run` and don't get the self-heal. The runtime-side
>   advisory check in the boot path warns them (TODO if not yet wired).
> - **Chrome's WSL → /mnt/c/ mirror** still needs `opencues sync chrome`
>   to push rebuilt dist/ into the Chrome extension dir. That's a
>   separate fan-out from the bundle-rebuild covered above.
>
> Where to look when self-heal needs extension:
> - `packages/opencues-cli/src/lib/version-markers.cjs:BUNDLED_SOURCE_DIRS` —
>   add a new bundled package's `src/` path here. Anything outside
>   this list is invisible to drift detection.
> - `packages/opencues-cli/src/commands/run.cjs:ensureFreshBundle` —
>   the launch-time gate. Calls `enumerateInstalledHosts` + `checkDrift`,
>   then `spawnSync('node', [cli.cjs, 'install', host, '--no-prompts', '--yes'])`
>   on stale.
> - `packages/opencues-cli/src/lib/version-markers.test.cjs` — drift-
>   detection unit tests, including the deterministic-hash + ignored-
>   dirs (`dist/` / `node_modules/` / `.cache/`) contracts.
>
> Concrete failure mode this rule prevents: a May-2026 resolver fix
> (`isLlmBlankSource` exemption from the `_`-tip guard in
> `packages/opencues-runtime/src/modules/resolver.ts`) landed in source and got
> installed into the cli.js fork. The 150 fork was never re-run; users on
> `claude-cues-150` had every TransformBlank substitute silently dropped for
> hours before we noticed the version skew in `node_modules`. Post-self-heal,
> next `opencues run claude-code` on that fork would detect srcHash drift
> and rebuild before the launch — closed loop.
>
> **The discipline contract (CONTRIBUTORS MUST follow):**
> 1. Any PR touching `packages/opencues-{core,runtime}/src/**` is
>    automatically caught by srcHash drift detection at `opencues run`
>    time. No special action required for users on the canonical
>    install path.
> 2. PRs SHOULD still bump `package.json` version + add CHANGELOG.md
>    entry per the discipline in `docs/architecture/versioning.md` —
>    not for drift detection (srcHash handles that), but for npm
>    publish-readiness, downstream consumer tracking, and changelog
>    discoverability.
> 3. PRs that add a NEW bundled `@opencues/<pkg>` package MUST append
>    its `src/` path to `BUNDLED_SOURCE_DIRS` in `version-markers.cjs`,
>    or the new package will be invisible to drift detection.
> 4. PRs that touch chrome's bake-bundle path
>    (`integrations/chrome/dist/configs/`) still need an explicit
>    `opencues sync chrome` step on the user side — chrome's fan-out
>    is separate from the bundle-rebuild and not covered by self-heal.

---

## Repository Structure

```
opencues/
├── CLAUDE.md                      # THIS FILE - project overview
├── README.md                      # Public readme with install instructions
│
├── defaults/                      # Shipped defaults — seed source for `opencues seed-configs`
│   │                              # AND the Chrome extension's bake-time bundled fallbacks.
│   │                              # NOT an ambient project-level config — the repo does not
│   │                              # self-dogfood via `<cwd>/.cues` anymore. Devs working
│   │                              # on opencues run `seed-configs` once just like any user.
│   │                              # See docs/features/shipped-defaults.md.
│   ├── CUES.md                    # Cue master: project metadata frontmatter + ## Tips / ## Ignore / ## Prompt sections (LLM cue sources)
│   ├── OPENCUES.md                # Runtime settings (voice-mode, fluid-blank-mode, llm-provider, agent-debounce-ms, ...)
│   ├── cues/                      # Folder-based cue configs (LLM word-cues + static tip groups)
│   │   ├── extended-thinking/CUE.md  # type: tips, words: { ultrathink: { tip, alts } }
│   │   ├── …                      # 38 shipped tip-group folders
│   │   ├── legal/CUE.md           # Legal terminology word-cues (LLM)
│   │   ├── medical/CUE.md         # Clinical terminology word-cues
│   │   └── financial/CUE.md       # Financial terminology word-cues
│   └── blanks/                    # Folder-based cue-blanks (colocated scripts + state)
│       ├── volume/
│       │   ├── BLANK.md           # type: blank, blankKeywords: volume, …
│       │   ├── volume-blank.sh    # Blank script: get/set system volume
│       │   └── VolCtl.cs          # C# source for Windows Core Audio API (compiled by setup.sh)
│       ├── brightness/
│       │   ├── BLANK.md
│       │   └── brightness-blank.sh
│       ├── affirmations.md        # List blank (stepValues: [...])
│       ├── stocks.md              # impl: @opencues/runtime StocksBlank
│       ├── weather.md             # impl: @opencues/runtime WeatherBlank
│       ├── hackernews.md          # impl: @opencues/runtime HackerNewsBlank
│       ├── prompt.md              # impl: @opencues/runtime PromptImproverBlank
│       ├── answer.md              # impl: @opencues/runtime AnswerBlank
│       ├── countries.md           # impl: @opencues/runtime CountriesBlank
│       ├── crypto.md              # impl: @opencues/runtime CryptoBlank
│       ├── dictionary.md          # impl: @opencues/runtime DictionaryBlank
│       └── opencues/BLANK.md      # impl: @opencues/runtime OpenCuesSettingsBlank
│
├── packages/                      # Core packages (publish as @opencues/*)
│   ├── opencues-core/             # LLM analysis library — publishes as @opencues/core
│   │   ├── node-http-adapter.js  # HTTPS w/ keep-alive — hand-written CJS at PACKAGE ROOT (not src/);
│   │   │                         # bypasses tsc so every integration's setup.sh has an explicit cp.
│   │   │                         # See packages/opencues-runtime/adapters/oc/REPAIR.md § LF-7.
│   │   ├── src/
│   │   │   ├── resolver.ts        # CueResolver orchestration
│   │   │   ├── cues-md.ts         # CUES.md parser (parseCuesMd, parseSingleCueMd)
│   │   │   ├── discover.ts        # Folder-based config discovery
│   │   │   └── sources/           # ConfigSource, RoutedWordSourceGroup, BlankSource, FluidBlankSource, SpellingSource, parsers
│   │   ├── prompts/               # Prompt references + documentation
│   │   │   ├── linked.txt         # Linked words prompt
│   │   │   └── references/        # Prompt documentation
│   │   └── dist/                  # Built output
│   └── opencues-runtime/          # Host-agnostic runtime — publishes as @opencues/runtime
│       ├── src/                   # Modules: Navigation, Cycling, BlankFill, etc.
│       ├── adapters/              # Per-host adapter bands
│       │   ├── cc/v2.1/           # Claude Code 2.1.x adapter
│       │   ├── oc/v1.4/           # OpenCode 1.4.x adapter
│       │   └── chrome/v1/         # Chrome extension adapter
│       └── dist/                  # Built output
│
├── integrations/claude-code/      # Claude Code integration (@opencues/claude-code)
│   ├── patches/                   # tweakcc patches + installer
│   │   ├── setup.sh               # ONE-COMMAND INSTALLER
│   │   ├── opencuesRuntime.ts     # The patch source — boots @opencues/runtime via S1/S3/S6 seams
│   │   └── highlight-statusline.sh # Status line script
│   ├── docs/                      # Claude Code implementation docs
│   │   ├── navigation.md          # Keys, modes, visual states, cursor export
│   │   ├── cursor-positioning.md  # Cursor offset adjustment during blank fill
│   │   ├── cycling.md             # Numbers, alts, linked, spans, clearing
│   │   ├── alternatives.md        # Tips, LLM sources, blanks, auto-submit
│   │   ├── cue-blanks.md         # Cue-blanks + WSL guide
│   │   ├── selector-satellite.md  # Selector + satellite blanks
│   │   ├── status-line.md         # Status line setup, format, disabling
│   │   ├── config.md              # All config options
│   │   ├── architecture.md        # Architecture + data flow diagrams
│   │   └── prompting-guide.md     # Claude Code CLI tips
│   └── tests/                     # Integration tests
│
├── docs/                          # General documentation
│   ├── overview.md                # System layers, API, interfaces, usage examples
│   ├── features/                  # One file per feature concept (20 features)
│   │   ├── README.md              # Feature index
│   │   ├── navigation.md          # Feature 1: Word navigation
│   │   ├── cycling.md             # Feature 2: Word cycling
│   │   ├── ...                    # Features 3-15 (one file each)
│   │   └── secondary-display.md   # Feature 14: Secondary display (status line)
│   ├── guides/                    # Task-oriented how-tos
│   │   ├── adding-a-feature.md    # How to add a new feature
│   │   ├── adding-an-integration.md # How to add a new editor integration
│   │   ├── adding-a-cue-blank.md # How to add a cue-blank (external script trigger)
│   │   ├── adding-an-auditor.md  # How to add an auditor (inline-rewrite concern)
│   │   ├── porting-to-new-integration.md # Porting guide: contracts, pitfalls, edge cases
│   │   ├── parser-types.md        # Response parser types (alternatives, compute, answer, raw)
│   │   └── llm-providers.md       # LLM provider setup & benchmarks
│   └── prompt-design-learnings.md # Prompt engineering principles
│
└── tests/                         # End-to-end + benchmark scaffolding
    ├── user-test.md               # Manual sanity checklist (run after code changes)
    ├── benchmarks/                # LLM accuracy benchmarks (TS runners per pipeline)
    │   ├── agent-rewrite/         # AgentRewrite cadence + merge
    │   ├── transform-blank/       # 3-pass imperative pipeline
    │   └── fluid-blank/           # Free-form `_` lookup
    └── results/                   # Benchmark results + reports
```

---

## Quick Install (Claude Code)

```bash
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues && pnpm install
pnpm exec opencues install claude-code
export GROQ_API_KEY="your-key"
```

`opencues install claude-code` chains two scripts:

1. **`opencues seed-configs --silent`** — owns all writes to `~/.cues/`
   (shared by every native host: CC, OC). First-time copy +
   library-script sync + 0-byte OPENCUES.md self-heal + colocated `.cs`
   compile (WSL only).
2. **`integrations/claude-code/patches/setup.sh`** — strictly CC-specific.
   Default behavior: nuke + rebuild from scratch. Pinned `@anthropic-ai/claude-code@2.1.110`
   reinstalled + cloned tweakcc inside `<CC_FORK>/.cues/tweakcc/` +
   `@opencues/{core,runtime}` built and installed into `<CC_FORK>/node_modules/@opencues/`
   + statusline.sh into `<CC_FORK>/.cues/` + tweakcc patched (only
   the OpenCues v2 wiring; every stock tweakcc patch disabled) +
   verified at build AND apply time. ~1m 5s warm install.

**Compact footprint**: everything CC-specific lives inside `~/claude-code-cues/`.
Uninstall is `rm -rf ~/claude-code-cues` + tweakcc revert. OpenCode
keeps working (it reads shared `~/.cues/` independently).

For non-standard cli.js paths: `--target /path/to/cli.js`.
For dev iteration on patch sources: `--keep-state` (skips nuke; ~39s).

The legacy `integrations/claude-code/patches/setup.sh` direct invocation still
works for contributors hacking on the patches (also accepts `--keep-state`).

---

## Key References

- **README.md** — Features, install, configuration, troubleshooting
- **CONTRIBUTING.md** — How to extend the standard, build integrations, modify opencues-core
- **docs/overview.md** — System architecture, core interfaces, API usage
- **docs/glossary.md** — All terminology (cues, blanks, sources, parsers, config files)
- **docs/guides/** — Task-oriented how-tos (adding features, integrations, cue-blanks, auditors, parser types, LLM providers)
  - **`adding-a-cue-blank.md`** ⚠️ Must-read before adding any new cue-blank — covers blank routing, cycling pitfalls (list-only — no numeric stepping), span invalidation contract, and `def.word` post-populate behaviour. **Update the pitfalls section** when new failure modes are found.
  - **`adding-an-auditor.md`** Reference for shipping a new inline-rewrite concern (grammar, clarity, tone, etc.). Explains the composition model (one LLM call per agent tick, all auditors concatenated by priority desc), what the frontmatter does, why per-auditor `provider:` / `match:` are inert, and `<project>/.cues/AUDITORS.md` `disable:` for project-level scoping.
- **integrations/claude-code/docs/** — Claude Code implementation docs
- **`<CC_FORK>/.cues/tweakcc/`** — tweakcc install lives inside the CC fork (re-cloned every from-scratch install — no global `~/tweakcc/` dir to manage)
- **docs/features/** — 21+ feature concepts (one file each)
- **docs/architecture/spans-and-cycling.md** ⚠️ Canonical implementation reference for the cycling/span/dim/nav system. Two span systems (blank-fill vs static-alt), the cycling priority order (selector/satellite → spanFill → list blank → blankStep DynDef → static alts), the shift+prune flow, the bugs we've already fixed. Read this before touching `cycling.ts`, `dyn-defs.ts`, `span-fill.ts`, `dim-render.ts`, or `navigation.ts`.
- **docs/architecture/transform-blank.md** ⚠️ Canonical reference for the imperative-blank pipeline (EXTRACT → APPLY → VERIFY). Covers the 3-pass design rationale, prompt design (why minimal-EXTRACT but verbose-APPLY), sequential composition for "X and Y", skip-VERIFY rules, parser quirks (`[ \t]*` not `\s*`), runtime substitution, debug logs, and 10 concrete lessons from the experiment log. Read this before touching `transform-blank-source.ts` or any of the prompts. Companion: `tests/benchmarks/transform-blank/EXPERIMENTS.md` for the empirical justification of every design decision.
- **docs/architecture/security-audit.md** ⚠️ Canonical security-posture summary — threat model, attack-class table with current defences + residual risk, open follow-ups. Read this before touching trust-gate / sandbox / capability / secret-binding code, and update it when those move. Companion deep-dives: `docs/architecture/sandbox.md` (OS confinement), `docs/architecture/chrome-security.md` (chrome boundaries), `docs/architecture/user-blanks.md` (capability model).
- **docs/architecture/blank-replace-modes.md** ⚠️ Canonical reference for the unified `blankReplace` field (`keep` / `wipe` / `wipe-all` / `auto`) and the deterministic copula/equation/question heuristic `auto` runs. Read before touching `BlankFill`'s fill pipeline, `resolveReplaceMode` in core, or migrating a built-in blank's mode. Includes the migration cheat-sheet for every shipped blank.
- **docs/architecture/blank-sources.md** ⚠️ Canonical reference for the family of `CueSource` classes (BlankSource / FluidBlankSource / TransformBlankSource / SentenceCueSource / ConfigIntentSource / ConfigSource / LocalCueSource) + the two substitute mechanisms the resolver picks between: deterministic slot splice (used by BlankSource / FluidBlankSource / 3-pass TransformBlank — splice bounds come from the parser, never from an LLM-claimed span) vs three-way-merge (used by fused TransformBlank + AgentRewrite — LLM owns the whole buffer, runtime diffs against `originalText` and merges into `liveText`). Documents WHY the May 2026 long-body duplication bug occurred (splice trusting an LLM-claimed TARGET span + concat-tail) and the structural fix (align mechanism to data — whole-buffer → merge; bounded-span → splice only if input was that exact bounded span). Decision table for picking the mechanism when adding a new source. Read before touching the resolver substitute dispatch (`packages/opencues-runtime/src/modules/resolver.ts`) or adding a new `CueSource` subclass.
- **docs/architecture/agent-task.md** ⚠️ Canonical reference for the AgentRewrite module — the single shipping implementation of agentic rewrite tasks (`agentically X _` / `add task X _`). One debounce-driven LLM call per tick that emits the full rewritten buffer; a three-way merge against the live buffer drops any LLM hunk overlapping user edits so typing during the call is never clobbered. Covers the merge invariant, cadence (`agent-debounce-ms`), DynDef placement for Down-arrow revert, and why the earlier per-keystroke `AgentLoop` + per-edit `Judge` were retired in May 2026. Read before touching `agent-rewrite.ts`, the agent-task state machine (`AgentTaskState`), or the merge layer. Sub-doc: `agent-rewrite-cache.md` (cache layer); LLM-prompt design lives inline in `agent-rewrite.ts`.
- **docs/architecture/agent-rewrite-cache.md** ⚠️ Canonical reference for the AgentRewrite two-tier cache (skip-on-stable + LRU). Covers cache-key composition (snapshot + task + cursor + windowWords + auditorSignature), the determinism assumption (Groq temp=0 + seed pinning), and the list of extension points (size, cross-session persistence, approximate-match keys, negative caching, telemetry, manual invalidation). Read before touching `_rewriteCache` / `_lastStableSnapshot` / `makeCacheKey` / `computeAuditorSignature` in `agent-rewrite.ts`.
- **docs/architecture/universal-integration.md** ⚠️ Canonical reference for the no-cycling attach profile. A host that can't paint colour or intercept Ctrl+Alt+arrow advertises `supportsCycling: false`; every cycleable cue/blank is then pruned at registration (word-cues, selector/satellite, list blanks, script-backed cycling like volume/brightness). Inference is structural — no frontmatter changes needed (`isBlankConfigCycleable` reads each def's shape). Today's only host in this profile: chrome's normal-`<input>` / `<textarea>` mode. Two filter paths (resolver's `buildSourcesFromConfig` + BlankFill's `matchKeyword`) both import the same `isBlankConfigCycleable` predicate from `@opencues/core` — drift on cycleability semantics is structurally impossible; adding a new cycleable condition auto-propagates to both. Read this before touching `HostAdapter.supportsCycling`, the cycleable getters on each `CueSource`, or either filter point.
- **docs/architecture/chrome-llm-keys.md** ⚠️ Canonical reference for chrome's multi-provider key forwarding + real-time updates. Covers the three-tier merge, failure-mode surface (missing/invalid/typo'd provider), boot-time probes (`verifyLlmKeyAtBoot`, `auditProvidersAgainstKeys`), and the live-mutation contract on `Resolver.options.apiKeys` that makes mid-session key swaps work without a tab reload. Read before touching chrome's storage adapter, the bootstrap's key-audit code, or the runtime's `BootResult.updateApiKeys`.
- **docs/architecture/identity-context.md** ⚠️ Canonical reference for the optional `identity-context-mode` feature (renamed June 2026 from `sentinels-mode`, which itself was renamed May 2026 from `user-context-mode`; runtime back-compat-reads both legacy names, `opencues seed-configs` self-heals) — FluidBlankSource + TransformBlankSource receive the user's own personal data (`~/.cues/IDENTITY.md` frontmatter, formerly `SENTINELS.md`, originally `USER.md`) as identity-context tokens so `_` lookups and rewrites personalise without re-typing. **OFF by default** (`sentinels-mode: off | safe | raw` scalar in OPENCUES.md). `safe` mode sends only token names + descriptions; a runtime post-processor substitutes real values AFTER the LLM responds — PII never reaches the provider's logs. `raw` mode inlines values (opt-in). Phase 1 wired for **fluid-blank**; Phase 2 (May 2026) extended to **transform-blank** (`draft email _`) with `preserveUnknown: true` so non-sender placeholders survive. Validator chokepoint at `@opencues/core/sentinels-validator.ts:validateSentinelWrite` enforces key shape, value cap, token collision, capacity (64 fields × 256 chars) for any code path that mutates SENTINELS.md — used by `opencues sentinels` CLI today; mandatory for any future in-editor sentinel-writing blank (audit row #24). Post-processor handles: verbatim resolve, tolerant matching (Claude's `[WORK_CITY]` underscore drift), hallucination strip (Claude's invented `[DATE OF BIRTH]`), and originalBody preservation (user-typed brackets are sacred). Bench evidence: `tests/benchmarks/user-context/FINDINGS.md` — 5 providers × 42 cases, 100% buffer-safe output, zero raw-value leaks. **Phase 3** (raw mode body injection, pack-side `requires-sentinels:` declaration, per-pack capability) stays deferred. User-facing summary: `docs/features/sentinels.md`. CLI: `opencues sentinels` (interactive interview + scriptable `set` / `remove` / `list --json`).
- **docs/architecture/feature-registry.md** ⚠️ Canonical reference for the FEATURES + MENU_TUNABLES + BUILTIN_BLANKS single-source-of-truth pattern at `packages/opencues-core/src/feature-registry.ts`. Replaces the pre-May-2026 multi-site drift where adding a feature required editing doctor.cjs + chrome/host.cjs + seed-configs.cjs + OPENCUES.md `settings:` block + per-host bootstraps in lockstep. **Adding a feature is now one PR appending one entry; nothing else can drift.** Documents: which sites the registry replaces, the one site it deliberately doesn't (typed OpenCuesState — caught by the alignment test), how to add a new feature step-by-step with a worked example (`agent-mode`), how to hide values from cycling (`exposeInMenu: false`, today only `sentinels-mode: raw`), every drift-prevention test (71 across 6 files), and when NOT to use the registry (per-cue config, implementation details). Read before touching feature-registry.ts, doctor's Feature wiring section, host.cjs's file-push list, seed-configs's templated copies, or BUILTIN_BLANKS in opencues-runtime/src/blanks/index.ts.
- **docs/architecture/model-override.md** ⚠️ Canonical reference for the per-call `with <model>` LLM dispatch override (June 2026). Detected in the buffer prose by `model-aliases.ts:detectModelOverride()` (regex `\bwith\s+([a-zA-Z][\w.-]*)\b`, case-insensitive on `with`, word-boundary anchored so `without` doesn't slip through). Resolves the token via a 5-tier ladder: COMMON_ALIASES (opus / haiku / sonnet / cerebras / groq / openai / nano / mini / gemini / flash / openrouter / gpt-oss / llama) → exact provider id → exact model name → prefix in any provider's `knownModels` (shortest-wins tie-break) → substring fallback. **Dispatch-only by design** — flips which (provider, model, apiKey) `dispatchChat` uses for ONE FluidBlank or TransformBlank call, never writes OPENCUES.md, doesn't bypass the bucket-class `trainsOnInput` guard, doesn't reach word-cues / sentence-cues / auditors / agent-rewrite / ConfigIntent. ConfigIntent CEDES synchronously when `detectModelOverride` matches (added with this feature) to avoid misclassifying override syntax as PROVIDER routing — without the cede, `make formal with opus _` was being misclassified as `cues-llm-provider: anthropic:claude-opus-4-7` and written to disk. FluidBlank threads override args explicitly into `callLLM`; TransformBlank uses a `_currentOverride` field cleared in `finally` because it has 6 callLLM sites (race-safe under the resolver's one-getCues-per-generation contract + the sibling-abort shipped earlier in June 2026). WIPE-mode span forced to `[0, context.text.length)` when override active so `with opus` wipes along with the lookup phrase. `fluid-blank.started` / `transform-blank.started` events carry an optional `modelOverride: { provider, model, token }` field — agentic scenarios 65-71 in `tests/agentic/scenarios/` assert on it. apiKeys map plumbed through build-sources keyed by `envKeyName` (matches `resolveLLM` at `llm-provider.ts:1817`). User-facing summary: `docs/features/model-override.md`. Read this before touching `model-aliases.ts`, the override-detect branch in FluidBlank / TransformBlank getCues, the ConfigIntent synchronous cede gate, or the apiKeys plumbing in `build-sources.ts`.
- **docs/architecture/llm-routing.md** ⚠️ Canonical reference for the three-bucket LLM routing (cues / auditors / blanks). Each bucket has one scalar pair in OPENCUES.md (`cues-llm-provider:` / `cues-llm-model:`, plus `auditors-llm-*` and `blanks-llm-*`); per-aspect scalars (`word-cues-provider:`, `agent-provider:`, `fluid-blank-provider:`, …) remain as file-edit-only advanced overrides and are deliberately kept out of the menu. Precedence ladder (top wins): per-call `with <model>` (override) > per-source > per-feature > bucket > global `llm-provider:` > auto-fallback. `agent-rewrite` reads the **auditors** bucket (background prose rewriter, not blank-bucket trust class). Both cues + auditors are prose-bearing and refuse `trainsOnInput` providers (opencode-zen) via the resolver's source-build guard; only blanks expose `opencode-zen` in its menu (the `_` keystroke is the user's consent gate). Migration from legacy singular `blank-llm-*` → plural `blanks-llm-*` handled by `seed-configs` self-heal + a back-compat read in `config-loader.ts:bucketProvider`. `opencues doctor` surfaces effective resolution per bucket. Read before touching the bucket entries in `feature-registry.ts`, `resolveFor` in `build-sources.ts`, `buildAgentLLMResolver` in `boot-common.ts`, or bucket parsing in `config-loader.ts`.
- **docs/architecture/max-thinking.md** ⚠️ Canonical reference for the `max-thinking: on | off` scalar (default on) — per-model reasoning-effort budget. Each verified reasoning model has a `{ max, off }` pair in `packages/opencues-core/src/model-thinking.ts:MODEL_THINKING` (cerebras gpt-oss → medium/low; groq/openai/openrouter gpt-oss + gpt-5 → low/none); ceilings seeded to equal each provider's `defaultReasoningEffort` so `on` reproduces pre-feature behaviour byte-for-byte, `off` is the only state that changes anything. **Single resolver, single chokepoint**: `resolveReasoningEffort()` (explicit per-call value wins but clamps DOWN to the ceiling; otherwise toggle picks max/off; `undefined` for non-reasoning providers — exactly the prior `req.reasoningEffort ?? defaultReasoningEffort` contract) runs inside `buildOpenAIBody` (`llm-provider.ts`), which every reasoning-capable wire call funnels through (the source `dispatchChat` calls AND AgentRewrite's direct `provider.buildRequest`). `maxThinking` rides the dispatch **ctx** that already flows to `buildRequest` — `dispatchChat` needed no body edit, only the ctx TYPE widened (buildRequest / dispatchChat / buildProviderRequest / AgentRewrite's adapter). Each OpenAI-compatible provider forwards `ctx.maxThinking`. Wired from OPENCUES.md via `resolver.ts` (cue/blank sources → build-sources `maxThinking` option) and `boot-common.buildAgentLLMResolver` (stamps `ResolvedAgentLLM.maxThinking` for agent-rewrite). **Settings-map-only** (no typed OpenCuesState field — listed in `feature-registry-alignment.test.ts:SETTINGS_MAP_ONLY`). config-intent classifier unaffected (pins `low`); non-reasoning providers (anthropic/gemini) ignore it. **NOT a spec change** — runtime reference-impl knob, `SPEC_VERSION` unchanged. **Known v1 gap**: AgentRewrite's legacy no-core-provider inline path doesn't consult it (only fires when `@opencues/core` can't be required). Read before touching `model-thinking.ts`, the reasoning branch of `buildOpenAIBody`, or the `maxThinking` plumbing across sources / build-sources / resolver / agent-rewrite. User-facing summary: `docs/features/max-thinking.md`.
- **docs/architecture/sentence-cues.md** ⚠️ Canonical reference for `scope: sentence` cues + the `sentence-cues-mode` scalar. New CueSource class `SentenceCueSource` (priority 85, sits between BlankSource 95 / TransformBlank 93 and typical word-cues 60-80). Emits one CueResult per sentence with `alternatives: [originalSentence, alt1, alt2, alt3]` + char-range `spanStart`/`spanEnd`; resolver registers a **passive** DynDef at `currentIndex: 0` (buffer keeps the original sentence) so Ctrl+Alt+Up at any word inside the sentence swaps in the next rewrite via the existing word-cue `applyAltCycle` path. Suppresses overlapping word-cues outright (design 4a). **Sentence-cues are CUES, not agents** — the buffer is never modified without an explicit user keystroke; the May 2026 prototype that auto-spliced `alts[1]` on emission was retired after the chrome agentic-harness verification showed prose being rewritten in the background without consent. Resolver also drops the cue if its span overlaps an active selector/satellite pair or any other span-bound DynDef (fluid-blank, transform-blank, config-intent) to prevent mid-overwriting a managed span on cycle. **Parser forward-compat** (May 2026): `cues-md.ts` exports a `KNOWN_SCOPES` allowlist; both `parseSingleCueMd` and `parsePromptSection` drop sources whose `scope:` is outside the set, with a `console.warn` naming the cue and unknown scope. This prevents a stale integration (chrome bundle that hasn't been rebuilt for the new scope) from misrendering a future-scoped cue as a generic word-cue — the structural fix for the same chrome rebuild gap that produced the May 2026 sentence-cue misrender. **v1 limitations:** one sentence-cue per resolve pass (avoids multi-splice word-index shift cascade — v2 will batch in reverse-span order); regex-based segmenter (abbreviations / URLs split mid-token but the LLM-cede via `ALT: NONE` recovers). Bench: `tests/benchmarks/sentence-cues/` validates 100% precision + 91-100% recall across 5 providers on the 30-case `more-formal` suite. **Re-run before editing `SENTENCE_ALT_FORMAT_SPEC` or the segmenter.** Shipped canonical cue: `defaults/cues/more-formal/CUE.md` (priority 85, `scope: sentence`). User-facing summary: `docs/features/sentence-cues.md`. Adding a new sentence-scope cue is one CUE.md file — no source-class edits.
- **docs/architecture/fluid-config.md** ⚠️ Canonical reference for the optional `fluid-config-mode` feature — semantic `_` → settings change classifier at priority 94 (between BlankSource 95 and TransformBlank 93). Routes ONLY to FEATURES registry scalars (never user blanks — volume / brightness / weather / etc. would widen the prompt-injection blast radius unacceptably). Three structural defences: prompt enumerates only registry-cyclable values; `validateAgainstRegistry` runtime check rejects unknown setting / unlisted value / `exposeInMenu: false` (footgun-mode); apply path uses the same `applyOpenCuesScalar` (write + 2.5s reload-suppression) the satellite cycling has used since v0.1. Emits a selector-satellite-shaped result that wipes the summon words via `spanStart=0/spanEnd=text.length` and hands off to standard `cycleSelectorSatellite`; `clearOnEdit: true` lets backspace wipe the resulting pair as one span. Bench: `tests/benchmarks/fluid-config/` validated v2.1 prompt across 5 providers at 100% precision + 90-100% holdout recall. **Re-run that bench before editing `SYSTEM_PROMPT` in `config-intent-source.ts`.** User-facing summary: `docs/features/fluid-config.md`. Adding a feature to FEATURES automatically extends the classifier's choice space — no prompt edit needed.
- **docs/architecture/ambient-context.md** ⚠️ Canonical reference for the optional `ambient-context-mode` feature — fluid-blank receives sanitized field metadata for disambiguating lookups. The host gathers a wider set (label/placeholder/aria/title/url-origin+path/meta-description) but the prompt ships only **label + placeholder + page-title** (the bench-validated 3-field minimal). OFF by default; chrome-only gatherer today but host-agnostic at the `HostAdapter` contract level; single-field scope (no sibling values, no system data). The whole model leans on a **structural invariant**: OpenCues has no tool handlers, no exec layer, and no out-of-band action channel for fluid-blank LLM output — worst-case prompt-injection lands as user-visible text the user sees before submitting. **Don't plug fluid-blank output into any side-effect layer** (tool execution, agentic actions, clipboard, fetch, etc.); doing so invalidates row #21 in `security-audit.md` and the threat model in this doc must be re-reviewed first. Read before touching `FluidBlankSource`, `AmbientContext`, the chrome gatherer, or the resolver's ambient-context gate. **Any edit to `FUSED_SYSTEM_PROMPT` or `renderAmbientBlock`'s field list MUST re-run `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` first** — the rewrite that introduced ambient handling cost 2pp on the standard 137-case suite until a CONTEXT-vs-UNTRUSTED_FIELD_CONTEXT distinction rule was added back; later (May 2026) the 2-pass P1+P3 pipeline was collapsed to a single fused call so the segmenter could also use the field's label for meta-triggers like `_` / `answer _`. Target: 175/176 or better. Bench orientation: `tests/benchmarks/CLAUDE.md`. User-facing summary: `docs/features/ambient-context.md`.

---

## Build Commands

**Target:** `claude-cues` (`~/claude-code-cues`) only. The native `claude` install is never touched.

After any change to a Claude Code patch source or to `@opencues/core` / `@opencues/runtime`, run:

```bash
integrations/claude-code/patches/setup.sh
```

The script:
1. Copies `opencuesRuntime.ts` to tweakcc and rebuilds it (compiles the patch into `dist/`)
2. Builds `@opencues/core` and copies to `<CC_FORK>/node_modules/@opencues/core/` (so cli.js's bare-specifier `require("@opencues/core")` resolves via Node's standard upward walk — no symlinks)
3. Builds `@opencues/runtime` and rsyncs `dist/` to `<CC_FORK>/node_modules/@opencues/runtime/`. Statusline script + OS action scripts go under `<CC_FORK>/.cues/{statusline.sh,scripts/}`. tweakcc's own config + `cli.js.backup` redirect to `<CC_FORK>/.cues/patch-state/` via `TWEAKCC_CONFIG_DIR`. **Compact footprint**: everything (runtime, support files, patcher state, patched cli.js) lives inside `~/claude-code-cues/`. Uninstall is `rm -rf ~/claude-code-cues` + tweakcc revert (mirrors OpenCode).
4. Applies compiled patches to `claude-cues` (`~/claude-code-cues`)

To re-apply patches without rebuilding (after a Claude Code version bump, no source changes):

```bash
cd integrations/claude-code/tweakcc
CLI_JS=$(find ~/claude-code-cues -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

> **Note:** `.md` config files (`CUES.md`, `BLANKS.md`, `cues/`, `blanks/`) hot-reload within ~2 seconds on the next keystroke — no restart needed.

---

> **Important:** Patch development rule: never use bare `require()` in
> the cli.js bootstrap — cli.js is ESM-converted and `require` isn't
> defined at module scope. Use the `createRequire`-derived var that
> `getRequireFuncName(oldFile)` returns (see `opencuesRuntime.ts`).

---

## Upgrade path — name the steps BEFORE saying "go test"

When you finish a feature and are about to suggest the user try it,
state the upgrade path explicitly first, in this shape:

> "To exercise this, you will need to: (1) rebuild X, (2) sync Y to
> Z, (3) re-run `opencues install …` if file W changed, (4) seed any
> new config file, (5) edit OPENCUES.md to flip the scalar, (6) reload
> the extension / restart the host."

Then ask: "is any step in that list non-obvious or non-seamless?" —
because that list is *also* what users will hit when they upgrade.
If the path has more than two steps the user has to remember, the
feature isn't shippable yet; we need a `seed-configs` self-heal, a
chained installer, or a doctor check to collapse the steps.

Why this lives here: in the sentinels + ambient-context ship
(May 2026) every "go test" had a hidden defect at an install-boundary
join — SENTINELS.md (then `USER.md`) not pushed by chrome-host, template frontmatter at
the wrong position, ConfigLoader silent on missing file, DynDefs
leaking across buffers. Unit tests covered each component in
isolation but missed the chain. Naming the upgrade path up front
forces the chain to be walked mentally before the user walks it
manually — defects in the chain become observations instead of
back-and-forth debugging sessions.

The rule applies to every new feature, not just chrome's. Whenever
a feature adds a config file, a scalar, a host-process update, a
bundle change, or any cross-component wire — call out the upgrade
path explicitly when you hand the feature back for testing. Treat
"seamlessness" as a feature requirement, not a polish item.

**Per-feature checklist when adding a new scalar or config file:**

There is ONE source of truth for the set of optional features:
`packages/opencues-core/src/feature-registry.ts`. Adding a feature is
one PR appending to `FEATURES` (or `CORE_TEMPLATES` for a new always-on
config file with a starter template). Every install-boundary site
reads from the registry:

- `packages/opencues-cli/src/commands/doctor.cjs` — iterates `FEATURES`
  for the Feature wiring section + `chromeHostFileList()` for the
  chrome-host parity check.
- `integrations/chrome/host/host.cjs` — iterates `chromeHostFileList()`
  to know which files to push into chrome.storage.
- `packages/opencues-cli/src/commands/seed-configs.cjs` — iterates
  `seedableOptionalFiles()` to know which template files to copy.

The one thing the registry does NOT replace yet:

- `packages/opencues-runtime/src/modules/config-loader.ts` — still
  manually parses each scalar into a typed `OpenCuesState` field. This
  is a deliberate trade-off: keeping the typed enum gives TypeScript
  consumers narrow types (`opencuesState.userContextMode: 'off' |
  'safe' | 'raw'`) instead of `string`. Drift between the registry
  and `OpenCuesState` is caught by a test pinning that every scalar
  in `FEATURES` has a matching `OpenCuesState` field.

When you add a feature, update `FEATURES` first. If the feature needs
typed access in TypeScript consumers, also add the field to
`OpenCuesState` + the parse case in `config-loader.ts` — but NEVER
add the file-push list to host.cjs or the diagnostic row to doctor
or the seed copy to seed-configs. Those are now derived.

---

## Testing — write the SCENARIO that triggered the bug

The runtime has 500+ tests. Most are unit tests, which are good at
pinning module behaviour but **structurally bad at catching the bug
class we keep hitting**: state inconsistencies across multiple modules
during multi-step user journeys (cycle → cycle → type → cycle, two
spans active, dim flicker between cycles, etc.).

**Rule:** when fixing a bug, write the SCENARIO (multi-step user
journey) that triggered it, not just a unit-level repro of the
broken function.

The right shape:
```ts
it('cycle → cycle → type → cycle preserves downstream defs', async () => {
  const { adapter, hlState, dynDefs } = await setupScenario('the attorney filed today');
  hlState.activate(1, ...);
  adapter.fireKey('up', { ctrl: true, alt: true });
  expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed today');
  adapter.fireKey('up', { ctrl: true, alt: true });
  expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle filed today');
  expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
  // ... continue the user journey, asserting at every step
});
```

The wrong shape (what we'd write reflexively):
```ts
it('applyAltCycle handles multi-word alt', () => {
  const def = makeDef(...);
  applyAltCycle(event, def, +1, 1);
  expect(def.spanEnd).toBe(...);  // unit-level — misses every interaction
});
```

Where to put scenario tests:
- `packages/opencues-runtime/src/modules/cycling.scenarios.test.ts` — the
  canonical place for cycling/span/dim/nav journeys. 30+ tests cover
  the well-traveled paths; add to the relevant describe block.
- New domains get their own `<feature>.scenarios.test.ts` file.

Why this matters: the April 2026 bug arc had 8+ regressions caught
only after the user reported them. Each was a state inconsistency
across modules during a multi-step interaction. Unit tests covered
each module in isolation but missed the journey. The scenarios file
+ the pattern above is the structural fix.

See `docs/architecture/spans-and-cycling.md` § "Bugs we've fixed" for
the table of regressions and which scenario test now pins each one.

---

## Cross-platform shell scripts — bash 3.2 / BSD compat

Any shell script that ships in this repo (`defaults/`, `integrations/*/bin/`,
`integrations/*/patches/*.sh`) MUST be portable across:

- **macOS** — `/bin/bash` is 3.2 (no bash 4 features), coreutils are BSD (different flags), no `/proc`.
- **Linux / WSL** — GNU bash 4+, GNU coreutils, has `/proc`.

A friend trying to install on a Mac (May 2026) hit two install-time blockers
(`sed -i ''` BSD form + pnpm workspace dup) plus four runtime degradations
(bash 3.2 `mapfile`, `[[ =~ ]]`, `(( ))`; `/proc` reads; `stat -c`; `readlink -f`).
Install path is now hardened; runtime path was patched script-by-script.
Future scripts that re-introduce non-portable constructs silently regress macOS users.

**Defaults when writing a new `.sh`:**

- Shebang: `#!/usr/bin/env bash` (not `#!/bin/bash` — picks up macOS 3.2 only)
- No bash 4+ features: avoid `mapfile`, `declare -A`, `${var^^}` / `,,`, namerefs (`declare -n`)
- Prefer POSIX over bashisms when equivalent: `grep -qE` over `[[ =~ ]]`, `[ -gt ]` / `[ -lt ]` over `(( ))`
- `sed -i` → reuse the `sedi()` wrapper (see `integrations/claude-code/patches/setup.sh:42` or `defaults/blanks/volume/volume-blank.sh`)
- `stat -c %s` → `stat_size()` (`stat -c` GNU / `stat -f` BSD — pattern in `integrations/shell/bin/oc-popup:43`)
- `readlink -f X` → `resolve_link()` portable walker (pattern in `integrations/shell/bin/{oc-shell,oc-edit,oc-editd,oc-popup}`)
- `/proc/$PID/...` → gate with `[ -d /proc ]`; fall back to `ps -o ppid= -p $PID` / `ps -o command= -p $PID` (pattern in `integrations/claude-code/patches/highlight-statusline.sh`)
- `xargs -r` → use `[ -s file ] && xargs < file` or `find ... -print0 | xargs -0`
- `find -printf` → use `stat` / `awk` equivalent

**When a feature needs a new external tool** (tmux, bun, etc.): extend
`preflightChecks` in `packages/opencues-cli/src/commands/install.cjs` so
macOS users learn about the dependency at `opencues install` time, not
the first time the feature fires. The preflight is darwin-only (Linux
distros vary too much) and prints `impact:` / `fix:` per item without
blocking the install.

Bash-syntax-check every shell-script edit before handing back: `bash -n <file>`. The repo-wide lint at `scripts/lint-shell-portability.sh` (wired into CI as the `shell-portability` job) covers all the hard bans automatically — run it locally before pushing if you touched any `.sh`.

---

## Environment

- **Native build dep**: `isolated-vm` (runtime sandbox, INFOSEC F1). Prebuilt binaries cover linux/darwin x64+arm64 + win32 x64; rare arches fall back to `node-gyp rebuild` which needs a C++ toolchain (`build-essential` + `python3` on Linux, `xcode-select --install` on macOS). `opencues install` probes the binding load and prints actionable platform-specific guidance if it can't — bypass with `OPENCUES_SKIP_NATIVE_PROBE=1` once verified.
- **API Key**: `GROQ_API_KEY` for Groq (default provider)
- **API Key**: `FINNHUB_API_KEY` for Finnhub (stock prices)
- **Debug**: `DEBUG=cues*` for debug logging
- **Config**: `~/.tweakcc/config.json` for Claude Code settings

> **PRE-LAUNCH:** Rotate `GROQ_API_KEY` and `FINNHUB_API_KEY` before making the repo public. Keys are hardcoded in `integrations/chrome/.env` (gitignored) for dev convenience.

---

## Config search paths — who reads what

Native hosts (CC / OC) read the filesystem directly. Chrome
can't — it runs in the browser — so it reads a pre-built bundle. The
two paths behave differently:

| Host | Sources at runtime | How project configs get in |
|---|---|---|
| **claude-code** | `$OPENCUES_HOME` → `<cwd>/.cues/` → `~/.cues/` | Automatic (cwd-based merge) |
| **opencode** | same | same |
| **gemini-cli** | same | same |
| **chrome** | `chrome.storage.local['opencues_bundle']` (pushed live by the native-messaging host) → `<extension>/dist/configs/` (bake-time) → esbuild `__DEFAULT_*__` constants | Live — `opencues install chrome-host` watches `~/.cues/` and pushes; bake-time fallback via `opencues sync chrome` |

For the native hosts, project wins on name conflicts. Missing dirs are
silently skipped; the runtime degrades gracefully. Hot-reload polls
every search path on every keystroke.

Chrome has no runtime filesystem access, so it relies on a local
native-messaging host process (installed via `opencues install
chrome-host`) that watches `~/.cues/` and pushes bundles into
`chrome.storage.local` over Chrome's native-messaging API. The
extension reads storage first, falling back to the bake-time bundle
in `dist/configs/` and finally to esbuild-inlined `__DEFAULT_*__`
constants from `<repo>/defaults/` (see
`docs/features/shipped-defaults.md`). A user who installs but never
runs the host still gets grammar/legal/medical etc. via the bake-time
path. Full spec: `docs/features/chrome-sync.md`.

### ConfigLoader search-path detail (native hosts)

```
$OPENCUES_HOME           ← env override (top priority; for CI / power users)
<cwd>/.cues          ← project-level (cd into your project)
~/.cues              ← user-level (global defaults)
```

The convention mirrors `.editorconfig` / `.npmrc` / `.claude/skills/` — opaque
host-neutral dir at the project root. Missing dirs are silently skipped; the
runtime degrades gracefully.

A user with no `.cues/` anywhere gets empty config (CC/OC)
— not a crash. Hot-reload polls every search path on every keystroke
(same `maybeReload` mechanism as before).

### OPENCUES.md vs CUES.md — two different files

Despite the similar names, these are unrelated files: `OPENCUES.md` is user-level runtime system settings (scalars + tunables, schema owned by FEATURES/MENU_TUNABLES registry); `CUES.md` is the cue master config (project metadata + Tips/Ignore/Prompt sections, lives user-level OR project-level). Full disambiguation + lifecycle: [docs/glossary.md § OPENCUES.md vs CUES.md](docs/glossary.md#opencuesmd-vs-cuesmd--two-different-files).

---

## Host compatibility — which integrations a cue/blank runs on

Default-attempt model: every cue/blank advertises as compatible with every host; the runtime tries the call and fails at runtime (exit 127) if the host can't fulfil it. Override via `on-host:` / `not-on-host:` frontmatter (host scoping) and `on-site:` / `not-on-site:` (chrome-only URL scoping; supports platform names, hostnames, `*.wildcard`, `host/path-prefix`). API: `@opencues/core`'s `inferHostCompat()` / `inferSiteCompat()`. Full spec + site-scoping rules: [docs/features/host-compat.md](docs/features/host-compat.md).

---

## Word-alt routing — per-word source dispatch

Every `### alternatives` section becomes one `ConfigSource`. `buildSourcesFromConfig` wraps them in ONE `RoutedWordSourceGroup`: each word is claimed by the highest-priority source whose `match:` regex or `keywords:` list hits, then per-source batches go to one parallel LLM call each. Every source MUST declare `match:` OR `keywords:` (construction-time check). **Don't concatenate `### alternatives` bodies** — per-word dispatch is the structural property that gives isolation (a hijacking prompt in one source can't poison words it doesn't claim). Full spec: [docs/features/word-cue-routing.md](docs/features/word-cue-routing.md).

---

## Hoisted-blank writes vs ConfigLoader hot-reload

Race: scalar-cycling does in-memory update + async host write + setText (which triggers `ConfigLoader.maybeReload`); the reload can fire before the async write lands and re-clobbers state from the stale file. Fix: `applyOpenCuesScalar` arms `_suppressReloadUntil = Date.now() + 2500`. **If you add a new path that mutates a scalar + writes via `blankInvoke`, reuse `applyOpenCuesScalar`** so the suppression fires automatically. Full analysis + test pointers: [docs/architecture/config-loader-reload-race.md](docs/architecture/config-loader-reload-race.md).

---

## Chrome Extension — Dev Workflow

Chrome runs on Windows but builds in WSL — after `npm run build`, copy `integrations/chrome/dist/*` + `manifest.json` to `/mnt/c/Users/wilfred/AppData/Local/opencues-chrome/` or Chrome runs the stale bundle. `opencues sync chrome` defaults to user-level only (`~/.cues/`); opt project configs in via `--include` / `--project` (`--watch` is a long-running process; explicit paths beat cwd-dependence). Full workflow + symptom checklist: [integrations/chrome/CLAUDE.md § Dev workflow](integrations/chrome/CLAUDE.md). Sync spec: [docs/features/chrome-sync.md](docs/features/chrome-sync.md).

---

## Pre-launch — items to handle before going public

**Markdown files to remove or move to a gitignored path:**

- `damon.md` — overview written for one specific person
- `todos.md` — internal TODO list
- `pre-launch-readme.md` — the launch checklist itself ("Pre-Launch TODO")
- `opencues-strategy.md` — internal strategy doc (OpenClaw-model framing, latent-moat self-assessment); public version of the framing lives in `blog-resources/` / future `GOVERNANCE.md`

**Other**:

- Switch `LICENSE` from "Proprietary. All rights reserved." to the chosen open-source license; the README license section will continue to render the new text without further changes.

**Switch `opencues` npm name from parked placeholder to real CLI**: runbook at [docs/launch/npm-handover.md](docs/launch/npm-handover.md) — covers the 5-step handover, the version-can't-be-reused caveat, and the security-key/TOTP gotcha for org-write commands.

Tracked here so the launch pass doesn't miss them. Update this section
as items are resolved.

---

## Package version map (snapshot)

Snapshot of `name` + `version` across every `package.json` in the repo
(excluding `node_modules/` + worktrees). Regenerate with:

```bash
for f in package.json packages/*/package.json integrations/*/package.json; do
  printf "%-50s " "$f"
  node -e "const p=require('./$f'); console.log(p.name, p.version, p.private?'(private)':'')"
done
```

| Path | Name | Version | Status |
|---|---|---|---|
| `SPEC.md` (open-standard) | `cues-spec` | 0.2 (draft) | exported as `SPEC_VERSION` from `@opencues/core` |
| `package.json` (monorepo root) | `opencues` | 0.1.0 | private |
| `packages/opencues-core/` | `@opencues/core` | 0.3.5 | private |
| `packages/opencues-runtime/` | `@opencues/runtime` | 0.2.8 | private |
| `packages/opencues-cli/` | `opencues` (real CLI) | 0.2.0 | private |
| `packages/opencues-park/` | `opencues` (placeholder) | 0.0.1 | **PUBLISHED on npm** |
| `integrations/claude-code/` | `@opencues/claude-code` | 0.2.0 | private |
| `integrations/opencode/` | `@opencues/opencode` | 0.2.0 | private |
| `integrations/chrome/` | `@opencues/chrome` | 0.2.3 | private |
| `integrations/gemini-cli/` | `@opencues/gemini-cli` | 0.2.0 | private |
| `integrations/shell/` | `@opencues/shell` | 0.2.0 | private |

Two packages share the bare `opencues` name — the real CLI at `packages/opencues-cli/` (still private) and the parking placeholder at `packages/opencues-park/` (published as v0.0.1 to the public npm registry, owned by the `opencues` org via the `developers` team). Launch handover is described in the npm-name pre-launch checklist above; the real CLI's v0.1.0 cleanly supersedes the placeholder's v0.0.1 on first publish.

Everything except the placeholder is currently `private: true`. Flipping a package to publishable requires removing `"private": true` AND repointing (or removing) its `publishConfig` block (most currently target `npm.pkg.github.com`).

## Cerebras-specific features

Cerebras is the default inference path and the provider OpenCues optimises hardest for. **Automatic prompt prefix caching** is the biggest current feature: cerebras hits 99.5% cache rate on our ~20k-token `FUSED_SYSTEM` / `FUSED_SYSTEM_PROMPT` constants, saving ~300-500ms of TTFT per dispatch. Two hard rules for prompt authors:

1. **Stable session-level context (identity catalog, blank-context catalog) goes in the SYSTEM message** so cerebras caches it as part of the prefix.
2. **Per-call binding context (ambient field metadata, user INPUT) stays in the USER message.** Moving ambient to system regressed the fluid-blank-ambient bench from 175/176 → 166/176 — the LLM stops tightly binding ambient hints to the input.

Cache visibility lives at `dispatchChat`'s optional `onUsage(u: UsageReport)` callback. The three semantic-`_` sources wire it to `this.log` and emit a debug-level line when `cachedTokens > 0`. Enable `debug-mode: on` to observe.

Full design + cross-provider comparison + code-pointer table: [docs/architecture/cerebras.md](docs/architecture/cerebras.md). Read it before touching the system/user message split in any source, before adding per-call salts anywhere near the start of a system prompt, or before adopting a new cerebras-only feature (reasoning effort, strict JSON, routing keys, etc.).

## Versioning policy

Semver per package, stay <1.0 until public launch, bump in the same commit as the change, integrations bump independently of core/runtime. `SPEC_VERSION` bumps only on wire-format changes. **Every version bump also updates `CHANGELOG.md` (root) in the same PR**; spec-affecting changes also update `spec/CHANGELOG.md`. Full policy with per-package bump rules + changelog discipline: [docs/architecture/versioning.md](docs/architecture/versioning.md).

### Chrome integration — bump `manifest.json` AND `package.json` in lockstep

The chrome integration has **two** version fields that MUST stay aligned:

- `integrations/chrome/manifest.json` — what **Chrome itself displays** in `chrome://extensions` and uses for the auto-update tracker. The user-visible version.
- `integrations/chrome/package.json` — what **npm + the monorepo's version snapshot** track.

These have drifted multiple times because contributors update one and forget the other. The June 2026 LinkedIn-Quill PR (#91) found `manifest.json` at 0.2.1 while `package.json` had moved to 0.2.2 — five chrome-touching PRs (#84, #75, #82, #83) had landed without touching the manifest. Users reloading the extension saw the SAME version string in `chrome://extensions` across all 5 PRs, so there was no way to confirm a new bundle was actually loaded. The prior drift event was commit `dfd7658 fix(chrome): align manifest.json version with package.json (0.1.1 → 0.1.4)` — the same shape.

**Rule:** any PR that touches `integrations/chrome/src/**` (or any file that lands in `dist/`) MUST bump BOTH `manifest.json` AND `package.json` to the same new version in the same commit. If the chrome bundle's bytes change, both files change. No exceptions.

`scripts/pre-pr.sh`'s `doctor` check doesn't currently catch this drift; it's a structural gap. Until a lint covers it, reviewers MUST eyeball chrome PRs for the lockstep bump.

### When to bump `SPEC_VERSION`

The open-standard version (`packages/opencues-core/src/spec-version.ts`'s `SPEC_VERSION`) is the wire-contract pin a second implementation targets. **Bump the spec version in the same PR** when any of these land:

- New file format (e.g. June 2026 added `IDENTITY.md` — bumped 0.1 → 0.2).
- New frontmatter key documented in `spec/cue-spec.md` / `spec/blank-spec.md` / `spec/auditor-spec.md` / `spec/identity-context-spec.md` (e.g. `as-context:`, `contextTtl:`).
- New spec-level OPENCUES.md scalar (anything declared in `spec/core.md` § Spec-mandated scalars — today `identity-context-mode`, `blank-context-mode`).
- Reserved blank/cue/auditor name (e.g. `name: sentinel` reserved for the IDENTITY.md write surface).
- Any change that would make a `0.x-alpha` reader misinterpret a file authored against the new spec.

**Do NOT bump** when only changing:

- Prompt prose internal to the reference impl (out of spec scope).
- Reference-impl class names, file paths, runtime-only knobs (`debug-mode`, `voice-mode`, `tts-rate`, per-bucket LLM routing — all live in `packages/opencues-runtime/SPEC.md`, not the standard).
- Editorial wording in spec docs that doesn't change a normative claim.

**The bump checklist** (in one commit):

1. `packages/opencues-core/src/spec-version.ts` — bump the exported constant (`'0.1'` → `'0.2'`).
2. `SPEC.md` (root) — update the **Current version** line.
3. `spec/README.md` — update the Status banner + Status & versioning section.
4. `spec/*.md` (every spec doc — cue/blank/auditor/identity-context/core) — bump the Status banner.
5. `spec/CHANGELOG.md` — release the `[Unreleased]` block under the new version header with today's date + add a `## [Unreleased]` placeholder above it.
6. `packages/opencues-core/src/conformance.test.ts` — bump the `case 'spec-too-new'` regex to match the new version's "too-new" threshold.
7. **Conformance fixtures (`spec/conformance/`)** — per `spec/conformance/README.md`, the suite forks when a new spec version cuts. Adding fixtures for the new surface (e.g. `spec/conformance/valid/identity/`) goes here. If the new surface ships without fixtures, add a TODO row to `spec/conformance/README.md` explicitly calling out the coverage gap.
8. **JSON schemas (`spec/schemas/`)** — update any schema affected by the new frontmatter keys or scalars. JSON-schema-driven validators are the first thing a third-party tooling integrator will reach for; stale schemas silently flag valid frontmatter as unknown.
9. Update package versions per the usual per-package rules (`@opencues/core` always bumps when SPEC_VERSION bumps; downstream packages bump per `docs/architecture/versioning.md`).

The `version-bump-gate` lint enforces `package.json` version bumps when `src/` changes; it does NOT enforce SPEC_VERSION bumps when only `spec/` changes. Reviewers MUST eyeball spec-only PRs for the bump checklist above — there's no current static gate. (Candidate for a future `lint-spec-bump.sh`.)

### Spec-omit-default is permanent

`spec/core.md` says "Files that omit `spec:` MUST be treated as `opencues/0.1-alpha`". When the spec bumps to `0.2-alpha`, the omit-default **stays at `0.1-alpha`** — never moves forward. Reasoning: old unannotated files keep working; new files SHOULD declare their target spec explicitly. Moving the default forward would silently misinterpret pre-existing files.

The `version-bump-gate` CI job + `scripts/lint-version-bump.sh` enforce the "src changed → version bumped" half of this policy structurally. Bypass per-PR with the commit-message marker `[skip version-bump]` for non-shipping changes (docs, refactors, tests-only).

---

## Before you merge — minimum checklist

The June 2026 PR cluster (#42 → #48, #47 → #49) all needed follow-up PRs because the shipping PR didn't exercise enough surfaces locally. The pre-PR gates below structurally prevent the same shape.

**One command** runs every gate:

```bash
bash scripts/pre-pr.sh
```

Takes ~3 minutes warm. Individual gates can be skipped with `SKIP_BUILD=1 / SKIP_TESTS=1 / SKIP_INSTALL_SMOKE=1` for tight iteration loops.

What each gate catches, mapped to a real bug it would have caught:

| Gate | Script | Bug pattern it catches |
|---|---|---|
| **Shell portability + strict-mode** | `scripts/lint-shell-portability.sh` | PR #43 (silent npm failure — `set -e` without `pipefail` let `npm install ... \| tail -3` swallow errors) |
| **Legacy-names lint** | `scripts/lint-legacy-names.sh` | June 2026 sentinels → identity-context rename — `SENTINELS.md` / `sentinels-mode` / `opencues sentinels` references lingered in dozens of files after the rename PR. Banned-list with `LEGACY-NAME-ALLOW` marker for historical/narrative carve-outs. |
| **Version-bump gate** | `scripts/lint-version-bump.sh` | PRs #37-#41 (source changed, version stayed put → marker drift detection blind to the change) |
| **Chrome bundle artifacts** | `scripts/check-chrome-bundle.sh` | PR #47 → #49 (`await import('node:fs')` in boot-common broke esbuild; bundle silently shipped with missing dist files) |
| **Test hermeticity** | `scripts/check-test-hermeticity.sh` | PR #41 (vendor-pins test `fs.rmSync`'d the real user's `~/.opencues/vendor/tmux/` on every `pnpm test` run) |
| **Install self-heal smoke** | `scripts/check-install-self-heal.sh` | PR #42 → #48 (install short-circuited "already healthy" without updating marker; `opencues run cc` rebuilt forever in a closed loop) |
| **CC fork bundle integrity** | `scripts/check-cc-bundle-integrity.sh` | PR #117 providers/-missing class — a new file/subdir under `packages/opencues-{core,runtime}/dist/` that the CC patch's bootstrap requires but `integrations/claude-code/patches/setup.sh`'s copy step misses. Assembles the exact fork bundle setup.sh ships into a tmp dir, then `require()`s every spec the patch references from a clean NODE_PATH so workspace hoisting can't mask missing transitive deps. ~10s. |
| **`doctor`** | built-in CLI command | Real install-state warnings (⚠) — chrome /mnt/c sync, missing keys, broken forks. Content-hash-based since June 2026, so no false-positive after `pnpm build`. CI runs `doctor --strict` for info-level findings too. As of PR #118, doctor surfaces per-CC-fork drift (each `~/claude-code-cues*` dir gets a discrete row: stale → warn, missing marker → warn, fresh → info). |

CI runs the same gates as separate jobs so a green local run mirrors what CI will report. If `pre-pr.sh` passes locally, CI will pass.

## Cross-PR contract — when you change X, run Y

The follow-up PR class arose specifically because changes to *runtime / boot / install* code interact with downstream consumers without obvious source-level coupling. Concrete contracts:

- **Change `@opencues/runtime/src/boot-common.ts` or anything importing `node:*` modules?** Run `cd integrations/chrome && npm run build`. The chrome esbuild fails on unmarked node imports — `external:` declaration goes in `integrations/chrome/esbuild.config.mjs`.
- **Change `integrations/claude-code/bin/install.cjs` or `packages/opencues-cli/src/commands/run.cjs`?** Run `bash scripts/check-install-self-heal.sh`. Or manually: `opencues install <host>` → `opencues run <host>` → `opencues run <host>` again. The second run must be **silent** (no "Rebuilding before launch"). If it isn't, the install path lost the marker write or the run path's drift check is firing incorrectly.
- **Change `version-markers.cjs` or any code that calls `writeMarker` / `checkDrift`?** Run the PR #42 demo scenarios (A–D) in the PR description manually OR via `scripts/check-install-self-heal.sh`.
- **Change LLM dispatch error handling (any `catch` in `packages/opencues-core/src/sources/*-source.ts`)?** The catch MUST `this.log(...)` or `this.logInfo(...)` before returning the error envelope. Resolver consumers ignore the `error` field — silent catches eat the only failure signal.
- **Add a new log line that more than one host emits?** Prefix it with `[<host>]` or emit via `adapter.log` (which auto-prefixes). Bare `[opencues] ...` lines in the shared `/tmp/opencues.log` confuse multi-host debugging — see PR #45.
- **Edit a test file?** Grep for `os.homedir()`, `process.env.HOME`, `path.join(os.tmpdir())`. If any test writes under those without a `before/after` hook that mkdtemps and restores HOME, you have a vendor-pins-class bug. See PR #41 for the fix pattern.
- **Renaming a feature, file, or scalar?** Add the old name(s) to `BANNED_PATTERNS` at the top of `scripts/lint-legacy-names.sh` in the SAME PR. The lint enforces "no shipping-code reference to the old name" structurally — what was an editorial pass of grep-and-replace becomes a CI gate. Migration code (files whose JOB is to handle the rename — `seed-configs.cjs`, `doctor.cjs`, migration tests) goes on `FILE_ALLOWLIST`. One-off historical-narrative references get a `// LEGACY-NAME-ALLOW: <reason>` marker on the same line.
- **Editing `integrations/claude-code/patches/opencuesRuntime.ts`?** Run `node scripts/check-cc-patch-boot.cjs` (or `bash scripts/pre-pr.sh`, which includes it). The CC patch is a JS string injected into a minified cli.js; source typechecks won't catch identifier-scope errors in the emitted string. The smoke evaluates the emitted bootstrap in a sandbox to surface `ReferenceError` / missing field errors that would otherwise only fire on a user's machine. Any identifier referenced in the boot args object literal (`blanks:`, `blankInvoke:`, `spawnProcess:`, etc.) MUST be declared in the surrounding `s1Bootstrap` scope, not inside an IIFE in the args themselves.
- **Adding a new file or subdir under `packages/opencues-{core,runtime}/dist/` that the CC patch's bootstrap references?** Run `bash scripts/check-cc-bundle-integrity.sh`. The script assembles the exact bundle `integrations/claude-code/patches/setup.sh` ships into a tmp synthetic fork + runs `require()` from a clean NODE_PATH against every spec in the patch's bootstrap. If setup.sh's copy step doesn't cover the new file, the gate fails with a pointer at the broken require. The recursive `for sub in $CUES_CORE/dist/*/` loop in setup.sh § 5 covers any new subdir structurally; a NEW top-level file (not under a subdir) would need its own copy line. Always add the spec to `REQUIRED_SPECS` or `OPTIONAL_SPECS` in `scripts/check-cc-bundle-integrity.sh` so the gate exercises it. OC/Gemini/Shell setup.sh already use full-recursive `cp -r dist/`, so they're not affected by this bug class — but if any of those ever switches to a hard-coded list, the same bug shape returns and a parallel gate should be added for that integration.
- **Adding a feature that requires re-installing existing CC users?** PRs that bump `@opencues/{runtime,core}` versions auto-trigger srcHash drift in every fork's `version.json` marker, and `opencues install claude-code` now fans out across every `~/claude-code-cues*` dir with a CC binary by default. Multi-fork dev setups (`-150`, `-158`, `-170`) refresh in one command. `--canonical-only` opts out of the fan-out when you genuinely only want the user-facing fork rebuilt. Boot-time `checkRuntimeDrift` (wired into CC's adapter band in PR #118) warns direct-launch users in `/tmp/opencues.log` if they bypassed both `opencues run` and the install fan-out.

If a change touches more than one row above, run them all. The `pre-pr.sh` aggregator runs every gate regardless — when in doubt, just run it.

## Common drift-bug patterns

The eight bug classes from the June 2026 debugging session, with the file + the test that pins each one going forward. When something feels off in similar territory, start by re-reading the pattern that matches.

| Bug class | First seen in PR | Pinned at | Lint that catches it |
|---|---|---|---|
| Test writes to real `~/.opencues/` | PR #41 | `vendor-pins.test.cjs` (before/after hook with mkdtempSync) | `check-test-hermeticity.sh` |
| Shell script with `set -e` but no `pipefail` masks pipe failures | PR #43 | `setup.sh:38` + comment | `lint-shell-portability.sh` strict-mode check |
| Source catch returns error envelope without logging | PR #44 | `transform-blank-source.ts:1910`, `fluid-blank-source.ts:843` | code review (no static lint yet — candidate for a future grep-based linter) |
| Log line lacks `[host]` prefix in shared log | PR #45 | `chrome opencues-bootstrap.ts:1886` (now uses `[opencues][chrome]`) | convention check |
| OPENCUES.md edit doesn't propagate without keystroke | PR #46 | `config-loader.ts:subscribe` (5s background poll) | `config-loader.test.ts` background-poll tests |
| Direct launch bypasses self-heal | PR #47 | `boot-common.ts:checkRuntimeDrift` | runs at every host boot |
| Install short-circuits with stale marker → run-loop | PR #48 | `integrations/claude-code/bin/install.cjs:checkSrcHashDrift` | `check-install-self-heal.sh` |
| `node:*` import in runtime breaks chrome bundle | PR #49 | `integrations/chrome/esbuild.config.mjs:external` | `check-chrome-bundle.sh` |
| Renamed feature's old name lingers in shipping code | June 2026 sentinels → identity-context rename | `scripts/lint-legacy-names.sh:BANNED_PATTERNS` + per-line `LEGACY-NAME-ALLOW` markers | `lint-legacy-names.sh` |
| CC patch emits JS with scope/reference errors that only fire at runtime | June 2026 cc38ab8 (`blanks: __ocReg` where `__ocReg` was IIFE-local) — every keystroke ReferenceError'd, swallowed by patch's own catch, OpenCues silently dead on every CC user's machine. Bundle parsed fine; source typechecked fine; install applied fine. | `scripts/check-cc-patch-boot.cjs` evaluates the emitted bootstrap in a Node vm sandbox with stubs — surfaces ReferenceError + asserts boot args have all required fields | `check-cc-patch-boot.cjs` |
| Chrome `manifest.json` version drifts from `package.json` version | June 2026 PR #91 — manifest stuck at 0.2.1 while package.json had moved to 0.2.2 across PRs #84, #75, #82, #83. Users reloading the extension saw the same version string in `chrome://extensions` across 5 PRs, so there was no way to confirm a new bundle was actually loaded. Prior drift event: commit `dfd7658 fix(chrome): align manifest.json version with package.json (0.1.1 → 0.1.4)` — same shape. | CLAUDE.md § "Chrome integration — bump `manifest.json` AND `package.json` in lockstep" | none yet — candidate for a future `lint-chrome-version-lockstep.sh` |
| Top-level Node-only native import in `@opencues/runtime` crashes Bun-based hosts at boot | June 2026 b460076 — INFOSEC F1 added `import ivm from 'isolated-vm'` at the top of `node-loader.ts`. opencode + shell run on Bun (JavaScriptCore), so their host process crashed at boot with `undefined symbol: _ZN2v8...` before any try/catch could fire. Unit tests run on Node so they stayed green; only the agentic harness on opencode caught it. Two hosts (40% of integrations) were broken silently for hours. | `packages/opencues-runtime/src/user-blanks/node-loader.ts:getIvm` — keep the top-level import type-only; lazy-require inside the function that uses it so a failed load propagates to `registry.ts`'s try/catch and the host disables only JS user-blanks. | `check-runtime-loads-on-bun.sh` — Bun loads `registry.js`; any top-level Node-V8 native pull-in re-introduces the crash and the gate fails |
| New `@opencues/{core,runtime}/dist/<subdir>/` not copied by an integration's `setup.sh` | June 2026 PR #117 — `packages/opencues-core/src/providers/claude-cli-daemon.ts` shipped, then `integrations/claude-code/patches/setup.sh` (which hard-coded the subdir list to `sources/` only) silently dropped `providers/` at install. Installed `model-aliases.js` required a missing module, CC patch's outer try/catch swallowed the load error, every CC session came up with `__oc.failed=true` — no cues + no blanks + no log line + no install error (`validateFork` checked for textual opencues markers, not actual runtime loadability). Affected only CC; OC/Gemini/Shell setup.sh already use `cp -r dist/`. | (1) `integrations/claude-code/patches/setup.sh` § 5 now uses `for sub in $CUES_CORE/dist/*/` — recursive over every subdir, no hard-coded list. (2) `integrations/claude-code/bin/install.cjs:validateFork` runs a per-fork boot-smoke probe: `spawnSync(node, '-e', 'require(<spec>)')` from the fork's root for every spec the patch's bootstrap references; mismatch refuses to ship the fork. (3) `scripts/check-cc-bundle-integrity.sh` mirrors that probe in CI on every PR so the bug class is blocked before merge without needing a real install. | `check-cc-bundle-integrity.sh` (CI gate); per-fork drift in `opencues doctor` as a secondary surface |
| Multi-fork CC install drift — non-canonical `~/claude-code-cues-NNN/` dev forks silently run stale code | June 2026 PR #117 — runtime + core bumped; only the canonical fork got rebuilt by the release pass; `-170` dev fork (documented in CLAUDE.md as a load-bearing test install) silently kept running the prior bundle for hours. `enumerateInstalledHosts` only knew about canonical; `opencues run`'s self-heal was bypassed by direct launches (`~/claude-code-cues-170/.../claude.exe` directly + the agentic harness's `--binary` flag); CC's per-band boot was the only host missing `checkRuntimeDrift` from `buildSharedRuntime` (added in PR #47 for everyone else) so no boot-time warning fired either. | (1) `version-markers.cjs:enumerateCCForks()` walks every `~/claude-code-cues*` dir with a real CC binary. (2) `integrations/claude-code/bin/install.cjs:doInstall()` fans out across every detected fork by default (per-fork drift check + targeted rebuild). (3) `update.cjs` walks every fork before deciding "nothing to do" at current-pin. (4) `doctor.cjs` surfaces per-fork drift as a discrete `warn` row. (5) `adapters/cc/v2.1/boot.ts` now calls `checkRuntimeDrift` at boot, matching every other host. | `opencues install claude-code` fans out by default; `opencues doctor` warns on every stale fork; CC boot-time `[cc][warn]` advisory lands in `/tmp/opencues.log` if a direct launch hits a stale fork |

---

*Last updated: June 2026*
