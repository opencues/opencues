# Token-integration / rewrite-polish — status snapshot

Branch: `feat/identity-context-section-types-and-covers`

This is a context dump so the direction can be resumed after exploring
alternatives on sibling branches. The branch is intentionally NOT merged
to master — companion design notes are in `token-integration-plan.md`
and `identity-dehydration-plan.md`.

## What's shipped on this branch (uncommitted → committed by the
## commit that introduces this doc)

Two pipeline stages running after the source's primary LLM call:

1. **Token-integration (splice-shape)** — for FluidBlank.
   - Input: `(buffer-with-_, substitute)`
   - Output: `(REPLACE, WITH)` — `REPLACE` is a verbatim substring of
     buffer containing `_`. Validated; falls back to `_` → substitute on
     any failure.
   - Replaces the legacy `determineReplaceMode` regex (WIPE vs FILL) AND
     the post-hoc polish step that ran on top. One LLM call decides
     intent (sentence-with-slot / lookup question / continuation) + the
     formatting fit.
   - File: `packages/opencues-core/src/token-integration.ts` (~300 LoC).
   - Cache: LRU 256, keyed on `_`-centred 32-char window + substitute +
     hint.
   - Telemetry: `cache-hit | integrated | fallback-* | skipped-*`.

2. **Rewrite-polish (whole-buffer shape)** — for TransformBlank's FUSED
   branch.
   - Input: `(instruction, rewrite-with-sentinels-already-resolved)`
   - Output: `KEEP` (rewrite unchanged) OR `POLISHED: <body>`.
   - Refines prose around resolved data values (e.g. "$212.45 is the
     NVIDIA price" → "NVIDIA is at $212.45").
   - File: same `token-integration.ts` (appended) — 200 LoC.
   - Cache: LRU 128, keyed on `instruction + rewrite-head + rewrite-tail
     + rewrite-length`.
   - Telemetry: `cache-hit | polished | unchanged | fallback-* |
     skipped-short-rewrite`.

## Why two shapes, not one

The splice shape always falls back when the substitute is a whole-buffer
rewrite (no `_` in the substitute → no valid REPLACE substring with
`_`). For FluidBlank substitutes (`$212.45`) the splice shape is the
right tool — surgical. For TransformBlank FUSED rewrites (a full email
body) the prose-level polish shape is the right tool. We tried unifying
under a `mode:` flag — the prompts diverge enough that two functions is
cleaner than one with two prompts.

## The gate

Both stages gate on the same scalar — `fluid-blank-token-integration:
smart | legacy`. Default `legacy` (bit-identical to pre-feature). Set
to `smart` in `~/.cues/OPENCUES.md` to enable both. Adding a separate
scalar per stage was considered and rejected as menu noise.

Stages also gate on `resolvedSentinelCount > 0` from the source's
post-processor — there's no value polishing a rewrite that didn't
resolve any catalog data.

## Files touched

```
packages/opencues-core/src/
  token-integration.ts            — splice + polish modules
  token-integration.test.ts       — splice unit tests
  rewrite-polish.test.ts          — polish unit tests
  index.ts                        — re-exports
  feature-registry.ts             — new scalar
  sources/build-sources.ts        — wires both into FluidBlank +
                                    TransformBlank sources
  sources/fluid-blank-source.ts   — splice smart path
  sources/transform-blank-source.ts — polish smart path

packages/opencues-runtime/src/
  boot-common.ts                  — buildBlankTokenIntegrationRunner +
                                    buildRewritePolishRunner factories,
                                    SharedRuntime adds both
  modules/resolver.ts             — runTokenIntegration + runRewritePolish
                                    on ResolverOptions
  modules/feature-registry-alignment.test.ts — SETTINGS_MAP_ONLY entry

packages/opencues-runtime/adapters/
  cc/v2.1/boot.ts                 — builds its own runners (no shared)
  oc/v1.14/boot.ts                — uses shared
  chrome/v1/boot.ts               — uses shared
  gemini/v0.41/boot.ts            — uses shared

tests/agentic/scenarios/
  91-token-integration-smart-mode.json    — 4 splice cases that
                                            previously misbehaved
  92-transform-blank-token-integration.json — email case with polish
```

## Verified manually (opencode session, 16 June 2026 02:00 UTC)

- `nvda is at _` → `nvda is at $212.45` (splice, REPLACE=`_`).
- `whats nvda stock price _` → `$212.45` (splice, REPLACE=whole input).
- `Hi team, AAPL is at $200, NVDA: _` → preserves prose; substitutes
  cleanly.
- `make the email about apple too _` (against existing email buffer) →
  full email with NVIDIA + AAPL both naturally integrated. FluidBlank
  splice fired in parallel; TransformBlank's polish call landed
  `fallback-no-underscore` correctly on the whole-buffer rewrite (the
  pre-polish-impl behaviour) — confirms the splice→polish swap was
  needed. The polish path now runs in its place when the user retries
  on a fresh build.

## Bench / tests

- Unit: 944 core + 1680 runtime, all green (`pnpm -r test`).
- Agentic: scenarios 91 + 92 pass against opencode + cerebras.
- Bench: not yet — was deferred until the design stabilised. Was the
  PR3 step in `token-integration-plan.md`.

## Open work that this branch did NOT close

These are the live questions when work resumes on this direction:

1. **Default flip** — `fluid-blank-token-integration` is still
   `legacy` by default. Flip after a bench run + a week of dogfooding.
2. **Sunset legacy** — once smart is default for a release, delete the
   regex+polish path from FluidBlankSource. ~150 LoC of dead branch.
3. **BlankFill migration** — keyword-bound blanks (volume, weather,
   stocks, hackernews, …) still use `determineReplaceMode`. PR6 in the
   plan doc.
4. **Polish bench** — run cross-provider on 30+ TransformBlank rewrites
   to measure the polish call's effect (precision = don't change
   already-natural prose; recall = catch awkward dropped-in values).
5. **Latency** — polish adds 500-1000ms serial to TransformBlank FUSED
   when sentinels were resolved. Acceptable on cerebras (prefix-cache
   hits on the polish system prompt across consecutive calls), worth
   measuring on groq / anthropic.

## What sparked the "change the system even more" direction

The realisation that two separate post-source stages (splice + polish)
exist at all suggests the source/post-source boundary is misdrawn. The
sibling direction(s) being explored:

- Inline the polish/splice decision into the source itself (one LLM
  call per source, no post-stage)? Trades cerebras prefix-cache
  ergonomics for a simpler control flow.
- Move the gate one level up — have the resolver run a single
  cross-source "buffer reconciliation" pass that knows about all
  sources' substitutes (selector/satellite, fluid-blank, transform-
  blank) instead of each source doing its own?
- A "sentinel dehydration → LLM → rehydration" layer (see
  `identity-dehydration-plan.md` for prior thinking).

If one of those wins, the splice+polish modules become the design that
was deprecated, not a layer to keep stacking on. Keep the test fixtures
in `tests/agentic/scenarios/91-*` and `92-*` as regression coverage —
whatever replaces this should pass them.

## How to resume

```
git checkout feat/identity-context-section-types-and-covers
pnpm install
pnpm -r build
pnpm -r test                           # 944 + 1680 should be green
opencues install opencode --keep-state  # rebuild the fork
opencues run opencode                  # smoke-test in the editor
```

The plan doc (`token-integration-plan.md`) tracks the PR sequence; PRs
1-2 are landed in source on this branch (uncommitted until the commit
that introduces this status doc). PRs 3-6 are open.
