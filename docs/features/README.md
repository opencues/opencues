---
last_updated: 2026-07-04
---

# Feature Concepts

Platform-agnostic feature specifications. Each integration implements these concepts with its own UI. See [`docs/glossary.md`](../glossary.md) for terminology. Feature numbers are stable identifiers — cross-references in code and docs point at them, so they don't renumber when this file is reorganized.

For implementers reading these top-down: the **Editor interaction** chapter is the minimum viable host (a runtime that only implements those features can render cues with no cycling, no blanks, no LLM). Every subsequent chapter is additive.

## Contents

- [Editor interaction](#editor-interaction) — Navigation, cycling, visual treatment, cursor handling
- [Cue sources](#cue-sources) — Where alternatives come from + how they route
- [Blanks](#blanks) — `_`-gated substitutions and the blank pipelines
- [State & invariants](#state--invariants) — Multi-word spans, linking, per-edit clearing, re-anchoring
- [Sentence-level](#sentence-level) — Cues that operate on whole sentences instead of words
- [Agentic](#agentic) — Continuously-running rewrite tasks
- [LLM context inputs](#llm-context-inputs) — Optional context the LLM receives alongside the prompt
- [Surfacing](#surfacing) — Display + dispatch concerns (status line, auto-submit, host scoping)
- [Configuration & loading](#configuration--loading) — Where configs live, when they reload, how defaults are seeded
- [Chrome specifics](#chrome-specifics) — Behaviour unique to the chrome integration

## Editor interaction

The minimum surface a host must implement to render cues. Every other chapter builds on these.

| # | Feature | Description |
|---|---------|-------------|
| 1 | [Navigation](navigation.md) | Move between words to select one |
| 2 | [Cycling](cycling.md) | Change the selected word via alternatives |
| 3 | [Visual Cues](visual-cues.md) | Indicate available alternatives within the text |
| 4 | [Cursor Preservation](cursor-preservation.md) | Adjust cursor when words change length |
| 14 | [Cursor Export](cursor-export.md) | Export cursor position for external tools |
| 21 | [Cursor Navigate](cursor-navigate.md) | Highlight automatically follows cursor to navigable words |

## Cue sources

How a word gets alternatives. Sources are declared in `CUE.md` files and dispatched per-word.

| # | Feature | Description |
|---|---------|-------------|
| 6 | [Local Cues](local-cues.md) | Alternatives computed locally (~0ms) |
| 7 | [Remote Cues](remote-cues.md) | Alternatives computed via LLM (~200-500ms) |
| 18 | [Tip Priority](tip-priority.md) | Which tip source wins when multiple sources match a word |
| 22 | [Word-Cue Routing](word-cue-routing.md) | Per-word dispatch of folder-based cue sources via per-source match/keywords/priority |

## Blanks

User-triggered substitutions at `_`. The trio is BlankSource (keyword), FluidBlankSource (lookup), TransformBlankSource (imperative rewrite); the remaining entries are surrounding machinery + UX.

| # | Feature | Description |
|---|---------|-------------|
| 8 | [Fill-in-the-Blank](fill-in-the-blank.md) | Underscore placeholder filling |
| 11 | [Cue-Blanks](cue-blanks.md) | Words and `_` positions with built-in cycling — script-driven, auto-populated, step, list, read-only |
| 48 | [Note collection](note.md) *(prototype, all 5 hosts)* | `note add/recall/delete _` over `~/.cues/NOTES.md` — save a snippet once, recall it with a couple of words, tweak in place. Fully local + deterministic (never sent to an LLM, `as-context: off`); line-surgery writes through a `validateNoteWrite` chokepoint (256 notes, 1024 chars/entry, control-char reject, duplicate idempotency). Labelled entries (`label: body`) recall the body only. |
| 49 | [Undo / Redo](undo.md) | `undo _` reverts the last change OpenCues made — a fill, a rewrite, a settings write, a volume/brightness set; `redo _` re-applies; `undo 3 _` goes deeper. Language-invariant (classified by the same LLM call as fluid-config: `元に戻して _`, `deshacer _` work; counts normalize from number-words). Exact-match-or-refuse: text you edited since is skipped and reported, never guessed; external effects of user-pack blanks are declared irreversible. ON by default (`undo-mode: off` to disable). |
| 17 | [Selector + Satellite Blanks](selector-satellite.md) | Single `_` becomes two linked words: selector picks a setting, satellite shows/writes its value |
| 29 | [Transform Blanks](transform-blank.md) | Imperative-instruction blanks at `_` — a single fused LLM call (classify + rewrite in one pass) that rewrites the surrounding text per the instruction. Plus a generative branch for "write a poem _" / "compose an email _" prompts. The third leg of the blank trio alongside BlankSource (keyword) and FluidBlankSource (lookup). |
| 31 | [Blank Loading Animation](blank-loading.md) | Per-frame glyph + colour cycling at `_` slots while their source resolves. Five OPENCUES.md scalars (mode, frames, RGB palette, ANSI palette, interval). Thunk-shaped re-read so hot edits propagate; capability-routed RGB vs ANSI per host. |
| 36 | [Blank Trigger Mode](blank-trigger-mode.md) | Controls when `_` fires its blank. `immediate` (default): trigger on insertion (v0.1 behaviour). `spaced`: trigger only when a confirming space follows — lets markdown `_italic_` typists keep their formatting without the first `_` substituting. Cycleable via `opencues settings _`. |
| 44 | [Markdown Styling](markdown-styling.md) | LLM-origin text (TransformBlank rewrites, FluidBlank fills) may contain `**bold**`/`*italic*`/`` `code` ``/`~~strike~~`/headings/lists — stripped before writing to the buffer and rendered natively per host (ANSI in terminals, `execCommand` in chrome) instead of showing literal markers. Also the entry point for TransformBlank's `make X bold` named-span-decoration instruction. |
| 37 | [Fluid Config](fluid-config.md) | Type `enable debug logging _` (or any natural-language settings phrase) and OpenCues classifies the intent, flips the setting in `~/.cues/OPENCUES.md`, wipes your summon words, and leaves the standard `opencues settings _` selector-satellite menu pre-positioned at the now-current state. Backspace deletes the pair as one span. FEATURES-only scope — never routes to user blanks (volume / brightness / weather / stocks / etc.). OFF by default. Validated across 5 providers at 100% precision + 90-100% recall on the holdout suite. |
| 52 | [Location Blank](location.md) | `location <place> _` / `address <place> _` → a terse one-line address; `map <place> _` → a rich location card (name, address, hours, phone, website + Maps link). OpenStreetMap Nominatim, no API key, 24h per-query cache + identifying User-Agent (policy). blankShapes-gated (leading / trailing / bare forms) so the keyword in prose never fires it.
| 53 | [Model Blank + `opencues models`](../architecture/llm-routing.md) | `whats my model _` / `list models _` answer from dispatch TRUTH (the effective per-bucket resolution, not just the config); the `opencues models` CLI prints the same effective routing + provider catalog. Shares one effective-routing walk with dispatch so display can't drift from what actually runs. Wired through the three-bucket LLM routing — see llm-routing.md.

## State & invariants

The state machine that keeps multi-word substitutions, cycle progress, and per-edit clearing consistent across keystrokes. New host adapters should read [`docs/architecture/spans-and-cycling.md`](../architecture/spans-and-cycling.md) for the canonical implementation.

| # | Feature | Description |
|---|---------|-------------|
| 9 | [Multi-Word Spans](multi-word-spans.md) | Alternatives that are multiple words |
| 10 | [Per-Word Clearing](per-word-clearing.md) | Preserve alternatives when editing text |
| 26 | [Resolver Skip Filter](resolver-skip-filter.md) | The four-condition check that prevents the LLM from re-resolving words already owned by cycling — keeps cycle tracks stable and saves tokens |
| 27 | [Deterministic Relocate](deterministic-relocate.md) | Cycle progress survives prefix/middle text edits — DynDefs are re-anchored to their content's new position when (and only when) the match is unambiguous |

## Sentence-level

| # | Feature | Description |
|---|---------|-------------|
| 38 | [Sentence Cues](sentence-cues.md) | A cue can declare `scope: sentence` and operate on whole sentences instead of individual words. Highlights span the sentence; cycling Up/Down swaps in alternative rewrites. Sentence-cues outrank overlapping word-cues (priority 85 vs ~70 — sentence wins outright, word-cues on words inside the span are suppressed). Default cue shipped: `more-formal` — rewrites informal sentences to formal register. OFF by default. Validated across 5 providers at 100% precision (CEDE on fragments/code) + 91-100% recall. |
| 51 | [Contradiction Cues](contradiction-cues.md) | Deterministic fact-check cues: an LLM PARSES your prose into a typed claim, the runtime VERIFIES it (correction is DATA, never generation) and flags a mismatch as a passive sentence-cue (priority 87). Tier 0 — weekday≠date, split-the-bill math (buffer + clock, no network); higher tiers light up when their world-data cache is present — 0.5 bank-holiday collision (GOV.UK), 5 outdoor-plan vs weather (open-meteo), 5b London transit disruption (TfL), 5c journey-time underestimate (photon geocode). One `contradiction-cues-mode` scalar, OFF by default; egress hosts hardcoded + inputs grounded (security-audit #28).
| 56 | [Dismissing a Cue](cue-dismissal.md) | Silence a passive advisory from its own note: `_` once mutes it for 30 minutes (in memory), `_` twice forgets it (written to `<cues>/dismissals.json`). Confined to cues with nothing to cycle to, so `_` still means "cycle" everywhere else. `opencues dismissals` lists what is forgotten and turns any of it back on, live — the host re-reads within seconds, no restart. Keyed on the normalized advisory TEXT, never a commitment id (those are per-snapshot ordinals). No scalar — a gesture, not a mode. |
| 55 | [AskUserQuestion Cues](ask-cues.md) | Generic tool-prompt cue primitive: borrow a well-known tool's system prompt (AskUserQuestion first) as a cue *generator* — the sentence under your cursor becomes an inline question (`❓` tip) with cyclable options (Ctrl+Alt+↑/↓); options carrying a concrete `apply` rewrite the sentence, advisory ones just inform. No new UI (reuses navigate + cycle + tip). Ambient at cursor, cached per sentence (one LLM call per new sentence). `TOOL_PROMPTS` registry — adding a tool is one entry. One `ask-cues-mode` scalar, ON by default (the prompt makes silence the default, so most sentences draw nothing). |
| 54 | [Session-Contradiction Cues](session-contradiction.md) | Claude-Code-only "you're contradicting yourself" cue. Two stages: a background producer distils the CC session transcript into a **commitments watchlist** (stack / constraint / memory-compaction / scope decisions) via `opencues extract-commitments` (kicked by the statusline); a fast matcher flags a draft that goes against one, as a passive sentence-cue (priority 88, reconciled rewrite on `Ctrl+Alt+↑`). LLM-authored (grounded: quote must be in the buffer, cited commitment must be on the watchlist). One `session-contradiction-mode` scalar, ON by default (inert on hosts with no session transcript). Data-minimized (only prose reaches the producer; tool I/O + thinking dropped).

## Agentic

| # | Feature | Description |
|---|---------|-------------|
| 30 | [Agent Tasks](agent-task.md) | Continuously-running agent loop declared in plain English (`agentically <X> _`). Re-evaluates the doc on every debounce settle; applies edits as dimmed words you can revert via cycling. Per-task invalidation cache keyed on (textHash, taskId). Built on the same DynDef-backed ownership primitives the rest of the runtime uses. |

## LLM context inputs

Optional information the FluidBlank LLM call receives in addition to the user's prompt. Each gated on a scalar in `OPENCUES.md` (ambient context OFF by default; identity context defaults to `safe`). Read [`docs/architecture/ambient-context.md`](../architecture/ambient-context.md) and [`docs/architecture/identity-context.md`](../architecture/identity-context.md) before wiring fluid-blank output into any side-effect channel.

| # | Feature | Description |
|---|---------|-------------|
| 32 | [Ambient Context](ambient-context.md) | FluidBlank optionally receives the focused field's label / placeholder / page-title so `_` lookups disambiguate per context (e.g. "destination" on flights.google.com vs airbnb.com). OFF by default. Chrome only — needs DOM. Host-agnostic at the `HostAdapter` contract level. |
| 33 | [Identity Context](identity-context.md) | The user's own personal data (`~/.cues/IDENTITY.md` frontmatter) as identity-context tokens so `_` lookups and rewrites personalise without re-typing. `safe` mode (the default) is bidirectional — the catalog ships token-only AND typed values are dehydrated from outbound buffer text, hydrated back locally; `raw` opts in to inlining. Catalog wired for fluid-blank + transform-blank. |
| 39 | [Blank as Context](blank-as-context.md) | Local blanks (weather, stocks, calendar, …) surfaced as ambient catalog context for fluid-blank/transform-blank — same security model as identity-context, for parameterised dynamic data instead of static personal fields. |
| 40 | [Max Thinking](max-thinking.md) | `max-thinking` scalar trades reasoning depth for speed on reasoning-capable models (Groq / Cerebras / OpenAI gpt-oss + gpt-5 families). |
| 46 | [Calendar Context](calendar-context.md) | Ingests your calendar (`.ics` / webcal feeds via `opencues calendar`) as a **reasoning** catalog so fluid-blank answers availability (`am i free thursday _`, `next event _`) and a cue flags prose that contradicts your schedule. Event times reach the LLM; titles are dehydrated `[EVENT N]` tokens hydrated locally. OFF by default. **No MCP** — plain calendar feeds. |

## Surfacing

How runtime state reaches the user (status line, auto-submit) and how cues/blanks scope themselves to hosts.

| # | Feature | Description |
|---|---------|-------------|
| 13 | [Auto-Submit](auto-submit.md) | Automatic analysis as you type |
| 15 | [Secondary Display](secondary-display.md) | Show cue-tips in a secondary area |
| — | [Host Compat](host-compat.md) | `on-host:` / `not-on-host:` frontmatter scopes a cue/blank/auditor to a subset of integrations |
| 43 | [Missing-Key Fallback](missing-key-fallback.md) | When no blanks-bucket LLM source could be wired (zero working API keys), `_` substitutes a visible, host-specific in-buffer hint instead of silently doing nothing. Chrome points at the extension popup; native hosts mention `~/.cues/.env`. |
| 45 | [Provider Health](provider-health.md) | Classifies LLM-call failures (auth / quota / rate-limit / outage / model-missing) into a status-line signal. Shipped as a library module with full scenario-test coverage; **not yet wired into any live host** — see the doc's "Current wiring state" section before relying on it. |
| 50 | [Katas](kata.md) *(experimental, all 5 hosts)* | Modal guided scenarios (`start kata 1 _`) authored as `katas/<name>/KATA.md`: a debounced LLM coach detects progress from typed text + submits + salient key presses, coaches the next micro-action on the status line, and enforces step order. Deterministic floor throughout: `stop kata _`, `next _`/`skip _`, Esc ×3 escape hatch, loud no-LLM degraded mode. Submit detection works on newline hosts (Chrome/Gmail/Shell) via Enter-keypress-on-non-empty-buffer, not just buffer-clear. |
| 47 | [Status-bar position](statusbar-position.md) *(chrome-only)* | Where Chrome's in-page floating status bar sits — `bottom` (default, full-width), `top` (full-width), or `right` (compact bottom-right panel). A real FEATURE (not a tunable) so the fluid-config intent classifier can route to it (`move the status bar to the top _`), host-scoped to chrome so it never pollutes the CLI hosts' menus. |

## Configuration & loading

Where `.cues/` lives, when changes reload, how `defaults/` seeds a fresh install.

| # | Feature | Description |
|---|---------|-------------|
| 16 | [Hot-Reload Config](hot-reload-config.md) | Config file changes take effect without restart |
| 24 | [Shipped Defaults](shipped-defaults.md) | `<repo>/defaults/` as the seed + bake source for `opencues seed-configs` and the Chrome extension's bundled fallback |
| 28 | [Config Search Paths](config-search-paths.md) | Three-layer precedence (`$OPENCUES_HOME → <cwd>/.cues → ~/.cues`), the `OPENCUES.md` system-settings user-level-only special case, and how `seed-configs` populates `~/.cues/` |
| 41 | [claude-cli Provider](claude-cli-provider.md) | Route opencues' agent surfaces through a Claude Pro/Max subscription (via the local `claude` CLI) instead of a pay-per-token `ANTHROPIC_API_KEY`. |
| 42 | [Cues Skill + Plugin](cues-skill-and-plugin.md) *(experimental, WIP)* | A Claude skill / plugin that side-effect-writes `.cues/CUES.md` from within a chat conversation with the user's AI assistant. |

## Chrome specifics

Chrome's threat model (sandboxed content scripts, no filesystem) forces a different sync + attach model. The Universal Integration profile (#35) is the structural fix that lets other hosts adopt the same constraints without breaking cycling.

| # | Feature | Description |
|---|---------|-------------|
| 23 | [Chrome Sync](chrome-sync.md) | How `opencues sync chrome` picks which `.cues/` dirs feed the browser extension (user-only by default; opt-in for projects) |
| 25 | [Chrome Hot-Reload](chrome-hot-reload.md) | Content-addressable `.version` polling so chrome picks up `sync chrome --watch` edits in already-open tabs (~2.5s) |
| 34 | [Chrome Normal Inputs](chrome-normal-inputs.md) | Chrome attaches `_`-trigger behaviour to plain `<input>` / `<textarea>`, not just contenteditables. Single-answer blanks only (no cycling — Universal Integration profile, #35). Sensitive-field exclusion gates attach for password / CC / OTP fields. |
| 35 | [Universal Integration profile](../architecture/universal-integration.md) | `HostAdapter.supportsCycling` lets hosts advertise "no cycling surface" (chrome's normal-input branch, future read-only contexts). Cycleable cues/blanks (word-cues, selector/satellite, list blanks, script-backed cycling) are pruned at registration; single-answer sources (fluid / transform / compute) survive. Structural inference — no frontmatter changes needed. |

## Adding a new feature

See [`docs/guides/adding-a-feature.md`](../guides/adding-a-feature.md).
