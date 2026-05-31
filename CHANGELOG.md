# Changelog

All notable changes to OpenCues will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Backfill note**: the project shipped 276 feat + 160 fix commits between 0.1.0 (2026-04-10) and 2026-05-31 with no changelog updates. The entries below are reconstructed thematically from git log — major user-visible deltas grouped by theme. Per-commit detail lives in git; this is the readable summary.

### Added

#### LLM routing & provider surface
- **Three-bucket LLM routing** (`cues` / `auditors` / `blanks`) — collapses the multi-knob provider/model config into three top-level bucket scalars in OPENCUES.md: `cues-llm-provider/model`, `auditors-llm-provider/model`, `blanks-llm-provider/model`. Per-aspect overrides (`word-cues-provider`, `fluid-blank-provider`, `agent-provider`, …) remain as file-edit-only advanced overrides. Precedence ladder: per-source > per-feature > bucket > global `llm-provider` > auto-fallback. agent-rewrite reads the auditors bucket. Both cues and auditors are prose-bearing and refuse `trainsOnInput` providers (opencode-zen) via the resolver guard. Canonical doc at `docs/architecture/llm-routing.md`. Migration from legacy singular `blank-llm-*` → plural `blanks-llm-*` handled by `seed-configs` self-heal + back-compat read in config-loader.
- **Fluid-config natural-language provider/model switching** — when `fluid-config-mode: on`, the classifier now supports a PROVIDER intent alongside the existing SETTING intent. Phrases like `switch to anthropic _`, `use cerebras for cues _`, `use claude opus for auditors _` write the corresponding bucket scalar(s). Bare phrases (no explicit scope) default to the **blanks** bucket — the user-opt-in `_` surface. Bounded by `ProviderAdapter.knownModels` (new optional field, 2-5 curated entries per provider) — file edits still accept any model string.
- **`ProviderAdapter.knownModels`** — optional `readonly string[]` per adapter listing the model ids the fluid-config classifier may route to. First entry typically matches `defaultModel`. Documented in `docs/guides/llm-providers.md § Adding a new provider`.
- **Bench: fluid-config switch-provider** at `tests/benchmarks/fluid-config-switch-provider/` — 33-case scenario suite (provider-only / provider+model / model-implies-provider / trust-class refusal / unknown / setting regression / none regression). 100% precision, 100% recall, 0 FP on Groq + gpt-oss-120b. Imports the live SYSTEM_PROMPT — drift between bench and shipped prompt is structurally impossible.
- **`opencues doctor` LLM routing section** — shows effective resolution per bucket (bucket > global > auto-fallback) with `← llm-provider` annotation when a bucket inherits.
- **CLI help screen Providers row** — replaced the four per-aspect surfaces with the three buckets (cues / auditors / blanks) to match the menu + the routing doc.
- **`opencues update` detects stale bundles** — when host version is at current-pin but bundled `@opencues/{core,runtime}` is older than source, the update transparently reroutes to rebuild instead of short-circuiting as "nothing to do." Same drift class doctor catches.
- **Bold `--rebuild` hint** in the CC installer's "already installed + healthy" line — the flag is the actionable bit and was lost in the dim line.
- **`opencues doctor` honors vendored tmux fallback** — when the system tmux is < 3.2 but `~/.opencues/vendor/tmux` is ≥ 3.2 (oc-shell's vendored install), doctor reports green instead of flagging the system version.
- **Claude Code 2.1.158** — added to `compat.tested` and promoted to `current-pin`. Reuses the existing `cc/v2.1` adapter band; all four required seams (S1/S2/S3/S7) still hit; S6 still falls back to `statusLine.refreshInterval` polling as in 2.1.150.
- **5-provider matrix** — groq, cerebras, gemini, anthropic, openai all wired with reasoned defaults. Auto-route picks the first provider whose env key is set (preference: cerebras → groq → gemini → anthropic → openai). Per-provider `defaultReasoningEffort` from the May 2026 thinking-budget bench. Cross-provider fallback (groq ↔ cerebras) on transient errors. Documented at `docs/guides/llm-providers.md` + `tests/benchmarks/BENCHMARKS.md`.
- **`claude-cli` subscription provider** — `transport: 'cli'` adapter, persistent daemon, accepts both Claude aliases (`haiku`/`sonnet`/`opus`) and full model names. Uses the user's `claude` install for auth — no API key needed.
- **`openai-subscription` provider** — Responses API direct via ChatGPT OAuth (token from `~/.codex/auth.json`). Subscription model allow-list: `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`, `gpt-5.3-codex`. ~530ms warm.
- **OpenCode Zen free pool** + `ProviderHealth` surface — `blanks-llm-provider: opencode-zen` + `blanks-llm-model: free` walks the free model list, health-caches dead entries for 30s, bubbles sticky failures (auth/quota) immediately. `trainsOnInput: true` flag refuses prose-bearing sources structurally.
- **Per-source `maxTokens` + `temperature` overrides** — every CueSource accepts per-feature scalars (`<feature>-max-tokens`, `<feature>-temperature`) for fine-grained tuning.

#### Cue sources & blank pipelines
- **AgentRewrite** — in-place LLM rewrite cadence triggered by `agentically X _` / `add task X _`. One debounce-driven LLM call per tick; three-way merge against the live buffer drops any LLM hunk overlapping user edits so typing during the call is never clobbered. Two-tier cache (skip-on-stable + LRU). Replaces the pre-May-2026 per-keystroke AgentLoop + per-edit Judge. Canonical doc at `docs/architecture/agent-task.md`.
- **Auditors** — always-on prose concerns (grammar, clarity, tone, etc.). Isolated-mode composition: one parallel LLM call per auditor, results diff-merged by priority. `max-concurrent-auditors` cap. Spec at `spec/auditor-spec.md`; how-to at `docs/guides/adding-an-auditor.md`.
- **Sentence cues** — new `SentenceCueSource` at priority 85 emits one CueResult per sentence with `alternatives: [originalSentence, ...rewrites]`. Suppresses overlapping word-cues. Passive — never modifies the buffer without an explicit user keystroke. Canonical: `defaults/cues/more-formal/CUE.md`. Docs at `docs/architecture/sentence-cues.md`.
- **Fluid-config classifier** — semantic `_` → settings change at priority 94. Routes ONLY to FEATURES registry scalars (never user blanks — widens the prompt-injection blast radius). Three structural defences (prompt enumerates only registry-cyclable values; runtime validator rejects unknown setting/value/exposeInMenu:false; apply path reuses `applyOpenCuesScalar`'s 2.5s reload-suppression). Docs at `docs/architecture/fluid-config.md`.
- **Ambient context** (chrome) — fluid-blank receives sanitized field metadata (label + placeholder + page-title — bench-validated 3-field minimal) for disambiguating lookups. OFF by default; chrome-only gatherer but host-agnostic at the `HostAdapter` contract level. Docs at `docs/architecture/ambient-context.md`.
- **User context** — `user-context-mode: off | safe | raw` scalar. `safe` sends only token names + descriptions from `~/.cues/USER.md`; runtime post-processor substitutes real values AFTER the LLM responds — PII never reaches the provider's logs. `raw` mode inlines values (opt-in). Wired for fluid-blank only. Docs at `docs/architecture/user-context.md`.
- **TransformBlank deictic resolver + cursor-aware "here"** — P1.5 pass resolves pronouns/deictics against cursor anchor. APPLY rule 12 for add/insert. Partial-translation detector in VERIFY. Multi-line layout tests.
- **Strict structured outputs (JSON schema)** — extended from TransformBlank to FluidBlank, WordCues, AgentRewrite. Groq's `openai/gpt-oss-*` with `strict: true` constrained decoding; other OpenAI-compat providers get best-effort.
- **`blank-trigger-mode`** — defer `_` firing until a space follows. Lets users type markdown `_italic_` without the first `_` triggering. Default `immediate`, opt-in `spaced`.
- **Blank loading animations** — per-frame glyph progression at `_` while its source resolves. Five modes (bounce, braille-rotate, flipper, custom, off); per-frame interval scalar; per-frame RGB colour palettes; refcount animator so Resolver + BlankFill don't race.

#### Chrome extension
- **MV3 extension** with CSS Custom Highlight API for in-page rendering, contenteditable + Lexical + ProseMirror + Draft.js engine support, real-time apiKeys updates via `BootResult.updateApiKeys`, undo/redo wipes per-buffer state, normal `<input>` / `<textarea>` attach mode (blanks-only via Universal Integration profile), live `.env` reload, write-file sync (host as source of truth), `BootResult.updateLlmConfig` for live provider/model/endpoint swap, hide defer toggle until host connects.
- **Chrome native-messaging host** — installs via `opencues install chrome-host`, watches `~/.cues/`, pushes bundles into `chrome.storage.local`. Detected by doctor cross-platform.

#### Hosts & integrations
- **Native CC binary support (2.1.150+)** — tweakcc 4.0.13+ extracts cli.js from the `.bun` ELF section, patches the text, repacks. Single-fork install. Opt-in statusline. **S7 RenderKick** — Gemini-style `host.forceRender` via parent `useState`; pre-S7 fallback to ZWS-toggle.
- **OpenCode 1.4 → 1.14 bands** — multi-band adapter machinery exercised; per-band boot/holder/adapter.
- **Gemini CLI** integration — React/Ink host with render-kick + ZWS-toggle pull model; OpenCues brand foreground on decorated lines; blue background to match host theme.
- **Shell standalone (`oc-shell` + `oc-edit`)** — Bun + OpenTUI + SolidJS app. tmux-wrapped popup for any shell. Vendored tmux 3.4 build (`oc-install-tmux`) so system tmux is never touched. Drops silent unadvertised keybindings (only Ctrl+Alt+{S,Q}). Ctrl+C as hidden in-pane clear, not process killer.
- **Universal Integration profile** — `supportsCycling: false` adapter capability; reactive filter prunes every cycleable cue/blank at registration. Structural inference (no frontmatter changes needed). Today's only host in this profile: chrome's normal-`<input>` / `<textarea>` mode.

#### CLI & install infrastructure
- **`opencues review`** — sandboxed pre-install pack audit. LLM-powered (upgrades to strongest-reasoning model per provider).
- **`opencues doctor`** — cross-host diagnostics + suggested fixes. Surfaces install-boundary feature wiring + drift checks. Provider key probes for every supported provider (not just groq+finnhub).
- **`opencues check-keys`** / **`opencues set-key`** — verify configured API keys against provider endpoints; store keys in `~/.cues/.env`.
- **Seamless install + update infrastructure** — `opencues install <host>` chains `seed-configs` + per-host installer with idempotent re-runs. `opencues update <host>` reads compat.json, supports `--check` / `--to <ver>`.
- **`feature registry`** — single source of truth (`packages/opencues-core/src/feature-registry.ts`) for the FEATURES + MENU_TUNABLES + BUILTIN_BLANKS lists. Doctor, host.cjs file-push list, seed-configs templates all derive from it. Canonical doc at `docs/architecture/feature-registry.md`.
- **`opencues run`** — alt-screen banner + post-host-name flag passthrough.
- **Per-host log prefix** — `[cc]` / `[oc]` / `[chrome]` / `[gemini]` / `[shell]` prefix on every line in `/tmp/opencues.log`. Launch banner hints.
- **`seed-configs`** — SHIPPED-MD REFRESH phase (defaults overlay user values for runtime-owned schema fields while preserving user fields), legacy built-in/user-blank collision cleanup, copy `defaults/USER.md` on install.

#### Spec, defaults, docs
- **cues-spec v0.1 draft** — `SPEC_VERSION` exported from `@opencues/core`, full spec under `spec/` (cue-spec.md, blank-spec.md, auditor-spec.md, core.md, SECURITY.md).
- **`opencues-park`** — minimal placeholder published to npm as v0.0.1 + handover runbook in CLAUDE.md.
- **Shipped example/hello-world packs** under `defaults/`.
- **Markdown inline overlay rendering** — `**bold**` / `*italic*` / `` `code` `` / `~~strike~~` / `# heading` / `- list` (terminals, Phase 1).

#### Security
- **User-blank hardening sprint** — sanitization, quotas, AST rewriter, required secret bindings, dynamic-import block, namespace cap, LLM body scan, sandbox warn.
- **Mac OS sandbox** for `blankScript: sandbox: strict` runs.
- **Trust-gate sentinel** for chrome; off-context name/id gap close.
- **Canonical security-audit doc** at `docs/architecture/security-audit.md`.

### Changed (pre-this-session)
- **Single-fork CC install** — replaced the dual-fork-per-shape model with one fork that handles both cli.js and native-binary shapes via tweakcc's shape detection. `claude-code-cues-150` retired in favour of unified `claude-code-cues`.
- **Sentence cues converted to passive** — earlier prototype auto-spliced `alts[1]` on emission. Retired after the chrome agentic-harness verification showed prose being rewritten in the background without consent. Cues are CUES now, not agents — the buffer is never modified without an explicit user keystroke.
- **macOS portability hardening** — `sed -i ''` BSD form, pnpm workspace conflict, bash 3.2 / BSD coreutils fixes throughout the install + runtime shell scripts.
- **Shell tmux fallback** — auto-falls back to system tmux when vendored build is absent.

### Fixed (pre-this-session — selected)
- **CC `applyRender` strips ZWS at RenderContext boundary** — the May 2026 missed-third-boundary bug where multi-word blank-fill spans lost their dim when the user typed any character after the substitute.
- **chrome undo/redo no longer re-fires blank pipeline on restored `_`** — caught via Lexical / ProseMirror DOM-echo input events.
- **`_`-resolve skipped when answer is already cached in a DynDef** — prevents redundant LLM calls during cycling.
- **OpenTUI hosts paint spans by terminal cell, not code unit** — CJK + emoji width handling.
- **`opencues update` no longer suggests "add to tested" when already tested** — false-positive suggestion.

### Added (original Unreleased entries — pre-three-bucket)
- **Prompt Improver control** (`controls/prompt/`) — consume-all blank control with two-step LLM pipeline. Extracts user prompt + conditions from surrounding text, generates 3 improved alternatives + original. First use of `blankConsumeAll`.
- **`blankConsumeAll` config field** — expands blank resolution to clear the entire input (all non-blank positions), enabling multi-word result replacement. Parsed by opencues-core and passed to the integration.
- **First-party script config fields in `cue.md`** — `model`, `altCount`, `includeOriginal`, and body sections (e.g. `## Extract`, `## Transform`) parsed by opencues-core into `ControlConfig`. The integration passes them to blank scripts as `CUES_MODEL`, `CUES_ALT_COUNT`, `CUES_INCLUDE_ORIGINAL`, `CUES_PROMPT_*` env vars — keeping scripts free of config parsing.
- **Claude CLI provider support** — `prompt-blank.sh` detects `claude-*` model names and calls `claude -p` instead of the HTTP API, using existing Claude Code auth. Switch by setting `model: claude-sonnet-4-6` in `cue.md`.
- **`setup.sh --clean` flag** — wipes `~/.claude/node_modules/opencues-core` before reinstalling, removing stale files from old builds.
- **Prompt improver benchmark** — 99 test cases across 6 categories (creative, technical, professional, research, edge). Automated intent check + verbatim-echo detection. Output preserved at `tests/results/historical/prompt-improve-2026-04-10.txt`. (The runnable `prompt-improve.sh` script was retired when the runtime moved to in-process `prompt-improver.ts`.)

### Changed
- **Renamed `blank-llm-*` (singular) → `blanks-llm-*` (plural)** for the blanks bucket scalars. Runtime reads both names; `seed-configs` rewrites legacy → new in place on the next `opencues install` run. The back-compat fallback will be removed in a future release.
- **`@opencues/core` 0.1.0 → 0.1.3** — registry adds three bucket FEATURES entries; ProviderAdapter gains `knownModels`; ConfigIntentVerdict becomes a discriminated union (`setting` | `provider` | `none`); SYSTEM_PROMPT rewritten with three INTENT classes; validateAgainstRegistry handles both verdict kinds + the trust-class guard.
- **`@opencues/runtime` 0.1.1 → 0.1.3** — typed bucket fields on `OpenCuesState` with back-compat parsing; resolver routes per-bucket via `cuesBucket*` / `blanksBucket*` instead of the single `blankGlobal*`; `boot-common.buildAgentLLMResolver` reads the auditors bucket for agent-rewrite; `applyOpencuesScalar` now awaits the disk write (race fix — see below).
- **`opencues` CLI 0.1.2 → 0.1.3** — `seed-configs` self-heal renames legacy `blank-llm-*` keys; doctor's bucket-routing section + tmux vendored-fallback check; help screen three-bucket Providers row.

### Fixed
- **`applyOpencuesScalar` race on back-to-back disk writes** — ConfigIntent's provider-verdict apply path writes two scalars sequentially (`<scope>-llm-provider`, then `<scope>-llm-model`). The previous fire-and-forget disk write let the second invocation read the file before the first write landed, so the final file held only one of the two scalars. Fixed by awaiting the `ProcessHandle.result` from `blankInvoke` / `spawnProcess` so writes serialise.
- **`opencues update --to <ver>` crashed on the post-install hint path** — `compatLib.isTested` was defined but not exported, so the success-line hint that suggests adding the version to `compat.tested` threw `TypeError: compatLib.isTested is not a function`. Host had already pinned + installed by that point — the user impact was just a confusing trailing stack. `isTested` and `isKnownIncompatible` now exported.
- **`_consumeAllAlts` not clearing when highlight inactive** — cleanup was inside `if(_hlState.active)` guard. Moved unconditionally before the guard so it fires whether or not the highlight is active when the user edits.
- **Stale `cueTip` persisting after clearing consume-all span** — after editing over the span, the old control-blank WordDef in `_dynDefs` (with `metadata.controlName`) blocked the `controlName` guard in the LLM merge path, so grammar re-analysis updated `alts` but left `cueTip` stale. Fixed by also removing those WordDefs from `_dynDefs` during cleanup.
- **Cursor jumping during blank auto-populate** — `onChange` replaces the full input text, causing the cursor to land inside the filled value. Previous fix (`_pendingCursorOffset`) only updated the local `InputZone` without persisting via `onOffsetChange`, so the framework reverted it on the next render. New approach computes the correct target at insertion time using cursor delta, validates against expected stale position at render time, and persists via `onOffsetChange`.

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
