# CLAUDE.md - OpenCues

This document provides context for Claude sessions working on this project.

## Project Overview

**OpenCues** provides LLM-powered word alternatives and `_`-gated blank fill-ins for text editors. The system reduces to two ideas: **Cues** (LLM → user, on plain text) and **Blanks** (user → system, on `_`). **Auditors** are a continuous, whole-buffer variant of the Cues direction — one declared concern (grammar, clarity, tone, ...) applied as an ongoing, revertable rewrite rather than a per-word cycle. See `concept.md` at the repo root and `spec/auditor-spec.md`.

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
- **Claude Code** (`integrations/claude-code/`) — patches Claude Code 2.1.x (current pin 2.1.206 native binary; tested versions in `integrations/claude-code/compat.json`) via tweakcc 4.0.13+
- **OpenCode** (`integrations/opencode/`) — patches OpenCode 1.14.x (current pin 1.14.17, see `integrations/opencode/pin.json`); runtime loaded inline
- **Chrome** (`integrations/chrome/`) — MV3 extension; CSS Custom Highlight API for in-page rendering
- **Gemini CLI** (`integrations/gemini-cli/`) — patches Gemini CLI 0.41.x; React/Ink host with a render-kick + ZWS-toggle pull model. See its CLAUDE.md for the React quirks (it's the first React/Ink host so the integration was non-trivial).
- **Shell** (`integrations/shell/`) — standalone Bun + OpenTUI + SolidJS app. User-facing entry point is `oc-shell` (wraps the user's interactive shell in a private tmux session with an Alt+Shift+↑ input box); `oc-edit` is the internal Bun host lazy-spawned inside that session and is not directly user-invokable. **Self-owned host** — no upstream fork to patch. Built on the same OpenTUI primitives as OpenCode, so the adapter band (`adapters/shell/v1/`) is structurally a near-clone of `adapters/oc/v1.14/`. Canonical host name: `shell` (alias `terminal` kept for back-compat in `on-host:` directives).

> Re-org in progress — folders rename to `cc/`, `oc/`, `chrome/` in Stage 4 of
> the repo restructure. See `docs/architecture/repo-structure.md` for the
> target layout + stage tracker.

## Website sync — REQUIRED at every release, ping Wilfred for the rest

opencues.com (repo: `~/opencues-website`) is maintained separately and distills
this repo's CHANGELOG.md, feature docs, and FAQ.md into published pages
(changelog, features, FAQs, comparison tables, llms.txt). When a change here is
user-facing, **remind Wilfred to update the website**: new features,
integrations, or providers; spec version bumps; feature removals or renames;
release cuts; anything that alters install steps or the public capability
story. Unpublished-on-site features (see the website repo's CLAUDE.md content
rules) still apply there. The website repo tracks its last sync date against
this repo in its own CLAUDE.md.

**Release cuts are not advisory: cutting `vX.Y.Z` REQUIRES the paired
website changelog PR in the same pass** — it is step 7 of
[versioning.md § How to cut a release](docs/architecture/versioning.md#releases--tagging)
(site `changelog.md` entry with the real date + website CLAUDE.md sync line +
sitemap script). A release without its site PR is an incomplete release;
whoever cuts the tag opens the PR. There is no CI gate across the two repos —
this contract IS the gate, which is why it lives here.

---

## Claude Installs

Two Claude Code installs exist on this machine. **OpenCues work targets `claude-cues` only — never touch the native install.**

| Command | Location | Version | Purpose |
|---|---|---|---|
| `claude-cues` | `~/.opencues/forks/claude-code` (local npm) | 2.1.206 (native bun-binary, pegged via `compat.json:current-pin`) | OpenCues patches applied here |
| `claude` | `~/.local/bin/claude` (native) | latest | Clean/unpatched — development use |

- `claude-cues` is the only patched instance. The 2.1.113+ native bun-binary shape is patched via tweakcc 4.0.13+'s `.bun` ELF section extract/repack (the pre-2.1.113 cli.js shape used a direct minified-JS patch — same `setup.sh` auto-detects which shape is present).
- `claude` is never patched. Use it for unaffected Claude Code sessions during development.
- Each patched fork is pegged to its declared version — do not upgrade without re-running the [UPGRADING runbook](integrations/claude-code/UPGRADING.md) to verify the five seam anchors (S1/S2/S3 required, S6/S7 optional).
- **TWO pins move together on every CC bump, both in `integrations/claude-code/compat.json`:** `current-pin` (the `@anthropic-ai/claude-code` version) and `tweakcc-pin` (the Piebald-AI/tweakcc commit `setup.sh` checks out after clone — normally upstream's `Prompts for <version>` commit; wait for it to land before validating). tweakcc is both the patch engine and a per-CC-version prompt-regex catalogue, so validating one against a stale other is not a validation. A CC-bump PR that touches `current-pin` without `tweakcc-pin` (or vice versa) is incomplete — UPGRADING.md step 3 lists both, and `scripts/check-tweakcc-pin.sh` (pre-pr + CI) enforces the pin machinery itself.
- **If the patched binary dies at PARSE time (`SyntaxError ... ternary operator`) with all seams green**: that's tweakcc's system-prompt pipeline corrupting prompts on re-embed — disabled by `setup.sh` § 4e (issue #276 + the 2.1.206 nested-template variant). Diagnose with `bun build --no-bundle` against `<fork>/.cues/patch-state/native-claudejs-patched.js` (NOT `node --check` — cli.js uses the `using` keyword, which Node ≤22 can't parse). Post-mortem: `packages/opencues-runtime/adapters/cc/REPAIR.md` § 15.
- Multi-version dev forks (`~/.opencues/forks/claude-code-150/`, `-158/`, `-170/`) were retired June 2026. Re-spawn one for a targeted version test, but don't keep them around as ambient drift surfaces — `opencues install claude-code` fans out across every `~/.opencues/forks/claude-code*` dir it finds and stale forks rebuild silently, which is more cost than they're worth when no active test work is using them.

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
│   ├── OPENCUES.md                # Runtime settings (voice-mode, transform-blank-mode, llm-provider, agent-debounce-ms, ...)
│   ├── cues/                      # Folder-based cue configs (LLM word-cues + static tip groups) — 10 shipped folders
│   │   ├── example/CUE.md         # Reference/template cue
│   │   ├── legal/CUE.md           # Legal terminology word-cues (LLM)
│   │   ├── medical/CUE.md         # Clinical terminology word-cues
│   │   ├── financial/CUE.md       # Financial terminology word-cues
│   │   ├── more-formal/CUE.md     # scope: sentence — the shipped sentence-cue
│   │   ├── spelling/CUE.md        # Lowest priority (10) — catch-all spell-check
│   │   └── tips-{claude-code,gemini-cli,opencode,shell}/CUE.md  # Per-host static tip groups
│   └── blanks/                    # Folder-based cue-blanks (colocated scripts + state) — 17 shipped folders
│       ├── volume/
│       │   ├── BLANK.md           # type: blank, blankKeywords: volume, blankScript: ./volume-blank.sh
│       │   ├── volume-blank.sh    # Blank script: get/set system volume
│       │   └── VolCtl.cs          # C# source for Windows Core Audio API (compiled by setup.sh)
│       ├── brightness/
│       │   ├── BLANK.md
│       │   ├── brightness-blank.sh
│       │   └── BrightCtl.cs
│       ├── example/                # blankScript: ./time-blank.sh — reference/template script blank
│       ├── gh-issues/              # impl: ./blank.js — reference/template user-shipped JS blank
│       ├── claude-status/, countries/, crypto/, dictionary/, hackernews/, location/, model/, stocks/, weather/  # impl-by-name (no explicit `impl:`) — resolve to <PascalCase(name)>Blank in @opencues/runtime
│       ├── sentinel/                # Reserved built-in — mutates ~/.cues/IDENTITY.md (opencues identity)
│       ├── note/                    # impl: NoteBlank — runtime-only (needs injected notesMdIO); keyword add/recall/delete over ~/.cues/NOTES.md (PROTOTYPE, issue #210)
│       └── opencues/BLANK.md       # impl: OpenCuesSettingsBlank (selector+satellite)
│       # (prompt/, answer/, affirmations/, numbers/ blanks referenced in older docs are retired — see docs/features/shipped-defaults.md)
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
│   │   │   └── references/        # Prompt documentation
│   │   └── dist/                  # Built output
│   └── opencues-runtime/          # Host-agnostic runtime — publishes as @opencues/runtime
│       ├── src/                   # Modules: Navigation, Cycling, BlankFill, etc.
│       ├── adapters/              # Per-host adapter bands
│       │   ├── cc/v2.1/           # Claude Code 2.1.x adapter
│       │   ├── oc/{v1.4,v1.14}/   # OpenCode adapter bands (v1.14 is the live pin; v1.4 kept for reference)
│       │   ├── gemini/v0.41/      # Gemini CLI 0.41.x adapter
│       │   ├── chrome/v1/         # Chrome extension adapter
│       │   └── shell/v1/          # Shell (oc-shell/oc-edit) adapter — near-clone of oc/v1.14
│       └── dist/                  # Built output
│
├── integrations/claude-code/      # Claude Code integration (@opencues/claude-code)
│   ├── patches/                   # tweakcc patches + installer
│   │   ├── setup.sh               # ONE-COMMAND INSTALLER
│   │   ├── opencuesRuntime.ts     # The patch source — boots @opencues/runtime via S1/S3/S6 seams
│   │   └── highlight-statusline.sh # Status line script
│   └── docs/                      # Claude Code-specific implementation docs (3 files today —
│       │                          # navigation/cycling/alternatives/selector-satellite/config
│       │                          # content now lives centrally under docs/features/, see below)
│       ├── cue-blanks.md          # Cue-blanks + WSL guide
│       ├── status-line.md         # Status line setup, format, disabling
│       └── prompting-guide.md     # Claude Code CLI tips
│
├── docs/                          # General documentation
│   ├── overview.md                # System layers, API, interfaces, usage examples
│   ├── features/                  # One file per feature concept (45 files: 44 features + README)
│   │   ├── README.md              # Feature index
│   │   ├── navigation.md          # Word navigation
│   │   ├── cycling.md             # Word cycling
│   │   ├── ...                    # 36 more feature files (one concept each)
│   │   └── secondary-display.md   # Secondary display (status line)
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
    │   ├── transform-blank/       # fused imperative pipeline
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
   Default behavior: nuke + rebuild from scratch. Pinned `@anthropic-ai/claude-code`
   (version from `integrations/claude-code/compat.json:current-pin`, today 2.1.206)
   reinstalled + cloned tweakcc inside `<CC_FORK>/.cues/tweakcc/` +
   `@opencues/{core,runtime}` built and installed into `<CC_FORK>/node_modules/@opencues/`
   + statusline.sh into `<CC_FORK>/.cues/` + tweakcc patched (only
   the OpenCues v2 wiring; every stock tweakcc patch disabled) +
   verified at build AND apply time. ~1m 5s warm install.

**Compact footprint**: everything CC-specific lives inside `~/.opencues/forks/claude-code/`.
Uninstall is `rm -rf ~/.opencues/forks/claude-code` + tweakcc revert. OpenCode
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
  - **`adding-an-auditor.md`** Reference for shipping a new inline-rewrite concern (grammar, clarity, tone, etc.). Explains the composition model — **isolated mode** by default (one parallel LLM call per auditor, diff-merged by `priority:` order; the standard also permits a composed single-call mode but the OpenCues runtime doesn't use it, precisely to keep one auditor's prompt from steering a sibling's call) — what the frontmatter does, why per-auditor `provider:` is currently inert (`match:`/`keywords:` aren't inert, they're not real auditor fields at all — auditors aren't gated, the prompt body itself decides whether its concern applies), and `<project>/.cues/AUDITORS.md` `disable:` for project-level scoping.
- **integrations/claude-code/docs/** — Claude Code implementation docs
- **`<CC_FORK>/.cues/tweakcc/`** — tweakcc install lives inside the CC fork (re-cloned every from-scratch install — no global `~/tweakcc/` dir to manage)
- **docs/features/** — 21+ feature concepts (one file each)
- **docs/architecture/spans-and-cycling.md** ⚠️ Canonical implementation reference for the cycling/span/dim/nav system. Two span systems (blank-fill vs static-alt), the cycling priority order (selector/satellite → spanFill → list blank → blankStep DynDef → static alts), the shift+prune flow, the bugs we've already fixed. Read this before touching `cycling.ts`, `dyn-defs.ts`, `span-fill.ts`, `dim-render.ts`, or `navigation.ts`.
- **docs/architecture/transform-blank.md** ⚠️ Canonical reference for the imperative-blank pipeline. TransformBlank runs a SINGLE fused LLM call (`FUSED_SYSTEM`) on every provider — the 3-pass EXTRACT→APPLY→VERIFY groq path was retired June 2026 (groq fused benched at parity, ~35% faster; see EXPERIMENTS.md § Experiment 10). Covers the fused prompt design, sequential composition for "X and Y", runtime substitution (whole-buffer → three-way-merge), debug logs, and the lessons from the experiment log. Of the four capabilities initially assumed lost with the 3-pass retirement (cursor/deictic, heading/list, anchored-insert), three turned out to need no fix at all and one (cursor/deictic) got a `[CURSOR]` sentinel restored — see EXPERIMENTS.md § Experiments 11-12. Only auto-styling (pick-your-own-spans, as opposed to the shipped named-span `make X bold` path — see `docs/features/markdown-styling.md`) remains a genuine gap. Read this before touching `transform-blank-source.ts` or `FUSED_SYSTEM`. Companion: `tests/benchmarks/transform-blank/EXPERIMENTS.md` for the empirical justification of every design decision.
- **docs/architecture/security-audit.md** ⚠️ Canonical security-posture summary — threat model, attack-class table with current defences + residual risk, open follow-ups. Read this before touching trust-gate / sandbox / capability / secret-binding code, and update it when those move. Companion deep-dives: `docs/architecture/sandbox.md` (OS confinement), `docs/architecture/chrome-security.md` (chrome boundaries), `docs/architecture/user-blanks.md` (capability model).
- **docs/architecture/blank-integration.md** ⚠️ Canonical reference for blank routing + output placement after the June 2026 slim-down. `blankShapes` (anchored grammar, matched against the SENTENCE containing `_` via `matchBlankShape`) is the primary routing mechanism; `blankKeywords` is friendly shorthand that desugars to shapes (`synthesizeKeywordShapes`). Fill is always-FILL — the replace/consume dials (`blankReplace`/`blankConsumeContext`/`blankConsumeAll`) were deleted; clearing is SHAPE-DERIVED (a captured arg / typed set-step / `integration:` template consumes the command span; a bare keyword get keeps its label). Covers the additive `integration:` output template + its deferred LLM-weave direction. Read before touching `blank-fill.ts`'s fill pipeline, `blank-shapes.ts`, or the keyword window. (The `blank-intent-mode` LLM gate + `blankProximity` per-blank window were both retired — an anchored shape match is the invocation proof; the LINE-scoped `keyword-window.ts` fallback only applies to keyword-only blanks that declare no `blankShapes` — see the next bullet.)
- **docs/architecture/blank-sources.md** ⚠️ Canonical reference for the family of `CueSource` classes (BlankSource / FluidBlankSource / TransformBlankSource / SentenceCueSource / ConfigIntentSource / ConfigSource / LocalCueSource) + the two substitute mechanisms the resolver picks between: deterministic slot splice (used by BlankSource / FluidBlankSource — splice bounds come from the parser, never from an LLM-claimed span) vs three-way-merge (used by TransformBlank (single fused path) + AgentRewrite — LLM owns the whole buffer, runtime diffs against `originalText` and merges into `liveText`). (The bounded-span splice path the retired 3-pass TransformBlank used remains in the resolver for any future bounded-span source.) Documents WHY the May 2026 long-body duplication bug occurred (splice trusting an LLM-claimed TARGET span + concat-tail) and the structural fix (align mechanism to data — whole-buffer → merge; bounded-span → splice only if input was that exact bounded span). Decision table for picking the mechanism when adding a new source. Read before touching the resolver substitute dispatch (`packages/opencues-runtime/src/modules/resolver.ts`) or adding a new `CueSource` subclass.
- **docs/architecture/blank-sources.md § keyword window note** — routing is a TWO-TIER system, not a single line-scoped window: the primary tier is `blankShapes` sentence-scoped matching (`matchBlankShape` in `blank-shapes.ts` — a keyword claims `_` when it leads the SENTENCE containing `_`, per § Trigger model in `spec/blank-spec.md`); the line-scoped `keywordInWindow` / `lineOfWords` predicate in `packages/opencues-core/src/keyword-window.ts` is only a FALLBACK for keyword-only blanks that declare no `blankShapes`. The per-blank `blankProximity` knob and the `blank-intent-mode` gate-gated switch were both retired. `keywordInWindow` is the single shared fallback predicate routed through by the FIVE claim/cede sites (`BlankFill.matchKeyword` + `BlankSource` claim + `FluidBlank`/`TransformBlank`/`ConfigIntent` cede), so they can't drift from each other — but don't read it as the whole routing story. Shaped blanks bypass the window entirely (claimed by their shape).
- **docs/architecture/agent-task.md** ⚠️ Canonical reference for the AgentRewrite module — the single shipping implementation of agentic rewrite tasks (`agentically X _` / `add task X _`). One debounce-driven LLM call per tick that emits the full rewritten buffer; a three-way merge against the live buffer drops any LLM hunk overlapping user edits so typing during the call is never clobbered. Covers the merge invariant, cadence (`agent-debounce-ms`), DynDef placement for Down-arrow revert, and why the earlier per-keystroke `AgentLoop` + per-edit `Judge` were retired in May 2026. Read before touching `agent-rewrite.ts`, the agent-task state machine (`AgentTaskState`), or the merge layer. Sub-doc: `agent-rewrite-cache.md` (cache layer); LLM-prompt design lives inline in `agent-rewrite.ts`.
- **docs/architecture/agent-rewrite-cache.md** ⚠️ Canonical reference for the AgentRewrite two-tier cache (skip-on-stable + LRU). Covers cache-key composition (snapshot + task + cursor + windowWords + auditorSignature), the determinism assumption (Groq temp=0 + seed pinning), and the list of extension points (size, cross-session persistence, approximate-match keys, negative caching, telemetry, manual invalidation). Read before touching `_rewriteCache` / `_lastStableSnapshot` / `makeCacheKey` / `computeAuditorSignature` in `agent-rewrite.ts`.
- **docs/architecture/universal-integration.md** ⚠️ Canonical reference for the no-cycling attach profile. A host that can't paint colour or intercept Ctrl+Alt+arrow advertises `supportsCycling: false`; every cycleable cue/blank is then pruned at registration (word-cues, selector/satellite, list blanks, script-backed cycling like volume/brightness). Inference is structural — no frontmatter changes needed (`isBlankConfigCycleable` reads each def's shape). Today's only host in this profile: chrome's normal-`<input>` / `<textarea>` mode. Two filter paths (resolver's `buildSourcesFromConfig` + BlankFill's `matchKeyword`) both import the same `isBlankConfigCycleable` predicate from `@opencues/core` — drift on cycleability semantics is structurally impossible; adding a new cycleable condition auto-propagates to both. Read this before touching `HostAdapter.supportsCycling`, the cycleable getters on each `CueSource`, or either filter point.
- **docs/architecture/chrome-llm-keys.md** ⚠️ Canonical reference for chrome's multi-provider key forwarding + real-time updates. Covers the three-tier merge, failure-mode surface (missing/invalid/typo'd provider), boot-time probes (`verifyLlmKeyAtBoot`, `auditProvidersAgainstKeys`), and the live-mutation contract on `Resolver.options.apiKeys` that makes mid-session key swaps work without a tab reload. Read before touching chrome's storage adapter, the bootstrap's key-audit code, or the runtime's `BootResult.updateApiKeys`.
- **docs/architecture/identity-context.md** ⚠️ Canonical reference for the optional `identity-context-mode` feature (renamed June 2026 from `sentinels-mode`, which itself was renamed May 2026 from `user-context-mode`; runtime back-compat-reads both legacy names, `opencues seed-configs` self-heals) — FluidBlankSource + TransformBlankSource receive the user's own personal data (`~/.cues/IDENTITY.md` frontmatter, formerly `SENTINELS.md`, originally `USER.md`) as identity-context tokens so `_` lookups and rewrites personalise without re-typing. **`safe` by default** since PR #161 (2026-06-18) — was `off` before that (`identity-context-mode: off | safe | raw` scalar in OPENCUES.md). `safe` mode is **bidirectional** since spec `0.6` (July 2026): the catalog direction sends only token names + descriptions with a runtime post-processor (hydration) substituting real values AFTER the LLM responds, AND the buffer direction dehydrates catalog values the user typed into the buffer to their tokens before any outbound dispatch — see `docs/architecture/hydration-dehydration.md` for the buffer direction. PII never reaches the provider's logs. `raw` mode inlines values (opt-in, no dehydration). Phase 1 wired the catalog for **fluid-blank**; Phase 2 (May 2026) extended to **transform-blank** (`draft email _`) with `preserveUnknown: true` so non-sender placeholders survive. Validator chokepoint at `@opencues/core/identity-validator.ts:validateSentinelWrite` enforces key shape, value cap, token collision, capacity (64 fields × 256 chars) for any code path that mutates IDENTITY.md — used by `opencues identity` CLI today; mandatory for any future in-editor sentinel-writing blank (audit row #24). Post-processor handles: verbatim resolve, tolerant matching (Claude's `[WORK_CITY]` underscore drift), hallucination strip (Claude's invented `[DATE OF BIRTH]`), and originalBody preservation (user-typed brackets are sacred). Bench evidence: `tests/benchmarks/user-context/FINDINGS.md` — 5 providers × 42 cases, 100% buffer-safe output, zero raw-value leaks. **Phase 3** (raw mode body injection, pack-side `requires-sentinels:` declaration, per-pack capability) stays deferred. User-facing summary: `docs/features/identity-context.md`. CLI: `opencues identity` (interactive interview + scriptable `set` / `remove` / `list --json`).
- **docs/architecture/hydration-dehydration.md** ⚠️ Canonical reference for the bidirectional PII boundary in `identity-context-mode: safe` — **dehydration** (outbound: catalog values the user TYPED into the buffer → `[TOKEN]`s before ANY text ships to an LLM) and **hydration** (the existing post-processor, retroactively named). Covers the 9-channel coverage table (fluid-blank INPUT+ambient, transform-blank INPUT + cerebras prediction, sentence-cue SENTENCE, config-intent classifier+summon, word-cues PII-word drop, agent-rewrite DOCUMENT, blank-weave PRIOR TEXT — the table IS the coverage contract; extend it when adding a source), the compiled matcher (`dehydrate.ts` — longest-value-first, Unicode boundaries with CJK edge-drop, skip rules surfaced never silent, `mapOffset` for `[CURSOR]`), the **originalBody trap** (originalBody is ALWAYS the true pre-dehydration text or hydration silently breaks; preserve-wins on the ambiguous both-present case), AgentRewrite's **hydrate-before-merge** ordering, and the `dispatchChat` defense-in-depth floor (`applyOutboundDehydrationFloor` — a floor hit means a source is missing its hook). Read before touching `packages/opencues-core/src/dehydrate.ts`, the `introducedTokens` plumbing, any source's outbound dehydration hook, or the dispatch floor.
- **docs/architecture/kata.md** ⚠️ Canonical reference for the kata prototype (modal guided scenarios + live LLM coach; wired on all five host bands — CC/OC/gemini/shell/chrome). Note: kata is **scalar-less** — there is no `kata-mode` in FEATURES/OPENCUES.md; it's gated through `kata.ts` + the resolver gate + the statusline `kata` block, not a settings toggle. Covers the trace model (typed/submitted/pressed, attempt-preserving coalescing, 250ms self-write TTL), the coach tick (auditors bucket, stable-script system prompt for prefix caching, `STEP/STATUS/COACH` + the `CONTROL: STOP` exception to display-only output), the runtime safety floors vs prompt-owned judgement split, the `ResolverOptions.externallySuppressed` modal seam, the escape ladder (Esc ×3 deterministic hatch first), loud no-LLM degraded mode, and the **host wiring contract: `observeKey` must be the FIRST key subscriber** (emit-until-consumed dispatch blinds a late subscriber to Ctrl+Alt presses). Read before touching `kata.ts`, the resolver gate, or the statusline `kata` block. User-facing summary: `docs/features/kata.md`.
- **docs/architecture/feature-registry.md** ⚠️ Canonical reference for the FEATURES + MENU_TUNABLES + BUILTIN_BLANKS single-source-of-truth pattern at `packages/opencues-core/src/feature-registry.ts`. Replaces the pre-May-2026 multi-site drift where adding a feature required editing doctor.cjs + chrome/host.cjs + seed-configs.cjs + OPENCUES.md `settings:` block + per-host bootstraps in lockstep. **Adding a feature is now one PR appending one entry; nothing else can drift.** Documents: which sites the registry replaces, the one site it deliberately doesn't (typed OpenCuesState — caught by the alignment test), how to add a new feature step-by-step with a worked example (`agent-mode`), how to hide values from cycling (`exposeInMenu: false` — applied to `identity-context-mode: raw`, `blank-context-mode: raw`, and the non-menu provider values `openrouter` / `claude-code-cli` / `ollama` on each `*-llm-provider` bucket), every drift-prevention test (~50 across 6 files), and when NOT to use the registry (per-cue config, implementation details). Read before touching feature-registry.ts, doctor's Feature wiring section, host.cjs's file-push list, seed-configs's templated copies, or BUILTIN_BLANKS in opencues-runtime/src/blanks/index.ts.
- **docs/architecture/llm-routing.md** ⚠️ Canonical reference for the three-bucket LLM routing (cues / auditors / blanks). Each bucket has one scalar pair in OPENCUES.md (`cues-llm-provider:` / `cues-llm-model:`, plus `auditors-llm-*` and `blanks-llm-*`); per-aspect scalars (`word-cues-provider:`, `agent-provider:`, `fluid-blank-provider:`, …) remain as file-edit-only advanced overrides and are deliberately kept out of the menu. Precedence ladder (top wins): per-source > per-feature > bucket > global `llm-provider:` > auto-fallback. `agent-rewrite` reads the **auditors** bucket (background prose rewriter, not blank-bucket trust class). Both cues + auditors are prose-bearing and refuse `trainsOnInput` providers (opencode-zen) via the resolver's source-build guard; only blanks expose `opencode-zen` in its menu (the `_` keystroke is the user's consent gate). Migration from legacy singular `blank-llm-*` → plural `blanks-llm-*` handled by `seed-configs` self-heal + a back-compat read in `config-loader.ts:bucketProvider`. `opencues doctor` surfaces effective resolution per bucket. Read before touching the bucket entries in `feature-registry.ts`, `resolveFor` in `build-sources.ts`, `buildAgentLLMResolver` in `boot-common.ts`, or bucket parsing in `config-loader.ts`.
- **docs/architecture/max-thinking.md** ⚠️ Canonical reference for the `max-thinking: on | off` scalar (default on) — per-model reasoning-effort budget. Each verified reasoning model has a `{ max, off }` pair in `packages/opencues-core/src/model-thinking.ts:MODEL_THINKING` (cerebras gpt-oss → medium/low; groq/openrouter gpt-oss → low/low; openai gpt-5.4 → low/none); ceilings seeded to equal each provider's `defaultReasoningEffort` so `on` reproduces pre-feature behaviour byte-for-byte, `off` is the only state that changes anything. **Single resolver, single chokepoint**: `resolveReasoningEffort()` (explicit per-call value wins but clamps DOWN to the ceiling; otherwise toggle picks max/off; `undefined` for non-reasoning providers — exactly the prior `req.reasoningEffort ?? defaultReasoningEffort` contract) runs inside `buildOpenAIBody` (`llm-provider.ts`), which every reasoning-capable wire call funnels through (the source `dispatchChat` calls AND AgentRewrite's direct `provider.buildRequest`). `maxThinking` rides the dispatch **ctx** that already flows to `buildRequest` — `dispatchChat` needed no body edit, only the ctx TYPE widened (buildRequest / dispatchChat / buildProviderRequest / AgentRewrite's adapter). Each OpenAI-compatible provider forwards `ctx.maxThinking`. Wired from OPENCUES.md via `resolver.ts` (cue/blank sources → build-sources `maxThinking` option) and `boot-common.buildAgentLLMResolver` (stamps `ResolvedAgentLLM.maxThinking` for agent-rewrite). **Settings-map-only** (no typed OpenCuesState field — listed in `feature-registry-alignment.test.ts:SETTINGS_MAP_ONLY`). config-intent classifier unaffected (pins `low`); non-reasoning providers (anthropic/gemini) ignore it. **NOT a spec change** — runtime reference-impl knob, `SPEC_VERSION` unchanged. **Known v1 gap**: AgentRewrite's legacy no-core-provider inline path doesn't consult it (only fires when `@opencues/core` can't be required). Read before touching `model-thinking.ts`, the reasoning branch of `buildOpenAIBody`, or the `maxThinking` plumbing across sources / build-sources / resolver / agent-rewrite. User-facing summary: `docs/features/max-thinking.md`.
- **docs/architecture/contradiction-cues.md** ⚠️ Canonical reference for `contradiction-cues-mode` — the deterministic fact-check cue engine (`packages/opencues-core/src/contradiction/`). Parse (one cues-bucket LLM call turns a sentence into a TYPED claim) → verify (the runtime computes the correction: real weekday, arithmetic, world-data cache read) — the correction is DATA, never generation, so a cue can't hallucinate a false contradiction. ONE scalar (off by default); tiers are DATA-GATED, not per-scalar: Tier 0 (weekday-date, split-the-bill) needs only buffer + clock; 0.5 (bank holidays / GOV.UK), 5 (outdoor-plan vs weather / open-meteo), 5b (London transit / TfL), 5c (journey-underestimate / photon geocode) each activate only when their `{refresh,current}` cache is host-wired (absent → that verifier is a no-op). Renders as a PASSIVE sentence-cue (priority 87; never auto-splices). Egress hosts hardcoded (never LLM-chosen); journey inputs grounded via `isGeocodableName` (security-audit #28–#29). Read before touching `checks.ts` / `contradiction-llm-source.ts` / the per-provider `journey.ts`/`tfl.ts`/`weather.ts` or the resolver's `enableContradictionCues` + `worldDataFetch` wiring. User-facing summary: `docs/features/contradiction-cues.md`.
- **docs/architecture/sentence-cues.md** ⚠️ Canonical reference for `scope: sentence` cues + the `sentence-cues-mode` scalar. New CueSource class `SentenceCueSource` (priority 85, sits between BlankSource 95 / TransformBlank 93 and typical word-cues 60-80). Emits one CueResult per sentence with `alternatives: [originalSentence, alt1, alt2, alt3]` + char-range `spanStart`/`spanEnd`; resolver registers a **passive** DynDef at `currentIndex: 0` (buffer keeps the original sentence) so Ctrl+Alt+Up at any word inside the sentence swaps in the next rewrite via the existing word-cue `applyAltCycle` path. Suppresses overlapping word-cues outright (design 4a). **Sentence-cues are CUES, not agents** — the buffer is never modified without an explicit user keystroke; the May 2026 prototype that auto-spliced `alts[1]` on emission was retired after the chrome agentic-harness verification showed prose being rewritten in the background without consent. Resolver also drops the cue if its span overlaps an active selector/satellite pair or any other span-bound DynDef (fluid-blank, transform-blank, config-intent) to prevent mid-overwriting a managed span on cycle. **Parser forward-compat** (May 2026): `cues-md.ts` exports a `KNOWN_SCOPES` allowlist; both `parseSingleCueMd` and `parsePromptSection` drop sources whose `scope:` is outside the set, with a `console.warn` naming the cue and unknown scope. This prevents a stale integration (chrome bundle that hasn't been rebuilt for the new scope) from misrendering a future-scoped cue as a generic word-cue — the structural fix for the same chrome rebuild gap that produced the May 2026 sentence-cue misrender. **Per-sentence LLM calls** (refactored June 2026): `getCues` makes ONE call per segmented sentence via `mapWithConcurrency` (never batches N sentences into one prompt — batching dropped ~1/3 of sentences). The resolver registers **multiple** passive sentence-cue DynDefs per resolve pass (an array of `sentenceClaims`), keyed by span; same-word collisions (spaceless CJK — one whitespace-word holding several sentences) get synthetic keys via `SENTENCE_CUE_SYNTHETIC_KEY_BASE`. (The earlier "one sentence-cue per resolve pass" v1 cap was lifted — sentence-cues are passive, so multiple coexist without a splice cascade.) **v1 limitations:** regex-based segmenter (abbreviations / URLs split mid-token but the LLM-cede via `ALT: NONE` recovers). Bench: `tests/benchmarks/sentence-cues/` validates 100% precision + 91-100% recall across 5 providers on the 30-case `more-formal` suite. **Re-run before editing `SINGLE_SENTENCE_FORMAT_SPEC` or the segmenter.** Shipped canonical cue: `defaults/cues/more-formal/CUE.md` (priority 85, `scope: sentence`). User-facing summary: `docs/features/sentence-cues.md`. Adding a new sentence-scope cue is one CUE.md file — no source-class edits.
- **docs/architecture/fluid-config.md** ⚠️ Canonical reference for the optional `fluid-config-mode` feature — semantic `_` → settings change classifier at priority 94 (between BlankSource 95 and TransformBlank 93). Routes ONLY to FEATURES registry scalars (never user blanks — volume / brightness / weather / etc. would widen the prompt-injection blast radius unacceptably). Three structural defences: prompt enumerates only registry-cyclable values; `validateAgainstRegistry` runtime check rejects unknown setting / unlisted value / `exposeInMenu: false` (footgun-mode); apply path uses the same `applyOpenCuesScalar` (write + 2.5s reload-suppression) the satellite cycling has used since v0.1. Emits a selector-satellite-shaped result that wipes the summon phrase via `spanStart=summonPhraseStart(text)/spanEnd=text.length` (the last sentence terminator / line break before `_`, or 0 if none) — so prior user content before the settings command is preserved (`hii world. voice mode off _` keeps "hii world.") — and hands off to standard `cycleSelectorSatellite`; `clearOnEdit: true` lets backspace wipe the resulting pair as one span. Bench: `tests/benchmarks/fluid-config/` validated v2.1 prompt across 5 providers at 100% precision + 90-100% holdout recall. **Re-run that bench before editing `SYSTEM_PROMPT` in `config-intent-source.ts`.** User-facing summary: `docs/features/fluid-config.md`. Adding a feature to FEATURES automatically extends the classifier's choice space — no prompt edit needed.
- **docs/architecture/ambient-context.md** ⚠️ Canonical reference for the optional `ambient-context-mode` feature — fluid-blank receives sanitized field metadata for disambiguating lookups. The host gathers a wider set (label/placeholder/aria/title/url-origin+path/meta-description) but the prompt ships only **label + placeholder + page-title** (the bench-validated 3-field minimal). OFF by default; chrome-only gatherer today but host-agnostic at the `HostAdapter` contract level; single-field scope (no sibling values, no system data). The whole model leans on a **structural invariant**: OpenCues has no tool handlers, no exec layer, and no out-of-band action channel for fluid-blank LLM output — worst-case prompt-injection lands as user-visible text the user sees before submitting. **Don't plug fluid-blank output into any side-effect layer** (tool execution, agentic actions, clipboard, fetch, etc.); doing so invalidates row #21 in `security-audit.md` and the threat model in this doc must be re-reviewed first. Read before touching `FluidBlankSource`, `AmbientContext`, the chrome gatherer, or the resolver's ambient-context gate. **Any edit to `FUSED_SYSTEM_PROMPT` or `renderAmbientBlock`'s field list MUST re-run `tests/benchmarks/fluid-blank-ambient/fused-bench.ts` first** — the rewrite that introduced ambient handling cost 2pp on the standard 137-case suite until a CONTEXT-vs-UNTRUSTED_FIELD_CONTEXT distinction rule was added back; later (May 2026) the 2-pass P1+P3 pipeline was collapsed to a single fused call so the segmenter could also use the field's label for meta-triggers like `_` / `answer _`. Target: 175/176 or better. Bench orientation: `tests/benchmarks/CLAUDE.md`. User-facing summary: `docs/features/ambient-context.md`.
- **docs/architecture/calendar-context.md** ⚠️ Canonical reference for the optional `calendar-context-mode` feature — an ingested **calendar** snapshot as a *reasoning* catalog (the 4th catalog, but unlike identity/blank/system-context it's reasoned-over, not substituted). **No MCP** — the ingest is plain iCalendar (`.ics`/webcal) feeds via a producer/consumer seam: `opencues calendar {add,list,remove,sync,refresh}` (CLI, `packages/opencues-cli/src/commands/calendar.cjs`) + a host poller fetch feeds → parse via `packages/opencues-core/src/ics.ts` (`parseIcs`) → write ONE shared `~/.cues/calendar.json`, which every host reads (native directly, chrome via config-bundle). PII boundary: **event TIMES reach the LLM in the clear** (a busy interval isn't PII and is the irreducible reasoning substrate — rendered as minutes-since-midnight for pure-arithmetic availability); **event TITLES and LOCATIONS stay local** as `[EVENT N]` / `[EVENT N LOCATION]` tokens hydrated via `postProcessContext` after the response (a two-sided sentinel: values the user TYPES are dehydrated outbound too). `locationToken` is derived from the event's token (not index) and **re-derived in FluidBlank via `buildCalendarContextSnapshot`** — the host boundary reconstructs events and drops the derived token, so re-deriving at the point of use is what keeps `where is X` working (the July 2026 chrome bug). Safe-mode title lookup (`where is the dentist _`) resolves via `matchCalendarTitles` — an on-machine fuzzy match of typed words → event tokens, hint in the USER message, only the user's own words echoed (no title on the wire). Two render paths in `calendar-context.ts`: `renderCalendarContextCatalog` (BLANK) vs `renderCalendarContextForCue` (CUE — the `defaults/cues/calendar/CUE.md` `scope: sentence` body owns the conflict-flag task, priority 90, statusline via `def.cueTip`). CURRENT-MOMENT anchor computed LIVE at resolve time. Reasoning routes through the **cues bucket**. **ON by default but INERT without a feed** — with no `~/.cues/calendar.json` the snapshot is empty and nothing is sent; `opencues calendar add` is the real consent gate. Remaining: conflict cue also needs `sentence-cues-mode: on`. Read before touching `calendar-context.ts`, `ics.ts`, `calendar.cjs`, the resolver's `calendarContext` option, or the `uses-calendar-context` handling in `sentence-cue-source.ts`. User-facing summary: `docs/features/calendar-context.md`.

---

## Build Commands

**Target:** `claude-cues` (`~/.opencues/forks/claude-code`) only. The native `claude` install is never touched.

After any change to a Claude Code patch source or to `@opencues/core` / `@opencues/runtime`, run:

```bash
integrations/claude-code/patches/setup.sh
```

The script:
1. Copies `opencuesRuntime.ts` to tweakcc and rebuilds it (compiles the patch into `dist/`)
2. Builds `@opencues/core` and copies to `<CC_FORK>/node_modules/@opencues/core/` (so cli.js's bare-specifier `require("@opencues/core")` resolves via Node's standard upward walk — no symlinks)
3. Builds `@opencues/runtime` and rsyncs `dist/` to `<CC_FORK>/node_modules/@opencues/runtime/`. Statusline script + OS action scripts go under `<CC_FORK>/.cues/{statusline.sh,scripts/}`. tweakcc's own config + `cli.js.backup` redirect to `<CC_FORK>/.cues/patch-state/` via `TWEAKCC_CONFIG_DIR`. **Compact footprint**: everything (runtime, support files, patcher state, patched cli.js) lives inside `~/.opencues/forks/claude-code/`. Uninstall is `rm -rf ~/.opencues/forks/claude-code` + tweakcc revert (mirrors OpenCode).
4. Applies compiled patches to `claude-cues` (`~/.opencues/forks/claude-code`)

To re-apply patches without rebuilding (after a Claude Code version bump, no source changes):

```bash
cd integrations/claude-code/tweakcc
CLI_JS=$(find ~/.opencues/forks/claude-code -name "cli.js" | head -1)
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

## Agentic scenarios — assert the ABSENCE of a regression, not the PRESENCE of a specific LLM output

The agentic harness owns **runtime contracts**. The benches own **LLM
quality**. Scenarios that mix the two go flaky every time the LLM
behaves slightly differently — even when the runtime contract is
holding fine.

The June 2026 CC suite triage made this concrete. Five flaky tests:
three were genuine runtime bugs (event-emit-before-substitute,
cache-overwrite race, prev-text-stale gate); two were tests that
*depended on the LLM producing a specific output* before the runtime
invariant could be checked. We fixed the runtime bugs; we **rewrote
the test framing** for the LLM-quality-dependent ones.

**Rule:** for any agentic scenario testing a runtime contract,
phrase the assertion so it would still hold if the LLM bailed,
hallucinated, or refused. The runtime contract is "no double-fire,"
"prior content preserved," "satellite registered" — not "LLM
returned VALUE: active."

Concretely:

| Coupled-to-LLM (flaky shape) | Decoupled (robust shape) |
|---|---|
| `waitForEvent transform-blank.completed` + assert specific text | `waitForEvent transform-blank.started` + sleep enough for any retrigger + `expectEventCount started == 1` |
| `expect text matches "8"` after fluid-blank | `expect text notEquals <original input>` (substitution happened) |
| `waitFor selectorSatellite.currentSetting equals "voice-mode"` using a phrasing that hallucinates `VALUE: on` | use an LLM-stable phrasing (`voice mode off _` reliably classifies; `turn on voice mode _` doesn't) |
| `expect rewrite matches "the girl ran fast"` | dump DynDefs, assert `dynDefs.defs[0].blankName === 'transform-blank'` (the def landed, regardless of LLM phrasing) |

**When LLM-content assertion IS legitimate:**

- Identity-context substitution: assert `notMatches "\\[[A-Z][A-Z_]+\\]"` (no unsubstituted `[FIRST NAME]` tokens remain). That's a runtime guarantee — the post-processor MUST strip every token. Compare against the **negative** invariant. The post-processor must NOT leave a hole.
- Span preservation: scenario 102's `^hii world\.` on the buffer after ConfigIntent — that's pinning the SPAN-splice contract (prior content preserved), not LLM output. The LLM emits any voice-mode value; the runtime guarantees the prefix survives.
- Mode classification: `expect blankName equals "opencues"` on selector-satellite — that's the routing contract.

**Picking LLM-stable phrasings** (when a settings/transform-blank prompt is needed at all):

- `enable debug logging _` → debug-mode on (reliable on cerebras gpt-oss-120b)
- `voice mode off _` → voice-mode inactive (reliable)
- `enable X mode _` → X-mode on (reliable for any `*-mode` scalar)
- `<body> fix typos _` → reliable TransformBlank classification. **Order is body-first, instruction-last: `<BODY> <INSTRUCTION> _`** — the canonical shape per `docs/architecture/transform-blank.md` § "The shape — body first, instruction last". The reverse (`fix typos _ <body>`) is NOT canonical; several older scenarios use it and pass only because the fused classifier is lenient — do not copy that order into new scenarios.
- `make it caps _` (no prior content) → reliable

**Unstable phrasings** (avoid):

- `turn on voice mode _` → cerebras hallucinates `VALUE: on` (voice-mode is `active/inactive`)
- Long-body translations to dense scripts (Japanese/Chinese/Korean) → cerebras intermittently returns NONE on inputs >300 chars
- Specific paraphrasing prompts (`make this poetic _`) → output varies widely

**Don't add `expect text matches <LLM-content>` for the sake of
verifying the LLM ran.** The event-stream already proves the source
fired. Test the runtime contract: did the *def* land? Did the
*satellite* register? Did the buffer *change at all*? Did the wrong
event fail to fire?

LLM-quality benches in `tests/benchmarks/` exist for the other half.

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
- **API Key**: `GROQ_API_KEY` for Groq (the Quick-Install onboarding key; the shipped `defaults/OPENCUES.md` pins **cerebras** as the default provider and the auto-route order is `cerebras > groq > gemini > anthropic > openai` — see the Cerebras section below)
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
| `SPEC.md` (open-standard) | `cues-spec` | 0.11 (draft) | exported as `SPEC_VERSION` from `@opencues/core` |
| `package.json` (monorepo root) | `opencues` | 0.1.0 | private |
| `packages/opencues-core/` | `@opencues/core` | 0.41.0 | private |
| `packages/opencues-runtime/` | `@opencues/runtime` | 0.28.20 | private |
| `packages/opencues-cli/` | `opencues` (real CLI) | 0.4.0 | **PUBLISHED on npm** |
| `integrations/claude-code/` | `@opencues/claude-code` | 0.2.10 | private |
| `integrations/opencode/` | `@opencues/opencode` | 0.2.14 | private |
| `integrations/chrome/` | `@opencues/chrome` | 0.2.152 | private |
| `integrations/gemini-cli/` | `@opencues/gemini-cli` | 0.2.10 | private |
| `integrations/shell/` | `@opencues/shell` | 0.2.21 | private |
| `integrations/windows/` | `@opencues/windows` | 0.2.4 | private |

The bare `opencues` name on npm is the real CLI (`packages/opencues-cli/`, **published** — v0.4.0 superseded the retired parking placeholder's v0.0.1; the old `packages/opencues-park/` source was deleted post-publish, July 2026). The npm org grants access via the `developers` team.

The `@opencues/*` library packages remain `private: true`. Flipping one to publishable requires removing `"private": true` AND repointing (or removing) its `publishConfig` block (most currently target `npm.pkg.github.com`).

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
4. `spec/*.md` (every spec doc — cue/blank/auditor/identity-context/kata/core) — bump the Status banner.
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
| **tweakcc pin + CC install verification** | `scripts/check-tweakcc-pin.sh` | Issue #276 (July 2026) — setup.sh cloned tweakcc UNPINNED from upstream main; a HEAD regression (system-prompt pipeline) corrupted both CC install shapes and the installer still said "Done." because the syntax check was a warning and nothing executed the patched artifact. Asserts: exact-sha `compat.json:tweakcc-pin` + checkout verification, setup.sh § 4e system-prompt disable, fatal `node --check`, `--version` runtime smoke. |
| **CC fork bundle integrity** | `scripts/check-cc-bundle-integrity.sh` | PR #117 providers/-missing class — a new file/subdir under `packages/opencues-{core,runtime}/dist/` that the CC patch's bootstrap requires but `integrations/claude-code/patches/setup.sh`'s copy step misses. Assembles the exact fork bundle setup.sh ships into a tmp dir, then `require()`s every spec the patch references from a clean NODE_PATH so workspace hoisting can't mask missing transitive deps. ~10s. |
| **`doctor`** | built-in CLI command | Real install-state warnings (⚠) — chrome /mnt/c sync, missing keys, broken forks. Content-hash-based since June 2026, so no false-positive after `pnpm build`. CI runs `doctor --strict` for info-level findings too. As of PR #118, doctor surfaces per-CC-fork drift (each `~/.opencues/forks/claude-code*` dir gets a discrete row: stale → warn, missing marker → warn, fresh → info). |

CI runs the same gates as separate jobs so a green local run mirrors what CI will report. If `pre-pr.sh` passes locally, CI will pass.

## Cross-PR contract — when you change X, run Y

The follow-up PR class arose specifically because changes to *runtime / boot / install* code interact with downstream consumers without obvious source-level coupling. Concrete contracts:

- **Change `@opencues/runtime/src/boot-common.ts` or anything importing `node:*` modules?** Run `cd integrations/chrome && npm run build`. The chrome esbuild fails on unmarked node imports — `external:` declaration goes in `integrations/chrome/esbuild.config.mjs`.
- **Change anything that could affect the chrome extension** — `integrations/chrome/src/**`, or `@opencues/{core,runtime}/src/**` code that runs in the content script / service worker (boot, config-loader, resolver, sources, trust-gate, sensitive-field, site-filter, the fetch/LLM path)? **STOP and ASK the user to run the chrome E2E** (`cd integrations/chrome && npm run build && npm run test:e2e:chrome`), or offer to run it yourself. It loads the real unpacked extension and drives features + security controls (trust-gate, sensitive-field, site-filter) to observable output — the "wired but inert / degraded-open in chrome" bug class the unit tests and static lints can't see (`integrations/chrome/tests/e2e/`, ~11s, run-on-demand, NOT in CI). Don't just build-and-hope: a chrome bundle can compile clean and still be silently dead. Because it's not a CI gate, the reminder is manual — this line is that reminder.
- **Change `integrations/claude-code/bin/install.cjs` or `packages/opencues-cli/src/commands/run.cjs`?** Run `bash scripts/check-install-self-heal.sh`. Or manually: `opencues install <host>` → `opencues run <host>` → `opencues run <host>` again. The second run must be **silent** (no "Rebuilding before launch"). If it isn't, the install path lost the marker write or the run path's drift check is firing incorrectly.
- **Change `version-markers.cjs` or any code that calls `writeMarker` / `checkDrift`?** Run the PR #42 demo scenarios (A–D) in the PR description manually OR via `scripts/check-install-self-heal.sh`.
- **Change LLM dispatch error handling (any `catch` in `packages/opencues-core/src/sources/*-source.ts`)?** The catch MUST `this.log(...)` or `this.logInfo(...)` before returning the error envelope. Resolver consumers ignore the `error` field — silent catches eat the only failure signal.
- **Edit `FUSED_SYSTEM` in `transform-blank-source.ts`?** TransformBlank is a SINGLE fused pipeline on every provider (the 3-pass path was retired June 2026 — EXPERIMENTS.md § Experiment 10), so there's one prompt and no second copy to keep in sync. Re-run `prod.ts --provider cerebras` AND `--provider groq` (both run fused now). IMPORTANT: the bench drives the BARE source — catalog-induced classification bugs (identity/blank-context on) only surface in the agentic harness (e.g. scenario 103), not the bench. The bold bug (PR #195) was exactly that shape.
- **Add a new log line that more than one host emits?** Prefix it with `[<host>]` or emit via `adapter.log` (which auto-prefixes). Bare `[opencues] ...` lines in the shared `/tmp/opencues.log` confuse multi-host debugging — see PR #45.
- **Edit a test file?** Grep for `os.homedir()`, `process.env.HOME`, `path.join(os.tmpdir())`. If any test writes under those without a `before/after` hook that mkdtemps and restores HOME, you have a vendor-pins-class bug. See PR #41 for the fix pattern.
- **Renaming a feature, file, or scalar?** Add the old name(s) to `BANNED_PATTERNS` at the top of `scripts/lint-legacy-names.sh` in the SAME PR. The lint enforces "no shipping-code reference to the old name" structurally — what was an editorial pass of grep-and-replace becomes a CI gate. Migration code (files whose JOB is to handle the rename — `seed-configs.cjs`, `doctor.cjs`, migration tests) goes on `FILE_ALLOWLIST`. One-off historical-narrative references get a `// LEGACY-NAME-ALLOW: <reason>` marker on the same line.
- **Editing `integrations/claude-code/patches/opencuesRuntime.ts`?** Run `node scripts/check-cc-patch-boot.cjs` (or `bash scripts/pre-pr.sh`, which includes it). The CC patch is a JS string injected into a minified cli.js; source typechecks won't catch identifier-scope errors in the emitted string. The smoke evaluates the emitted bootstrap in a sandbox to surface `ReferenceError` / missing field errors that would otherwise only fire on a user's machine. Any identifier referenced in the boot args object literal (`blanks:`, `blankInvoke:`, `spawnProcess:`, etc.) MUST be declared in the surrounding `s1Bootstrap` scope, not inside an IIFE in the args themselves.
- **Adding a new file or subdir under `packages/opencues-{core,runtime}/dist/` that the CC patch's bootstrap references?** Run `bash scripts/check-cc-bundle-integrity.sh`. The script assembles the exact bundle `integrations/claude-code/patches/setup.sh` ships into a tmp synthetic fork + runs `require()` from a clean NODE_PATH against every spec in the patch's bootstrap. If setup.sh's copy step doesn't cover the new file, the gate fails with a pointer at the broken require. The recursive `for sub in $CUES_CORE/dist/*/` loop in setup.sh § 5 covers any new subdir structurally; a NEW top-level file (not under a subdir) would need its own copy line. Always add the spec to `REQUIRED_SPECS` or `OPTIONAL_SPECS` in `scripts/check-cc-bundle-integrity.sh` so the gate exercises it. OC/Gemini/Shell setup.sh already use full-recursive `cp -r dist/`, so they're not affected by this bug class — but if any of those ever switches to a hard-coded list, the same bug shape returns and a parallel gate should be added for that integration.
- **Adding a feature that requires re-installing existing CC users?** PRs that bump `@opencues/{runtime,core}` versions auto-trigger srcHash drift in every fork's `version.json` marker, and `opencues install claude-code` now fans out across every `~/.opencues/forks/claude-code*` dir with a CC binary by default. Multi-fork dev setups (`-150`, `-158`, `-170`) refresh in one command. `--canonical-only` opts out of the fan-out when you genuinely only want the user-facing fork rebuilt. Boot-time `checkRuntimeDrift` (wired into CC's adapter band in PR #118) warns direct-launch users in `/tmp/opencues.log` if they bypassed both `opencues run` and the install fan-out.
- **Change `packages/opencues-cli/src/lib/repo-root.cjs`, `bin/cli.cjs`'s repo resolution / `REPO_NEEDING` set, or `scripts/prepublish-guard.cjs`? Or just published the CLI?** Run `bash scripts/check-npm-fresh-install.sh` (needs Docker + network; not in pre-pr.sh). It cold-installs the published package — or a local tarball via `check-npm-fresh-install.sh <tgz>` — in a pristine node:22 container and asserts: light commands never clone, repo-needing commands fetch + bootstrap via the corepack fallback (no pnpm in the container), and `~/.opencues/repo` lands at exactly the CLI's own version tag. This is the only gate that exercises the standalone `npm i -g opencues` path end-to-end; the unit tests fake the upstream with a file:// fixture.
- **Changing `compat.json:tweakcc-pin`, setup.sh's tweakcc clone/section-4e/verification steps, or `validateFork`'s artefact probes?** Run `bash scripts/check-tweakcc-pin.sh` (also in `pre-pr.sh` + CI), then validate a full install against `current-pin` on both shapes via the isolated-fork recipe in `integrations/claude-code/UPGRADING.md` § "Bumping the tweakcc pin". The pin bump itself is a runbook step, never a `git pull`.

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
| Node-only runtime code (HTTP, `process.env`, `node:*`) silently dead in chrome's content script | June 2026 — the BlankIntent gate shipped working on every native host and **completely inert in chrome**. Two causes, both silent: (1) `ConfigLoader.maybeReload` read `process.env.OPENCUES_BRIDGE` unguarded → `ReferenceError: process is not defined` killed config hot-reload + the keystroke handler in the browser; (2) `buildBlankIntentClassifier` constructed `NodeHttpAdapter` (`node:https`, stubbed in the chrome bundle) and `require`d core, so it returned `null` → the gate degraded to a plain GET with **no log**. CC/OC are Node so both worked; chrome users got `volume 40 _` → `volume 40 100%` for hours of debugging because every failure was silent. | (1) Guard every `process` access with `typeof process !== 'undefined'`. (2) Any HTTP-making runtime module accepts an `httpAdapter` param; chrome's band passes its fetch-based `host.httpAdapter`, native hosts fall back to `NodeHttpAdapter` (mirrors `Resolver`). *(The specific carrier here — `buildBlankIntentClassifier` + `BuildSharedRuntimeOptions.blankIntentHttpAdapter` — has since been **retired**; `blankIntentHttpAdapter` is now a `BANNED_PATTERN` in `lint-legacy-names.sh`. The `httpAdapter`-param pattern remains the fix; the BlankIntent gate that first exercised it is gone.)* (3) Don't cache a `null` LLM client — chrome keys arrive async post-boot; retry the build until it succeeds. (4) Add a `debug` boot + per-decision diagnostic for anything that can silently degrade on one host. Full pattern + checklist: **`docs/architecture/chrome-runtime-compat.md`**. | **`scripts/lint-runtime-browser-safe.sh`** (in `pre-pr.sh` + CI `runtime-browser-safe` job) — flags unguarded `process.X` + unmarked `new NodeHttpAdapter` in core/runtime src, the two build-invisible shapes (`cd integrations/chrome && npm run build` covers unmarked `node:*` imports). Node-only modules are allowlisted; opt a line out with `// BROWSER-SAFE-ALLOW: <reason>`. The remaining end-to-end silent-degrade gap (a feature wired but inert in chrome) still wants a Playwright chrome E2E — tracked follow-up. |
| New `@opencues/{core,runtime}/dist/<subdir>/` not copied by an integration's `setup.sh` | June 2026 PR #117 — `packages/opencues-core/src/providers/claude-cli-daemon.ts` shipped, then `integrations/claude-code/patches/setup.sh` (which hard-coded the subdir list to `sources/` only) silently dropped `providers/` at install. An installed module under `dist/sources/` required the missing `providers/` module, CC patch's outer try/catch swallowed the load error, every CC session came up with `__oc.failed=true` — no cues + no blanks + no log line + no install error (`validateFork` checked for textual opencues markers, not actual runtime loadability). Affected only CC; OC/Gemini/Shell setup.sh already use `cp -r dist/`. | (1) `integrations/claude-code/patches/setup.sh` § 5 now uses `for sub in $CUES_CORE/dist/*/` — recursive over every subdir, no hard-coded list. (2) `integrations/claude-code/bin/install.cjs:validateFork` runs a per-fork boot-smoke probe: `spawnSync(node, '-e', 'require(<spec>)')` from the fork's root for every spec the patch's bootstrap references; mismatch refuses to ship the fork. (3) `scripts/check-cc-bundle-integrity.sh` mirrors that probe in CI on every PR so the bug class is blocked before merge without needing a real install. | `check-cc-bundle-integrity.sh` (CI gate); per-fork drift in `opencues doctor` as a secondary surface |
| Multi-fork CC install drift — non-canonical `~/.opencues/forks/claude-code-NNN/` dev forks silently run stale code | June 2026 PR #117 — runtime + core bumped; only the canonical fork got rebuilt by the release pass; `-170` dev fork (documented in CLAUDE.md as a load-bearing test install) silently kept running the prior bundle for hours. `enumerateInstalledHosts` only knew about canonical; `opencues run`'s self-heal was bypassed by direct launches (`~/.opencues/forks/claude-code-170/.../claude.exe` directly + the agentic harness's `--binary` flag); CC's per-band boot was the only host missing `checkRuntimeDrift` from `buildSharedRuntime` (added in PR #47 for everyone else) so no boot-time warning fired either. | (1) `version-markers.cjs:enumerateCCForks()` walks every `~/.opencues/forks/claude-code*` dir with a real CC binary. (2) `integrations/claude-code/bin/install.cjs:doInstall()` fans out across every detected fork by default (per-fork drift check + targeted rebuild). (3) `update.cjs` walks every fork before deciding "nothing to do" at current-pin. (4) `doctor.cjs` surfaces per-fork drift as a discrete `warn` row. (5) `adapters/cc/v2.1/boot.ts` now calls `checkRuntimeDrift` at boot, matching every other host. | `opencues install claude-code` fans out by default; `opencues doctor` warns on every stale fork; CC boot-time `[cc][warn]` advisory lands in `/tmp/opencues.log` if a direct launch hits a stale fork |
| Unpinned third-party patcher clone — installs pull whatever upstream main is that day, and a corrupted patch output ships as "success" because nothing executes the patched artifact | July 2026 issue #276 — `setup.sh` cloned tweakcc with no commit pin; a tweakcc-main regression (its system-prompt pipeline, which runs OUTSIDE the `patchImplementations` map section 4d disables, double-escaped CC's prompt template literals on prompt-DB/CC-version mismatch) corrupted BOTH install shapes: 2.1.110 cli.js died with a SyntaxError, the 2.1.170 native repack produced a binary Bun refuses to load ("Expected CommonJS module to have a function wrapper"). The post-patch `node --check` was a WARNING, nothing ran the artifact, and a fork with artefacts-but-no-marker skipped as "already installed + healthy" (missing marker counted as fresh). Reported on macOS arm64; reproduced byte-for-byte on Linux x64 — platform was incidental. | (1) `compat.json:tweakcc-pin` exact-sha pin + `setup.sh` checkout + HEAD verification. (2) `setup.sh` § 4e disables the system-prompt pipeline. (3) Fatal `node --check` (cli.js shape) + `--version` runtime smoke on the patched artifact (both shapes) in setup.sh § 9 AND `install.cjs:validateFork` — corruption can neither install nor later skip as healthy. (4) `checkSrcHashDrift`: missing marker → rebuild, not fresh. NOTE: never `node --check` the native extract — CC's embedded JS uses Bun-only syntax (`using`) that fails Node's parser on a pristine extract; the exec smoke is the native gate. | `scripts/check-tweakcc-pin.sh` (pre-pr + CI `tweakcc-pin-gate` job) |
| Security guard hand-mirrored across two parallel loader implementations drifts, or nearly does, on every subsequent edit | July 2026 PR #246 (INFOSEC NF1) — the Bun-subprocess user-blank loader (`subprocess-loader.ts`, added #148) guarded `ctx.fetch` against secret-destination exfil but not `ctx.llm`, because that guard had been hand-copied from the in-process loader (`registry.ts`) and the copy drifted. Fixed, then a reviewer found a **second** gap in the same territory (a type-confusion bypass of the secret scan) that had to be patched on **both** copies by hand in the same PR — the fix-the-symptom-twice pattern was about to repeat immediately after the first fix landed. | Extracted the hostname-resolution + coerce-then-scan-then-dispatch logic into one shared `buildLlmSecretGuard` (`packages/opencues-runtime/src/user-blanks/secret-leak-guard.ts`); both `registry.ts` and `subprocess-loader.ts` now call it instead of maintaining separate copies. **Rule of thumb:** when a security-relevant guard must exist identically on two (or more) code paths because of a structural split (Node vs Bun, native vs chrome, etc.), extract it to a shared function in the same PR that adds the second copy — don't defer the extraction as a follow-up. A copied guard is a standing invitation for the next edit to update one copy and forget the other. | none yet — candidate for a lint that flags near-duplicate function bodies across `registry.ts` / `subprocess-loader.ts`'s capability-handler builders |
| Launch-time self-heal rebuilds forks BACKWARD when `opencues run` is invoked from a clone whose source is OLDER than the installed bundle (second clone, git worktree, or an old branch in the same clone) — and because installers copy without deleting, the fork ends up MIXED (new files present, `blanks/index.js` + package.json stale), worse than either version | July 2026 model-visibility ship — a CC fork freshly installed from a master worktree (runtime 0.16.0) was silently "healed" back to a wip-branch checkout's 0.13.5 by the very next `opencues run` from `~/opencues`; srcHash is direction-blind, so DIFFERENT read as STALE and the rebuild fired with only the normal one-line info notice | `version-markers.cjs:markerIsNewer` — a semver direction signal added to `checkDrift`'s stale verdict (`downgrade: true` when either bundled package is strictly newer than the invoking clone's source; conservative on missing fields so pre-marker installs keep the rebuild). `run.cjs:ensureFreshBundle` refuses the automatic downgrade, launches the installed bundle as-is, and names the explicit override (`opencues install <host>` rebuilds from anywhere — deliberate downgrades stay one command) | `version-markers.test.cjs` downgrade/upgrade direction pins + `markerIsNewer` matrix; `check-install-self-heal.sh` pins the no-false-rebuild contract |

---

*Last updated: July 2026*
