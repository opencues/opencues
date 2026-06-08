# Changelog

All notable changes to OpenCues will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Scope of this section**: only changes tied to an actual package version bump are listed. The project shipped many other features and fixes since 0.1.0 (sentence cues, auditors, agent-rewrite, ambient/user context, etc.) without bumping versions at the time — those landed in source but aren't formally versioned, so they're tracked in git, not here. From now on, the rule in `docs/architecture/versioning.md` § Discipline keeps changelog entries and version bumps shipping together.

### Changed — Resolver also skips forwarding `identityContext` when no consumer source will fire (symmetric with the blank-context gate)

PR #74 added a gate that skips the `blankContext` provider fetch when no consumer source (FluidBlank, TransformBlank) will fire. The symmetric site — `identityContext` forwarding in the same `_resolver.resolve(...)` call — was left as legacy "forward whenever `identity-context-mode !== 'off'`". The identity catalog is in-memory at ConfigLoader so the cost saving is small (no IO), but the symmetric correctness + payload-size win is worth the one-line gate.

- **`@opencues/runtime` (0.2.5 → 0.2.6)** — the same `noBlankContextConsumer(cleanWords, claimed)` predicate that gates `blankContext` now also gates `identityContext`: skip when either (a) the buffer has no `_` at all, or (b) every `_` is in the keyword-bound set passed via `keywordBoundSlotIndices`.
- **4 new regression tests** in `packages/opencues-runtime/src/modules/resolver.test.ts`'s new `identity-context skip for keyword-bound slots (symmetric with blank-context)` block: (1) every-`_`-claimed → not forwarded; (2) no-`_`-claimed → forwarded; (3) mode=off → not forwarded regardless; (4) no-`_` at all → not forwarded.

### Fixed — `volume _` and other keyword-bound blanks no longer pay a 1.2s wasted catalog fetch

Typing `volume _` / `weather _` / `nvidia _` / `brightness _` / any keyword-bound script-backed blank was visibly slow — the spinner ran ~1.3s even though the underlying script (`volume-blank.sh`, etc.) returned in ~200ms. The agentic harness traced the wasted second to the `blankContextProvider()` fetch: every `_` resolve sequentially called `await blank.get(slot.slot)` for every blank with `as-context: safe|raw` in its frontmatter (weather, crypto, stocks, hackernews, claude-status). 5 network/script calls on every keystroke that contains a `_`. The catalog is only ever consumed by FluidBlankSource and TransformBlankSource — both of which **cede** when a keyword-bound BlankFill slot claims the `_`. For `volume _` the catalog was being built and immediately thrown away.

The shipped fix is a single gate at the catalog-fetch site, plus the plumbing to feed it BlankFill's current slot indices.

- **`@opencues/runtime` (0.2.2 → 0.2.3)** — new `ResolverOptions.keywordBoundSlotIndices?: (text) => readonly number[]` option. Each of the 6 adapter bands (cc/v2.1, oc/v1.4, oc/v1.14, chrome/v1, gemini/v0.41, shell/v1) passes `text => shared.blankFill.scan(text).map(s => s.index)`. `SharedRuntime` now exposes `blankFill` so the closure is well-defined. Resolver calls a new internal `noBlankContextConsumer(cleanWords, claimed)` helper which returns true when either (a) the buffer has no `_` at all, or (b) every `_` is in the keyword-bound set. When true the `blankContextProvider()` fetch is skipped entirely. Backwards-compatible — adapters that don't pass the callback get legacy behaviour.
- **Measured on opencode via the agentic harness:** `volume _` resolver latency 1247ms → 8ms (99% reduction). `weather _` ~1s → 6ms. `nvidia _` ~1s → 5ms. Substitution lands at ~600-800ms (script time, not eliminable). `atomic number of oxygen _` and `draft stocks information email _` still fetch the catalog — both consumers run and produce correct output (the email draft still includes all 5 live ticker prices).
- **5 regression tests** in `packages/opencues-runtime/src/modules/resolver.test.ts` pin every branch: every-`_`-claimed → no fetch; no-`_`-claimed → fetch; partial coverage → fetch; no-`_`-at-all → no fetch; option-omitted → legacy behaviour.

The 1.2s tail was introduced in `22c898f feat(transform-blank): wire blank-as-context end-to-end (#73)` — the catalog fetch shipped without the "no consumer" gate. The agentic harness also uncovered a latent silent-drop bug in BlankFill's staleness check (introduced May 2026 in `0097d65 blank-loading: refcount animator`); that fix is staged in a follow-up PR alongside the dance-blank WIP.

### Added — transform-blank wires blank-as-context end-to-end

Blank-as-context's June 2026 v1 shipped fluid-blank-only — transform-blank (the compose / rewrite surface) consumed identity-context but not ambient blank-context tokens. The deferral was bench-gated, not architectural — `docs/architecture/blank-as-context.md:36-38` named it as the next milestone. This change closes that deferral.

The structural difference matters: fluid-blank already has the deterministic keyword path (`weather london _` works regardless of catalog), so blank-context for fluid is a convenience layer over a working path. Transform-blank has NO keyword path for ambient data — there is no way to type `weather london _` in the middle of `draft an email about today's weather`. Wiring blank-context into transform-blank is the structural unlock that lets compose flows reference live ambient data ("draft email about btc", "tweet about how stocks are doing", "morning standup: weather + crypto + nvda") with the runtime substituting live values into the prose locally.

- **`@opencues/core` (0.2.3 → 0.3.0)** — added `renderBlankContextCatalogForTransform` (a transform-flavoured prompt block: no INPUT/ANSWER examples since transform has no such shape; rules phrased for long-output prose; emit verbatim, never invent bracket-tokens from covers-hints, third-party `[Recipient Name]` / `[Date]` placeholders survive). Wired into TransformBlankSource at three prompt sites (GENERATIVE / 3-pass APPLY / FUSED). `resolveSentinels` now merges identity + blank-context catalogs into a single post-processor pass via `mergeCatalogs`, with `preserveUnknown: true` so non-catalog brackets in long bodies aren't stripped. 3-pass VERIFY REPAIR path also re-runs the post-processor to catch the edge case where VERIFY hallucinates a token in its correction.
- **Default frontmatter additions** (`defaults/blanks/*/BLANK.md`) — every shipping blank now declares `as-context:` explicitly. Data sources default ON (weather, stocks, crypto, hackernews, claude-status); action / write / loop-hazard blanks default OFF with a one-line rationale (volume, brightness, prompt, answer, sentinel, opencues, dictionary). Concrete slot lists:
  - **weather**: `context-bind: workCity` — binds to the existing `IDENTITY.md:workCity` field. `[WEATHER <CITY>]`.
  - **stocks**: `context-slots: NVDA, AAPL, TSLA, MSFT, GOOGL`. Documented in-frontmatter how to swap to `context-bind: portfolio` (with split + ack) for a personal watchlist.
  - **crypto**: `context-slots: BTC, ETH`. Majors only.
  - **hackernews**: `context-slots: top`. Single-slot — current top story.
  - **claude-status**: `context-slots: api`. Useful for "is claude working _" / "should i wait to retry _" routing.

  Per-blank audit table at `docs/architecture/blank-as-context.md:216` updated to match shipped state.

- **Bench evidence** — new `tests/benchmarks/blank-context-recall/transform-prod-bench.ts`. 7 compose-flow scenarios (email about weather, tweet about BTC, multi-token standup, identity+blank-context mix, etc.) hitting real Cerebras gpt-oss-120b: **7/7** with live substitution into prose. Plus 7 new unit tests at `packages/opencues-core/src/sources/transform-blank-blank-context.test.ts` pinning catalog injection (3-pass APPLY + FUSED), safe/raw mode contracts, post-processor substitution, and `preserveUnknown` survival of `[Recipient]` / `[Date]` placeholders.

**The user-facing scenarios this unlocks** — `draft an email to the team about today's weather _`, `write a tweet about how btc is doing _`, `compose a morning standup mentioning weather and crypto _`, `add a P.S. about today's btc price _`. All produce live-data prose without a keyword break. Threat-model parity with identity-context: `safe` mode keeps live values off the wire (substitution is local post-LLM); `raw` mode opt-in inlines them.

### Fixed — fluid-blank catalog recall +26pp via FUSED prompt rebalance

The FUSED_SYSTEM_PROMPT carries 30+ plain-prose factual-lookup examples that established a strong "answer in prose" prior — strong enough that catalog tokens were being dropped on indirect phrasings (`how are my stocks doing _` → empty answer; `biggest mover in my portfolio _` → invented `[PORTFOLIO]` bracket-token; `what's it like outside _` → prose instead of `[WEATHER LONDON]`). The shipped catalog block had a CRITICAL DECISION RULE but no inline counterweight to the plain-prose pull.

- **`@opencues/core` (0.2.2 → 0.2.3)** — `FUSED_SYSTEM_PROMPT` adds an explicit PRIORITY ORDER section (catalog tokens FIRST when a USER CONTEXT or BLANK CONTEXT block is present), plus an anti-hallucination rule: covers-hints are routing synonyms, NEVER bracket-token names ("portfolio" in the covers for `[STOCKS NVDA]` routes there; it does NOT license emitting `[PORTFOLIO]`). The empty-answer failure mode is named explicitly as the worst outcome.
- **Bench evidence** — new `tests/benchmarks/blank-context-recall/` matrix (30-35 cases, 5-provider matrix shape lifted from the matrix bench). Cerebras gpt-oss-120b on the production path: 25/35 (71.4%) → 34/35 (**97.1%**). Positive class 65% → 100%; negative 100% preserved. Ambient bench (`fluid-blank-ambient/fused-bench.ts`) holds at 174/176 — within noise.
- **Re-run before editing `FUSED_SYSTEM_PROMPT`** — `OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/blank-context-recall/prod-bench.ts`. Target: positive ≥95%, negative 100%, no invented bracket-tokens.

### Added — spec-version gate (the standard's "MUST refuse newer" rule, finally enforced)

The `SPEC.md` § Version policy clause "A conforming reader MUST refuse to parse a file whose declared spec version is higher than the reader's pinned SPEC_VERSION" used to be normative-but-inert — the parsers ignored the `spec:` frontmatter field entirely. Conformance fixtures pretended to cover it via regex-matching the fixture content, never calling into the runtime.

Now actually enforced:

- **`@opencues/core` (0.2.1 → 0.2.2)** — `spec-version.ts` adds `parseSpecPin`, `isSpecCompatible`, and `SPEC_OMIT_DEFAULT`. Every parser entry (`parseCuesMd`, `parseSingleCueMd`, `parseSingleAuditorMd`, `parseCuesMaster`, `parseBlanksMaster`, `parseAuditorsMaster`) calls the gate before producing a config. On refusal, an empty `CuesMdConfig` is returned with a populated `specError` field. `discover.ts` honours the gate and exposes an optional `log` hook so callers see refusal reasons. The algorithm encodes both the draft (`0.x`) and post-stable (`1.0+`) regimes: newer-major refuse, newer-minor refuse, AND post-1.0 cross-major refuse (major bumps are breaking by definition).
- **`@opencues/runtime` (0.2.1 → 0.2.2)** — `ConfigLoader` wires the discover log hook + every master-file load checks `specError` and emits `[warn] ConfigLoader: <file> refused — <reason>`. Refused sources are visible in `/tmp/opencues.log` instead of silently missing.
- **Conformance test rewritten** — `conformance.test.ts`'s `spec-too-new` case now calls `parseSingleCueMd` directly and asserts the returned config has `specError` set + no sources/blanks/auditors populated. The fixture-only regex check it replaced was technically passing the conformance suite without exercising any production code path.
- **39 new tests** — `spec-version.test.ts` (32 unit tests covering the algorithm against future versions: a 2.0 reader, 1.5 reader, pre-release suffix semantics, unparseable input) + `discover.spec-version.test.ts` (7 integration tests covering the log hook + the back-compat "omit-default never moves forward" invariant).

**The bug this prevents.** Without the gate, a `0.2-alpha` runtime silently accepts files declaring `spec: opencues/99.0`. The runtime tries to honour any feature the file uses — including future surfaces the runtime can't model — and produces incoherent results. With the gate, the runtime says "I'm 0.2, file declares 99.0, refused" and the user sees a single warn line they can act on.

**Forward-compat invariant.** `SPEC_OMIT_DEFAULT` stays at `opencues/0.1-alpha` permanently. When the spec bumps to 0.3, 1.0, 2.0, etc., legacy spec-less files still load (the default is always ≤ the runtime's version). New files SHOULD declare their target explicitly. Codified in `CLAUDE.md` § Spec-omit-default is permanent.

### Breaking + Added — identity-context rename, blank-as-context feature, and `opencues context`/`opencues cleanup` CLI

**Renamed** the personal-data feature from `sentinels` → `identity-context`:

- `~/.cues/SENTINELS.md` → `~/.cues/IDENTITY.md`
- `sentinels-mode` scalar in OPENCUES.md → `identity-context-mode`
- Public exports: `parseSentinelsMd` → `parseIdentityMd`, `renderSentinelsCatalog` → `renderIdentityContextCatalog`, `postProcessSentinels` → `postProcessContext`, types `Sentinels`/`Sentinel`/`SentinelsMode` → `Identity`/`IdentityField`/`ContextMode`
- CLI: `opencues sentinels` → `opencues identity`
- Source files: `packages/opencues-core/src/sentinels{,-validator}.ts` → `identity-context.ts` / `identity-validator.ts`
- Docs: `docs/features/sentinels.md` + `docs/architecture/sentinels.md` → `identity-context.md` siblings

No runtime back-compat reads. `opencues seed-configs` self-heals: `USER.md` → `SENTINELS.md` → `IDENTITY.md` two-hop rename + rewrites legacy scalar names in `OPENCUES.md`. Runs automatically on `opencues install <host>` for every existing user.

Why the rename — `sentinels` named the implementation (bracket tokens), not the content (identity), and conflicted with three sibling features (blank-context, ambient-context) all sharing the same `<context>` prompt block. The new umbrella is "context" with three sources (identity / blank / ambient). See `docs/features/identity-context.md`.

**Added — blank-as-context** (`docs/features/blank-as-context.md`): blanks can opt into surfacing their current values as ambient sentinel-style tokens for fluid-blank without the user typing the keyword. Stocks, weather, crypto, etc. become available as `[STOCK AAPL]`, `[WEATHER LONDON]` tokens that the LLM can emit; runtime substitutes after the response. Off by default per scalar `blank-context-mode: off | safe | raw` + per-blank `as-context: off | safe | raw` frontmatter. Bench evidence at `tests/benchmarks/blank-sentinels-matrix/FINDINGS.md` — 5-method × 5-provider × 6-count matrix (9,200 LLM calls); `safe-tokens` wins on every provider tested (100% on Cerebras + Groq, 99.4-99.7% on Gemini + OpenAI, 92.9% on Claude Haiku).

**Added — `opencues context list`**: unified inspection surface for all three context sources (identity / blank / ambient). Shows mode scalar, file paths, active tokens. `--json` for scripting. (LLM provider/model pair-display lives in `opencues doctor` from #68.)

**Added — `opencues cleanup`**: find and SIGTERM orphan host processes left behind by prior `opencues run` invocations. Also wired into `opencues run opencode|gemini-cli` as a predecessor-kill so fresh launches supersede prior instances for the same project. `--host`, `--project`, `--kill`, `--force`, `--json` flags. Self-protective: walks the current process's ppid chain to avoid killing its own ancestor.

**Fixed — config-intent classifier false-positive on identity-related lookups**: the rename created semantic collision between the user-typed phrase `mother's maiden name _` and the scalar name `identity-context-mode`. The classifier was applying `identity-context-mode safe` instead of ceding to fluid-blank. Added six NEGATIVE example phrases (`mother's maiden name`, `my email`, `my name`, `who am I`, `what's my github`, `i work at`) to the classifier's few-shot prompt. The positive setting-flip path (`let it use my personal info when answering _`) still routes correctly.

**Fixed — ConfigIntent auto-corrects stale model when switching provider via NL**: companion to PR #68's pair-display + cycling-resets-model fix, on the NL-classifier-apply path. When a user types `switch blanks to anthropic _`, ConfigIntent now reads the current `<bucket>-llm-model` scalar (via a new optional `readScalar` callback) and overwrites it with the new provider's `defaultModel` if the existing model belongs to a different provider's namespace. The runtime wires `readScalar` from `ConfigLoader.opencuesState.settings`; existing test callers without it get the old "leave alone" behaviour. Two new tests pin both branches.

Versions bumped: `@opencues/core` 0.1.12 → 0.2.1, `@opencues/runtime` 0.1.20 → 0.2.1, `opencues` (CLI) 0.1.10 → 0.2.0, `@opencues/chrome` 0.1.4 → 0.2.1.

### Fixed — bogus API key no longer fails silently when the provider's 401 body lacks an HTTP status number

Reported as part of switch-model testing: users with an invalid `ANTHROPIC_API_KEY` typed `_` and saw nothing happen — no buffer change, no inline error, no UI signal at all. The runtime *was* hitting the provider and *was* getting a 401 back, but Anthropic's response body is shaped as a 200-ish JSON envelope containing `{"type":"error","error":{"message":"invalid x-api-key","type":"authentication_error"}}`. `parseResponse` correctly threw `Error("anthropic error: invalid x-api-key")`, but `classifyHttpError` only matched HTTP-status numbers like `401` / `403` — the textual error fell through to the silent default, no `formatLLMErrorAsSubstitute` was called, and no inline message landed in the buffer.

Fix: `classifyHttpError` now also matches textual auth-error patterns (`invalid_api_key`, `invalid x-api-key`, `incorrect api key`, `api key not valid`, `authentication_error`, `authentication failed`, `permission_denied`, `unauthorized`). Anthropic, OpenAI, Groq, Gemini, and any future provider whose 401 body carries no HTTP status number now surface the same `[OpenCues: API key rejected ...]` substitute that 401/403 already did. Pre-existing `\b40[13]\b` HTTP-status path remains, so providers that *do* prefix the message with `HTTP 401` are still caught by the same branch.

Companion precision tweak: the `fluid-blank.bailed` event now carries the classified reason (`invalid-api-key`, `model-not-found`, etc.) instead of always reporting the generic `llm-error`. Event-stream consumers can now assert on the specific failure class without grepping log strings. The `llm-error` fallback is preserved for unclassified (silent / 5xx / malformed-response) failures.

Five new unit tests in `fluid-blank-error-substitute.test.ts` pin each provider's textual auth-error shape (Anthropic / OpenAI+Groq / Gemini / generic `authentication_error` / bare `Unauthorized`).

Version bumped: `@opencues/core` 0.1.11 → 0.1.12.

### Added — fluid-config `provider:model` pair display + granular model discovery via `config _`

Two UX gaps closed in one PR. Builds on top of #66 (provider cycling now skips values whose env key isn't set) — the pair-aware cycling here composes cleanly with that filter: cycling the provider skips ineligible providers AND resets the sibling model on the way, so neither "no env key" nor "stale model" pairs can persist.

**The pair-display gap.** Typing `use claude opus for auditors _` previously wrote both `auditors-llm-provider: anthropic` AND `auditors-llm-model: claude-opus-4-7` to OPENCUES.md, but the satellite splice showed only `auditors-llm-provider anthropic` — the model was set silently. Worse, cycling the provider satellite (Ctrl+Alt+Up on `anthropic`) walked to `openai` without touching the model scalar, shipping the invalid pair `openai + claude-opus-4-7` as soon as the next LLM dispatch fired (→ 400). Fix: ConfigIntent now emits the satellite as `anthropic:claude-opus-4-7` (one splitWords token; `:` is non-whitespace) with new `satelliteCyclingValue: 'anthropic'` metadata so cycling state stores just the provider while the buffer shows the full pair. The runtime reads the new metadata in `resolver.ts:1372`. The user always sees what model they got.

**The discovery gap.** Models weren't reachable from the `config _` cycling menu at all — only the three `*-llm-provider` scalars were in FEATURES. Users had to type natural language or hand-edit OPENCUES.md to pick a model. Fix: `FeatureSpec` gains an optional `valuesProvider?: (settings) => readonly ValueSpec[]` callback. Three new entries register `cues-llm-model`, `auditors-llm-model`, `blanks-llm-model` with a `valuesProvider` that reads the sibling `*-llm-provider` and enumerates that provider's `knownModels` from `llm-provider.ts`. The first cyclable value is always `default` (treated by `normalizeModelScalar` in resolver.ts as equivalent to absent — falls through to the provider's `defaultModel`). Cycling provider in `cycling.ts` now also writes `default` to the sibling model scalar via `providerScalarToModelScalar`, keeping the (provider, model) pair invariant by construction — no cycle path can land on an invalid pair.

`getMenuDefinitions` accepts an optional `settings` argument so dynamic values reflect live state. `applyOpenCuesScalar` overlays the three dynamic definitions on top of any existing file-shipped settings block on every scalar mutation (`overlayDynamicDefinitions` in config-loader.ts), so cycling provider immediately reshapes the model menu without waiting for the 2.5s reload-suppression window.

Test coverage: 8 new vitest cases in `feature-registry.test.ts` (valuesProvider shape + provider→model derivation), 4 new in `fluid-config.scenarios.test.ts` (pair splice + cycling-state semantics), 10 new in `llm-config-cycling.scenarios.test.ts` (provider-cycle-resets-model invariant across all three buckets + non-bucket scalars unaffected). Agentic scenario at `tests/agentic/scenarios-ts/fluid-config-pair-and-model-discovery.ts` drives the full live journey.

Versions bumped: `@opencues/core` 0.1.10 → 0.1.11, `@opencues/runtime` 0.1.19 → 0.1.20.

### Added — cycling `*-llm-provider` settings now SKIPS values whose env key isn't set

Same "test before you switch" property the chrome popup enforces natively: cycling on the CLI hosts (CC / OC / gemini / shell) must not land on a provider value the runtime can't actually dispatch with. Prior to this change, `config _` → cycle to `blanks-llm-provider` → Ctrl+Alt+Up stepped through every registry-declared value blindly. A user with only `CEREBRAS_API_KEY` set could land on `groq`, commit `blanks-llm-provider: groq` to `~/.cues/OPENCUES.md`, then watch every subsequent `_` silently no-op until they read `/tmp/opencues.log` (or, with #65 landed, see the inline `[OpenCues: API key rejected ...]` substitute).

New predicate `isProviderValueCyclable(providerId, apiKeys, { isCliAvailable? })` in `@opencues/core/llm-provider.ts` encodes the eligibility rule: `inherit` is always cyclable; `transport: 'cli'` providers (claude-code-cli, openai-subscription) are cyclable iff their CLI binary is on PATH; `optionalAuth: true` providers (opencode-zen) are cyclable without a key; all others require `apiKeys[provider.envKeyName]` to be set. Cycling reads it via a new `getApiKeys: () => apiKeys` callback threaded through `buildSharedRuntime` and the per-host adapter bands.

Safety net: when the filter would collapse a setting's value list to empty (no eligible providers + no `inherit` in the list), the cycle falls back to the unfiltered list so it still steps SOMEWHERE — the runtime then surfaces the resulting LLM-call failure inline (#65) rather than freezing the menu on the same value forever.

Scope is intentionally narrow — only `llm-provider`, `cues-llm-provider`, `auditors-llm-provider`, `blanks-llm-provider` scalars are filtered. Other settings (voice-mode, debug-mode, tips-mode, etc.) cycle unchanged. Hosts that don't thread `getApiKeys` (back-compat path) keep the pre-change blind-cycle semantic, so third-party adapters don't break.

7 new tests in `cycling.test.ts` pin the matrix (zero keys / one key / multi-key cycling forward + reverse / back-compat default / never-empty safety net / non-provider-scalar pass-through). 6 unit tests in `llm-provider.test.ts` pin `isProviderValueCyclable` independently across http / cli / optionalAuth / unknown-id / legacy-alias cases.

Versions bumped: `@opencues/core` 0.1.9 → 0.1.10, `@opencues/runtime` 0.1.18 → 0.1.19.

### Fixed — fluid-blank chain extension now survives a multi-word first answer

Pre-existing regression surfaced by live-testing the scroll-order fix below. Fluid-blank stored its DynDef `spanEnd` as the END OF THE FIRST WORD of the substitution (`newSpanEnd = newWord.end` in `resolver.ts:1235`). For a single-word answer that happened to be correct; for a multi-word answer like `William Shakespeare` inserted at char 0, `spanEnd` landed at 7 (end of `William`) instead of 19 (end of `Shakespeare`). The next substitute's chain verbatim check (`liveText.slice(spanStart, spanEnd) === currentAlt`) then compared `"William "` against `"William Shakespeare"` and bailed, dropping the first link from the chain — a 3-step lookup chain ended up only 2 links deep, with the original prompt + first answer silently missing from the walk-back history.

Fix: set `newSpanEnd = start + answer.length` (the FULL substituted range) in `resolver.ts:1235`. New scenario test at `blank-chain.scenarios.test.ts` pins the case explicitly.

Version bumped: `@opencues/runtime` 0.1.17 → 0.1.18.

### Fixed — fluid-blank AND transform-blank cycle order now match every other blank type ([#61](https://github.com/opencues/opencues/issues/61))

Cycling through a fluid-blank chain (`translate to japanese _` → `… translate to chinese _`) or a transform-blank chain (`draft email _` → continue → another transform) moved in the opposite direction from list-blanks / selector-satellite / sentence-cues. After the first substitution the buffer showed the answer (`こんにちは`); the DynDef stored `[question, answer]` with `currentIndex: 1`, so pressing Up (+1) wrapped from the end of the array straight to the oldest question instead of stepping back one item. With a chain `[q1, a1, q2, a2]` at `currentIndex=3`, Up jumped all the way to `q1` while Down only walked to `q2` — opposite of every other blank where `alts[0]` is the current visible and Up advances through `alts[1..]` one entry at a time.

The bug structurally affected both LLM-blank chain pipelines (`fluid-blank` and `transform-blank`) because they share the same `[oldest, …, newest]` chronological layout with `currentIndex` pointing at the tail. The initial PR only fixed fluid-blank per the narrow issue title; manual testing in CC surfaced that `draft email _` (transform-blank) had identical broken cycling, so the fix was extended to transform-blank.

Fix: store both fluid-blank AND transform-blank alternatives in reverse-chronological order — `[newestAnswer, newestQuestion, …priorItems]` with `currentIndex: 0`. Up now walks backward through history one entry at a time (newest answer → newest question → prior answer → original prompt), matching the convention list-blanks and sentence-cues already use. Chain truncate-on-branch flipped accordingly for both pipelines: drop the items NEWER than where the user cycled to (the indices BELOW `currentIndex` in the new layout) before prepending the next substitution. Tests at `packages/opencues-runtime/src/modules/blank-chain.scenarios.test.ts` and `transform-blank.scenarios.test.ts` updated for the new shape.

Version bumped: `@opencues/runtime` 0.1.15 → 0.1.17.

### Fixed — Claude Code: second `_` in a chain silently dropped (ZWS leaks into KeyEvent)

CC-only regression after [#52](https://github.com/opencues/opencues/pull/52). Chaining `_` triggers (`draft email _` → `… translate to japanese _`) worked on OpenCode but failed on Claude Code: the second transform never fired, the `_` just sat in the buffer. Root cause: the CC adapter's `dispatchKey` passed `iz.text` straight into `normaliseKeyEvent` (`packages/opencues-runtime/adapters/cc/v2.1/boot.ts:708-727`) without stripping the render-kick `\u200B`/`\u200C` marker that `__oc_pushHostText` toggles to defeat React's string-equality bail. Resolver's `onUnderscoreKey` (added by #52) simulates the standalone-`_` check via `splitWords`, which matches `\S+`; the ZWS is non-whitespace, so it glues to the cursor word — the trailing `_` is no longer detected as standalone, the one-shot gate refuses to arm, and `onTextChange` falls through to the debounced path with `allowBlanks=false`, masking the blank source. OC isn't affected because it doesn't render-kick.

Fix: strip ZWS at the KeyEvent boundary, same pattern as `checkTextDrift` (boot.ts:282) and `applyRender` (boot.ts:771-772) already use — this was the missing fourth row in the boundaries table in `integrations/claude-code/CLAUDE.md`. Adapter test pinned via `KeyEvent.text + cursorOffset are ZWS-stripped before reaching onKey handlers`.

Version bumped: `@opencues/runtime` 0.1.14 → 0.1.15.

### Fixed — LLM blanks silently dead on auto-routed Cerebras (invalid provider/model pair) + provider errors now surface inline

One root cause: a provider-blind default model leaking into an auto-routed provider of a different model namespace. The guiding principle for the fix: **always land on a valid (provider, model) pair; if a real error remains (credits, auth, …) surface it inline; never silently ship an invalid model.**

1. **Valid-pair guarantee — defaulting (`packages/opencues-runtime/src/modules/resolver.ts`).** The resolver no longer falls back to the host-supplied (legacy Groq-namespaced) `defaultModel` for the global MODEL tier. With `CEREBRAS_API_KEY` set and no `llm-provider:`/`llm-model:` in OPENCUES.md, auto-route correctly picked the Cerebras *provider* but the host default model `openai/gpt-oss-120b` was injected as `globalModel`, overriding Cerebras's own native `gpt-oss-120b` — so every `_` fluid/transform blank died with `provider error: Model openai/gpt-oss-120b does not exist … (code=model_not_found)`. (Script/static blanks like `weather _` were unaffected.) `globalModel` now comes ONLY from an explicit choice (`llm-model:` scalar or host-UI `modelOverride`); with neither, `resolveLLM` falls through to the resolved provider's own `defaultModel`, valid by construction. Two regression tests pin the invariant via the `resolverFactory` capture hook.

2. **Valid-pair guarantee — canonicalization (`packages/opencues-core/src/llm-provider.ts`).** New `canonicalizeModelForProvider()` normalises a known cross-namespace model alias INTO the resolved provider's own namespace on the PRIMARY dispatch path (previously the gpt-oss `openai/`-prefix ↔ bare translation only happened on the *fallback* path). A stale or mistyped `llm-model: openai/gpt-oss-120b` paired with Cerebras is now healed to `gpt-oss-120b` **before** the call instead of bouncing as `model_not_found`. Deliberately narrow (gpt-oss family only); an unknown/genuinely-wrong model is left untouched so the provider rejects it and the runtime surfaces that inline. Unit + `resolveLLM` integration tests cover both directions and the no-op cases.

3. **Provider errors surface inline like 401/404 (`packages/opencues-core/src/sources/fluid-blank-source.ts`).** `classifyHttpError` now recognizes two error classes that previously carried no HTTP status number and fell through to the silent default (visible only in `/tmp/opencues.log`):
   - **`model-not-found`** — `model_not_found` / `not_found_error` / "does not exist" / "do not have access". Checked before the generic 404 branch so a model 404 is attributed to the model, not the endpoint URL.
   - **`insufficient-credits`** — 402 / `payment_required` / `insufficient_quota` / "out of credits" / "billing". This is the "real" downstream error once canonicalization has landed a valid model — the account simply can't pay for the call.
   Both route through the existing `formatLLMErrorAsSubstitute` path, painting actionable inline messages. Reasons added to every formatter union site (`resolver.ts`, `build-sources.ts`, `boot-common.ts` native formatter, chrome `boot.ts`).

4. **Observability — resolver-side explicit-`_` gate now logs its suppression (`packages/opencues-runtime/src/modules/resolver.ts`).** When the explicit-`_` keystroke gate suppresses a blank trigger on the resolver path (fluid / transform / config-intent), it previously did so completely silently — no `starting` line, nothing even at debug level — so a `_` that "did nothing" was undiagnosable from the log. It now emits a `debug`-level `Resolver: explicit-_ gate BLOCKED …` line mirroring `BlankFill`'s existing one, surfaced under `debug-mode: on` (or `DEBUG_OPENCUES`).

Versions bumped: `@opencues/core` 0.1.8 → 0.1.9, `@opencues/runtime` 0.1.13 → 0.1.14.

### Changed — Provider rename `claude-cli` → `claude-code-cli`, llama-3.3 removed from Groq catalogue, CLI providers added to smoke

Follow-up on the LLM-provider fix below. Renamed the Anthropic CLI-transport provider id from `claude-cli` to `claude-code-cli` to match the official product name and remove ambiguity ("claude-cli" reads as a generic Claude CLI; the canonical user-facing brand for the binary is "Claude Code"). `canonicalizeProviderId()` keeps legacy user configs (`globalProvider: claude-cli`) silently working — old id resolves to canonical at every user-input boundary (resolveLLM + validateEndpoint + getProvider). Drop after 2027-01-01.

`llama-3.3-70b-versatile` removed from Groq's `knownModels` — it's not a reasoning model, so the adapter's default `reasoning_effort: low` 400s on it. The `modelRejectsReasoningEffort` predicate keeps it usable via direct OPENCUES.md edit; the classifier just doesn't surface it.

Smoke runner now also covers the two CLI-transport providers (`claude-code-cli`, `openai-subscription`) — `probe()` branches on `transport === 'cli'` and dispatches via `invokeCli()` instead of `fetch()`. Verified live 2026-06-02: 20 of 21 combos pass; the one failure was the user's expired `codex login` (actionable, not a bug — the runner correctly surfaced the API's auth-expired message).

Version bumped: `@opencues/core` 0.1.7 → 0.1.8 (single bump covers both fixes).

### Fixed — LLM providers: temperature/reasoning-effort deprecations + stale model catalogues

User reported `draft email _` producing no output in claude-cues despite doctor reporting healthy. Log trace caught the actual failure: `anthropic error: \`temperature\` is deprecated for this model.` — every blank routing through `blanks-llm-provider: anthropic` (Claude 4.x) was silently dying in the LLM call. A live smoke runner ([`tests/integration/llm-providers-smoke.cjs`](tests/integration/llm-providers-smoke.cjs)) verifying all 19 shipped (provider, model) combinations against real keys caught three more latent failures:

- **anthropic + claude-{opus,sonnet,haiku}-4-*** rejected `temperature`. Anthropic deprecated the field on the entire Claude 4.x family in June 2026. Now omitted at request build (`modelRejectsTemperature` registry). OpenRouter passthrough to `anthropic/claude-*` also covered.
- **groq + llama-3.3-70b-versatile** rejected `reasoning_effort` with HTTP 400. Groq's adapter previously claimed "non-reasoning models silently ignore it" — they don't on llama. Now gated by `modelRejectsReasoningEffort` registry; gpt-oss companions (which REQUIRE the field) keep getting it.
- **cerebras** catalogue listed `qwen-3-235b-a22b-instruct-2507` which Cerebras's `/v1/models` endpoint no longer returns. Removed from `knownModels`.
- **gemini** catalogue listed `gemini-3.1-flash` / `gemini-3.1-pro` which 404 on the live API. Google switched to the `gemini-flash-latest` / `gemini-pro-latest` rolling aliases. Updated.

Capability matrix lives in two registry consts in `llm-provider.ts` (`TEMPERATURE_REJECTING_MODELS`, `REASONING_EFFORT_REJECTING_MODELS`). Adding a future deprecation is a one-line append. 24 unit-test pins in `llm-provider.temperature.test.ts` cover the predicates + the buildRequest forwarding (Anthropic inline body + buildOpenAIBody-driven Groq/OpenRouter/Cerebras/OpenAI shared body). Live smoke runner (opt-in, requires API keys) verifies every catalogue entry actually accepts a minimal request — re-run on any model-catalogue or provider-adapter edit:

```bash
node tests/integration/llm-providers-smoke.cjs           # smoke every combo
node tests/integration/llm-providers-smoke.cjs --models  # list known combos
```

Verified live: 19/19 combos pass after the fix. Version bumped: `@opencues/core` 0.1.7 → 0.1.8.

### Changed — Blanks fire only on explicit `_` keystroke (cursor-split bug)

Explicit-`_` gate for blank activation (`packages/opencues-runtime/src/modules/{resolver,blank-fill}.ts`). FluidBlank / TransformBlank / ConfigIntent and script-backed blanks (volume, brightness, …) now fire ONLY when the `_` in the buffer was placed by an explicit user keystroke. A `_` exposed via cursor-relocation (typing `monologue_` and then splitting it to `monologue _`), paste, or programmatic `setText` is suppressed. Resolver and BlankFill each arm a one-shot flag on a plain `_` keypress, but only when the simulated insertion would produce a standalone `_` — so typing `_` adjacent to an existing word never arms. The flag is cleared at the end of the next `onTextChange` (exception: spaced-mode unconfirmed `_` keeps it through one extra dispatch so the confirming space still dispatches). `MockAdapter.pushText` auto-fires the `_` keystroke when the new text introduces additional `_` chars; the new `pushTextNoKeystroke` is the explicit opt-out for paste/programmatic-insertion simulations. Three scenario tests pin the user journey.

A follow-up commit on the same branch adds an event-bridge synth on `text:` injection that grows the underscore count — keeps the gate honest when text arrives through programmatic paths that bypass `onKey`.

Version bumped: `@opencues/runtime` 0.1.12 → 0.1.13.


### Fixed — Terminal.app Ctrl+Option+arrow: stdin byte-rewrite (completes the #51 synth)

Real-device testing of the [#51](https://github.com/opencues/opencues/pull/51) synth on a **default** Terminal.app profile (claude-cues 2.1.158, Ink) showed it still did nothing. A runtime probe of the raw event proved why: Ink **splits** the `\x1b\x1b[A` chord into two events *before any consumer sees it* — a standalone `escape` (seq `\x1b`) + a plain arrow (seq `\x1b[A`), same millisecond. After the split the arrow no longer carries the double-ESC prefix, so the event-level `shouldSynthesizeMacDoubleEscCtrl` gate can never fire (`synthFired:false` on every arrow; zero `ctrl:true` in the dispatch log).

The fix runs one layer earlier — at the raw stdin bytes, before Ink parses:

- **`packages/opencues-runtime/src/modules/mac-keyboard.ts`** — new pure `rewriteMacDoubleEscArrows(chunk)` rewrites `\x1b\x1b[A/B/C/D` → `\x1b[1;7A/B/C/D` (modifier param `7` = Ctrl(4)+Alt(2)+1 — the exact bytes Ghostty/iTerm2 already send, which Ink decodes to `{ctrl:true, alt:true}`). Plus `installMacDoubleEscStdinRewrite(stdin)` — darwin-gated, idempotent. Ink/CC consume stdin via 'readable' + `read()` with `setEncoding('utf8')`, so the installer wraps `read()` (the path that matters; chunks arrive as utf8 STRINGS, handled by a string-form rewrite) plus `emit('data')` for flowing hosts — each normalised before Ink's keypress parser sees it.
- **`packages/opencues-runtime/adapters/cc/v2.1/boot.ts`** — installs it once in `boot()` (CC only; shell / OC / gemini receive pre-parsed events and don't read stdin).

Safe by the **contiguous-byte invariant**: the terminal writes the chord's 4 bytes atomically → one stdin buffer; a real lone Escape arrives as its own buffer. Matching `\x1b\x1b[A` only within a single buffer therefore can never swallow a real Escape — no state, no timing window, no Escape latency. **Strictly darwin-gated — a complete no-op on Windows/Linux**: the installer returns early (`platform !== 'darwin'`) before wrapping stdin, so the byte rewrite is never reached off macOS. Degradation floor: on split-chunk transports (tmux/ssh) it no-ops, identical to the prior release. The #51 event-level synth is retained (no-op on this path, still covers hosts that preserve the full sequence). gemini-cli's matrix-❌ row is fixable by the same installer in its bootstrap (follow-up).

Version bumped: `@opencues/runtime` 0.1.11 → 0.1.12.

### Added — Bootstrap-coverage tests + banner-combo extraction (no behaviour change)

Follow-up to the macOS Ctrl+Option+arrow fix in [#51](https://github.com/opencues/opencues/pull/51). Two surfaces were behaviour-correct but untested:

- **OpenTUI bootstraps** (`integrations/shell/src/bootstrap.ts`, `integrations/opencode/patches/opencuesBootstrap.ts`) inlined the modifier-coalesce for the runtime `Modifiers` shape. Now factored into `buildOpenTuiModifiers(evt)` in `@opencues/runtime/src/modules/mac-keyboard.ts`, pinned by 19 new test cases in `mac-keyboard.test.ts` covering: Mac Terminal.app double-ESC (all 4 arrows + meta preservation), Ghostty / iTerm2 xterm-modifier CSI (Ctrl+Option+arrow + plain Option+arrow), Linux/Windows xterm (Ctrl+Alt+arrow, plain Alt+arrow regression guard, plain arrow), Ctrl+Shift+arrow + 4-modifier combinations, the alt-coalesce truth table (option/alt/meta cross-product), and defensive edge cases (missing sequence, missing key). Both bootstraps now delegate verbatim — drift between the two is structurally impossible.
- **Banner combo label** (`packages/opencues-cli/src/commands/run.cjs`) had inline `pickNavCombo(host)` that read `process.platform` directly — not testable. Now extracted to `packages/opencues-cli/src/lib/nav-combo.cjs` with an explicit `platform` parameter (defaults to `process.platform`); pinned by 21 new `node:test` cases in `nav-combo.test.cjs` across `darwin / linux / win32 / freebsd / openbsd / sunos / aix` × every shipped host. Confirms macOS reads "Ctrl+Option" (matches physical Mac keyboard label) and every other platform reads "Ctrl+Alt"; chrome's label follows the user's keyboard, not the browser env.

Net coverage: **+40 unit pins** across the two surfaces flagged as untested in #51's post-merge audit. Runtime suite now 1496 tests; CLI suite now 133 tests. Versions bumped: `@opencues/runtime` 0.1.10 → 0.1.11, `opencues` CLI 0.1.8 → 0.1.9, `@opencues/shell` 0.1.3 → 0.1.4, `@opencues/opencode` 0.1.2 → 0.1.3.

### Fixed — macOS Ctrl+Option+arrow now works on every terminal, including Terminal.app

A tester reported `Ctrl+Alt+arrow` doing nothing on macOS. `cat -v` testing traced the byte stream Mac Terminal.app emits for Ctrl+Option+arrow: `\x1b\x1b[A` (double-ESC + CSI). The Ctrl modifier byte is missing — Terminal.app doesn't encode it — but **the double-ESC prefix is a unique signature**: no other macOS key combination produces double-ESC arrow CSI. Plain Option+Left/Right emits word-jump bytes (`^[b` / `^[f`), not arrow codes; plain arrows omit the ESC prefix entirely. Both Ink and OpenTUI parsers detect double-ESC and surface `option: true` on the arrow event (see `ink/parse-keypress.js:471` and `@opentui/core parse.keypress:5957`).

Three sites now synthesise `ctrl: true` when the runtime sees `option && arrow && !ctrl`, so the `ctrl-alt` matcher fires on Mac Terminal.app exactly the way it does on Ghostty / iTerm2 (which already transmit the Ctrl bit in modifier-encoded CSI like `\x1b[1;7A`):

- **`packages/opencues-runtime/adapters/cc/v2.1/adapter.ts:328-380`** — synth in `normaliseKeyEvent`, covers CC for both forks (cli.js 2.1.110 + native 2.1.150/158).
- **`integrations/shell/src/bootstrap.ts:412-440`** — synth in `dispatchOpenCuesKey`. Same OpenTUI host as OC.
- **`integrations/opencode/patches/opencuesBootstrap.ts:511-540`** — same synth.

Per-integration matrix on macOS after this PR:

| Integration | Mac Terminal.app | Ghostty / iTerm2 |
|---|---|---|
| CC | ✅ works (synth fires on double-ESC) | ✅ works (synth is no-op, ctrl already true) |
| OC | ✅ works | ✅ works |
| shell | ✅ works | ✅ works |
| gemini-cli | ❌ Gemini's own parser at `KeypressContext.tsx:585` reads `alt` from the CSI modifier byte and discards the outer ESC-prefix from a double-ESC sequence. Mac Terminal users on gemini-cli need to install Ghostty or iTerm2 (which emit modifier-encoded CSI directly and bypass the parser quirk). | ✅ works |
| chrome | ✅ DOM `altKey` works in any Mac browser | ✅ same |

Also in this PR:

- **`packages/opencues-runtime/src/modules/nav-keymap.ts`** — removed the `TERM_PROGRAM=Apple_Terminal → ctrl-shift` auto-fallback. It was based on the wrong assumption that Ctrl+Alt+arrow was stripped; per `cat -v` testing, *Ctrl+Shift+arrow* is the combo Terminal.app actually strips, so the fallback was making things worse. `auto` now resolves to `ctrl-alt` everywhere (chrome stays hard-pinned).
- **`docs/install.md`** macOS section rewritten — Terminal.app now works without manual configuration thanks to the synth above. Earlier drafts of this PR recommended toggling "Use Option as Meta key" in profile settings; that's no longer required for OpenCues itself (users may still want it for general shell ergonomics).
- **Shared helper** `packages/opencues-runtime/src/modules/mac-keyboard.ts` exports `shouldSynthesizeMacDoubleEscCtrl`. Single source of truth used by all three sites above; 16-test pin in `mac-keyboard.test.ts` covers every byte-shape × terminal × edge-case combination.

Versions bumped: `@opencues/runtime` 0.1.9 → 0.1.10, `@opencues/core` 0.1.6 → 0.1.7, `opencues` CLI 0.1.7 → 0.1.8, `@opencues/shell` 0.1.2 → 0.1.3, `@opencues/opencode` 0.1.1 → 0.1.2. Banner in `opencues run` shows "Ctrl+Option" on darwin to match the physical Mac keyboard label.

User-facing upgrade path: `opencues run <host>` auto-rebuilds on next launch (srcHash drift detection from June 2026). No manual terminal-settings toggle required.

### Added — Self-healing forks: `opencues run <host>` auto-rebuilds on source drift

The "git pull and existing forks silently keep running pre-pull bytecode forever" trap is now closed structurally. Three pieces shipping together in this batch:

- **`packages/opencues-cli/src/lib/version-markers.cjs`** gains `computeSourceHash(repoRoot)` — a SHA-256 over every file under `packages/opencues-runtime/src/**` + `packages/opencues-core/src/**` + `packages/opencues-core/node-http-adapter.js`. `writeMarker` records it; `checkDrift` returns `status: 'stale', reason: 'srcHash'` when it diverges from the bundle's recorded hash. Load-bearing because it fires on ANY source byte change, not just package.json bumps — developers forgetting to bump no longer masks drift.
- **`packages/opencues-cli/src/commands/run.cjs`** calls `ensureFreshBundle(host, ctx)` at the top of every `opencues run <host>` invocation. Stale → transparently runs `opencues install <host> --no-prompts --yes` before spawning the host. One info line tells the user what's happening (`bundle is stale (source files changed since last install). Rebuilding before launch`). `--no-rebuild-check` opts out.
- **CLAUDE.md** gains a "Drift-prevention discipline" section codifying the new mechanism, the contract for adding bundled source dirs, and what contributors MUST do when changing `@opencues/{core,runtime}/src/**`.

### Added — `@opencues/core` 0.1.4 → 0.1.5
- **0.1.4 → 0.1.5** (PR #37 — nav-keymap): new `nav-keymap` scalar in FEATURES (`auto` | `ctrl-alt` | `ctrl-shift`). Auto resolves per host: chrome → ctrl-alt always (browser owns ctrl-shift+arrow); macOS Terminal.app (`TERM_PROGRAM=Apple_Terminal`) → ctrl-shift; everything else → ctrl-alt. Lets macOS Terminal.app users keep navigating without switching terminal emulators.

### Added — `@opencues/runtime` 0.1.5 → 0.1.6
- **0.1.5 → 0.1.6** (PR #37 — nav-keymap): `OpenCuesState.navKeymap` field with parser + `applyOpenCuesScalar` support; new `nav-keymap.ts` module exporting `resolveNavKeymap(configured, hostName)`. `Navigation` + `Cycling` subscribe both modifier combos at boot and gate each handler per-keystroke against the resolved keymap — flipping the scalar in OPENCUES.md hot-reloads without restart. Chrome adapter band skips the ctrl-shift subscription entirely (browser owns it for text selection).

### Added — `opencues` CLI 0.1.5 → 0.1.6
- **0.1.5 → 0.1.6** (PRs #38 / #39 / #40 / #41 + this batch):
  - PR #38: `opencues run <host>` launch banner with key hints + `--skip-banner` opt-out. Banner held in alt-screen for 3s minimum dwell so the Keys line is actually readable.
  - PR #39: shell-install tmux noise reduction — consolidated from 4 mentions per install to ≤2. Vendored-first preflight check skips the system-tmux warning when `~/.opencues/vendor/tmux/bin/tmux ≥ 3.2` is present.
  - PR #40: banner Keys section restructured so "Keys" is the leftmost section header with ├─/└─ branches hanging beneath; description column aligned across both Ctrl+Alt (12) and Ctrl+Shift (14) widths.
  - PR #41: vendor-pins test sandboxed via temp-`$HOME` so `pnpm test` stops deleting the real user's `~/.opencues/vendor/tmux/`.
  - This batch: `ensureFreshBundle` drift check + auto-rebuild on `opencues run`; `version-markers.cjs` gains `computeSourceHash` + `srcHash` + `reason` fields.

### Added — `@opencues/shell` 0.1.1 → 0.1.2
- **0.1.1 → 0.1.2** (PR #39): `bin/install.cjs` no longer prints the duplicate "tmux not installed" note (preflight in `opencues install` is now the single source of truth); the auto-vendor message names WHY it's running (`▸ System tmux is X.Y (oc-shell needs ≥ 3.2). Vendoring tmux 3.4 to ~/.opencues/vendor/tmux/`); `patches/setup.sh` tail prints only `✓ Shell build done.`, with the Launch / Open input / Optional-shell-integration summary moved into install.cjs so it lands AFTER the vendor step, not before.

### Added — `@opencues/core` 0.1.0 → 0.1.4
- **0.1.0 → 0.1.1**: Three-bucket LLM routing (`cues` / `auditors` / `blanks`). FEATURES registry gains three bucket scalars; `ConfigLoader` parses `cues-llm-provider` / `auditors-llm-provider` / `blanks-llm-provider` with back-compat read for legacy singular `blank-llm-*`. `build-sources.ts` routes per-bucket via `cuesBucket*` / `blanksBucket*` instead of the single `blankGlobal*`; the trust-class guard refuses `trainsOnInput: true` providers on prose buckets. Canonical doc: `docs/architecture/llm-routing.md`.
- **0.1.1 → 0.1.2**: Fluid-config natural-language provider/model switching. `ConfigIntentVerdict` becomes a discriminated union (`setting` | `provider` | `none`); SYSTEM_PROMPT rewritten with three INTENT classes; `validateAgainstRegistry` handles both verdict kinds. `ProviderAdapter.knownModels` (optional `readonly string[]`) bounds the model catalogue the classifier may route to — 2-5 curated entries per provider.
- **0.1.2 → 0.1.3**: Bare provider switches default to the **blanks** bucket. `"switch to anthropic _"` now writes `blanks-llm-provider: anthropic` (was `cues-llm-provider`). Cues and auditors require explicit scope; rationale: blanks is the user-opt-in `_` surface most likely targeted by a bucket-less phrase.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels infrastructure): TransformBlankSource now consumes the SENTINELS.md catalog — `draft email _`, `write a bio _`, etc. resolve sender sentinels via the same post-processor FluidBlank uses, with `preserveUnknown: true` so non-sender placeholders (`[Recipient Name]`, `[Date]`) survive untouched. New `validateSentinelWrite` discriminated chokepoint (`sentinels-validator.ts`) enforces key shape, value caps (256 chars / 64 fields), control-character filter, and token-collision detection for any code path that mutates SENTINELS.md. Renames: file `USER.md` → `SENTINELS.md`; symbols `UserContext*` → `Sentinels*`, `parseUserMd` → `parseSentinelsMd`, etc.; scalar `user-context-mode:` → `sentinels-mode:`. Back-compat: ConfigLoader reads both scalar names; seed-configs self-heals the file + scalar rename. Audit row #24 codifies the new write-surface threat model.

### Added — `@opencues/runtime` 0.1.0 → 0.1.5
- **0.1.0 → 0.1.1** (PR #17 chain-history): sequential LLM-blank substitutes chain into walkable history so the user can cycle back through prior fill-ins.
- **0.1.1 → 0.1.2**: typed bucket fields (`cuesLlmProvider` / `auditorsLlmProvider` / `blanksLlmProvider`) on `OpenCuesState` with back-compat parsing; `boot-common.buildAgentLLMResolver` reads the auditors bucket so `agent-rewrite` routes through it.
- **0.1.2 → 0.1.3**: `applyOpencuesScalar` now awaits the disk write — back-to-back applyScalar calls (ConfigIntent's provider+model verdict path) serialise on disk instead of racing the read-modify-write.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels rename): `OpenCuesState.userContextMode` → `sentinelsMode`; `ConfigLoader` parses the new `sentinels-mode:` scalar with back-compat fall-through to legacy `user-context-mode:`. No behaviour change for users who haven't opted into sentinels.
- **0.1.4 → 0.1.5** (PR #34 — sentinel-write blank): new `SentinelBlank` class in `BUILTIN_BLANKS` handles `set sentinel <key> <value> _` and `remove sentinel <key> _`. Every write routes through `@opencues/core`'s `validateSentinelWrite` chokepoint (no parallel paths). New `sentinelsMdIO` field on `BuiltinBlankContext`; the blank registers only when the host wires it. Errors paint visibly into the buffer as `[err] <detail>` — never silent, never throws. 7 layered defences documented in security-audit.md row #24.

### Added — `opencues` CLI 0.1.1 → 0.1.5
- **0.1.1 → 0.1.2** (Option-B self-heal): `seed-configs` cleans up legacy built-in / user-blank collisions left over from the May 2026 user-blank migration. Per-host log prefix; per-version markers.
- **0.1.2 → 0.1.3**: `seed-configs` self-heals legacy `blank-llm-*` → `blanks-llm-*` rename in place; `doctor` grows a "LLM routing" section showing effective resolution per bucket; `doctor` tmux check honors the vendored 3.4 fallback (`~/.opencues/vendor/tmux`); `update` detects stale bundled `@opencues/{core,runtime}` and transparently rebuilds instead of short-circuiting; CC install's "already healthy" hint bolds the `--rebuild` flag; help screen's Providers row shows three buckets instead of four per-aspect surfaces; `update` exports `isTested` / `isKnownIncompatible` (regression fix).
- **0.1.3 → 0.1.4** (PR #33): SIGINT race fix — `opencues update` registers signal handlers BEFORE `acquireLock` writes the lockfile (see CLI #33 entry above).
- **0.1.4 → 0.1.5** (PR #32 — Sentinels CLI + migrations): new `opencues sentinels` command (interactive interview + scriptable `list` / `set` / `add` / `remove` / `rm` / `path` / `list --json`). Smart defaults from `git config` and `gh api user`. All writes route through `@opencues/core`'s `validateSentinelWrite`. `seed-configs` self-heals `~/.cues/USER.md` → `~/.cues/SENTINELS.md` (pre-SEED step so user data survives) and `user-context-mode:` → `sentinels-mode:` (legacy-value-wins when both present). `doctor` surfaces leftover legacy artifacts with `opencues seed-configs` as the fix command.

### Added — `@opencues/claude-code` 0.1.0 → 0.1.2
- Single-fork CC install: one fork at `~/claude-code-cues/` handles both cli.js (≤2.1.111) and native-binary (≥2.1.113) shapes via tweakcc 4.0.13+ shape detection. `claude-code-cues-150` retired. Opt-in statusline. Native 2.1.150 support. Subsequent same-minor bumps (2.1.158 promoted to `current-pin` 2026-05-31) ride this band without a package-version bump — same adapter, same anchors, only `compat.json` updates.
- **0.1.1 → 0.1.2** (PR #34): CC bootstrap wires `sentinelsMdIO` so the keyword-bound `set sentinel _` / `remove sentinel _` blank can write to `~/.cues/SENTINELS.md`. Writes route through `@opencues/core`'s `validateSentinelWrite`; no parallel write paths. Security-audit row #24.

### Added — `@opencues/chrome` 0.1.0 → 0.1.2
- Bundle ships the new `BLANK.md` frontmatter (the user-blank migration that retired the per-host built-in/user-blank duplication).
- **0.1.1 → 0.1.2** (PR #34): Chrome bootstrap wires `sentinelsMdIO` so the sentinel blank works on contenteditables + normal inputs. Writes go through chrome.storage via the same validator chokepoint.

### Added — `@opencues/opencode` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): OC bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — `@opencues/gemini-cli` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): Gemini bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — `@opencues/shell` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): Shell (`oc-edit`) bootstrap wires `sentinelsMdIO` for the sentinel blank.

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
