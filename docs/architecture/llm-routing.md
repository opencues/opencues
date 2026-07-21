# LLM routing — three buckets

OpenCues runs many LLM-driven surfaces (word-cues, sentence-cues,
fluid-blank, transform-blank, fluid-config, keyword blanks, auditors,
agent-rewrite). The provider/model picker collapses them into **three
buckets**, each with one user-visible scalar pair in
`~/.cues/OPENCUES.md`. Per-aspect overrides remain available but are
deliberately file-edit-only.

## The buckets

| Bucket | Surfaces | Scalars |
|---|---|---|
| **cues** | word-cues, sentence-cues | `cues-llm-provider`, `cues-llm-model`, `cues-llm-endpoint` |
| **auditors** | auditors, agent-rewrite | `auditors-llm-provider`, `auditors-llm-model`, `auditors-llm-endpoint` |
| **blanks** | fluid-blank, transform-blank, fluid-config, keyword blanks | `blanks-llm-provider`, `blanks-llm-model`, `blanks-llm-endpoint` |

Both cues + auditors are **prose-bearing** — the resolver's
`trainsOnInput` guard refuses to wire them through a provider whose ToS
allows training on submitted inputs (today: `opencode-zen`). Only the
blanks bucket exposes `opencode-zen` in its menu, because typing `_` is
the user's explicit consent gate.

The agent-rewrite surface goes into the **auditors** bucket because
auditors and agent-rewrite share the same trust class — background
prose rewriters that ship the whole buffer to the model. Putting them
on the same knob lets the user pick one provider for "things that
rewrite my prose without me typing `_`".

## Precedence ladder

Most-specific wins:

```
per-source frontmatter (`provider:` / `model:` in a CUE.md / BLANK.md)
  ▶ per-feature scalar (`word-cues-provider:`, `fluid-blank-provider:`, …)
    ▶ bucket scalar (`cues-llm-provider:`, `auditors-llm-provider:`, `blanks-llm-provider:`)
      ▶ global scalar (`llm-provider:`)
        ▶ auto-fallback (first env key in `PROVIDER_AUTO_ORDER`)
          ▶ subscription-CLI rung (`SUBSCRIPTION_AUTO_FALLBACK`: claude-code-cli, then
            openai-subscription — fires ONLY at zero env keys, iff the binary is on PATH)
```

The subscription rung makes a keyless Claude Code install work out of
the box: the CC integration patches the `claude` binary itself, so its
users by definition carry an authenticated subscription. The rung is
runtime-only detection (nothing written to config), unreachable once
any auto-order key exists — adding a key upgrades the route
automatically — and self-disabled in the browser (the binary probe
returns false without `process`, and chrome has no subprocess
transport anyway). `resolveLLM` emits a one-time notice naming the
route + `opencues set-key` as the faster path; opencode-zen's free
pool is deliberately NOT in the rung (`trainsOnInput` — keyless but
consent-gated).

Setting `cues-llm-provider: cerebras` pins every cue source to Cerebras
**unless** a particular word-cue source declares its own
`provider:` (per-source) or the user set a `word-cues-provider:`
(per-feature). Setting `cues-llm-provider: inherit` (the default)
collapses the bucket and lets `llm-provider:` take over.

## Per-aspect overrides — advanced, file-edit only

The per-aspect scalars are intentionally **not** in the menu, the
cycling list, or the fluid-config classifier. They exist for power
users who want fine-grained tuning. The full list:

- `word-cues-provider:` / `word-cues-model:` / `word-cues-endpoint:`
- `sentence-cues-provider:` / `sentence-cues-model:` / `sentence-cues-endpoint:`
- `fluid-blank-provider:` / `fluid-blank-model:` / `fluid-blank-endpoint:`
- `transform-blank-provider:` / `transform-blank-model:` / `transform-blank-endpoint:`
- `fluid-config-provider:` / `fluid-config-model:` / `fluid-config-endpoint:`
- `agent-provider:` / `agent-model:` / `agent-endpoint:` (auditors bucket)

If you want them, edit `~/.cues/OPENCUES.md` directly. The bucket scalars
cover the 90% case.

## How surfaces route at build time

The bucket→global collapse lives in ONE place:
`packages/opencues-core/src/effective-routing.ts:collapseBucketTier`
(July 2026). Every dispatch site calls it, and the display surfaces
(doctor's LLM-routing section, the `model` blank, `opencues models`)
run the same walk via `resolveEffectiveRouting` — dispatch and
"what's my model?" are structurally unable to disagree.

Pairing rules (`collapseBucketTier`):

- Bucket provider **pinned** → the bucket model rides with it; the
  global `llm-model` NEVER leaks in (a stale global model would pair
  with a provider it was never chosen for).
- Bucket provider **inherit/unset** → the global provider is used, and
  a set bucket model still WINS over the global model. The config menu
  writes `<bucket>-llm-model` against the inherited provider's
  knownModels; before July 2026 dispatch silently ignored that scalar.
- Model sentinels (`default` / `inherit` / empty) and unknown bucket
  provider ids (→ inherit, mirroring config-loader) are normalized
  inside the collapse.

**cues + blanks**: handled in
`packages/opencues-core/src/sources/build-sources.ts` via
`BuildSourcesOptions.{cuesBucket*, blanksBucket*}`; `resolveFor()`
collapses via `collapseBucketTier` then applies the ladder through
`resolveLLM`.

**auditors**: handled in
`packages/opencues-runtime/src/boot-common.ts` via
`buildAgentLLMResolver` (and `buildKataLLMResolver` for the kata
coach). Both collapse through core's `collapseBucketTier` and return
the resolved tuple for the per-tick LLM call.

## Migration from the legacy `blank-llm-*` scalars

Pre-three-bucket installs used `blank-llm-provider:` /
`blank-llm-model:` / `blank-llm-endpoint:` (singular). The new names are
plural (`blanks-llm-*`).

- **Runtime**: reads both names; new wins if present, legacy is the
  fallback. See `config-loader.ts:bucketProvider`.
- **`opencues install`**: runs `seed-configs` which rewrites legacy →
  new in place. Idempotent, single-line replacement, preserves
  surrounding frontmatter.

After everyone has run `opencues install` once post-three-bucket, the
back-compat fallback will be removed in the next release.

## Natural-language switching via fluid-config

When `fluid-config-mode: on`, the classifier at priority 94 catches
`_`-trailed sentences and routes them to one of three intents: a
**setting** change, a **provider** change, or **NONE**. The
provider-change intent is the bucket-aware natural-language path:

```
use anthropic for cues _              → cues-llm-provider: anthropic
switch the blanks brain to cerebras _ → blanks-llm-provider: cerebras
use claude opus for auditors _        → auditors-llm-provider: anthropic
                                        auditors-llm-model: claude-opus-4-7
route everything to gemini _          → blanks-llm-provider: gemini (blanks = default scope)
switch to anthropic _                 → blanks-llm-provider: anthropic
use cerebras _                        → blanks-llm-provider: cerebras
use gemma for blanks _                → blanks-llm-provider: cerebras
                                        blanks-llm-model: gemma-4-31b
```

> **Gemma on Cerebras (private preview).** `gemma-4-31b` is in cerebras's
> `knownModels`, so it's selectable by name — via the `opencues config`
> menu (`blanks-llm-model`) or natural language (`use gemma for blanks _`,
> `use gemma for cues _`) — exactly like `haiku` on anthropic. It is
> **NOT** the cerebras default (`gpt-oss-120b` stays the default) while it
> is in preview. It benches faster than gpt-oss-120b with comparable
> accuracy on lookups/rewrites, but trails on multilingual transforms
> (`tests/results/gemma-benchmark-2026-07-01/FINDINGS.md`).

### What the classifier may emit

The model is bounded by two registries:

- **Bucket scope** ∈ `{cues, auditors, blanks}` — hard-coded list.
- **Provider id** ∈ entries of `PROVIDERS` in
  `packages/opencues-core/src/llm-provider.ts` (the `ProviderId` union).
- **Model id** ∈ each provider's optional `knownModels: readonly string[]`
  list. Models outside that list are rejected at runtime even if the
  classifier emits them — power users can still pin them by editing
  OPENCUES.md directly.

The trust-class guard from the resolver mirrors here: the classifier
verdict for the cues or auditors bucket cannot route to a provider
whose `trainsOnInput: true` (today: `opencode-zen`). Only the blanks
bucket may pick that provider.

### Adding a new model to the classifier's choice space

Append the model id to the provider adapter's `knownModels` array in
`packages/opencues-core/src/llm-provider.ts`. The classifier prompt
renders the lists at module-load, so no prompt edit is required. Aim
for 3–5 entries per provider — bench-validated picks that cover the
common cheap-fast / balanced / deep-reasoning tiers.

### Cycling after a switch

The fluid-config result is a selector-satellite pair: the selector is
the bucket scalar (e.g. `cues-llm-provider`) — itself a FEATURES
registry entry — and the satellite is the provider id. After a switch
the user can cycle the satellite through the menu values for that
bucket scalar (the registry's `values` list, e.g. `inherit, cerebras,
groq, gemini, anthropic, openai`). Picking a different provider via
cycling overwrites the provider scalar only — the model scalar (if
previously set) stays put.

## Diagnostics

`opencues doctor` shows the **LLM routing** section with the effective
provider per bucket after precedence walks (bucket scalar > global
> auto-fallback). The arrow notation `← llm-provider` indicates which
tier provided the value when the bucket itself was `inherit`. Since
July 2026 the section is rendered from
`resolveEffectiveRouting` (the shared walk) and additionally warns on
unknown bucket-provider ids, configured-but-keyless providers, and
prose buckets routed to `trainsOnInput` providers.

## Related files

- Single source of truth: `packages/opencues-core/src/feature-registry.ts`
  (`FEATURES` entries for the three bucket scalars).
- Shared precedence walk: `packages/opencues-core/src/effective-routing.ts`
  (`collapseBucketTier` for dispatch, `resolveEffectiveRouting` for
  display; both sit on `resolveLLMTuple`, the pure half of `resolveLLM`).
- Provider catalog: `packages/opencues-core/src/llm-provider.ts`
  (`ProviderId` union, `PROVIDER_AUTO_ORDER`, `PROVIDERS` adapters).
- Resolver wiring: `packages/opencues-runtime/src/modules/resolver.ts`
  (`buildOpts` block).
- Auditors wiring: `packages/opencues-runtime/src/boot-common.ts`
  (`buildAgentLLMResolver`).
- Trust guard: `packages/opencues-core/src/sources/build-sources.ts`
  (`resolveFor` → `trainsOnInput` rejection).
