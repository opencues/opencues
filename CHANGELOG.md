# Changelog

All notable changes to OpenCues will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Scope of this section**: only changes tied to an actual package version bump are listed. The project shipped many other features and fixes since 0.1.0 (sentence cues, auditors, agent-rewrite, ambient/user context, etc.) without bumping versions at the time — those landed in source but aren't formally versioned, so they're tracked in git, not here. From now on, the rule in `docs/architecture/versioning.md` § Discipline keeps changelog entries and version bumps shipping together.

### Added — `@opencues/core` 0.1.0 → 0.1.4
- **0.1.0 → 0.1.1**: Three-bucket LLM routing (`cues` / `auditors` / `blanks`). FEATURES registry gains three bucket scalars; `ConfigLoader` parses `cues-llm-provider` / `auditors-llm-provider` / `blanks-llm-provider` with back-compat read for legacy singular `blank-llm-*`. `build-sources.ts` routes per-bucket via `cuesBucket*` / `blanksBucket*` instead of the single `blankGlobal*`; the trust-class guard refuses `trainsOnInput: true` providers on prose buckets. Canonical doc: `docs/architecture/llm-routing.md`.
- **0.1.1 → 0.1.2**: Fluid-config natural-language provider/model switching. `ConfigIntentVerdict` becomes a discriminated union (`setting` | `provider` | `none`); SYSTEM_PROMPT rewritten with three INTENT classes; `validateAgainstRegistry` handles both verdict kinds. `ProviderAdapter.knownModels` (optional `readonly string[]`) bounds the model catalogue the classifier may route to — 2-5 curated entries per provider.
- **0.1.2 → 0.1.3**: Bare provider switches default to the **blanks** bucket. `"switch to anthropic _"` now writes `blanks-llm-provider: anthropic` (was `cues-llm-provider`). Cues and auditors require explicit scope; rationale: blanks is the user-opt-in `_` surface most likely targeted by a bucket-less phrase.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels infrastructure): TransformBlankSource now consumes the SENTINELS.md catalog — `draft email _`, `write a bio _`, etc. resolve sender sentinels via the same post-processor FluidBlank uses, with `preserveUnknown: true` so non-sender placeholders (`[Recipient Name]`, `[Date]`) survive untouched. New `validateSentinelWrite` discriminated chokepoint (`sentinels-validator.ts`) enforces key shape, value caps (256 chars / 64 fields), control-character filter, and token-collision detection for any code path that mutates SENTINELS.md. Renames: file `USER.md` → `SENTINELS.md`; symbols `UserContext*` → `Sentinels*`, `parseUserMd` → `parseSentinelsMd`, etc.; scalar `user-context-mode:` → `sentinels-mode:`. Back-compat: ConfigLoader reads both scalar names; seed-configs self-heals the file + scalar rename. Audit row #24 codifies the new write-surface threat model.

### Added — `@opencues/runtime` 0.1.0 → 0.1.4
- **0.1.0 → 0.1.1** (PR #17 chain-history): sequential LLM-blank substitutes chain into walkable history so the user can cycle back through prior fill-ins.
- **0.1.1 → 0.1.2**: typed bucket fields (`cuesLlmProvider` / `auditorsLlmProvider` / `blanksLlmProvider`) on `OpenCuesState` with back-compat parsing; `boot-common.buildAgentLLMResolver` reads the auditors bucket so `agent-rewrite` routes through it.
- **0.1.2 → 0.1.3**: `applyOpencuesScalar` now awaits the disk write — back-to-back applyScalar calls (ConfigIntent's provider+model verdict path) serialise on disk instead of racing the read-modify-write.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels rename): `OpenCuesState.userContextMode` → `sentinelsMode`; `ConfigLoader` parses the new `sentinels-mode:` scalar with back-compat fall-through to legacy `user-context-mode:`. No behaviour change for users who haven't opted into sentinels.

### Added — `opencues` CLI 0.1.1 → 0.1.5
- **0.1.1 → 0.1.2** (Option-B self-heal): `seed-configs` cleans up legacy built-in / user-blank collisions left over from the May 2026 user-blank migration. Per-host log prefix; per-version markers.
- **0.1.2 → 0.1.3**: `seed-configs` self-heals legacy `blank-llm-*` → `blanks-llm-*` rename in place; `doctor` grows a "LLM routing" section showing effective resolution per bucket; `doctor` tmux check honors the vendored 3.4 fallback (`~/.opencues/vendor/tmux`); `update` detects stale bundled `@opencues/{core,runtime}` and transparently rebuilds instead of short-circuiting; CC install's "already healthy" hint bolds the `--rebuild` flag; help screen's Providers row shows three buckets instead of four per-aspect surfaces; `update` exports `isTested` / `isKnownIncompatible` (regression fix).
- **0.1.3 → 0.1.4** (PR #33): SIGINT race fix — `opencues update` registers signal handlers BEFORE `acquireLock` writes the lockfile (see CLI #33 entry above).
- **0.1.4 → 0.1.5** (PR #32 — Sentinels CLI + migrations): new `opencues sentinels` command (interactive interview + scriptable `list` / `set` / `add` / `remove` / `rm` / `path` / `list --json`). Smart defaults from `git config` and `gh api user`. All writes route through `@opencues/core`'s `validateSentinelWrite`. `seed-configs` self-heals `~/.cues/USER.md` → `~/.cues/SENTINELS.md` (pre-SEED step so user data survives) and `user-context-mode:` → `sentinels-mode:` (legacy-value-wins when both present). `doctor` surfaces leftover legacy artifacts with `opencues seed-configs` as the fix command.

### Added — `@opencues/claude-code` 0.1.0 → 0.1.1
- Single-fork CC install: one fork at `~/claude-code-cues/` handles both cli.js (≤2.1.111) and native-binary (≥2.1.113) shapes via tweakcc 4.0.13+ shape detection. `claude-code-cues-150` retired. Opt-in statusline. Native 2.1.150 support. Subsequent same-minor bumps (2.1.158 promoted to `current-pin` 2026-05-31) ride this band without a package-version bump — same adapter, same anchors, only `compat.json` updates.

### Added — `@opencues/chrome` 0.1.0 → 0.1.1
- Bundle ships the new `BLANK.md` frontmatter (the user-blank migration that retired the per-host built-in/user-blank duplication).

### Added — new packages introduced this period
- **`@opencues/runtime` 0.1.0** — host-agnostic runtime scaffold (HostAdapter types, MockAdapter, conformance suite). Replaces the inline runtime code that previously lived in the CC patch.
- **`opencues` CLI 0.1.0** — front-door CLI (`opencues install <host>`, `opencues run <host>`, `opencues doctor`, `opencues review`, `opencues check-keys`, `opencues set-key`, `opencues seed-configs`, `opencues update`).
- **Per-integration `package.json`** scaffolding — each integration ships its own version + compat metadata for `opencues update` to consume.
- **`@opencues/chrome` 0.1.0** — MV3 extension with CSS Custom Highlight API for in-page rendering, contenteditable + Lexical + ProseMirror + Draft.js engine support.
- **`@opencues/gemini-cli` 0.1.0** — Gemini CLI 0.41.x integration (React/Ink host).
- **`@opencues/terminal` 0.1.0** — standalone Bun + OpenTUI app (`oc-edit`). Later evolved into `@opencues/shell` (the `oc-shell` tmux-popup launcher).
- **`@opencues/codex` 0.0.1** — integration skeleton (Stage 1, not user-ready).
- **`opencues` (placeholder) 0.0.1** — minimal placeholder published to the npm registry to reserve the package name. Handover runbook in `CLAUDE.md`.

### Changed
- **Renamed `blank-llm-*` (singular) → `blanks-llm-*` (plural)** for the blanks bucket scalars (core 0.1.0 → 0.1.1). Runtime reads both names; `seed-configs` rewrites legacy → new in place on the next `opencues install` run. Back-compat fallback to be removed in a future release.

### Fixed (paired with version bumps above)
- **`applyOpencuesScalar` race on back-to-back disk writes** (runtime 0.1.2 → 0.1.3) — ConfigIntent's provider-verdict apply path writes two scalars sequentially (`<scope>-llm-provider`, then `<scope>-llm-model`). The previous fire-and-forget disk write let the second invocation read the file before the first write landed, so the final file held only one of the two scalars. Fix awaits the `ProcessHandle.result` from `blankInvoke` / `spawnProcess`.
- **`opencues update --to <ver>` crashed on the post-install hint path** (CLI 0.1.2 → 0.1.3) — `compatLib.isTested` was defined but not exported, so the success-line hint that suggests adding the version to `compat.tested` threw `TypeError`. Host had already pinned + installed by that point — the user impact was just a confusing trailing stack. Fixed by exporting `isTested` and `isKnownIncompatible`.

---

## [0.1.0] - 2026-04-10

Initial pre-release. All core features implemented with a working Claude Code integration.

### Features

#### Navigation & Interaction
- **Feature 1: Navigation** — Ctrl+Alt+Left/Right moves between interactive words (cue-controls, step patterns, local tips, LLM alternatives, multi-word spans). Index-based targeting skips non-interactive words.
- **Feature 2: Cycling** — Ctrl+Alt+Up/Down replaces the focused word through a five-tier priority: custom cue-controls → control-bound blanks → step controls → consume-all alts → LLM alternatives. Linked words synchronize automatically.
- **Feature 3: Visual Cues** — Real-time ANSI styling with three visual states: normal (white), dimmed (gray, has alternatives), highlighted (bold white, currently focused). Dimming appears within ~500ms of typing.
- **Feature 4: Cursor Preservation** — Cursor offset adjusts automatically when a replaced word differs in length, keeping the editing position stable during cycling.

#### Cue Sources
- **Feature 5: Linked Words** — LLM detects semantic pairs (e.g. "boy"/"his") and cycles them together to the same alternative index when either is changed.
- **Feature 6: Local Cues** — O(1) hash-map lookup from a JSON tips file provides instant alternatives (<5ms) without LLM round-trips. Merged with LLM results; tip-sourced words are never overwritten.
- **Feature 7: Remote Cues** — LLM-generated alternatives via a resolver that classifies source scope (word vs blank), applies priority, and combines multiple domain sources (grammar, legal, medical, financial) into a single API call.

#### Blanks
- **Feature 8: Fill-in-the-Blank** — Type `_` and get contextual completions. 10 built-in modes: math (`2+2=_` → `4`), factual (`capital of France is _` → `Paris`), translation, unit conversion, spelling, color codes, HTTP codes, timezone, roman numerals, and grammar. Three-stage classification: regex → keywords → LLM classifier.
- **Feature 9: Multi-Word Spans** — Alternatives that are multiple words (e.g. "Jeff Bezos") navigate, dim, and cycle as a single unit. Span tracking maintains original indices across word-count changes.

#### Controls
- **Feature 11: Cue-Controls** — Words that trigger external scripts on cycle. Navigate to "volume" and press Up/Down to change actual system volume. Supports DynDef-bound step matching (e.g. `50%` adjacent to a `volume` keyword), list-based values, and dynamic script outputs.
- **Feature 12: Control-Bound Blanks** — `volume _` auto-populates with the live system value; cycling writes back via script. Supports numeric step, string format, read-only, dismissible, suffix display, keyword expansion, and keyword clearing. Multi-word keywords match consecutive words as a single phrase.
- **Feature 17: Selector + Satellite Blanks** — `opencues settings _` expands into two linked words: a selector that picks a setting and a satellite that shows/writes its value. Cycling the selector swaps the satellite's entire alt list. The backing config (`OPENCUES.md`) uses a unified `settings:` block with colocated values and per-value tips. Indent-agnostic parser detects structure by key names, not whitespace.

#### System
- **Feature 10: Per-Word Clearing** — Editing text intelligently preserves alternatives at unchanged positions. Only words that actually changed are invalidated. Selector/satellite pairs cascade: clearing either side clears its partner.
- **Feature 13: Auto-Submit** — Three-tier debounced analysis triggers LLM resolution automatically: space-typed (immediate), typing-pause (350ms), mid-edit (1s). Eager tips lookup pre-populates before debounce fires.
- **Feature 14: Cursor Export** — Synchronous JSON export of highlight state to `/tmp/` on every render, consumed by the status line script and available to external tools.
- **Feature 15: Secondary Display** — Status line shows cue-tips and cycle position for the focused word. Per-alternative tips during cycling. Suppressed when no tip resolves.
- **Feature 16: Hot-Reload Config** — TTL-based polling (~2s) reloads all `.md` config files without restart. Parse errors preserve the previous config. Covers CUES.md, BLANKS.md, controls, OPENCUES.md.
- **Feature 18: Tip Priority** — Fixed resolution order: satellite per-value tips → selector tips → control blank tips → cue-control script tips → local cue tips → LLM tips. Control-bound words are shielded from LLM overwrite.

#### Controls Included
- **Volume** — System volume control with word-based (Up/Down key presses) and blank-based (exact set via Core Audio API) cycling
- **Brightness** — Screen brightness control via blank
- **Affirmations** — Static list control cycling through motivational phrases
- **Stocks** — Read-only API control fetching live stock prices from Finnhub (reddit, nvidia, apple, google, microsoft, amazon, tesla, meta)
- **Weather** — Read-only API control fetching live weather from Open-Meteo (any city/country, today/tomorrow/weekend/weekly)
- **Hacker News** — Dynamic list control fetching live HN front page titles via RSS
- **Prompt Improver** — Consume-all control with two-step LLM (model + prompts in `cue.md`): extracts prompt/conditions, returns 3 improved versions + original as cycling alternatives. First control using `blankConsumeAll`.
- **OpenCues Settings** — Selector+satellite control for live OpenCues configuration (voice-mode, debug-mode, tips-mode, output-format, display mode)

### Project

- **opencues-core** — Pure TypeScript library (resolver, config parser, HTTP adapter, 5 source types, 5 response parsers)
- **Claude Code integration** — via tweakcc patches (wordHighlight.ts, dynamicHighlight.ts, cursorStateExport.ts)
- **418 unit tests** across 6 test files + 390-sentence live benchmark
- **19 feature concept docs** + 8 implementation guides + glossary
- **8 Claude Code integration docs** covering all implementation details
- GitHub org at `opencues/opencues`
- Issue templates, PR template, CODE_OF_CONDUCT.md, SECURITY.md
- Pre-launch checklist with audit results

[0.1.0]: https://github.com/opencues/opencues/releases/tag/v0.1.0
