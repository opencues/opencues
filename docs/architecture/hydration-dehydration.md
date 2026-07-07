# Hydration & Dehydration — the bidirectional PII boundary

> ⚠ Canonical reference for the buffer-dehydration system (July 2026)
> and the retroactively-named hydration post-processor. Read this
> before touching `packages/opencues-core/src/dehydrate.ts`, the
> `introducedTokens` plumbing in `identity-context.ts` /
> `typed-sentinel.ts`, any source's outbound dehydration hook, the
> `dispatchChat` PII floor, or AgentRewrite's dehydrate→hydrate→merge
> ordering. Companion: `docs/architecture/identity-context.md` (the
> catalog + threat model), `spec/identity-context-spec.md`
> § Dehydration (the normative contract, spec `0.5`).

## Vocabulary

Borrowed from the web's hydration concept, inverted into a privacy
boundary:

- **Dehydration** (outbound): before buffer-derived text ships in an
  LLM request, real identity values are replaced with their canonical
  `[TOKEN]`s. The provider works on a *dehydrated* artifact — the
  structure of the text without the user's data.
- **Hydration** (inbound): the existing post-processor
  (`identity-context.ts:postProcessContext`, typed-engine sibling
  `typed-sentinel.ts:resolveTypedSentinels`), retroactively named.
  Tokens in LLM output bind back to real values locally, once, after
  the response.

In React, the server renders with real data and the client hydrates
*behavior* onto it. Here the direction is deliberately inverted: the
"server" (LLM) never sees the values at all — hydration attaches
*data*, locally, as a privacy boundary rather than a performance
optimization.

`identity-context-mode: safe` (the default) means dehydrated in BOTH
directions: the catalog direction (token-only prompt blocks — shipped
June 2026) and the buffer direction (this system). `raw` skips both.
`off` has no catalog at all.

## Why the buffer direction exists

Safe mode's original guarantee had a hole: IDENTITY.md values never
entered prompts, but anything personal the user *typed into the
buffer* shipped verbatim. `draft an email _ hi, this is Wilfred from
Command Stick` sent both the name and the company to the provider —
the catalog protection covered exactly the data the user had NOT put
in the buffer. Dehydration closes the loop: "safe means safe" for the
whole exchange.

## The 9 outbound channels (coverage table)

Every LLM-bound copy of buffer text is dehydrated. One open channel
defeats the claim — this table IS the coverage contract; extend it
when adding a source.

| # | Channel | Hook (file → where) | Return-path hydration |
|---|---|---|---|
| 1 | FluidBlank `INPUT:` + ambient block | `fluid-blank-source.ts` — before `fusedUser` build; ambient scrubbed with the same pass (page labels can echo PII) | existing post-process calls, now with `introducedTokens` |
| 2 | TransformBlank `INPUT:` | `transform-blank-source.ts` — `extractText` dehydrated before `[CURSOR]` injection | `resolveSentinels` (hydrates BEFORE the result leaves the source) |
| 3 | TransformBlank Cerebras `prediction` param | same — `fusedPrediction` ships the dehydrated text | n/a (request-side only) |
| 4 | SentenceCue `SENTENCE:` | `sentence-cue-source.ts` — per-span dehydrate inside the concurrency loop | per-alternative `postProcessContext` (`preserveUnknown: true`; `alternatives[0]` stays the original) |
| 5 | ConfigIntent classifier `INPUT:` | `config-intent-source.ts` — input-only (output is FEATURES-registry-validated, no PII can round-trip) | n/a |
| 6 | ConfigIntent summon `INPUT:` | same — echoed summon phrase is hydrated BEFORE `resolveSummonStart`, so `endsWith` runs on original bytes; a hydration miss degrades to the regex floor (safe, never a wrong span) | summon-phrase hydrate |
| 7 | Word-cues (ConfigSource + RoutedWordSourceGroup) | PII words **dropped from dispatch entirely** (`isPiiWord`) — no LLM synonyms for your name; `raw`-parser path dehydrates the buffer | raw-parser alternatives hydrated |
| 8 | AgentRewrite `DOCUMENT:` | `agent-rewrite.ts:callLLMOnce` — windowed doc dehydrated, `[CURSOR]` at `mapOffset` | hydrate LLM output BEFORE window splice + three-way merge (see below) |
| 9 | blank-weave `PRIOR TEXT:` | `blank-weave.ts` — priorContext dehydrated (the `⟦VALUE⟧` weave token is not bracket-shaped; hydration never touches it) | woven output hydrated |

Plus the **defense-in-depth floor** (below) covering anything missed.

## The dehydrator (`packages/opencues-core/src/dehydrate.ts`)

Pure, browser-safe, total (never throws — internal error returns the
input unchanged + warns; the floor still covers the call).

- **One compiled alternation** per catalog: escaped values, internal
  whitespace → `\s+`, branches sorted longest-value-first (JS
  alternation is ordered, so `Wilfred Kasekende` beats `Wilfred` at
  the same start), flags `giu`.
- **Boundaries per branch, not global**: Unicode lookarounds
  `(?<![\p{L}\p{N}]) … (?![\p{L}\p{N}])` (`\b` is wrong for emails,
  `+44…` phones). A side whose edge character is CJK
  (Han/Kana/Hangul) drops its boundary — scriptio continua has no
  space boundaries, and requiring one would silently LEAK CJK names
  embedded in CJK prose.
- **Variants for free**: possessive `'s` and trailing punctuation
  need no special casing — the boundary permits a following
  apostrophe/punct, so `Wilfred's` → `[FIRST NAME]'s`, and hydration
  restores it.
- **Skip rules (visible residual)**: values < 3 chars, common
  dictionary words, and month/day names are skipped —
  surfaced on `CompiledDehydrator.skipped` + warned once per compile
  with the value REDACTED (first char + length). Never silent.
- **Deterministic**: single left-to-right pass; same input + same
  catalog ⇒ byte-identical output, so Cerebras prefix caching keeps
  hitting.
- **`mapOffset(origOffset, bias)`**: maps original-text offsets into
  dehydrated coordinates, snapping a mid-value offset to the token
  boundary. Used for `[CURSOR]` injection — the sentinel must never
  split a value (`Wil[CURSOR]fred` would defeat matching and leak
  fragments).
- **`isPiiWord(word)`**: word-level test for the word-cue drop.
  Built from each whitespace-word of every eligible value, filtered
  through the same skip rules ("of" inside "Bank of America" doesn't
  poison ordinary prose). Over-dropping costs a cue; under-dropping
  ships a name.
- **Cache**: `getDehydrator` keys a WeakMap on the catalog Map
  *instance*. `ConfigLoader.load()` builds a fresh
  `Identity.catalog` per hot reload, so recompilation happens exactly
  when IDENTITY.md changes and every consumer (sources, AgentRewrite,
  the floor) shares one compiled matcher per config generation.

## The originalBody trap (round-trip correctness)

`postProcessContext` rule 1 preserves any token found in
`originalBody` (user-typed brackets are sacred). The structural rule
that keeps hydration correct:

> **`originalBody` is ALWAYS the true pre-dehydration text.
> Dehydration only ever produces outbound copies; `context.text` is
> never mutated.**

Then an *introduced* `[FIRST NAME]` is absent from the real
originalBody → falls through to rule 2 → hydrates. A genuinely
user-typed bracket is present → preserved. Passing the dehydrated
string as `originalBody` makes rule 1 "preserve" every introduced
token instead of hydrating it — the round-trip silently breaks. This
failure mode is pinned as an explicit test
(`dehydrate.test.ts` — "PINS the originalBody trap").

**The ambiguous both-present case**: the user typed the literal
`[FIRST NAME]` (a deliberate placeholder, e.g. a template) AND their
real name appears elsewhere in the same buffer. After an LLM rewrite,
per-occurrence disambiguation is impossible — both occurrences are
identical strings. **Preserve wins** (hydrate-wins would inject real
PII into a spot where the user deliberately wrote a placeholder — a
silent disclosure into a shareable artifact). The conflict is
recorded on `report.ambiguous` (threaded via the
`introducedTokens` option on `PostProcessOptions` /
`ResolveTypedOptions`) and callers log it. Worst case: a visible
token where the name was, one Down-arrow from revert.

## AgentRewrite: hydrate-before-merge

Order of operations per round:

1. Window + cursor computed on ORIGINAL coordinates.
2. Windowed doc dehydrated; `[CURSOR]` injected at
   `mapOffset(cursor, 'right')`.
3. LLM returns a token-space rewrite.
4. **Hydrate FIRST** (`preserveUnknown: true` — stripping would
   delete user content; failure discards the round, buffer
   untouched).
5. THEN the existing window splice + `threeWayMerge(snapshot,
   rewrite, live)` — all in value space.

Merging in dehydrated space was rejected: it would require
dehydrating the live buffer per tick and remapping every hunk +
cursor offset back through token-length deltas — a whole class of new
offset bugs for zero benefit. Because hydration precedes the merge,
token-length ≠ value-length can never drift an offset and the merge
invariant (user edits never clobbered) is untouched.

## Defense-in-depth floor (`dispatchChat`)

Per-source dehydration is the primary mechanism. The floor is the
belt-and-braces at the single transport gateway
(`llm-provider.ts:dispatchChat`, both CLI and HTTP transports):

- `setOutboundDehydrationGuard(thunk)` is registered at boot
  (`boot-common.buildSharedRuntime`; CC's inline band registers it
  explicitly in `adapters/cc/v2.1/boot.ts`) with a thunk that
  re-reads config per dispatch — mode flips hot-reload.
- `applyOutboundDehydrationFloor(req)` scrubs every
  `messages[i].content` + `prediction`. A hit means **a source is
  missing dehydration** — the request is scrubbed (never thrown; the
  floor must not break a feature) and a loud warning fires.
- **The one dispatchChat bypass** — AgentRewrite's HTTP branch
  (`buildRequest` + `postWithFallback` direct) — applies the same
  exported floor before `buildRequest`.
- Unregistered (bare-core benches / CLI / tests) or `raw` mode
  (thunk returns null): requests pass through byte-identical — the
  floor cannot fight raw mode's inlined catalog values.

## Failure-safety invariants (no logical landmines)

- **I1** — dehydration never mutates the buffer: outbound copies
  only (structural — there is no code path that writes dehydrated
  text into buffer state).
- **I2** — every hydration site is try/catch'd: worst case is a
  visible `[TOKEN]` in an alternative (revertable) or a discarded
  AgentRewrite round; never lost user content.
- **I3** — `alternatives[0]` stays the original text; DynDef revert
  paths unchanged.
- **I4** — mangled tokens recover via the tolerant matcher or
  survive visibly (`preserveUnknown: true` on every user-content
  path; FluidBlank's strip applies only to the ANSWER).
- **I5** — dehydrator internal error fails open per source, but the
  dispatch floor still scrubs → degradation is "floor warns loudly",
  not "PII ships".
- **I6** — skipped (too-short/common) values are logged once per
  catalog compile, redacted.

## Known residuals (documented, deliberate)

- **Case-drift**: `wilfred` typed lowercase dehydrates (PII is PII)
  but hydrates back as the canonical `Wilfred`. Cosmetic
  normalization, never data loss.
- **Skipped values** (< 3 chars, dictionary/month/day words) remain
  in outbound text — visible via the compile-time warning. A user
  named `June` is told, not silently exposed.
- **Fragments the matcher can't see**: a value the user typed with a
  typo (`Wilfrd`) doesn't match and ships. The floor has the same
  limitation — matching is exact-modulo-variants by design (fuzzy
  matching risks mangling innocent text, violating I1's spirit).
- **System-prompt example collisions**: static prompts contain
  real-looking example names; a user whose real name collides gets
  those examples scrubbed to tokens by the floor. Harmless and
  deterministic.
- **Pack `ctx.llm` egress**: user-blank packs' capability-gated LLM
  access (`user-blanks/registry.ts`) does its own HTTP and does NOT
  route through `dispatchChat`, so the floor doesn't cover it. Pack
  prompts are pack-constructed (not buffer copies), and the path is
  bounded by the capability model (security-audit rows #5/#6) — but a
  captured blank ARG can carry user-typed text. Tracked follow-up:
  either dehydrate captured args before they reach pack context, or
  apply the exported floor inside `ctx.llm`. Until then this is a
  documented residual, not a covered channel.

## Observability

Every source logs `dehydrated N value(s) → tokens (outbound PII
scrub)` at debug level (counts only, never values) — `debug-mode: on`
+ `grep dehydrated /tmp/opencues.log` to verify the scrub is live
(chrome BlankIntent silent-degrade lesson). Skip warnings appear once
per catalog compile. Floor hits warn loudly with the residual count.

## Tests

- `packages/opencues-core/src/dehydrate.test.ts` — matcher contract,
  skip rules, mapOffset, round-trip + the originalBody-trap pin, the
  ambiguous-case precedence.
- `packages/opencues-core/src/sources/dehydration-outbound.test.ts` —
  per-source negative invariant: NO catalog value substring anywhere
  in any recorded request body (messages + prediction) under `safe`;
  `raw` byte-compatible. Uses distinctive synthetic values (static
  prompts contain real-looking example names).
- `packages/opencues-core/src/dispatch.test.ts` — floor scrubs +
  warns; unregistered guard leaves requests untouched; throwing
  guard fails open.
- `packages/opencues-runtime/src/modules/agent-rewrite.test.ts` —
  tokens-out/values-back; user-types-during-call merge invariant
  through hydration; throwing-LLM buffer-byte-identical.
- `packages/opencues-runtime/src/modules/identity-dehydration.scenarios.test.ts`
  — runtime journeys: IDENTITY.md-on-disk → catalog forwarded
  (keyword-bound gate deliberately dropped for identity); off/raw/
  missing-file no-ops; the satellite-cycle mode-drift pin; hydrated
  substitution lands with zero token residue.
- `packages/opencues-runtime/src/modules/config-loader.test.ts` —
  the `applyOpenCuesScalar` two-tier default pin (the inline re-parse
  used to default the mode to `off`, silently disabling the scrub on
  any satellite cycle).

## When adding a new LLM-bound source

1. Gate on `context.identityContext?.mode === 'safe'` + non-empty
   catalog; `getDehydrator(catalog)` and dehydrate every outbound
   copy of buffer text (including any context/prediction side
   channels).
2. Hydrate the return path with `postProcessContext`, passing the
   TRUE pre-dehydration text as `originalBody` and
   `DehydrationResult.introduced` as `introducedTokens`;
   `preserveUnknown: true` for any output that carries user content.
3. Never compute buffer-coordinate offsets on dehydrated text; map
   with `mapOffset` or resolve against original bytes.
4. Add the source to the coverage table above and a negative-
   invariant case to `dehydration-outbound.test.ts`.
5. The floor will catch you if you forget — but a floor warning in
   the log is a bug report, not a feature.
