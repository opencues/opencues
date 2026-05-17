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
- **Claude Code** (`integrations/claude-code/`) — patches Claude Code 2.1.110+ via tweakcc
- **OpenCode** (`integrations/opencode/`) — patches OpenCode 1.4.x; runtime loaded inline
- **Chrome** (`integrations/chrome/`) — MV3 extension; CSS Custom Highlight API for in-page rendering
- **Gemini CLI** (`integrations/gemini-cli/`) — patches Gemini CLI 0.41.x; React/Ink host with a render-kick + ZWS-toggle pull model. See its CLAUDE.md for the React quirks (it's the first React/Ink host so the integration was non-trivial).

> Re-org in progress — folders rename to `cc/`, `oc/`, `chrome/` in Stage 4 of
> the repo restructure. See `docs/architecture/repo-structure.md` for the
> target layout + stage tracker.

---

## Claude Installs

Two Claude Code installs exist on this machine. **OpenCues work targets `claude-cues` only — never touch the native install.**

| Command | Location | Version | Purpose |
|---|---|---|---|
| `claude-cues` | `~/claude-code-cues` (local npm) | 2.1.110 (pegged) | OpenCues patches applied here |
| `claude` | `~/.local/bin/claude` (native) | 2.1.110 | Clean/unpatched — development use |

- `claude-cues` is the patched instance. All `setup.sh` runs and tweakcc patch applies target it.
- `claude` is never patched. Use it for unaffected Claude Code sessions during development.
- The version on `claude-cues` is pegged at **2.1.110** — do not upgrade it without verifying patch compatibility.

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
│   ├── CUES.md                    # Master config: settings frontmatter + ignore: array + project metadata
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
│   │   ├── src/
│   │   │   ├── resolver.ts        # CueResolver orchestration
│   │   │   ├── cues-md.ts         # CUES.md parser (parseCuesMd, parseSingleCueMd)
│   │   │   ├── discover.ts        # Folder-based config discovery
│   │   │   ├── node-http-adapter.ts  # HTTPS with keep-alive
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
   library-script sync + 0-byte CUES.md self-heal + colocated `.cs`
   compile (WSL only).
2. **`integrations/claude-code/patches/setup.sh`** — strictly CC-specific.
   Default behavior: nuke + rebuild from scratch. Pinned `@anthropic-ai/claude-code@2.1.110`
   reinstalled + cloned tweakcc inside `<CC_FORK>/.opencues/tweakcc/` +
   `@opencues/{core,runtime}` built and installed into `<CC_FORK>/node_modules/@opencues/`
   + statusline.sh into `<CC_FORK>/.opencues/` + tweakcc patched (only
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
- **`<CC_FORK>/.opencues/tweakcc/`** — tweakcc install lives inside the CC fork (re-cloned every from-scratch install — no global `~/tweakcc/` dir to manage)
- **docs/features/** — 21+ feature concepts (one file each)
- **docs/architecture/spans-and-cycling.md** ⚠️ Canonical implementation reference for the cycling/span/dim/nav system. Two span systems (blank-fill vs static-alt), the cycling priority order (selector/satellite → spanFill → list blank → blankStep DynDef → static alts), the shift+prune flow, the bugs we've already fixed. Read this before touching `cycling.ts`, `dyn-defs.ts`, `span-fill.ts`, `dim-render.ts`, or `navigation.ts`.
- **docs/architecture/transform-blank.md** ⚠️ Canonical reference for the imperative-blank pipeline (EXTRACT → APPLY → VERIFY). Covers the 3-pass design rationale, prompt design (why minimal-EXTRACT but verbose-APPLY), sequential composition for "X and Y", skip-VERIFY rules, parser quirks (`[ \t]*` not `\s*`), runtime substitution, debug logs, and 10 concrete lessons from the experiment log. Read this before touching `transform-blank-source.ts` or any of the prompts. Companion: `tests/benchmarks/transform-blank/EXPERIMENTS.md` for the empirical justification of every design decision.
- **docs/architecture/security-audit.md** ⚠️ Canonical security-posture summary — threat model, attack-class table with current defences + residual risk, open follow-ups. Read this before touching trust-gate / sandbox / capability / secret-binding code, and update it when those move. Companion deep-dives: `docs/architecture/sandbox.md` (OS confinement), `docs/architecture/chrome-security.md` (chrome boundaries), `docs/architecture/user-blanks.md` (capability model).
- **docs/architecture/blank-replace-modes.md** ⚠️ Canonical reference for the unified `blankReplace` field (`keep` / `wipe` / `wipe-all` / `auto`) and the deterministic copula/equation/question heuristic `auto` runs. Read before touching `BlankFill`'s fill pipeline, `resolveReplaceMode` in core, or migrating a built-in blank's mode. Includes the migration cheat-sheet for every shipped blank.
- **docs/architecture/agent-task.md** ⚠️ Canonical reference for the AgentRewrite module — the single shipping implementation of agentic rewrite tasks (`agentically X _` / `add task X _`). One debounce-driven LLM call per tick that emits the full rewritten buffer; a three-way merge against the live buffer drops any LLM hunk overlapping user edits so typing during the call is never clobbered. Covers the merge invariant, cadence (`agent-debounce-ms`), DynDef placement for Down-arrow revert, and why the earlier per-keystroke `AgentLoop` + per-edit `Judge` were retired in May 2026. Read before touching `agent-rewrite.ts`, the agent-task state machine (`AgentTaskState`), or the merge layer. Sub-doc: `agent-rewrite-cache.md` (cache layer); LLM-prompt design lives inline in `agent-rewrite.ts`.
- **docs/architecture/agent-rewrite-cache.md** ⚠️ Canonical reference for the AgentRewrite two-tier cache (skip-on-stable + LRU). Covers cache-key composition (snapshot + task + cursor + windowWords + auditorSignature), the determinism assumption (Groq temp=0 + seed pinning), and the list of extension points (size, cross-session persistence, approximate-match keys, negative caching, telemetry, manual invalidation). Read before touching `_rewriteCache` / `_lastStableSnapshot` / `makeCacheKey` / `computeAuditorSignature` in `agent-rewrite.ts`.
- **docs/architecture/universal-integration.md** ⚠️ Canonical reference for the no-cycling attach profile. A host that can't paint colour or intercept Ctrl+Alt+arrow advertises `supportsCycling: false`; every cycleable cue/blank is then pruned at registration (word-cues, selector/satellite, list blanks, script-backed cycling like volume/brightness). Inference is structural — no frontmatter changes needed (`isBlankConfigCycleable` reads each def's shape). Today's only host in this profile: chrome's normal-`<input>` / `<textarea>` mode. Two filter paths (resolver's `buildSourcesFromConfig` + BlankFill's `matchKeyword`) both import the same `isBlankConfigCycleable` predicate from `@opencues/core` — drift on cycleability semantics is structurally impossible; adding a new cycleable condition auto-propagates to both. Read this before touching `HostAdapter.supportsCycling`, the cycleable getters on each `CueSource`, or either filter point.
- **docs/architecture/chrome-llm-keys.md** ⚠️ Canonical reference for chrome's multi-provider key forwarding + real-time updates. Covers the three-tier merge, failure-mode surface (missing/invalid/typo'd provider), boot-time probes (`verifyLlmKeyAtBoot`, `auditProvidersAgainstKeys`), and the live-mutation contract on `Resolver.options.apiKeys` that makes mid-session key swaps work without a tab reload. Read before touching chrome's storage adapter, the bootstrap's key-audit code, or the runtime's `BootResult.updateApiKeys`.
- **docs/architecture/user-context.md** ⚠️ Canonical reference for the optional `user-context-mode` feature — FluidBlankSource receives the user's own personal data (`~/.cues/USER.md` frontmatter) as sentinel tokens so `_` lookups personalise without re-typing. **OFF by default** (`user-context-mode: off | safe | raw` scalar in OPENCUES.md). `safe` mode sends only token names + descriptions; a runtime post-processor substitutes real values AFTER the LLM responds — PII never reaches the provider's logs. `raw` mode inlines values (opt-in). Phase 1 wired for **fluid-blank only**; widening to other pipelines requires per-pipeline threat-model review. Post-processor handles: verbatim resolve, tolerant matching (Claude's `[WORK_CITY]` underscore drift), hallucination strip (Claude's invented `[DATE OF BIRTH]`), and originalBody preservation (user-typed brackets are sacred). Bench evidence: `tests/benchmarks/user-context/FINDINGS.md` — 5 providers × 42 cases, 100% buffer-safe output, zero raw-value leaks. Tests: 32 unit + 6 FluidBlankSource integration + 1 scalar-parsing. **Phase 2/3** (raw mode body injection, pack-side `requires-user:` declaration, per-pack capability) all stay deferred — see "Future work" in the architecture doc. User-facing summary: `docs/features/user-context.md`.
- **docs/architecture/feature-registry.md** ⚠️ Canonical reference for the FEATURES + MENU_TUNABLES + BUILTIN_BLANKS single-source-of-truth pattern at `packages/opencues-core/src/feature-registry.ts`. Replaces the pre-May-2026 multi-site drift where adding a feature required editing doctor.cjs + chrome/host.cjs + seed-configs.cjs + OPENCUES.md `settings:` block + per-host bootstraps in lockstep. **Adding a feature is now one PR appending one entry; nothing else can drift.** Documents: which sites the registry replaces, the one site it deliberately doesn't (typed OpenCuesState — caught by the alignment test), how to add a new feature step-by-step with a worked example (`agent-mode`), how to hide values from cycling (`exposeInMenu: false`, today only `user-context-mode: raw`), every drift-prevention test (71 across 6 files), and when NOT to use the registry (per-cue config, implementation details). Read before touching feature-registry.ts, doctor's Feature wiring section, host.cjs's file-push list, seed-configs's templated copies, or BUILTIN_BLANKS in opencues-runtime/src/blanks/index.ts.
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
3. Builds `@opencues/runtime` and rsyncs `dist/` to `<CC_FORK>/node_modules/@opencues/runtime/`. Statusline script + OS action scripts go under `<CC_FORK>/.opencues/{statusline.sh,scripts/}`. tweakcc's own config + `cli.js.backup` redirect to `<CC_FORK>/.opencues/patch-state/` via `TWEAKCC_CONFIG_DIR`. **Compact footprint**: everything (runtime, support files, patcher state, patched cli.js) lives inside `~/claude-code-cues/`. Uninstall is `rm -rf ~/claude-code-cues` + tweakcc revert (mirrors OpenCode).
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

Why this lives here: in the user-context + ambient-context ship
(May 2026) every "go test" had a hidden defect at an install-boundary
join — USER.md not pushed by chrome-host, template frontmatter at
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

## Environment

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

The OpenCuesSettingsBlank read/write of system settings now happens
on the user-level `OPENCUES.md` frontmatter. The frontmatter holds
system-wide settings (voice-mode, tips-mode, debug-mode, cursor-navigate,
fluid-blank-mode, word-cues-mode) whose schema is
owned by the OpenCues runtime. A single value applies across every
integration, so projects cannot override it. The file lives at
`~/.cues/CUES.md` (or `$OPENCUES_HOME/CUES.md` when set).

- `opencues seed-configs` copies `defaults/CUES.md` to `~/.cues/`
  and runs an idempotent migration that splits any legacy
  `OPENCUES.md` + `## Tips` / `## Ignore` / `## Blanks` sections into
  the new layout (tip groups become folders under `cues/<id>/CUE.md`,
  ignore moves to a frontmatter array, OPENCUES.md and BLANKS.md are
  deleted).
- **A 0-byte `CUES.md` is treated as missing** — `OpenCuesSettingsBlank`
  silently no-ops on null/empty content, which would otherwise break
  `opencues ___` / `config ___` blank-fills on every native host.
  Chrome falls back to the bake-time `__DEFAULT_CUES_MD__` constant.
  The seed-configs HEAL phase ensures `CUES.md` is always non-empty.
- `ConfigLoader._loadOnce` reads settings from the last search path's
  CUES.md frontmatter (the user-level entry).

---

## Host compatibility — which integrations a cue/blank runs on

Every cue / blank has an implicit (or explicit) host-compat
list: which of `{chrome, claude-code, gemini-cli, opencode}` it works on.
Native hosts (CC, OC, gemini-cli) can spawn subprocesses + read the
filesystem natively. Chrome can do both — config sync via the
chrome-host's filesystem watch, subprocess via the chrome-host's
`exec` protocol — but only when `opencues install chrome-host` has
been run. Without the host, chrome is sandboxed and scripted blanks
fail with exit 127.

Default: every cue / blank advertises as compatible with every host.
The runtime attempts the call; if the host can't fulfil it (e.g. chrome
without chrome-host trying to spawn `.sh`), it fails at runtime (exit
127) rather than being hidden behind a misleading "incompatible host"
marker.

Historical note: `inferHostCompat` used to auto-exclude chrome for
entries with `script: ./X.sh` / `.py` / etc., on the assumption chrome
couldn't run subprocesses. With chrome-host (May 2026 native-messaging
bridge) chrome CAN run POSIX scripts via the host process, so the
heuristic became actively wrong. Removed in favour of explicit overrides.

Override via frontmatter when you really need to scope:

```yaml
on-host: [claude-code, opencode, gemini-cli]   # allow-list (chrome would fail)
not-on-host: [chrome]                          # equivalent deny-list
```

Resolution: `on-host` (if set) is the allow-list; `not-on-host` removes
denials from whichever set was chosen. Surfaced by `opencues list`
(per-entry marker, hidden when "all"), validated by `opencues validate`
(typos + contradictions).

Full spec: `docs/features/host-compat.md`. Glossary entry:
`docs/glossary.md § Host Compat`. API: `@opencues/core`'s
`inferHostCompat()`, `formatHostList()`, `unknownHostNames()`,
`HOSTS`, `NATIVE_HOSTS`.

### Site scoping (chrome) — `on-site` / `not-on-site`

`on-site` is the strictly-broader sibling of `on-host`. Each entry can be:

- A **platform name**: `claude-code`, `cc`, `opencode`, `oc`, `chrome`, `gemini-cli`, `gemini` — matches the running host.
- A **hostname**: `reddit.com`, `www.reddit.com` — exact match against `location.hostname`.
- A **wildcard hostname**: `*.reddit.com` — matches subdomains and the bare domain.
- A **hostname with path prefix**: `reddit.com/r/claudeai` — hostname AND `location.pathname.startsWith(...)`.

```yaml
on-site: [chrome, reddit.com/r/claudeai]               # allow-list
not-on-site: [twitter.com, *.evil.example]             # deny-list
```

Evaluation:
- `not-on-site` is checked first; any match → entry filtered out.
- `on-site` empty → passes everywhere; non-empty → at least one entry must match.

Native hosts (CC/OC/gemini-cli) have null hostname/path. Platform-
name entries still match; hostname entries don't. So
`on-site: [reddit.com]` produces an entry that fires on chrome at
reddit.com but is invisible on CC/OC/gemini.

Chrome applies the filter at bundle-read time (in
`integrations/chrome/src/opencues-bootstrap.ts:applySiteCompatFilter`).
SPAs that change `pathname` without a page reload re-trigger the
filter via `popstate` + monkey-patched `pushState` / `replaceState`.

API: `@opencues/core`'s `inferSiteCompat(input, ctx)`,
`SiteCompatContext` type.

Real-world example: `.cues/blanks/opencues/BLANK.md` has
`blankScript: ./opencues-blank.sh` (native fallback) AND a
runtime-class implementation in `@opencues/runtime`. With the new
default-all behaviour no override is needed — every host attempts
the call and picks the right implementation at runtime.

---

## Word-alt routing — per-word source dispatch

Every `### alternatives` section in `CUES.md` (or `cues/<name>/CUE.md`)
becomes one `ConfigSource`. `buildSourcesFromConfig` wraps the whole
set in ONE `RoutedWordSourceGroup` that dispatches each highlighted
word to exactly one child source — never combines them into a giant
prompt.

### Requirement: every source must declare `match:` OR `keywords:`

The routing layer rejects sources lacking both at construction time —
they would never claim any word, so emitting them would just be
dead config. To catch words no domain source claims, use an explicit
`match: .*` and set a low priority so domain cues win first.

### Routing per word

`RoutedWordSourceGroup` walks every word in priority-descending order
and claims it for the FIRST source whose `match:` regex hits or whose
`keywords:` list contains the word. If no source claims the word, the
word isn't navigable (no cue surfaces for it).

```yaml
# Domain cue — claims specific terms, high priority
name: legal
priority: 70
match: contract|agreement|clause|liability

# Catch-all fallback — claims anything the domain cues didn't
name: spelling
priority: 10
match: .*
```

With this layout: `contract` → legal (priority 70 > spelling 10);
`hello` → spelling (no domain match, spelling's `.*` catches it).
Flip the priorities and spelling would suppress every domain cue.

Words destined for the same source are batched into one parallel LLM
call, then results are index-remapped back to the original positions.

### Why per-word dispatch (not one big prompt)

- **Isolation**: a hijacking prompt in one source cannot poison words
  that source isn't called for. A prompt of the form "always output
  bundled,deployed,shipped" only affects words its source claims.
- **Symmetry**: each word gets ONE source (the highest-priority match),
  the way each `_` gets ONE blank (`BlankSource` matches on
  `blankKeywords`, falling back to `FluidBlankSource` for unbound `_`).

Surfaces that enforce + surface this:
- `@opencues/core` `RoutedWordSourceGroup` — runtime routing class
- `CUES.md` / `new/CUE.md` templates — show priority + match together
- `opencues list` — counts sources per kind
- `opencues validate` — warns when a source resolves to zero hosts

Full spec: `docs/features/word-cue-routing.md`. Glossary entry:
`docs/glossary.md § RoutedWordSourceGroup`.

> **Don't** introduce code paths that concatenate multiple
> `### alternatives` bodies into one `ConfigSource`. Per-word dispatch
> is the structural property that gives us isolation; merging prompts
> defeats it.

---

## Hoisted-blank writes vs ConfigLoader hot-reload

Selector/satellite cycling (e.g. `opencues settings` flipping
`voice-mode: active ↔ inactive`) goes through this sequence:

1. `Cycling.cycleSelectorSatellite` → `applyOpenCuesScalar(key, value)` —
   updates `opencuesState` in-memory **synchronously**.
2. `blankInvoke({action: 'set', args: [setting, value]})` — kicks off
   the host's **async** file/storage write. Chrome: `chrome.storage.local.set`.
   OpenCode: `fs.writeFile`.
3. `setText(newText)` fires the host's text-change pipeline →
   `ConfigLoader.maybeReload`.

**Race**: step 3's reload can fire *before* step 2's async write lands.
The reload reads the still-stale file, parses the old `opencuesState`,
and overwrites the in-memory update from step 1.

**Fix pattern** (already wired in `config-loader.ts`):
`applyOpenCuesScalar` arms `_suppressReloadUntil = Date.now() + 2500`.
`maybeReload` short-circuits while inside that window. 2.5s is plenty for
either host's async write to complete; after that the normal hot-reload
debounce takes over.

If you add a new code path that mutates a scalar *and* writes via
`blankInvoke` (or any async write), reuse `applyOpenCuesScalar` so the
suppression fires automatically. Tests pinning the contract live in
`config-loader.test.ts` — `applyOpenCuesScalar suppresses the next
maybeReload (write-race guard)` and the resume-after-window companion.

---

## Chrome Extension — Dev Workflow

Chrome runs on Windows; this repo lives in WSL2. The unpacked extension Chrome
loads from is on the Windows desktop, **not** the WSL build dir:

- **Build (WSL)**: `/home/wilfred/opencues/integrations/chrome/`
- **Loaded by Chrome (Windows)**: `/mnt/c/Users/wilfred/AppData/Local/opencues-chrome/`
  (i.e. `C:\Users\wilfred\AppData\Local\opencues-chrome\`)

After every `npm run build`, sync the fresh artefacts to the Windows path or
Chrome will keep running the stale bundle (no errors, just no new behaviour):

```bash
cp -r integrations/chrome/dist/* /mnt/c/Users/wilfred/AppData/Local/opencues-chrome/dist/
cp integrations/chrome/manifest.json /mnt/c/Users/wilfred/AppData/Local/opencues-chrome/manifest.json
```

Then reload the extension at `chrome://extensions` and hard-refresh the page.

> Symptom that this step was skipped: `[opencues][info] OpenCues runtime starting (Chrome v1)` is missing from devtools console while legacy `[OpenCues] ...` lines still fire.

### `opencues sync chrome` source discovery

Chrome is a global browser extension — it runs across every tab, has
no cwd, and isn't scoped to any single project. So `sync chrome`
deliberately breaks from the user+project search-paths model the
native hosts use (see above). By default, **only `~/.cues/`
feeds into the chrome bundle.** The cwd you happen to run sync from
does NOT get mixed in.

To bundle project configs, opt them in explicitly:

```bash
opencues sync chrome --wsl                              # user-level only (default)
opencues sync chrome --include ~/work/proj/.cues --wsl    # + one project
opencues sync chrome --include ~/a/.cues --include ~/b/.cues --wsl  # + several
opencues sync chrome --project --wsl                    # + <cwd>/.cues
opencues sync chrome --pack demo-pack --wsl             # ONLY that pack
opencues sync chrome --source ~/custom/.cues --wsl  # ONLY that dir
```

Why this matters — `sync chrome --watch` is a long-running process.
Under the old cwd-default model, starting the watcher from `~/scratch`
would bind it to `~/scratch/.cues` forever, silently missing edits
in the project the user actually cares about. The explicit
`--include` / `--project` model makes the watched paths part of the
command, not a side-effect of startup cwd.

Rule of thumb: if you're iterating on configs *inside this repo*, use

```bash
opencues sync chrome --include ~/opencues/.cues --wsl --watch
```

so the watcher's path list is stable regardless of shell cwd.

Full spec: `docs/features/chrome-sync.md`.

---

## Pre-launch — items to handle before going public

**Markdown files to remove or move to a gitignored path:**

- `damon.md` — overview written for one specific person
- `todos.md` — internal TODO list
- `pre-launch-readme.md` — the launch checklist itself ("Pre-Launch TODO")
- `opencues-strategy.md` — internal strategy doc (OpenClaw-model framing, latent-moat self-assessment); public version of the framing lives in `blog-resources/` / future `GOVERNANCE.md`

**Other**:

- Switch `LICENSE` from "Proprietary. All rights reserved." to the chosen open-source license; the README license section will continue to render the new text without further changes.

Tracked here so the launch pass doesn't miss them. Update this section
as items are resolved.

---

*Last updated: May 2026*
